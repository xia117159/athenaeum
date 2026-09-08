use std::{collections::HashMap, sync::Arc};

use chrono::{DateTime, Datelike, NaiveDate, Utc};
use pest::{error::InputLocation, iterators::Pair, Parser};
use pest_derive::Parser;
use regex_automata::{
    dfa::{dense, sparse, Automaton},
    Anchored, Input,
};

use crate::domain::{
    color_filter::{
        ColorFilterValidationResult, ColorFilterValidationSpan, ColorRule, ColorRuleTarget,
    },
    models::EntryKind,
};

pub mod migration;

#[derive(Parser)]
#[grammar = "services/color_filter/grammar.pest"]
struct ExpressionParser;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Truth {
    True,
    False,
    Unknown,
}

impl Truth {
    fn not(self) -> Self {
        match self {
            Self::True => Self::False,
            Self::False => Self::True,
            Self::Unknown => Self::Unknown,
        }
    }

    fn and(self, other: Self) -> Self {
        match (self, other) {
            (Self::False, _) | (_, Self::False) => Self::False,
            (Self::True, Self::True) => Self::True,
            _ => Self::Unknown,
        }
    }

    fn or(self, other: Self) -> Self {
        match (self, other) {
            (Self::True, _) | (_, Self::True) => Self::True,
            (Self::False, Self::False) => Self::False,
            _ => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Variable {
    Name,
    Extension,
    Path,
    Size,
    Created,
    Modified,
    Accessed,
    Age,
    Attributes,
    Type,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Operator {
    Equal,
    NotEqual,
    Less,
    LessEqual,
    Greater,
    GreaterEqual,
    Has,
    NotHas,
}

#[derive(Debug, Clone, PartialEq)]
enum Literal {
    Text(String),
    Pattern(CompiledWildcard),
    Bytes(u64),
    Duration(chrono::Duration),
    Timestamp(DateTime<Utc>),
    Date(NaiveDate),
    DateRange(Option<(DateTime<Utc>, DateTime<Utc>)>),
    Attribute(Attribute),
    Kind(EntryKind),
}

pub(crate) const MAX_COLOR_RULE_COUNT: usize = 256;
pub(crate) const MAX_COLOR_RULE_NAME_SCALARS: usize = 128;
pub(crate) const MAX_COLOR_FILTER_TEXT_SCAN_BUDGET: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Attribute {
    File,
    Directory,
    Hidden,
    System,
    ProtectedSystem,
    ReadOnly,
    Symlink,
    Archive,
}

#[derive(Debug, Clone, PartialEq)]
enum Expression {
    Compare(Variable, Operator, Literal),
    Not(Box<Expression>),
    And(Box<Expression>, Box<Expression>),
    Or(Box<Expression>, Box<Expression>),
}

#[derive(Debug, Clone, Default)]
pub struct AttributeFacts {
    pub hidden: Option<bool>,
    pub system: Option<bool>,
    pub protected_system: Option<bool>,
    pub read_only: Option<bool>,
    pub symlink: Option<bool>,
    pub archive: Option<bool>,
}

impl AttributeFacts {
    #[cfg(test)]
    pub fn all_known(value: bool) -> Self {
        Self {
            hidden: Some(value),
            system: Some(value),
            protected_system: Some(value),
            read_only: Some(value),
            symlink: Some(value),
            archive: Some(value),
        }
    }
}

#[derive(Debug, Clone)]
pub struct EntryFacts {
    pub name: String,
    pub path: String,
    pub extension: Option<String>,
    pub kind: EntryKind,
    pub size: Option<u64>,
    pub created_at: Option<DateTime<Utc>>,
    pub modified_at: Option<DateTime<Utc>>,
    pub accessed_at: Option<DateTime<Utc>>,
    pub attributes: AttributeFacts,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColorStyle {
    pub foreground_color_hex: Option<String>,
    pub background_color_hex: Option<String>,
}

struct CompiledRule {
    target: ColorRuleTarget,
    expression: Expression,
    style: ColorStyle,
    case_sensitive: bool,
}

pub struct CompiledColorRules {
    rules: Vec<CompiledRule>,
    now: DateTime<Utc>,
    has_case_insensitive_rules: bool,
}

struct TextValue {
    original: String,
    lowercase: Option<String>,
}

impl TextValue {
    fn new(value: &str, include_lowercase: bool) -> Self {
        Self {
            original: value.to_owned(),
            lowercase: include_lowercase.then(|| encode_lowercase_scalars(value)),
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.original.chars().count()
    }

    fn haystack(&self, case_sensitive: bool) -> &str {
        if case_sensitive {
            &self.original
        } else {
            self.lowercase
                .as_deref()
                .expect("case-insensitive rules require normalized entry facts")
        }
    }
}

fn encode_lowercase_scalars(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len() * 2);
    for scalar in value.chars() {
        encoded.extend(scalar.to_lowercase());
        encoded.push('\0');
    }
    encoded
}

struct TextEntryFacts {
    name: TextValue,
    path: TextValue,
    extension: Option<TextValue>,
}

impl TextEntryFacts {
    fn new(facts: &EntryFacts, include_lowercase: bool) -> Self {
        Self {
            name: TextValue::new(&facts.name, include_lowercase),
            path: TextValue::new(&facts.path, include_lowercase),
            extension: facts
                .extension
                .as_deref()
                .map(|value| TextValue::new(value, include_lowercase)),
        }
    }
}

struct LocalTimeZoneSnapshot(jiff::tz::TimeZone);

impl LocalTimeZoneSnapshot {
    fn capture() -> Self {
        Self(jiff::tz::TimeZone::system())
    }

    fn day_boundary(&self, date: NaiveDate) -> Option<DateTime<Utc>> {
        let requested = jiff::civil::Date::new(
            i16::try_from(date.year()).ok()?,
            i8::try_from(date.month()).ok()?,
            i8::try_from(date.day()).ok()?,
        )
        .ok()?;
        let zoned = requested.to_zoned(self.0.clone()).ok()?;
        if zoned.date() != requested {
            return None;
        }
        let timestamp = zoned.timestamp();
        DateTime::from_timestamp(
            timestamp.as_second(),
            u32::try_from(timestamp.subsec_nanosecond()).ok()?,
        )
    }
}

impl CompiledColorRules {
    pub fn style_for(&self, facts: &EntryFacts) -> Option<ColorStyle> {
        let text_facts = TextEntryFacts::new(facts, self.has_case_insensitive_rules);
        self.rules.iter().find_map(|rule| {
            let target_matches = match rule.target {
                ColorRuleTarget::Any => true,
                ColorRuleTarget::File => facts.kind == EntryKind::File,
                ColorRuleTarget::Directory => facts.kind == EntryKind::Directory,
            };
            (target_matches
                && evaluate(&rule.expression, facts, &text_facts, self.now) == Truth::True)
                .then(|| rule.style.clone())
        })
    }
}

pub fn compile_rules(rules: &[ColorRule], now: DateTime<Utc>) -> CompiledColorRules {
    let time_zone = LocalTimeZoneSnapshot::capture();
    compile_rules_with_resolver(rules, now, |date| time_zone.day_boundary(date))
}

fn compile_rules_with_resolver(
    rules: &[ColorRule],
    now: DateTime<Utc>,
    day_boundary: impl Fn(NaiveDate) -> Option<DateTime<Utc>>,
) -> CompiledColorRules {
    let mut ordered = rules.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|rule| rule.priority);
    let mut wildcard_cache = HashMap::new();
    let rules = ordered
        .into_iter()
        .filter(|rule| {
            rule.enabled
                && (rule.foreground_color_hex.is_some() || rule.background_color_hex.is_some())
        })
        .filter_map(|rule| {
            parse_expression(&rule.expression)
                .ok()
                .map(|mut expression| {
                    resolve_date_literals(&mut expression, &day_boundary);
                    compile_text_literals(
                        &mut expression,
                        rule.case_sensitive,
                        &mut wildcard_cache,
                    );
                    CompiledRule {
                        target: rule.target.clone(),
                        expression,
                        style: ColorStyle {
                            foreground_color_hex: rule.foreground_color_hex.clone(),
                            background_color_hex: rule.background_color_hex.clone(),
                        },
                        case_sensitive: rule.case_sensitive,
                    }
                })
        })
        .collect::<Vec<_>>();
    let has_case_insensitive_rules = rules.iter().any(|rule| !rule.case_sensitive);
    CompiledColorRules {
        rules,
        now,
        has_case_insensitive_rules,
    }
}

#[cfg(test)]
fn compile_rules_with_day_boundary(
    rules: &[ColorRule],
    now: DateTime<Utc>,
    day_boundary: impl Fn(NaiveDate) -> Option<DateTime<Utc>>,
) -> CompiledColorRules {
    compile_rules_with_resolver(rules, now, day_boundary)
}

fn resolve_date_literals(
    expression: &mut Expression,
    day_boundary: &impl Fn(NaiveDate) -> Option<DateTime<Utc>>,
) {
    match expression {
        Expression::Compare(_, _, literal) => {
            let Literal::Date(date) = literal else {
                return;
            };
            let range = day_boundary(*date).zip(date.succ_opt().and_then(day_boundary));
            *literal = Literal::DateRange(range);
        }
        Expression::Not(value) => resolve_date_literals(value, day_boundary),
        Expression::And(left, right) | Expression::Or(left, right) => {
            resolve_date_literals(left, day_boundary);
            resolve_date_literals(right, day_boundary);
        }
    }
}

fn compile_text_literals(
    expression: &mut Expression,
    case_sensitive: bool,
    cache: &mut HashMap<(String, bool), CompiledWildcard>,
) {
    match expression {
        Expression::Compare(_, _, literal) => {
            let Literal::Text(pattern) = literal else {
                return;
            };
            let key = (pattern.clone(), case_sensitive);
            let compiled = cache
                .entry(key)
                .or_insert_with(|| CompiledWildcard::new(pattern, case_sensitive))
                .clone();
            *literal = Literal::Pattern(compiled);
        }
        Expression::Not(value) => compile_text_literals(value, case_sensitive, cache),
        Expression::And(left, right) | Expression::Or(left, right) => {
            compile_text_literals(left, case_sensitive, cache);
            compile_text_literals(right, case_sensitive, cache);
        }
    }
}

pub fn validate_expression(source: &str) -> ColorFilterValidationResult {
    match parse_expression(source) {
        Ok(_) => ColorFilterValidationResult {
            valid: true,
            message: None,
            span: None,
        },
        Err(error) => ColorFilterValidationResult {
            valid: false,
            message: Some(error.message),
            span: Some(ColorFilterValidationSpan {
                start: byte_to_utf16(source, error.start),
                end: byte_to_utf16(source, error.end.max(error.start)),
            }),
        },
    }
}

pub(crate) fn text_comparison_count(source: &str) -> Result<usize, String> {
    parse_expression(source)
        .map(|expression| count_text_comparisons(&expression))
        .map_err(|error| error.message)
}

fn count_text_comparisons(expression: &Expression) -> usize {
    match expression {
        Expression::Compare(
            Variable::Name | Variable::Extension | Variable::Path,
            _,
            Literal::Text(_),
        ) => 1,
        Expression::Compare(_, _, _) => 0,
        Expression::Not(value) => count_text_comparisons(value),
        Expression::And(left, right) | Expression::Or(left, right) => {
            count_text_comparisons(left) + count_text_comparisons(right)
        }
    }
}

#[derive(Debug)]
struct ParseFailure {
    message: String,
    start: usize,
    end: usize,
}

fn failure(message: impl Into<String>, start: usize, end: usize) -> ParseFailure {
    ParseFailure {
        message: message.into(),
        start,
        end,
    }
}

fn byte_to_utf16(source: &str, offset: usize) -> usize {
    let mut clamped = offset.min(source.len());
    while clamped > 0 && !source.is_char_boundary(clamped) {
        clamped -= 1;
    }
    source[..clamped].encode_utf16().count()
}

fn parse_expression(source: &str) -> Result<Expression, ParseFailure> {
    let trimmed = source.trim();
    let leading_offset = source.len() - source.trim_start().len();
    if trimmed.is_empty() {
        return Err(failure("Expression is required", 0, 0));
    }
    validate_expression_bounds(source)?;
    validate_parenthesis_depth(trimmed).map_err(|error| offset_failure(error, leading_offset))?;
    if is_shorthand(trimmed) {
        let pattern = if trimmed.starts_with('"') {
            parse_quoted_text(trimmed, 0).map_err(|error| offset_failure(error, leading_offset))?
        } else {
            encode_bare_shorthand(trimmed)
        };
        return Ok(Expression::Compare(
            Variable::Name,
            Operator::Equal,
            Literal::Text(pattern),
        ));
    }

    let pair = ExpressionParser::parse(Rule::expression, trimmed)
        .map_err(|error| {
            let (start, end) = match error.location {
                InputLocation::Pos(position) => (position, position.saturating_add(1)),
                InputLocation::Span((start, end)) => (start, end),
            };
            failure(
                format!("Invalid expression: {error}"),
                start + leading_offset,
                end + leading_offset,
            )
        })?
        .next()
        .expect("expression pair");
    let expression_pair = pair.into_inner().next().expect("or expression");
    validate_ast_depth(expression_pair.clone())
        .map_err(|error| offset_failure(error, leading_offset))?;
    build_expression(expression_pair).map_err(|error| offset_failure(error, leading_offset))
}

fn validate_expression_bounds(source: &str) -> Result<(), ParseFailure> {
    if source.chars().count() > 1024 {
        return Err(failure(
            "Expression exceeds 1024 characters",
            0,
            source.len(),
        ));
    }
    validate_token_limit(source)
}

pub fn validate_expression_storage_limits(source: &str) -> Result<(), String> {
    validate_expression_bounds(source).map_err(|error| error.message)?;
    let trimmed = source.trim();
    validate_parenthesis_depth(trimmed).map_err(|error| error.message)?;
    if trimmed.is_empty() || is_shorthand(trimmed) {
        return Ok(());
    }
    if let Ok(mut pairs) = ExpressionParser::parse(Rule::expression, trimmed) {
        let expression_pair = pairs
            .next()
            .expect("expression pair")
            .into_inner()
            .next()
            .expect("or expression");
        validate_ast_depth(expression_pair).map_err(|error| error.message)?;
    }
    Ok(())
}

fn validate_token_limit(source: &str) -> Result<(), ParseFailure> {
    const MAX_TOKENS: usize = 256;
    let bytes = source.as_bytes();
    let mut offset = 0usize;
    let mut token_count = 0usize;

    while offset < bytes.len() {
        if bytes[offset].is_ascii_whitespace() {
            offset += 1;
            continue;
        }

        let start = offset;
        match bytes[offset] {
            b'"' => {
                offset += 1;
                let mut escaped = false;
                while offset < bytes.len() {
                    let current = bytes[offset];
                    offset += 1;
                    if escaped {
                        escaped = false;
                    } else if current == b'\\' {
                        escaped = true;
                    } else if current == b'"' {
                        break;
                    }
                }
            }
            b'(' | b')' => offset += 1,
            b'=' | b'!' | b'<' | b'>' => {
                offset += 1;
                if offset < bytes.len() && bytes[offset] == b'=' {
                    offset += 1;
                }
            }
            _ => {
                offset += 1;
                while offset < bytes.len()
                    && !bytes[offset].is_ascii_whitespace()
                    && !matches!(
                        bytes[offset],
                        b'"' | b'(' | b')' | b'=' | b'!' | b'<' | b'>'
                    )
                {
                    offset += 1;
                }
            }
        }

        token_count += 1;
        if token_count > MAX_TOKENS {
            return Err(failure(
                "Expression exceeds 256 tokens",
                start,
                offset.max(start + 1),
            ));
        }
    }
    Ok(())
}

fn offset_failure(mut error: ParseFailure, offset: usize) -> ParseFailure {
    error.start += offset;
    error.end += offset;
    error
}

fn validate_parenthesis_depth(source: &str) -> Result<(), ParseFailure> {
    let mut depth = 0usize;
    let mut quoted = false;
    let mut escaped = false;
    for (offset, ch) in source.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            quoted = !quoted;
        } else if !quoted && ch == '(' {
            depth += 1;
            if depth > 24 {
                return Err(failure("Expression nesting exceeds 24", offset, offset + 1));
            }
        } else if !quoted && ch == ')' {
            depth = depth.saturating_sub(1);
        }
    }
    Ok(())
}

fn validate_ast_depth(pair: Pair<'_, Rule>) -> Result<usize, ParseFailure> {
    const MAX_AST_DEPTH: usize = 24;
    let span = pair.as_span();
    let depth = match pair.as_rule() {
        Rule::or_expression => boolean_depth(pair, Rule::or_operator)?,
        Rule::and_expression => boolean_depth(pair, Rule::and_operator)?,
        Rule::unary_expression => {
            let mut not_count = 0usize;
            let mut child_depth = 0usize;
            for child in pair.into_inner() {
                if child.as_rule() == Rule::not_operator {
                    not_count += 1;
                } else {
                    child_depth = validate_ast_depth(child)?;
                }
            }
            child_depth.saturating_add(not_count)
        }
        Rule::primary => validate_ast_depth(pair.into_inner().next().expect("primary child"))?,
        Rule::comparison => 1,
        _ => 0,
    };
    if depth > MAX_AST_DEPTH {
        return Err(failure(
            "Expression nesting exceeds 24",
            span.start(),
            span.end().max(span.start() + 1),
        ));
    }
    Ok(depth)
}

fn boolean_depth(pair: Pair<'_, Rule>, operator_rule: Rule) -> Result<usize, ParseFailure> {
    let span = pair.as_span();
    let mut children = pair.into_inner();
    let mut depth = validate_ast_depth(children.next().expect("left expression"))?;
    while let Some(operator) = children.next() {
        debug_assert_eq!(operator.as_rule(), operator_rule);
        let right_depth = validate_ast_depth(children.next().expect("right expression"))?;
        depth = depth.max(right_depth).saturating_add(1);
        if depth > 24 {
            return Err(failure(
                "Expression nesting exceeds 24",
                span.start(),
                span.end().max(span.start() + 1),
            ));
        }
    }
    Ok(depth)
}

fn is_shorthand(source: &str) -> bool {
    if source.starts_with('"') && source.ends_with('"') {
        return ExpressionParser::parse(Rule::quoted_shorthand, source).is_ok();
    }
    if source
        .chars()
        .any(|ch| ch.is_ascii_whitespace() || matches!(ch, '(' | ')' | '=' | '!' | '<' | '>'))
    {
        return false;
    }
    !matches!(
        source.to_ascii_uppercase().as_str(),
        "AND" | "OR" | "NOT" | "HAS"
    )
}

fn build_expression(pair: Pair<'_, Rule>) -> Result<Expression, ParseFailure> {
    match pair.as_rule() {
        Rule::or_expression => fold_boolean(pair, Rule::or_operator, Expression::Or),
        Rule::and_expression => fold_boolean(pair, Rule::and_operator, Expression::And),
        Rule::unary_expression => {
            let mut not_count = 0;
            let mut primary = None;
            for child in pair.into_inner() {
                if child.as_rule() == Rule::not_operator {
                    not_count += 1;
                } else {
                    primary = Some(build_expression(child)?);
                }
            }
            let mut result = primary.ok_or_else(|| failure("Missing expression", 0, 0))?;
            for _ in 0..not_count {
                result = Expression::Not(Box::new(result));
            }
            Ok(result)
        }
        Rule::primary => build_expression(pair.into_inner().next().expect("primary child")),
        Rule::comparison => build_comparison(pair),
        _ => Err(failure(
            "Unexpected expression token",
            pair.as_span().start(),
            pair.as_span().end(),
        )),
    }
}

fn fold_boolean(
    pair: Pair<'_, Rule>,
    operator_rule: Rule,
    constructor: fn(Box<Expression>, Box<Expression>) -> Expression,
) -> Result<Expression, ParseFailure> {
    let mut children = pair.into_inner();
    let mut result = build_expression(children.next().expect("left expression"))?;
    while let Some(operator) = children.next() {
        debug_assert_eq!(operator.as_rule(), operator_rule);
        let right = build_expression(children.next().expect("right expression"))?;
        result = constructor(Box::new(result), Box::new(right));
    }
    Ok(result)
}

fn build_comparison(pair: Pair<'_, Rule>) -> Result<Expression, ParseFailure> {
    let mut children = pair.into_inner();
    let variable_pair = children.next().expect("variable");
    let variable = parse_variable(&variable_pair)?;
    let operator_pair = children.next().expect("operator");
    let operator = parse_operator(operator_pair);
    let literal_pair = children.next().expect("literal");
    let literal = parse_literal(&variable, &operator, literal_pair)?;
    validate_operator(
        &variable,
        &operator,
        &literal,
        variable_pair.as_span().start(),
    )?;
    Ok(Expression::Compare(variable, operator, literal))
}

fn parse_variable(pair: &Pair<'_, Rule>) -> Result<Variable, ParseFailure> {
    let variable = match pair.as_str().to_ascii_lowercase().as_str() {
        "name" => Variable::Name,
        "extension" => Variable::Extension,
        "path" => Variable::Path,
        "size" => Variable::Size,
        "created" => Variable::Created,
        "modified" => Variable::Modified,
        "accessed" => Variable::Accessed,
        "age" => Variable::Age,
        "attributes" => Variable::Attributes,
        "type" => Variable::Type,
        _ => {
            return Err(failure(
                format!("Unknown variable: {}", pair.as_str()),
                pair.as_span().start(),
                pair.as_span().end(),
            ))
        }
    };
    Ok(variable)
}

fn parse_operator(pair: Pair<'_, Rule>) -> Operator {
    match pair.into_inner().next().expect("operator child").as_rule() {
        Rule::equal_operator => Operator::Equal,
        Rule::not_equal_operator => Operator::NotEqual,
        Rule::less_operator => Operator::Less,
        Rule::less_equal_operator => Operator::LessEqual,
        Rule::greater_operator => Operator::Greater,
        Rule::greater_equal_operator => Operator::GreaterEqual,
        Rule::has_operator => Operator::Has,
        Rule::not_has_operator => Operator::NotHas,
        _ => unreachable!("grammar limits operators"),
    }
}

fn parse_literal(
    variable: &Variable,
    _operator: &Operator,
    pair: Pair<'_, Rule>,
) -> Result<Literal, ParseFailure> {
    let inner = pair.into_inner().next().expect("literal child");
    let span = inner.as_span();
    let raw = inner.as_str();
    match variable {
        Variable::Name | Variable::Extension | Variable::Path => {
            let value = if inner.as_rule() == Rule::quoted_string {
                parse_quoted_text(raw, span.start())?
            } else {
                raw.to_string()
            };
            Ok(Literal::Text(value))
        }
        Variable::Size => parse_quantity(raw, true, span.start()),
        Variable::Age => parse_quantity(raw, false, span.start()),
        Variable::Created | Variable::Modified | Variable::Accessed => {
            let value = parse_quoted_text(raw, span.start())?;
            if let Ok(date) = NaiveDate::parse_from_str(&value, "%Y-%m-%d") {
                Ok(Literal::Date(date))
            } else {
                DateTime::parse_from_rfc3339(&value)
                    .map(|date| Literal::Timestamp(date.with_timezone(&Utc)))
                    .map_err(|_| {
                        failure(
                            "Expected ISO date or RFC3339 timestamp",
                            span.start(),
                            span.end(),
                        )
                    })
            }
        }
        Variable::Attributes => parse_attribute(raw).map(Literal::Attribute).ok_or_else(|| {
            failure(
                format!("Unknown attribute: {raw}"),
                span.start(),
                span.end(),
            )
        }),
        Variable::Type => match raw.to_ascii_lowercase().as_str() {
            "file" => Ok(Literal::Kind(EntryKind::File)),
            "directory" => Ok(Literal::Kind(EntryKind::Directory)),
            _ => Err(failure(
                format!("Unknown entry type: {raw}"),
                span.start(),
                span.end(),
            )),
        },
    }
}

fn parse_quoted_text(raw: &str, offset: usize) -> Result<String, ParseFailure> {
    if raw.len() < 2 || !raw.starts_with('"') || !raw.ends_with('"') {
        return Err(failure(
            "Expected a quoted string",
            offset,
            offset + raw.len(),
        ));
    }
    let mut result = String::new();
    let mut chars = raw[1..raw.len() - 1].chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            result.push(ch);
            continue;
        }
        let escaped = chars
            .next()
            .ok_or_else(|| failure("Incomplete escape", offset, offset + raw.len()))?;
        if !matches!(escaped, '\\' | '"' | '*' | '?') {
            return Err(failure("Unsupported escape", offset, offset + raw.len()));
        }
        if matches!(escaped, '\\' | '*' | '?') {
            result.push('\\');
        }
        result.push(escaped);
    }
    Ok(result)
}

fn encode_bare_shorthand(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            encoded.push(ch);
            continue;
        }
        match chars.peek().copied() {
            Some('*' | '?') => {
                encoded.push('\\');
                encoded.push(chars.next().expect("peeked wildcard"));
            }
            Some('\\') => {
                chars.next();
                encoded.push_str("\\\\");
            }
            Some('"') => {
                encoded.push(chars.next().expect("peeked quote"));
            }
            Some(_) | None => encoded.push_str("\\\\"),
        }
    }
    encoded
}

fn parse_quantity(raw: &str, size: bool, offset: usize) -> Result<Literal, ParseFailure> {
    let digits = raw.chars().take_while(|ch| ch.is_ascii_digit()).count();
    let value = raw[..digits]
        .parse::<u64>()
        .map_err(|_| failure("Quantity overflow", offset, offset + raw.len()))?;
    let unit = raw[digits..].to_ascii_lowercase();
    let multiplier = if size {
        match unit.as_str() {
            "b" => 1,
            "kb" => 1024,
            "mb" => 1024_u64.pow(2),
            "gb" => 1024_u64.pow(3),
            "tb" => 1024_u64.pow(4),
            _ => return Err(failure("Unknown size unit", offset, offset + raw.len())),
        }
    } else {
        match unit.as_str() {
            "m" => 60,
            "h" => 60 * 60,
            "d" => 24 * 60 * 60,
            "w" => 7 * 24 * 60 * 60,
            "y" => 365 * 24 * 60 * 60,
            _ => return Err(failure("Unknown duration unit", offset, offset + raw.len())),
        }
    };
    let scaled = value
        .checked_mul(multiplier)
        .ok_or_else(|| failure("Quantity overflow", offset, offset + raw.len()))?;
    if size {
        Ok(Literal::Bytes(scaled))
    } else {
        let seconds = i64::try_from(scaled)
            .map_err(|_| failure("Duration overflow", offset, offset + raw.len()))?;
        Ok(Literal::Duration(chrono::Duration::seconds(seconds)))
    }
}

fn parse_attribute(raw: &str) -> Option<Attribute> {
    Some(match raw.to_ascii_lowercase().as_str() {
        "file" => Attribute::File,
        "directory" => Attribute::Directory,
        "hidden" => Attribute::Hidden,
        "system" => Attribute::System,
        "protectedsystem" => Attribute::ProtectedSystem,
        "readonly" => Attribute::ReadOnly,
        "symlink" => Attribute::Symlink,
        "archive" => Attribute::Archive,
        _ => return None,
    })
}

fn validate_operator(
    variable: &Variable,
    operator: &Operator,
    literal: &Literal,
    offset: usize,
) -> Result<(), ParseFailure> {
    let valid = match variable {
        Variable::Name | Variable::Extension | Variable::Path | Variable::Type => {
            matches!(operator, Operator::Equal | Operator::NotEqual)
        }
        Variable::Size
        | Variable::Age
        | Variable::Created
        | Variable::Modified
        | Variable::Accessed => {
            matches!(
                operator,
                Operator::Equal
                    | Operator::NotEqual
                    | Operator::Less
                    | Operator::LessEqual
                    | Operator::Greater
                    | Operator::GreaterEqual
            )
        }
        Variable::Attributes => matches!(operator, Operator::Has | Operator::NotHas),
    };
    if !valid {
        return Err(failure(
            "Operator is not valid for this variable",
            offset,
            offset + 1,
        ));
    }
    let type_valid = matches!(
        (variable, literal),
        (
            Variable::Name | Variable::Extension | Variable::Path,
            Literal::Text(_)
        ) | (Variable::Size, Literal::Bytes(_))
            | (Variable::Age, Literal::Duration(_))
            | (
                Variable::Created | Variable::Modified | Variable::Accessed,
                Literal::Timestamp(_) | Literal::Date(_) | Literal::DateRange(_)
            )
            | (Variable::Attributes, Literal::Attribute(_))
            | (Variable::Type, Literal::Kind(_))
    );
    type_valid
        .then_some(())
        .ok_or_else(|| failure("Literal type does not match variable", offset, offset + 1))
}

fn evaluate(
    expression: &Expression,
    facts: &EntryFacts,
    text_facts: &TextEntryFacts,
    now: DateTime<Utc>,
) -> Truth {
    match expression {
        Expression::Not(value) => evaluate(value, facts, text_facts, now).not(),
        Expression::And(left, right) => {
            evaluate(left, facts, text_facts, now).and(evaluate(right, facts, text_facts, now))
        }
        Expression::Or(left, right) => {
            evaluate(left, facts, text_facts, now).or(evaluate(right, facts, text_facts, now))
        }
        Expression::Compare(variable, operator, literal) => {
            evaluate_comparison(variable, operator, literal, facts, text_facts, now)
        }
    }
}

fn evaluate_comparison(
    variable: &Variable,
    operator: &Operator,
    literal: &Literal,
    facts: &EntryFacts,
    text_facts: &TextEntryFacts,
    now: DateTime<Utc>,
) -> Truth {
    match (variable, literal) {
        (Variable::Name, Literal::Pattern(pattern)) => {
            compare_text(Some(&text_facts.name), pattern, operator)
        }
        (Variable::Extension, Literal::Pattern(pattern)) => {
            compare_text(text_facts.extension.as_ref(), pattern, operator)
        }
        (Variable::Path, Literal::Pattern(pattern)) => {
            compare_text(Some(&text_facts.path), pattern, operator)
        }
        (Variable::Size, Literal::Bytes(value)) => compare_ordered(facts.size, *value, operator),
        (Variable::Age, Literal::Duration(value)) => {
            let age = facts
                .modified_at
                .filter(|modified| *modified <= now)
                .map(|modified| now - modified);
            compare_ordered(age, *value, operator)
        }
        (Variable::Created, literal) => compare_date(facts.created_at, literal, operator),
        (Variable::Modified, literal) => compare_date(facts.modified_at, literal, operator),
        (Variable::Accessed, literal) => compare_date(facts.accessed_at, literal, operator),
        (Variable::Type, Literal::Kind(kind)) => compare_equal(Some(facts.kind == *kind), operator),
        (Variable::Attributes, Literal::Attribute(attribute)) => {
            let value = attribute_value(*attribute, facts);
            match operator {
                Operator::Has => value.map_or(Truth::Unknown, Truth::from),
                Operator::NotHas => value.map_or(Truth::Unknown, |value| Truth::from(!value)),
                _ => Truth::Unknown,
            }
        }
        _ => Truth::Unknown,
    }
}

impl From<bool> for Truth {
    fn from(value: bool) -> Self {
        if value {
            Self::True
        } else {
            Self::False
        }
    }
}

fn attribute_value(attribute: Attribute, facts: &EntryFacts) -> Option<bool> {
    match attribute {
        Attribute::File => Some(facts.kind == EntryKind::File),
        Attribute::Directory => Some(facts.kind == EntryKind::Directory),
        Attribute::Hidden => facts.attributes.hidden,
        Attribute::System => facts.attributes.system,
        Attribute::ProtectedSystem => facts.attributes.protected_system,
        Attribute::ReadOnly => facts.attributes.read_only,
        Attribute::Symlink => facts.attributes.symlink,
        Attribute::Archive => facts.attributes.archive,
    }
}

fn compare_text(
    value: Option<&TextValue>,
    pattern: &CompiledWildcard,
    operator: &Operator,
) -> Truth {
    let Some(value) = value else {
        return Truth::Unknown;
    };
    let matched = pattern.matches(value);
    compare_equal(Some(matched), operator)
}

fn compare_equal(value: Option<bool>, operator: &Operator) -> Truth {
    match (value, operator) {
        (Some(value), Operator::Equal) => Truth::from(value),
        (Some(value), Operator::NotEqual) => Truth::from(!value),
        _ => Truth::Unknown,
    }
}

fn compare_ordered<T: Ord + Copy>(left: Option<T>, right: T, operator: &Operator) -> Truth {
    let Some(left) = left else {
        return Truth::Unknown;
    };
    Truth::from(match operator {
        Operator::Equal => left == right,
        Operator::NotEqual => left != right,
        Operator::Less => left < right,
        Operator::LessEqual => left <= right,
        Operator::Greater => left > right,
        Operator::GreaterEqual => left >= right,
        _ => return Truth::Unknown,
    })
}

fn compare_date(value: Option<DateTime<Utc>>, literal: &Literal, operator: &Operator) -> Truth {
    match literal {
        Literal::Timestamp(timestamp) => compare_ordered(value, *timestamp, operator),
        Literal::DateRange(range) => {
            let Some(value) = value else {
                return Truth::Unknown;
            };
            let Some((start, next)) = range else {
                return Truth::Unknown;
            };
            Truth::from(match operator {
                Operator::Equal => value >= *start && value < *next,
                Operator::NotEqual => value < *start || value >= *next,
                Operator::Less => value < *start,
                Operator::LessEqual => value < *next,
                Operator::Greater => value >= *next,
                Operator::GreaterEqual => value >= *start,
                _ => return Truth::Unknown,
            })
        }
        _ => Truth::Unknown,
    }
}

const MAX_DENSE_WILDCARD_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug)]
enum WildcardDfa {
    Dense(dense::DFA<Vec<u32>>),
    Sparse(sparse::DFA<Vec<u8>>),
}

#[derive(Debug, Clone)]
struct CompiledWildcard {
    source: String,
    automaton: Arc<WildcardDfa>,
    case_sensitive: bool,
}

impl CompiledWildcard {
    fn new(pattern: &str, case_sensitive: bool) -> Self {
        let mut expression = String::from(r"\A");
        let mut chars = pattern.chars();
        while let Some(ch) = chars.next() {
            match ch {
                '\\' => push_regex_literal(
                    &mut expression,
                    chars.next().unwrap_or('\\'),
                    case_sensitive,
                ),
                '*' if case_sensitive => expression.push_str(r"(?s:.*)"),
                '*' => expression.push_str(r"(?:[^\x00]*\x00)*"),
                '?' if case_sensitive => expression.push_str(r"(?s:.)"),
                '?' => expression.push_str(r"(?:[^\x00]*\x00)"),
                literal => push_regex_literal(&mut expression, literal, case_sensitive),
            }
        }
        expression.push_str(r"\z");
        let dense = dense::DFA::new(&expression).expect("escaped wildcard must compile into a DFA");
        let automaton = if dense.memory_usage() <= MAX_DENSE_WILDCARD_BYTES {
            WildcardDfa::Dense(dense)
        } else {
            WildcardDfa::Sparse(
                dense
                    .to_sparse()
                    .expect("compiled wildcard must convert to a sparse DFA"),
            )
        };
        Self {
            source: pattern.to_owned(),
            automaton: Arc::new(automaton),
            case_sensitive,
        }
    }

    fn matches(&self, value: &TextValue) -> bool {
        let haystack = value.haystack(self.case_sensitive).as_bytes();
        let input = Input::new(haystack).anchored(Anchored::Yes);
        match self.automaton.as_ref() {
            WildcardDfa::Dense(automaton) => automaton
                .try_search_fwd(&input)
                .expect("wildcard DFA search must be valid")
                .is_some(),
            WildcardDfa::Sparse(automaton) => automaton
                .try_search_fwd(&input)
                .expect("wildcard DFA search must be valid")
                .is_some(),
        }
    }

    #[cfg(test)]
    fn matches_with_work(&self, value: &TextValue) -> (bool, usize) {
        let haystack = value.haystack(self.case_sensitive).as_bytes();
        (self.matches(value), haystack.len() + 1)
    }

    #[cfg(test)]
    fn matches_with_work_for_test(&self, value: &TextValue) -> (bool, usize) {
        self.matches_with_work(value)
    }

    #[cfg(test)]
    fn storage_units_for_test(&self) -> usize {
        self.source.len()
            + match self.automaton.as_ref() {
                WildcardDfa::Dense(automaton) => automaton.memory_usage(),
                WildcardDfa::Sparse(automaton) => automaton.memory_usage(),
            }
    }

    #[cfg(test)]
    fn uses_dense_dfa_for_test(&self) -> bool {
        matches!(self.automaton.as_ref(), WildcardDfa::Dense(_))
    }
}

impl PartialEq for CompiledWildcard {
    fn eq(&self, other: &Self) -> bool {
        self.source == other.source && self.case_sensitive == other.case_sensitive
    }
}

fn push_regex_literal(expression: &mut String, value: char, case_sensitive: bool) {
    if case_sensitive {
        expression.push_str(&regex::escape(&value.to_string()));
    } else {
        let mut encoded = value.to_lowercase().collect::<String>();
        encoded.push('\0');
        expression.push_str(&regex::escape(&encoded));
    }
}

#[cfg(test)]
mod persistence_tests;
#[cfg(test)]
mod tests;

use std::collections::HashSet;

use serde::{ser::Error as _, Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::domain::color_filter::{color_rule_schema_version, ColorRule, ColorRuleTarget};

use super::{
    text_comparison_count, MAX_COLOR_FILTER_TEXT_SCAN_BUDGET, MAX_COLOR_RULE_COUNT,
    MAX_COLOR_RULE_NAME_SCALARS,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2Row {
    #[serde(default)]
    schema_version: Option<u32>,
    id: String,
    name: String,
    enabled: bool,
    target: ColorRuleTarget,
    expression: String,
    #[serde(default)]
    case_sensitive: bool,
    #[serde(default)]
    foreground_color_hex: Option<String>,
    #[serde(default)]
    background_color_hex: Option<String>,
    #[serde(default)]
    priority: u32,
    #[serde(default)]
    migration_diagnostic: Option<String>,
    #[serde(default)]
    migration_source: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyRow {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    target: Option<ColorRuleTarget>,
    mode: String,
    #[serde(default)]
    pattern: Option<String>,
    #[serde(default)]
    color_hex: String,
    #[serde(default)]
    priority: u32,
}

struct MigratedRow {
    rule: ColorRule,
    raw: Value,
    original_index: usize,
    preserve_original_id: bool,
}

pub fn deserialize_rules<'de, D>(deserializer: D) -> Result<Vec<ColorRule>, D::Error>
where
    D: Deserializer<'de>,
{
    let mut raw_rows = Vec::<Value>::deserialize(deserializer)?;
    let overflow = (raw_rows.len() > MAX_COLOR_RULE_COUNT)
        .then(|| raw_rows.split_off(MAX_COLOR_RULE_COUNT - 1));
    let mut rows = raw_rows
        .into_iter()
        .enumerate()
        .map(|(index, value)| migrated_row(value, index))
        .collect::<Vec<_>>();
    if let Some(overflow) = overflow {
        let source = Value::Array(overflow);
        let original_index = MAX_COLOR_RULE_COUNT - 1;
        rows.push(MigratedRow {
            rule: diagnostic_rule(
                source.clone(),
                original_index,
                None,
                Some("Additional color rules".into()),
                &format!("Color rule count exceeds {MAX_COLOR_RULE_COUNT}"),
            ),
            raw: source,
            original_index,
            preserve_original_id: false,
        });
    }
    let mut original_ids = HashSet::new();
    for row in &mut rows {
        let original_id = row
            .raw
            .as_object()
            .and_then(|value| value.get("id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        row.preserve_original_id =
            original_id.is_some_and(|id| original_ids.insert(id.to_string()));
    }
    enforce_text_scan_budget(&mut rows);
    normalize_identity_and_order(&mut rows);
    Ok(rows.into_iter().map(|row| row.rule).collect())
}

fn enforce_text_scan_budget(rows: &mut [MigratedRow]) {
    let mut total = 0_usize;
    for row in rows {
        if !row.rule.enabled {
            continue;
        }
        let Ok(cost) = text_comparison_count(&row.rule.expression) else {
            continue;
        };
        if total + cost <= MAX_COLOR_FILTER_TEXT_SCAN_BUDGET {
            total += cost;
            continue;
        }
        let message = format!(
            "Enabled Name/Extension/Path comparisons exceed the aggregate limit of {MAX_COLOR_FILTER_TEXT_SCAN_BUDGET}"
        );
        row.rule.enabled = false;
        row.rule.schema_version = 0;
        row.rule.migration_diagnostic = Some(match row.rule.migration_diagnostic.take() {
            Some(existing) => format!("{existing}; {message}"),
            None => message,
        });
        row.rule.migration_source = Some(row.raw.clone());
    }
}

fn migrated_row(value: Value, index: usize) -> MigratedRow {
    let mut rule = migrate_row(value.clone(), index);
    if rule.name.trim().chars().count() > MAX_COLOR_RULE_NAME_SCALARS {
        rule.name = rule
            .name
            .trim()
            .chars()
            .take(MAX_COLOR_RULE_NAME_SCALARS)
            .collect();
        rule.enabled = false;
        rule.schema_version = 0;
        rule.migration_diagnostic = Some(format!(
            "Color rule name exceeds {MAX_COLOR_RULE_NAME_SCALARS} characters"
        ));
        rule.migration_source = Some(value.clone());
    }
    MigratedRow {
        rule,
        raw: value,
        original_index: index,
        preserve_original_id: false,
    }
}

pub fn serialize_rules<S>(rules: &[ColorRule], serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    let rows = rules
        .iter()
        .map(|rule| {
            let mut value = serde_json::to_value(rule).map_err(S::Error::custom)?;
            if let (Some(object), Some(source)) = (value.as_object_mut(), &rule.migration_source) {
                object.insert("migrationSource".into(), source.clone());
            }
            Ok(value)
        })
        .collect::<Result<Vec<_>, S::Error>>()?;
    rows.serialize(serializer)
}

fn migrate_row(value: Value, index: usize) -> ColorRule {
    let object = value.as_object();
    let explicit_version = object.and_then(|row| row.get("schemaVersion"));
    let is_versioned = explicit_version.is_some();
    let recoverable_id = object
        .and_then(|row| row.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let recoverable_name = object
        .and_then(|row| row.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let ignored_legacy_fields = object
        .map(|row| {
            ["mode", "pattern", "colorHex"]
                .into_iter()
                .filter(|key| row.contains_key(*key))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let has_v2_key = object.is_some_and(|row| {
        [
            "enabled",
            "expression",
            "caseSensitive",
            "foregroundColorHex",
            "backgroundColorHex",
            "migrationDiagnostic",
        ]
        .iter()
        .any(|key| row.contains_key(*key))
    });

    if explicit_version.is_some() || has_v2_key {
        return match serde_json::from_value::<V2Row>(value.clone()) {
            Ok(row) if row.schema_version.unwrap_or(2) == 2 => {
                migrate_v2(row, value, index, is_versioned, &ignored_legacy_fields)
            }
            Ok(row) => diagnostic_rule(
                value,
                index,
                Some(row.id),
                Some(row.name),
                "Unsupported color rule schemaVersion",
            ),
            Err(error) => diagnostic_rule(
                value,
                index,
                recoverable_id,
                recoverable_name,
                &format!("Invalid V2 color rule: {error}"),
            ),
        };
    }

    if object.is_some_and(|row| {
        row.contains_key("mode") || row.contains_key("pattern") || row.contains_key("colorHex")
    }) {
        return match serde_json::from_value::<LegacyRow>(value.clone()) {
            Ok(row) => migrate_legacy(row, value, index),
            Err(error) => diagnostic_rule(
                value,
                index,
                None,
                None,
                &format!("Invalid legacy color rule: {error}"),
            ),
        };
    }

    diagnostic_rule(value, index, None, None, "Unknown legacy color rule")
}

fn migrate_legacy(row: LegacyRow, source: Value, index: usize) -> ColorRule {
    let pattern = row.pattern.unwrap_or_default();
    let escaped = escape_expression_literal(&pattern);
    let expression = match row.mode.to_ascii_lowercase().as_str() {
        "extension" => {
            let suffix = pattern.trim_start_matches('.');
            if suffix.is_empty() {
                "Extension == \"\"".into()
            } else {
                format!("Extension == \".{}\"", escape_expression_literal(suffix))
            }
        }
        "namecontains" => format!("Name == \"*{escaped}*\""),
        "pathcontains" => format!("Path == \"*{escaped}*\""),
        "hidden" => "Attributes HAS Hidden".into(),
        "readonly" => "Attributes HAS ReadOnly".into(),
        _ => {
            return diagnostic_rule(
                source,
                index,
                Some(row.id),
                Some(row.name),
                "Unknown legacy color rule mode",
            )
        }
    };
    if let Err(message) = super::validate_expression_storage_limits(&expression) {
        let mut diagnostic = diagnostic_rule(source, index, Some(row.id), Some(row.name), &message);
        diagnostic.migration_source = None;
        return diagnostic;
    }
    let color = canonical_color(Some(row.color_hex));
    if color.is_none() {
        return diagnostic_rule(
            source,
            index,
            Some(row.id),
            Some(row.name),
            "Invalid legacy color",
        );
    }
    ColorRule {
        schema_version: 1,
        id: row.id,
        name: row.name,
        enabled: true,
        target: row.target.unwrap_or(ColorRuleTarget::Any),
        expression,
        case_sensitive: false,
        foreground_color_hex: color,
        background_color_hex: None,
        priority: row.priority,
        migration_diagnostic: None,
        migration_source: None,
    }
}

fn migrate_v2(
    row: V2Row,
    source: Value,
    index: usize,
    versioned: bool,
    ignored_legacy_fields: &[&str],
) -> ColorRule {
    if let Err(message) = super::validate_expression_storage_limits(&row.expression) {
        let foreground = canonical_color(row.foreground_color_hex.clone());
        let background = canonical_color(row.background_color_hex.clone());
        let mut diagnostic =
            diagnostic_v2_rule(row, source, index, foreground, background, &message);
        diagnostic.expression.clear();
        diagnostic.migration_source = None;
        return diagnostic;
    }
    let foreground = canonical_color(row.foreground_color_hex.clone());
    if row.foreground_color_hex.is_some() && foreground.is_none() {
        let background = canonical_color(row.background_color_hex.clone());
        return diagnostic_v2_rule(
            row,
            source,
            index,
            None,
            background,
            "Invalid foregroundColorHex",
        );
    }
    let background = canonical_color(row.background_color_hex.clone());
    if row.background_color_hex.is_some() && background.is_none() {
        return diagnostic_v2_rule(
            row,
            source,
            index,
            foreground,
            None,
            "Invalid backgroundColorHex",
        );
    }
    if row.enabled {
        let validation = super::validate_expression(&row.expression);
        if !validation.valid {
            let message = validation
                .message
                .unwrap_or_else(|| "Invalid expression".into());
            return diagnostic_v2_rule(row, source, index, foreground, background, &message);
        }
        if foreground.is_none() && background.is_none() {
            return diagnostic_v2_rule(
                row,
                source,
                index,
                foreground,
                background,
                "Enabled rule requires a color",
            );
        }
    }
    ColorRule {
        schema_version: if versioned { 2 } else { 1 },
        id: row.id,
        name: row.name,
        enabled: row.enabled,
        target: row.target,
        expression: row.expression,
        case_sensitive: row.case_sensitive,
        foreground_color_hex: foreground,
        background_color_hex: background,
        priority: row.priority,
        migration_diagnostic: if ignored_legacy_fields.is_empty() {
            row.migration_diagnostic
        } else {
            let compatibility = format!(
                "Ignored legacy fields because V2 fields take precedence: {}",
                ignored_legacy_fields.join(", ")
            );
            Some(match row.migration_diagnostic {
                Some(existing) => format!("{existing}; {compatibility}"),
                None => compatibility,
            })
        },
        migration_source: row.migration_source,
    }
}

fn diagnostic_v2_rule(
    row: V2Row,
    source: Value,
    index: usize,
    foreground_color_hex: Option<String>,
    background_color_hex: Option<String>,
    message: &str,
) -> ColorRule {
    ColorRule {
        schema_version: 0,
        id: if row.id.trim().is_empty() {
            stable_diagnostic_id(&source, index)
        } else {
            row.id
        },
        name: if row.name.trim().is_empty() {
            format!("未命名规则 {}", index + 1)
        } else {
            row.name
        },
        enabled: false,
        target: row.target,
        expression: row.expression,
        case_sensitive: row.case_sensitive,
        foreground_color_hex,
        background_color_hex,
        priority: row.priority,
        migration_diagnostic: Some(message.into()),
        migration_source: Some(source),
    }
}

fn diagnostic_rule(
    source: Value,
    index: usize,
    id: Option<String>,
    name: Option<String>,
    message: &str,
) -> ColorRule {
    ColorRule {
        schema_version: 0,
        id: id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| stable_diagnostic_id(&source, index)),
        name: name
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("未命名规则 {}", index + 1)),
        enabled: false,
        target: ColorRuleTarget::Any,
        expression: String::new(),
        case_sensitive: false,
        foreground_color_hex: None,
        background_color_hex: None,
        priority: index as u32 + 1,
        migration_diagnostic: Some(message.into()),
        migration_source: Some(source),
    }
}

fn stable_diagnostic_id(source: &Value, index: usize) -> String {
    stable_replacement_id(source, index, 0)
}

fn stable_replacement_id(source: &Value, original_index: usize, attempt: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(source).unwrap_or_default());
    hasher.update(original_index.to_le_bytes());
    if attempt > 0 {
        hasher.update(attempt.to_le_bytes());
    }
    let digest = format!("{:x}", hasher.finalize());
    format!("legacy-{}", &digest[..12])
}

fn normalize_identity_and_order(rows: &mut Vec<MigratedRow>) {
    rows.sort_by(|left, right| {
        left.rule
            .priority
            .cmp(&right.rule.priority)
            .then(left.rule.name.cmp(&right.rule.name))
    });
    let reserved_ids = rows
        .iter()
        .filter(|row| row.preserve_original_id)
        .map(|row| row.rule.id.trim().to_string())
        .collect::<HashSet<_>>();
    let mut ids = reserved_ids;
    let mut names = HashSet::new();
    for (index, row) in rows.iter_mut().enumerate() {
        let rule = &mut row.rule;
        if row.preserve_original_id {
            rule.id = rule.id.trim().to_string();
        } else {
            let mut attempt = 0;
            loop {
                let candidate = stable_replacement_id(&row.raw, row.original_index, attempt);
                if ids.insert(candidate.clone()) {
                    rule.id = candidate;
                    break;
                }
                attempt += 1;
            }
        }
        let mut name = rule.name.trim().to_string();
        if name.is_empty() {
            name = format!("未命名规则 {}", index + 1);
        }
        name = name.chars().take(MAX_COLOR_RULE_NAME_SCALARS).collect();
        let base = name.clone();
        let mut suffix = 2;
        while !names.insert(name.to_lowercase()) {
            let suffix_text = format!(" {suffix}");
            let base_limit =
                MAX_COLOR_RULE_NAME_SCALARS.saturating_sub(suffix_text.chars().count());
            name = format!(
                "{}{}",
                base.chars().take(base_limit).collect::<String>(),
                suffix_text
            );
            suffix += 1;
        }
        rule.name = name;
        rule.priority = index as u32 + 1;
    }
}

fn canonical_color(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (trimmed.len() == 7
            && trimmed.starts_with('#')
            && trimmed[1..].chars().all(|ch| ch.is_ascii_hexdigit()))
        .then(|| trimmed.to_ascii_lowercase())
    })
}

fn escape_expression_literal(value: &str) -> String {
    value
        .chars()
        .flat_map(|ch| match ch {
            '\\' | '"' | '*' | '?' => vec!['\\', ch],
            _ => vec![ch],
        })
        .collect()
}

pub fn rules_need_migration(rules: &[ColorRule]) -> bool {
    rules
        .iter()
        .any(|rule| rule.schema_version != color_rule_schema_version())
}

pub fn canonicalize_rules(rules: &mut [ColorRule]) {
    for rule in rules {
        rule.schema_version = color_rule_schema_version();
    }
}

pub fn deserialize_revision<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    match value.as_str() {
        Some(value) if is_canonical_revision(value) => Ok(value.into()),
        _ => Ok("0".into()),
    }
}

pub fn is_canonical_revision(value: &str) -> bool {
    (value == "0" || (!value.starts_with('0') && value.chars().all(|ch| ch.is_ascii_digit())))
        && value.parse::<u64>().is_ok()
}

pub fn revision_value_was_canonical(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(is_canonical_revision)
}

pub fn increment_revision(value: &mut String) -> anyhow::Result<()> {
    let next = value
        .parse::<u64>()
        .map_err(|_| anyhow::anyhow!("invalid color-filter revision"))?
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("color-filter revision overflow"))?;
    *value = next.to_string();
    Ok(())
}

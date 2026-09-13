use std::{cell::Cell, time::Instant};

use chrono::{FixedOffset, LocalResult, NaiveDate, TimeZone, Utc};

use super::{
    compile_rules, compile_rules_with_day_boundary, text_comparison_count, validate_expression,
    validate_expression_storage_limits, AttributeFacts, CompiledWildcard, EntryFacts,
    LocalTimeZoneSnapshot, TextValue,
};
use crate::domain::color_filter::{ColorFilterValidationSpan, ColorRule, ColorRuleTarget};
use crate::domain::models::EntryKind;

fn rule(id: &str, expression: &str, foreground: &str, priority: u32) -> ColorRule {
    ColorRule {
        schema_version: 2,
        id: id.into(),
        name: id.into(),
        enabled: true,
        target: ColorRuleTarget::Any,
        expression: expression.into(),
        case_sensitive: false,
        foreground_color_hex: Some(foreground.into()),
        background_color_hex: None,
        priority,
        migration_diagnostic: None,
        migration_source: None,
    }
}

fn file_facts(name: &str) -> EntryFacts {
    EntryFacts {
        name: name.into(),
        path: format!("C:\\work\\{name}"),
        extension: name
            .rsplit_once('.')
            .map(|(_, suffix)| format!(".{suffix}")),
        kind: EntryKind::File,
        size: Some(25 * 1024 * 1024),
        created_at: None,
        modified_at: Some(Utc.with_ymd_and_hms(2026, 8, 1, 0, 0, 0).unwrap()),
        accessed_at: None,
        attributes: AttributeFacts::all_known(false),
    }
}

#[test]
fn shorthand_wildcards_and_compound_size_rules_match() {
    let now = Utc.with_ymd_and_hms(2026, 9, 7, 0, 0, 0).unwrap();
    let compiled = compile_rules(
        &[
            rule("personal", "*个人*", "#ffffff", 2),
            rule(
                "large-text",
                "Size >= 20MB AND Extension == \".txt\"",
                "#101010",
                1,
            ),
        ],
        now,
    );

    let style = compiled
        .style_for(&file_facts("个人资料.txt"))
        .expect("matching style");
    assert_eq!(style.foreground_color_hex.as_deref(), Some("#101010"));
    assert_eq!(style.background_color_hex, None);
    assert_eq!(
        compile_rules(&[rule("personal", "*个人*", "#ffffff", 1)], now)
            .style_for(&file_facts("我的个人文档.doc"))
            .expect("matching style")
            .foreground_color_hex
            .as_deref(),
        Some("#ffffff")
    );
}

#[test]
fn unavailable_attributes_remain_unknown_through_negation() {
    let now = Utc.with_ymd_and_hms(2026, 9, 7, 0, 0, 0).unwrap();
    let mut facts = file_facts("report.txt");
    facts.attributes.read_only = None;

    for expression in [
        "Attributes HAS ReadOnly",
        "Attributes NOT HAS ReadOnly",
        "NOT (Attributes HAS ReadOnly)",
    ] {
        assert_eq!(
            compile_rules(&[rule("unknown", expression, "#ffffff", 1)], now).style_for(&facts),
            None,
            "{expression} must not match an unavailable fact"
        );
    }

    assert_eq!(
        compile_rules(
            &[rule(
                "kleene",
                "Attributes HAS ReadOnly OR Type == File",
                "#ffffff",
                1,
            )],
            now,
        )
        .style_for(&facts)
        .expect("known true branch should match")
        .foreground_color_hex
        .as_deref(),
        Some("#ffffff")
    );
}

#[test]
fn directory_size_is_unknown_and_age_uses_the_fixed_clock() {
    let now = Utc.with_ymd_and_hms(2026, 9, 7, 0, 0, 0).unwrap();
    let mut directory = file_facts("archive");
    directory.kind = EntryKind::Directory;
    directory.extension = None;
    directory.size = None;

    assert_eq!(
        compile_rules(&[rule("size", "Size >= 1B", "#ffffff", 1)], now).style_for(&directory),
        None
    );
    assert_eq!(
        compile_rules(&[rule("age", "Age >= 30d", "#ffffff", 1)], now)
            .style_for(&file_facts("old.log"))
            .expect("age should match")
            .foreground_color_hex
            .as_deref(),
        Some("#ffffff")
    );
}

#[test]
fn validation_reports_utf16_spans_after_non_ascii_text() {
    let result = validate_expression("Name == \"个人\" AND Szie >= 20MB");
    assert!(!result.valid);
    let span = result.span.expect("validation span");
    assert_eq!(span.start, "Name == \"个人\" AND ".encode_utf16().count());
    assert_eq!(span.end, span.start + "Szie".encode_utf16().count());
    assert!(result.message.unwrap_or_default().contains("Szie"));
}

#[test]
fn validation_spans_include_leading_whitespace() {
    let source = "  Name == \"个人\" AND Szie >= 20MB";
    let result = validate_expression(source);
    assert!(!result.valid);
    let span = result.span.expect("validation span");
    assert_eq!(span.start, "  Name == \"个人\" AND ".encode_utf16().count());
    assert_eq!(span.end, span.start + "Szie".encode_utf16().count());
}

#[test]
fn malformed_quoted_shorthand_is_rejected() {
    let result = validate_expression("\"foo\" OR \"bar\"");
    assert!(!result.valid);
}

#[test]
fn validation_enforces_the_256_token_limit() {
    fn balanced_or(count: usize) -> String {
        if count == 1 {
            return "Name==x".into();
        }
        let left = count / 2;
        format!("({} OR {})", balanced_or(left), balanced_or(count - left))
    }

    let within_limit = balanced_or(43);
    assert!(validate_expression(&within_limit).valid);

    let over_limit = format!("({within_limit} OR Name==x)");
    let result = validate_expression(&over_limit);
    assert!(!result.valid);
    assert!(result
        .message
        .as_deref()
        .is_some_and(|message| message.contains("256 tokens")));
    assert!(result.span.is_some_and(|span| span.start < span.end));
}

#[test]
fn quoted_windows_paths_and_escaped_wildcards_preserve_literal_characters() {
    let now = Utc.with_ymd_and_hms(2026, 9, 7, 0, 0, 0).unwrap();
    let mut facts = file_facts("report.txt");
    facts.path = r"C:\work\Archive\report.txt".into();

    for expression in [
        r#"Path == "*\\Archive\\*""#,
        r#"Path == "C:\\work\\Archive\\report.txt""#,
    ] {
        assert!(
            compile_rules(&[rule("path", expression, "#ffffff", 1)], now)
                .style_for(&facts)
                .is_some(),
            "{expression} should match a Windows path"
        );
    }

    for (expression, name, non_match) in [
        (r#"Name == "report\*.txt""#, "report*.txt", "report1.txt"),
        (r#"Name == "report\?.txt""#, "report?.txt", "report1.txt"),
        (
            r#"Name == "\"quoted\".txt""#,
            "\"quoted\".txt",
            "quoted.txt",
        ),
        (
            r#"Name == "folder\\file.txt""#,
            r"folder\file.txt",
            "folder-file.txt",
        ),
    ] {
        assert!(
            compile_rules(&[rule("literal", expression, "#ffffff", 1)], now)
                .style_for(&file_facts(name))
                .is_some(),
            "{expression} should preserve its escaped literal"
        );
        assert!(
            compile_rules(&[rule("literal", expression, "#ffffff", 1)], now)
                .style_for(&file_facts(non_match))
                .is_none(),
            "{expression} should not turn an escaped literal into a wildcard"
        );
    }
}

#[test]
fn bare_shorthand_preserves_wildcard_escapes_and_windows_separators() {
    let now = Utc.with_ymd_and_hms(2026, 9, 7, 0, 0, 0).unwrap();
    for (expression, matching, non_matching) in [
        (r"report\*.txt", "report*.txt", "report1.txt"),
        (r"report\?.txt", "report?.txt", "report1.txt"),
        ("report*.txt", "report-final.txt", "notes.txt"),
        ("report?.txt", "report1.txt", "report-final.txt"),
        (r"folder\file.txt", r"folder\file.txt", "folder-file.txt"),
        (r"folder\\file.txt", r"folder\file.txt", "folder-file.txt"),
    ] {
        let compiled = compile_rules(&[rule("bare", expression, "#ffffff", 1)], now);
        assert!(
            compiled.style_for(&file_facts(matching)).is_some(),
            "{expression} should match {matching}"
        );
        assert!(
            compiled.style_for(&file_facts(non_matching)).is_none(),
            "{expression} should not match {non_matching}"
        );
    }
}

#[test]
fn compiled_wildcards_handle_anchored_overlapping_and_multi_star_segments() {
    let now = Utc.with_ymd_and_hms(2026, 9, 7, 0, 0, 0).unwrap();
    for (expression, matching, non_matching) in [
        ("a*ab", "aaab", "aaba"),
        ("*aba*ba", "abacaba", "abab"),
        ("ab?d*ef", "abXd-middle-ef", "abXd-middle-eg"),
        ("*ba???b*b", "aabacbaccbbab", "aabacbaccbaab"),
        ("*Ä?*", "prefix-äx-suffix", "prefix-aex-suffix"),
    ] {
        let compiled = compile_rules(&[rule("glob", expression, "#ffffff", 1)], now);
        assert!(
            compiled.style_for(&file_facts(matching)).is_some(),
            "{expression} should match {matching}"
        );
        assert!(
            compiled.style_for(&file_facts(non_matching)).is_none(),
            "{expression} should not match {non_matching}"
        );
    }
}

#[test]
fn case_insensitive_wildcards_preserve_original_unicode_scalar_boundaries() {
    let now = Utc.with_ymd_and_hms(2026, 9, 7, 0, 0, 0).unwrap();
    for (expression, matching, non_matching) in [
        ("Name == \"\u{0130}\"", "\u{0130}", "i\u{0307}"),
        ("?", "\u{0130}", "ix"),
        ("??", "\u{0130}x", "\u{0130}"),
        (
            "*start*left-??-right*end*",
            "pre-start-mid-left-\u{0130}x-right-tail-end-post",
            "pre-start-mid-left-\u{0130}-right-tail-end-post",
        ),
    ] {
        let compiled = compile_rules(&[rule("unicode", expression, "#ffffff", 1)], now);
        assert!(
            compiled.style_for(&file_facts(matching)).is_some(),
            "{expression} should count each original Unicode scalar once"
        );
        assert!(
            compiled.style_for(&file_facts(non_matching)).is_none(),
            "{expression} should preserve wildcard scalar cardinality"
        );
    }
}

#[test]
fn compiled_wildcard_search_has_linear_work_and_storage_bounds() {
    let literal = (0..1024)
        .map(|index| char::from_u32(0x400 + index).unwrap())
        .collect::<String>();
    let wildcard = CompiledWildcard::new(&format!("*{literal}z*"), false);
    let value = TextValue::new(&format!("{literal}{literal}"), true);

    let (matched, work) = wildcard.matches_with_work_for_test(&value);
    assert!(!matched);
    assert!(
        work <= 4 * (literal.chars().count() * 2 + 1),
        "wildcard search performed {work} transitions"
    );
    let wildcard_storage = wildcard.storage_units_for_test();
    let shorter_literal = literal.chars().take(512).collect::<String>();
    let shorter_storage =
        CompiledWildcard::new(&format!("*{shorter_literal}z*"), false).storage_units_for_test();
    assert!(
        wildcard_storage <= 4096 * (literal.chars().count() + 1),
        "compiled wildcard storage ({wildcard_storage}) must stay linear for distinct literals"
    );
    assert!(
        wildcard_storage <= shorter_storage * 3,
        "doubling the wildcard grew storage from {shorter_storage} to {wildcard_storage}"
    );

    let mixed_pattern = format!("*?{}z*", literal.chars().take(1022).collect::<String>());
    let mixed = CompiledWildcard::new(&mixed_pattern, false);
    let mixed_value = TextValue::new(&format!("{}x", literal.repeat(2)), true);
    let (mixed_matched, mixed_work) = mixed.matches_with_work_for_test(&mixed_value);
    assert!(!mixed_matched);
    assert!(
        mixed_work <= 4 * (mixed_pattern.chars().count() + mixed_value.len()),
        "mixed wildcard search performed {mixed_work} transitions"
    );
    let mixed_storage = mixed.storage_units_for_test();
    assert!(
        mixed_storage <= 4096 * mixed_pattern.chars().count(),
        "mixed wildcard storage ({mixed_storage}) must stay linear for distinct literals"
    );
}

#[test]
fn compiled_wildcards_match_a_reference_implementation_exhaustively() {
    fn generate(alphabet: &[char], maximum: usize) -> Vec<String> {
        let mut values = vec![String::new()];
        let mut frontier = vec![String::new()];
        for _ in 0..maximum {
            frontier = frontier
                .iter()
                .flat_map(|prefix| {
                    alphabet.iter().map(move |character| {
                        let mut next = prefix.clone();
                        next.push(*character);
                        next
                    })
                })
                .collect();
            values.extend(frontier.clone());
        }
        values
    }

    fn reference(pattern: &[char], value: &[char]) -> bool {
        let mut reachable = vec![false; value.len() + 1];
        reachable[0] = true;
        for unit in pattern {
            let mut next = vec![false; value.len() + 1];
            match unit {
                '*' => {
                    let mut seen = false;
                    for index in 0..=value.len() {
                        seen |= reachable[index];
                        next[index] = seen;
                    }
                }
                '?' => {
                    for index in 0..value.len() {
                        next[index + 1] = reachable[index];
                    }
                }
                literal => {
                    for index in 0..value.len() {
                        next[index + 1] = reachable[index] && value[index] == *literal;
                    }
                }
            }
            reachable = next;
        }
        reachable[value.len()]
    }

    for pattern in generate(&['a', 'b', '?', '*'], 6) {
        let wildcard = CompiledWildcard::new(&pattern, true);
        for value in generate(&['a', 'b'], 7) {
            assert_eq!(
                wildcard.matches(&TextValue::new(&value, false)),
                reference(
                    &pattern.chars().collect::<Vec<_>>(),
                    &value.chars().collect::<Vec<_>>()
                ),
                "pattern={pattern:?}, value={value:?}"
            );
        }
    }
}

#[test]
fn supported_rule_limits_keep_large_directory_evaluation_bounded() {
    let now = Utc.with_ymd_and_hms(2026, 9, 7, 0, 0, 0).unwrap();
    let probe_pattern = format!("*?{}z000*", "a".repeat(976));
    let probe = CompiledWildcard::new(&probe_pattern, true);
    assert!(
        probe.uses_dense_dfa_for_test(),
        "representative matcher used sparse storage ({} bytes)",
        probe.storage_units_for_test()
    );
    let rules = (0..256)
        .map(|index| {
            let expression = if index < 16 {
                format!("Path == \"*?{}z{index:03}*\"", "a".repeat(976))
            } else {
                "Size > 1TB".into()
            };
            let mut rule = rule(&format!("rule-{index}"), &expression, "#ffffff", index + 1);
            rule.case_sensitive = true;
            rule
        })
        .collect::<Vec<_>>();
    let entries = (0..1000)
        .map(|index| {
            let mut facts = file_facts(&format!("entry-{index}.txt"));
            facts.path = format!("C:\\{}-{index}", "a".repeat(1000));
            facts
        })
        .collect::<Vec<_>>();

    let started = Instant::now();
    let compiled = compile_rules(&rules, now);
    for facts in &entries {
        assert_eq!(compiled.style_for(facts), None);
    }
    assert!(
        started.elapsed().as_secs_f32() < 3.0,
        "supported rule limits took {:?}",
        started.elapsed()
    );
}

#[test]
fn validation_enforces_the_24_level_ast_depth_limit() {
    let compare = "Name == x";
    let not_depth_24 = format!("{}{}", "NOT ".repeat(23), compare);
    let not_depth_25 = format!("{}{}", "NOT ".repeat(24), compare);
    assert!(validate_expression(&not_depth_24).valid);
    assert!(validate_expression(&not_depth_25)
        .message
        .as_deref()
        .is_some_and(|message| message.contains("24")));

    for operator in [" AND ", " OR "] {
        let depth_24 = std::iter::repeat(compare)
            .take(24)
            .collect::<Vec<_>>()
            .join(operator);
        let depth_25 = std::iter::repeat(compare)
            .take(25)
            .collect::<Vec<_>>()
            .join(operator);
        assert!(validate_expression(&depth_24).valid, "{operator} depth 24");
        let result = validate_expression(&depth_25);
        assert!(!result.valid, "{operator} depth 25");
        assert!(result.span.is_some_and(|span| span.start < span.end));
    }

    let mixed_depth_24 = format!("{}{} AND {compare}", "NOT ".repeat(22), compare);
    let mixed_depth_25 = format!("{}{} AND {compare}", "NOT ".repeat(23), compare);
    assert!(validate_expression(&mixed_depth_24).valid);
    assert!(!validate_expression(&mixed_depth_25).valid);
}

#[test]
fn semicolon_separated_segments_match_any_segment() {
    let now = Utc.with_ymd_and_hms(2026, 9, 7, 0, 0, 0).unwrap();
    let compiled = compile_rules(
        &[rule("multi", "*.cpp;*.md;*.json", "#ffffff", 1)],
        now,
    );

    for name in ["main.cpp", "README.md", "package.json"] {
        assert!(
            compiled.style_for(&file_facts(name)).is_some(),
            "{name} should match one of the segments"
        );
    }
    assert!(compiled.style_for(&file_facts("notes.txt")).is_none());
}

#[test]
fn semicolon_segments_mix_full_expressions_and_shorthand() {
    let now = Utc.with_ymd_and_hms(2026, 9, 7, 0, 0, 0).unwrap();
    let compiled = compile_rules(
        &[rule(
            "mixed",
            "Extension == \".log\";*.tmp;Size >= 20MB AND Name == \"*report*\"",
            "#ffffff",
            1,
        )],
        now,
    );

    assert!(compiled.style_for(&file_facts("x.log")).is_some());
    assert!(compiled.style_for(&file_facts("a.tmp")).is_some());
    assert!(compiled.style_for(&file_facts("big-report.bin")).is_some());
    assert!(compiled.style_for(&file_facts("small.bin")).is_none());

    assert_eq!(
        text_comparison_count("Extension == \".log\";*.tmp;Size >= 20MB AND Name == \"*report*\"")
            .expect("mixed expression parses"),
        3
    );
}

#[test]
fn semicolons_inside_quotes_stay_literal_and_in_parentheses_bare_is_invalid() {
    let now = Utc.with_ymd_and_hms(2026, 9, 7, 0, 0, 0).unwrap();
    let quoted = compile_rules(&[rule("quoted", "Name == \"a;b\"", "#ffffff", 1)], now);
    assert!(quoted.style_for(&file_facts("a;b")).is_some());
    assert!(quoted.style_for(&file_facts("ab")).is_none());

    let parenthesized = compile_rules(
        &[rule("paren", "(Name == \"a;b\")", "#ffffff", 1)],
        now,
    );
    assert!(parenthesized.style_for(&file_facts("a;b")).is_some());

    assert!(!validate_expression("(Name == a; Name == b)").valid);
    assert!(validate_expression("\"a;b\"").valid);
}

#[test]
fn escaped_semicolons_do_not_split() {
    let now = Utc.with_ymd_and_hms(2026, 9, 7, 0, 0, 0).unwrap();

    let escaped_quote = compile_rules(
        &[rule("esc-quote", "Name == \"a\\\";b\"", "#ffffff", 1)],
        now,
    );
    assert!(escaped_quote.style_for(&file_facts("a\";b")).is_some());

    let escaped_backslash = compile_rules(
        &[rule("esc-backslash", "Name == \"a\\\\;b\"", "#ffffff", 1)],
        now,
    );
    assert!(escaped_backslash.style_for(&file_facts("a\\;b")).is_some());

    let bare = compile_rules(&[rule("esc-bare", "a\\;b", "#ffffff", 1)], now);
    assert!(bare.style_for(&file_facts("a\\;b")).is_some());
}

#[test]
fn semicolon_expressions_reject_empty_segments_with_spans() {
    for expression in ["*.cpp;;*.md", ";*.cpp", "*.cpp;", ";"] {
        let result = validate_expression(expression);
        assert!(!result.valid, "{expression} must be invalid");
        assert!(
            result
                .message
                .as_deref()
                .is_some_and(|message| message.contains("required")),
            "{expression} should report a required-expression message"
        );
    }

    let middle = validate_expression("*.cpp;;*.md");
    assert_eq!(middle.span, Some(ColorFilterValidationSpan { start: 6, end: 7 }));
    let leading = validate_expression(";*.cpp");
    assert_eq!(leading.span, Some(ColorFilterValidationSpan { start: 0, end: 1 }));
    let trailing = validate_expression("*.cpp;");
    assert_eq!(trailing.span, Some(ColorFilterValidationSpan { start: 6, end: 6 }));
}

#[test]
fn segment_errors_shift_spans_to_the_segment_content_base() {
    // 段 1 内容 "Name ==" 的 pest 错误落在字节 7；分号前留空格时基准不得漂移。
    let pest_error = validate_expression("Name == ; *.tmp");
    assert_eq!(pest_error.span, Some(ColorFilterValidationSpan { start: 7, end: 8 }));

    // 段 2 " Szie >= q" 内容基址为字节 4（段起点 3 + 前导空白 1）。
    let variable_error = validate_expression("a ; Szie >= q");
    assert_eq!(variable_error.span, Some(ColorFilterValidationSpan { start: 4, end: 8 }));

    // 段自身深度超限：错误 span 必须落在该段字节范围内。
    let deep_source = format!("x ; {}Name == y", "NOT ".repeat(24));
    let depth_error = validate_expression(&deep_source);
    assert!(!depth_error.valid);
    let span = depth_error.span.expect("depth error span");
    assert!(
        span.start >= "x ; ".len() && span.end <= deep_source.len(),
        "depth error {span:?} should point into the second segment"
    );
}

#[test]
fn storage_limits_split_segments_before_depth_checks() {
    let leaf_chain_25 = std::iter::repeat("Name==x")
        .take(25)
        .collect::<Vec<_>>()
        .join(";");
    assert!(validate_expression_storage_limits(&leaf_chain_25).is_err());
    assert!(validate_expression_storage_limits("a;b").is_ok());
    assert!(validate_expression_storage_limits(" ; ").is_ok());
}

#[test]
fn escaped_quote_semicolons_follow_the_state_machine() {
    // `a\"b;c`：反斜杠转义引号，引号态从未开启，`;` 是顶层分隔符。
    let now = Utc.with_ymd_and_hms(2026, 9, 7, 0, 0, 0).unwrap();
    let compiled = compile_rules(&[rule("esc-open", "a\\\"b;c", "#ffffff", 1)], now);
    assert!(compiled.style_for(&file_facts("a\"b")).is_some());
    assert!(compiled.style_for(&file_facts("c")).is_some());
    assert!(compiled.style_for(&file_facts("ab")).is_none());
}

#[test]
fn semicolon_chains_respect_the_ast_depth_limit() {
    let leaf_chain_24 = std::iter::repeat("Name==x")
        .take(24)
        .collect::<Vec<_>>()
        .join(";");
    assert!(validate_expression(&leaf_chain_24).valid);

    let leaf_chain_25 = format!("{leaf_chain_24};Name==x");
    let result = validate_expression(&leaf_chain_25);
    assert!(!result.valid);
    assert!(result
        .message
        .as_deref()
        .is_some_and(|message| message.contains("nesting exceeds 24")));

    let deep_segment = format!("{}Name == x", "NOT ".repeat(23));
    assert!(validate_expression(&deep_segment).valid);
    let mixed_over = format!("{deep_segment};Name == y");
    assert!(!validate_expression(&mixed_over).valid);

    let depth_12_segment = format!("{}Name == x", "NOT ".repeat(11));
    let mixed_within = format!("{depth_12_segment};{depth_12_segment}");
    assert!(validate_expression(&mixed_within).valid);
}

#[test]
fn bare_shorthand_semicolon_meaning_changes_to_alternatives() {
    let now = Utc.with_ymd_and_hms(2026, 9, 7, 0, 0, 0).unwrap();

    let alternatives = compile_rules(&[rule("alt", "a;b", "#ffffff", 1)], now);
    assert!(alternatives.style_for(&file_facts("a")).is_some());
    assert!(alternatives.style_for(&file_facts("b")).is_some());
    assert!(alternatives.style_for(&file_facts("a;b")).is_none());

    let literal = compile_rules(&[rule("literal", "Name == \"a;b\"", "#ffffff", 1)], now);
    assert!(literal.style_for(&file_facts("a;b")).is_some());

    let quoted_bare = compile_rules(&[rule("quote-bare", "a\"b;c", "#ffffff", 1)], now);
    assert!(quoted_bare.style_for(&file_facts("a\"b;c")).is_some());
    assert!(quoted_bare.style_for(&file_facts("c")).is_none());
}

#[test]
fn date_only_rules_resolve_boundaries_once_in_the_captured_zone() {
    let now = Utc.with_ymd_and_hms(2026, 9, 8, 1, 0, 0).unwrap();
    let zone = FixedOffset::east_opt(8 * 60 * 60).unwrap();
    let resolver_calls = Cell::new(0);
    let compiled = compile_rules_with_day_boundary(
        &[rule("date", "Modified == \"2026-09-08\"", "#ffffff", 1)],
        now,
        |date: NaiveDate| {
            resolver_calls.set(resolver_calls.get() + 1);
            let naive = date.and_hms_opt(0, 0, 0)?;
            match zone.from_local_datetime(&naive) {
                LocalResult::Single(value) => Some(value.with_timezone(&Utc)),
                _ => None,
            }
        },
    );
    assert_eq!(resolver_calls.get(), 2);

    let mut facts = file_facts("report.txt");
    facts.modified_at = Some(Utc.with_ymd_and_hms(2026, 9, 7, 16, 30, 0).unwrap());
    assert!(compiled.style_for(&facts).is_some());
    assert!(compiled.style_for(&facts).is_some());
    assert_eq!(
        resolver_calls.get(),
        2,
        "evaluation must use captured boundaries"
    );
}

#[test]
fn civil_day_boundary_uses_first_real_instant_and_rejects_skipped_dates() {
    let sao_paulo = LocalTimeZoneSnapshot(
        jiff::tz::TimeZone::get("America/Sao_Paulo").expect("Sao Paulo time zone"),
    );
    let transition_date = NaiveDate::from_ymd_opt(2015, 10, 18).unwrap();
    assert_eq!(
        sao_paulo.day_boundary(transition_date),
        Some(Utc.with_ymd_and_hms(2015, 10, 18, 3, 0, 0).unwrap())
    );

    let apia =
        LocalTimeZoneSnapshot(jiff::tz::TimeZone::get("Pacific/Apia").expect("Apia time zone"));
    assert_eq!(
        apia.day_boundary(NaiveDate::from_ymd_opt(2011, 12, 30).unwrap()),
        None
    );
    assert_eq!(
        apia.day_boundary(NaiveDate::from_ymd_opt(2011, 12, 31).unwrap()),
        Some(Utc.with_ymd_and_hms(2011, 12, 30, 10, 0, 0).unwrap())
    );
}

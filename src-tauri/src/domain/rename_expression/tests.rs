use super::*;

fn item(name: &str) -> RenameContext {
    RenameContext {
        name: name.into(),
        is_directory: false,
        index: 0,
        now: DateTime::parse_from_rfc3339("2026-09-12T11:46:28+08:00").unwrap(),
        modified: Some(DateTime::parse_from_rfc3339("2026-08-24T10:00:00+08:00").unwrap()),
        created: Some(DateTime::parse_from_rfc3339("2026-08-18T10:00:00+08:00").unwrap()),
    }
}

#[test]
fn user_examples_preserve_extensions_and_expand_templates() {
    let examples = [
        ("ThisNew", "ThisNew.txt"),
        ("ThisNew.txt", "ThisNew.txt"),
        ("ThisNew.md", "ThisNew.md"),
        ("New-*", "New-Test.txt"),
        ("*-<date yyyy>", "Test-2026.txt"),
        ("?-<#001>", "txt-001.txt"),
        ("<TOUPPER *>", "TEST.txt"),
        ("<TOLOWER *>", "test.txt"),
        ("<TOUPPER New_<date yyyy-mm-dd>>", "NEW_2026-09-12.txt"),
        ("<tohex New_<date yyyy-mm-dd>>", "New_7EA-9-C.txt"),
        ("<tolower <tohex New_<date yyyy-mm-dd>>>", "new_7ea-9-c.txt"),
        ("New<#1>", "New1.txt"),
        ("New<#00>", "New00.txt"),
        (
            "New_<date yyyy-mm-ddThh-mm-ss>",
            "New_2026-09-12T11-46-28.txt",
        ),
        ("New_<date yyyymmddhhmmss>", "New_20260912114628.txt"),
        ("New_<datem yyyy-mm-dd>", "New_2026-08-24.txt"),
        ("New_<datec yyyy-mm-dd>", "New_2026-08-18.txt"),
    ];
    for (expression, expected) in examples {
        assert_eq!(
            evaluate(expression, &item("Test.txt")).unwrap(),
            expected,
            "{expression}"
        );
    }
}

#[test]
fn regex_nesting_and_quoted_arguments() {
    let source = item("log_20260912114628_esn2025gpa001-4-控制台A.zip");
    assert_eq!(
        evaluate(r"<toupper <regular 'esn\d{4}gpa\d{3}' *>>", &source).unwrap(),
        "ESN2025GPA001.zip"
    );
    assert_eq!(
        evaluate(r#"<toupper "New "*>"#, &item("Test.txt")).unwrap(),
        "NEW TEST.txt"
    );
    assert_eq!(
        evaluate("<replace * 'Test' 'string B'>", &item("Test.txt")).unwrap(),
        "string B.txt"
    );
}

#[test]
fn diagnostics_preserve_utf8_ranges_without_presenting_bytes_as_character_positions() {
    for (expression, start, call) in [
        ("新<unknown *>", 3, "<unknown *>"),
        ("😀新<unknown *>", 7, "<unknown *>"),
        ("<toupper *>😀<substr * bad>", 15, "<substr * bad>"),
    ] {
        let error = FunctionRegistry::builtins()
            .compile(expression)
            .and_then(|compiled| {
                compiled.evaluate(
                    &item("Test.txt"),
                    &mut Budget::new(&|| false),
                    &mut HashMap::new(),
                )
            })
            .unwrap_err();
        assert_eq!(error.start, start);
        assert_eq!(&expression[error.start..error.end], call);
        assert_eq!(error.to_string(), error.message,
            "formatting without source text must not label byte offsets as user character positions");
    }
}

#[test]
fn extension_provenance_composes_through_functions() {
    let source = item("archive.v1.txt");
    for (expression, expected) in [
        ("*", "archive.v1.txt"),
        ("<toupper *>", "ARCHIVE.V1.txt"),
        ("new.*", "new.archive.v1.txt"),
        ("*.md", "archive.v1.md"),
        ("<replace * '.v1' '.md'>", "archive.md"),
        (
            r"<regular 'archive\.md' <replace * '.v1' '.md'>>",
            "archive.md",
        ),
        ("<substr 'archive.md' 0 7>", "archive.txt"),
        ("<regular 'archive' 'archive.md'>", "archive.txt"),
        ("<toupper 'ß.md'>", "SS.MD"),
        ("name.<date yyyy.mm>", "name.2026.09.txt"),
    ] {
        assert_eq!(
            evaluate(expression, &source).unwrap(),
            expected,
            "{expression}"
        );
    }
}

#[test]
fn invalid_expressions_are_diagnosed_before_extension_fallback() {
    for expression in [
        "",
        "  ",
        "<trim '  '>",
        "<unknown *>",
        "<toupper>",
        "<toupper *",
        "<toupper 'x>",
        "<#>",
        "<#-1>",
        "<regular '[' *>",
        "<regular 'absent' *>",
        "<replace * '' 'x'>",
        "<substr * 0 -1>",
        "<date yyy>",
    ] {
        assert!(
            evaluate(expression, &item("Test.txt")).is_err(),
            "{expression:?}"
        );
    }
}

#[test]
fn counters_unicode_and_names_without_extensions() {
    let mut source = item("Test.txt");
    source.index = 235;
    assert_eq!(evaluate("New<#00>", &source).unwrap(), "New235.txt");
    assert_eq!(evaluate("New<#001>", &source).unwrap(), "New236.txt");
    assert_eq!(
        evaluate("<substr 'A中😀文B' 1 3>", &source).unwrap(),
        "中😀文.txt"
    );
    assert_eq!(
        evaluate("<substr 'A中😀文B' -2>", &source).unwrap(),
        "文B.txt"
    );
    assert_eq!(evaluate("<trim '  X  '>", &source).unwrap(), "X.txt");
    assert_eq!(
        evaluate("<tohex '18446744073709551616-000012'>", &source).unwrap(),
        "10000000000000000-C.txt"
    );
    assert_eq!(
        evaluate("new-*", &item(".gitignore")).unwrap(),
        "new-.gitignore"
    );
    assert_eq!(evaluate("new", &item("README")).unwrap(), "new");
    source.is_directory = true;
    source.name = "folder.v1".into();
    assert_eq!(evaluate("*-?", &source).unwrap(), "folder.v1-");
}

#[test]
fn functions_are_extensible_without_parser_changes_and_catalog_is_shared() {
    let mut registry = FunctionRegistry::builtins();
    registry
        .register(FunctionDefinition {
            info: FunctionInfo {
                name: "greet".into(),
                aliases: vec!["hello".into()],
                parameters: vec![FunctionParameter {
                    name: "name".into(),
                    role: "text".into(),
                    optional: false,
                }],
                description: "test extension".into(),
                examples: vec![],
            },
            evaluate: |args, _| {
                let mut text = EvalText::literal("Hello-");
                text.append(&args[0])?;
                Ok(text)
            },
        })
        .unwrap();
    let compiled = registry.compile("<TOUPPER <HeLLo *>>").unwrap();
    assert_eq!(
        compiled
            .evaluate(
                &item("Test.txt"),
                &mut Budget::new(&|| false),
                &mut HashMap::new()
            )
            .unwrap(),
        "HELLO-TEST.txt"
    );
    assert_eq!(registry.catalog().last().unwrap().name, "greet");
    assert!(registry
        .register(FunctionDefinition {
            info: FunctionInfo {
                name: "HELLO".into(),
                aliases: vec![],
                parameters: vec![],
                description: "".into(),
                examples: vec![]
            },
            evaluate: |_, _| Ok(EvalText::generated("x")),
        })
        .is_err());
}

#[test]
fn resource_limits_and_cancellation_are_visible_errors() {
    let source = item("Test.txt");
    assert!(evaluate(&"x".repeat(MAX_EXPRESSION_BYTES + 1), &source).is_err());
    assert!(evaluate(
        &format!("{}*{}", "<toupper ".repeat(65), ">".repeat(65)),
        &source
    )
    .is_err());
    assert!(evaluate("<counter 1 65537>", &source).is_err());
    assert!(evaluate(&format!("<regular '{}' *>", "x".repeat(4097)), &source).is_err());
    let compiled = FunctionRegistry::builtins()
        .compile("<tohex '12345678901234567890'>")
        .unwrap();
    assert!(compiled
        .evaluate(&source, &mut Budget::new(&|| true), &mut HashMap::new())
        .is_err());
    let mut budget = Budget {
        remaining: 1,
        cancelled: &|| false,
    };
    assert!(compiled
        .evaluate(&source, &mut budget, &mut HashMap::new())
        .is_err());
    assert_eq!(evaluate("<tolower 'ΟΣ'>", &source).unwrap(), "ος.txt");
    assert_eq!(
        evaluate(r"<replace 'a\'b' 'a' 'x'>", &source).unwrap(),
        "x'b.txt"
    );
}

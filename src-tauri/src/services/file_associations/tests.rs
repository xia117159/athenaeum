use super::*;
use crate::domain::models::{FileAssociationRule, FileOpenRequest, FileOpenTarget};
use serde_json::{json, Value};

fn rule(patterns: &str) -> FileAssociationRule {
    FileAssociationRule {
        id: "one".into(),
        patterns: patterns.into(),
        executable_path: r"C:\missing.exe".into(),
        arguments_template: "{file}".into(),
    }
}

#[test]
fn shared_extension_and_matching_contract() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../src/features/workspace/fileAssociationContract.fixtures.json"
    ))
    .unwrap();
    for case in fixture["extensions"].as_array().unwrap() {
        let actual = parse_extensions(case["input"].as_str().unwrap());
        if case["expected"].is_null() {
            assert!(actual.is_err(), "{case}");
        } else {
            assert_eq!(json!(actual.unwrap()), case["expected"], "{case}");
        }
    }
    for case in fixture["matching"].as_array().unwrap() {
        assert_eq!(
            matches(
                &rule(case["patterns"].as_str().unwrap()),
                case["path"].as_str().unwrap()
            ),
            case["expected"].as_bool().unwrap(),
            "{case}"
        );
    }
}

#[test]
fn shared_windows_argument_contract() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../src/features/workspace/fileAssociationContract.fixtures.json"
    ))
    .unwrap();
    for case in fixture["arguments"].as_array().unwrap() {
        let actual = file_arguments(
            case["template"].as_str().unwrap(),
            case["file"].as_str().unwrap(),
        );
        if case["expected"].is_null() {
            assert!(actual.is_err(), "{case}");
        } else {
            assert_eq!(json!(actual.unwrap()), case["expected"], "{case}");
        }
    }
}

#[test]
fn file_associations_accept_empty_rules_but_reject_invalid_nonempty_input() {
    assert!(normalize_rules(vec![FileAssociationRule {
        id: "empty".into(),
        ..Default::default()
    }])
    .is_ok());
    assert!(
        normalize_rules(vec![rule("txt"), rule("md")]).is_err(),
        "duplicate IDs"
    );
    assert!(validate_rule(&rule("?.txt")).is_err());
    let mut invalid = rule("md");
    invalid.arguments_template = "\"unfinished".into();
    assert!(validate_rule(&invalid).is_err());
    let normalized = normalize_rules(vec![rule(" *.MD; .txt ;; json ")]).unwrap();
    assert_eq!(normalized[0].patterns, "*.MD;.txt;json");
}

#[test]
fn file_associations_deserialize_actual_typescript_remote_contract() {
    let input = json!({"requestId":"open-1","target":{"kind":"remote","profileId":"sftp-main",
        "path":"/home/中文 文件.txt"},"associationId":"editor-1"});
    let request: FileOpenRequest = serde_json::from_value(input).unwrap();
    assert_eq!(request.request_id, "open-1");
    assert_eq!(
        request.target,
        FileOpenTarget::Remote {
            profile_id: "sftp-main".into(),
            path: "/home/中文 文件.txt".into()
        }
    );
    assert_eq!(
        serde_json::to_value(request.target).unwrap()["profileId"],
        "sftp-main"
    );
}

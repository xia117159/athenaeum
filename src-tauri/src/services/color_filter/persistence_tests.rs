use std::{fs, path::PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    domain::models::EntryKind,
    services::{
        color_filter::{compile_rules, AttributeFacts, EntryFacts},
        commit_color_rule_startup_migration,
        metadata_store::MetadataStore,
    },
};

fn replacement_id(raw: &Value, original_index: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(raw).unwrap());
    hasher.update(original_index.to_le_bytes());
    let digest = format!("{:x}", hasher.finalize());
    format!("legacy-{}", &digest[..12])
}

fn temp_file(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "athenaeum-color-{name}-{}.json",
        uuid::Uuid::new_v4()
    ))
}

#[test]
fn legacy_rows_migrate_independently_and_default_enabled() {
    let path = temp_file("legacy");
    fs::write(
        &path,
        r##"{
          "bookmarks": [], "hotlist": [], "tagDefinitions": [], "entryTags": [],
          "shortcuts": [], "remoteProfiles": [],
          "colorRules": [
            {"id":"txt","name":"Text","target":"file","mode":"extension","pattern":".txt","colorHex":"#336699","priority":2},
            {"id":"bad","name":"Bad","target":"any","mode":"futureMode","pattern":"x","colorHex":"broken","priority":1}
          ]
        }"##,
    )
    .expect("write legacy metadata");

    let store = MetadataStore::load_from(path.clone()).expect("load tolerant metadata");
    assert!(store.color_filter_enabled);
    assert!(store.color_rules_migration_dirty());
    assert_eq!(store.color_filter_revision, "0");
    assert_eq!(store.color_rules_revision, "0");
    assert_eq!(store.color_rules.len(), 2);
    let migrated = store
        .color_rules
        .iter()
        .find(|rule| rule.id == "txt")
        .unwrap();
    assert!(migrated.enabled);
    assert_eq!(migrated.expression, "Extension == \".txt\"");
    assert_eq!(migrated.foreground_color_hex.as_deref(), Some("#336699"));
    let malformed = store
        .color_rules
        .iter()
        .find(|rule| rule.id == "bad")
        .unwrap();
    assert!(!malformed.enabled);
    assert!(malformed.migration_diagnostic.is_some());

    let _ = fs::remove_file(path);
}

#[test]
fn canonical_persist_uses_v2_schema_and_string_revisions() {
    let path = temp_file("canonical");
    let mut store = MetadataStore::load_from(path.clone()).expect("create empty store");
    store
        .increment_color_revisions(true)
        .expect("increment revisions");
    store.persist().expect("persist metadata");

    let value: Value = serde_json::from_slice(&fs::read(&path).expect("read metadata")).unwrap();
    assert_eq!(value["colorFilterEnabled"], true);
    assert_eq!(value["colorFilterRevision"], "1");
    assert_eq!(value["colorRulesRevision"], "1");
    assert_eq!(value["colorRuleSchemaVersion"], 2);

    let reloaded = MetadataStore::load_from(path.clone()).expect("reload canonical metadata");
    assert!(!reloaded.color_rules_migration_dirty());
    assert_eq!(reloaded.color_filter_revision, "1");

    let _ = fs::remove_file(path);
}

#[test]
fn invalid_revision_tokens_are_recovered_without_json_precision_loss() {
    let path = temp_file("revision");
    fs::write(
        &path,
        r#"{"colorFilterRevision":9007199254740993,"colorRulesRevision":"01","colorRuleSchemaVersion":2}"#,
    )
    .expect("write metadata");

    let mut store = MetadataStore::load_from(path.clone()).expect("recover invalid revisions");
    assert_eq!(store.color_filter_revision, "0");
    assert_eq!(store.color_rules_revision, "0");
    assert!(store.color_rules_migration_dirty());
    assert_eq!(
        store.color_filter_recovery_diagnostics(),
        [
            "Invalid persisted colorFilterRevision was reset to 0",
            "Invalid persisted colorRulesRevision was reset to 0"
        ]
    );
    assert_eq!(
        store.take_color_filter_recovery_diagnostics(),
        [
            "Invalid persisted colorFilterRevision was reset to 0",
            "Invalid persisted colorRulesRevision was reset to 0"
        ]
    );
    assert!(store.take_color_filter_recovery_diagnostics().is_empty());

    let _ = fs::remove_file(path);
}

#[test]
fn future_rows_round_trip_raw_source_without_exposing_it_over_ipc() {
    let path = temp_file("future-row");
    fs::write(
        &path,
        r##"{
          "colorFilterRevision":"4","colorRulesRevision":"3","colorRuleSchemaVersion":2,
          "colorRules":[{
            "schemaVersion":3,"id":"future","name":"Future","enabled":true,
            "target":"file","expression":"*.future","caseSensitive":true,
            "foregroundColorHex":"#123456","backgroundColorHex":null,"priority":1,
            "vendorPayload":{"mode":"future","level":7}
          }]
        }"##,
    )
    .expect("write future metadata");

    let mut store = MetadataStore::load_from(path.clone()).expect("load future metadata");
    assert!(store.color_rules_migration_dirty());
    assert!(!store.color_rules[0].enabled);
    assert!(store.color_rules[0].migration_diagnostic.is_some());
    store.persist().expect("persist diagnostic placeholder");

    let disk: Value =
        serde_json::from_slice(&fs::read(&path).expect("read persisted metadata")).unwrap();
    assert_eq!(disk["colorRules"][0]["migrationSource"]["schemaVersion"], 3);
    assert_eq!(
        disk["colorRules"][0]["migrationSource"]["vendorPayload"]["level"],
        7
    );
    let ipc = serde_json::to_value(store.color_filter_snapshot()).expect("serialize IPC snapshot");
    assert!(ipc["rules"][0].get("migrationSource").is_none());

    let reloaded =
        MetadataStore::load_from(path.clone()).expect("reload preserved future metadata");
    assert!(!reloaded.color_rules_migration_dirty());
    let _ = fs::remove_file(path);
}

#[test]
fn invalid_v2_color_becomes_a_repairable_diagnostic_and_canonical_live_state() {
    let path = temp_file("invalid-v2-color");
    fs::write(
        &path,
        r##"{
          "colorFilterRevision":"0","colorRulesRevision":"0","colorRuleSchemaVersion":2,
          "colorRules":[{
            "schemaVersion":2,"id":"broken","name":"Broken","enabled":true,
            "target":"file","expression":"*.txt","caseSensitive":true,
            "foregroundColorHex":"red","backgroundColorHex":"#ddeeff","priority":1
          }]
        }"##,
    )
    .expect("write invalid V2 metadata");

    let mut store = MetadataStore::load_from(path.clone()).expect("load invalid V2 metadata");
    assert!(store.color_rules_migration_dirty());
    assert!(!store.color_rules[0].enabled);
    assert_eq!(
        store.color_rules[0].target,
        crate::domain::color_filter::ColorRuleTarget::File
    );
    assert_eq!(store.color_rules[0].expression, "*.txt");
    assert!(store.color_rules[0].case_sensitive);
    assert_eq!(store.color_rules[0].foreground_color_hex, None);
    assert_eq!(
        store.color_rules[0].background_color_hex.as_deref(),
        Some("#ddeeff")
    );
    assert!(store.color_rules[0]
        .migration_diagnostic
        .as_deref()
        .is_some_and(|message| message.contains("foregroundColorHex")));

    store.persist().expect("persist repaired envelope");
    assert!(!store.color_rules_migration_dirty());
    assert_eq!(store.color_rules[0].schema_version, 2);
    let reloaded = MetadataStore::load_from(path.clone()).expect("reload repaired envelope");
    assert!(!reloaded.color_rules_migration_dirty());
    assert!(reloaded.color_rules[0].migration_diagnostic.is_some());
    let _ = fs::remove_file(path);
}

#[test]
fn startup_migration_commits_incremented_revisions_and_canonical_live_state() {
    let path = temp_file("startup-success");
    fs::write(
        &path,
        r##"{
          "colorFilterRevision":"4","colorRulesRevision":"6","colorRuleSchemaVersion":1,
          "colorRules":[{"id":"txt","name":"Text","mode":"extension","pattern":"txt","colorHex":"#336699","priority":1}]
        }"##,
    )
    .expect("write legacy metadata");
    let mut store = MetadataStore::load_from(path.clone()).expect("load legacy metadata");

    assert!(commit_color_rule_startup_migration(&mut store).expect("commit migration"));
    assert_eq!(store.color_filter_revision, "5");
    assert_eq!(store.color_rules_revision, "7");
    assert!(!store.color_rules_migration_dirty());
    assert_eq!(store.color_rules[0].schema_version, 2);
    let reloaded = MetadataStore::load_from(path.clone()).expect("reload migrated metadata");
    assert!(!reloaded.color_rules_migration_dirty());
    assert_eq!(reloaded.color_filter_revision, "5");
    assert_eq!(reloaded.color_rules_revision, "7");
    let _ = fs::remove_file(path);
}

#[test]
fn failed_startup_migration_keeps_live_revisions_and_dirty_state() {
    let source_path = temp_file("startup-failure-source");
    fs::write(
        &source_path,
        r##"{
          "colorFilterRevision":"4","colorRulesRevision":"6","colorRuleSchemaVersion":1,
          "colorRules":[{"id":"txt","name":"Text","mode":"extension","pattern":"txt","colorHex":"#336699","priority":1}]
        }"##,
    )
    .expect("write legacy metadata");
    let original = fs::read(&source_path).expect("read source bytes");
    let mut store = MetadataStore::load_from(source_path.clone()).expect("load legacy metadata");
    let blocked_parent = temp_file("blocked-parent");
    fs::write(&blocked_parent, b"not a directory").expect("write blocking parent file");
    store.attach_path(blocked_parent.join("metadata.json"));

    assert!(commit_color_rule_startup_migration(&mut store).is_err());
    assert_eq!(store.color_filter_revision, "4");
    assert_eq!(store.color_rules_revision, "6");
    assert!(store.color_rules_migration_dirty());
    assert_eq!(store.color_rules[0].schema_version, 1);
    assert!(store
        .color_filter_recovery_diagnostics()
        .iter()
        .any(|message| message.contains("could not be persisted") && message.contains("retried")));
    assert_eq!(
        fs::read(&source_path).expect("read unchanged source"),
        original
    );

    store.attach_path(source_path.clone());
    store
        .persist()
        .expect("later unrelated save should finish migration");
    assert_eq!(store.color_filter_revision, "5");
    assert_eq!(store.color_rules_revision, "7");
    assert!(!store.color_rules_migration_dirty());
    let reloaded = MetadataStore::load_from(source_path.clone()).expect("reload later migration");
    assert_eq!(reloaded.color_filter_revision, "5");
    assert_eq!(reloaded.color_rules_revision, "7");
    assert!(!reloaded.color_rules_migration_dirty());
    let _ = fs::remove_file(source_path);
    let _ = fs::remove_file(blocked_parent);
}

#[test]
fn canonical_v2_identity_and_order_normalization_is_dirty_stable_and_collision_free() {
    let path = temp_file("v2-normalization");
    fs::write(
        &path,
        r##"{
          "colorFilterRevision":"8","colorRulesRevision":"5","colorRuleSchemaVersion":2,
          "colorRules":[
            {"schemaVersion":2,"id":"","name":"Same","enabled":false,"target":"any","expression":"","caseSensitive":false,"foregroundColorHex":"#112233","backgroundColorHex":null,"priority":2},
            {"schemaVersion":2,"id":"legacy-rule-2","name":" same ","enabled":false,"target":"any","expression":"","caseSensitive":false,"foregroundColorHex":"#445566","backgroundColorHex":null,"priority":1}
          ]
        }"##,
    )
    .expect("write noncanonical V2 metadata");

    let mut store = MetadataStore::load_from(path.clone()).expect("normalize V2 metadata");
    assert!(store.color_rules_migration_dirty());
    assert_ne!(store.color_rules[0].id, store.color_rules[1].id);
    assert_ne!(
        store.color_rules[0].name.to_lowercase(),
        store.color_rules[1].name.to_lowercase()
    );
    assert_eq!(
        store
            .color_rules
            .iter()
            .map(|rule| rule.priority)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
    commit_color_rule_startup_migration(&mut store).expect("persist normalization");
    let ids = store
        .color_rules
        .iter()
        .map(|rule| rule.id.clone())
        .collect::<Vec<_>>();

    let reloaded = MetadataStore::load_from(path.clone()).expect("reload normalized V2 metadata");
    assert!(!reloaded.color_rules_migration_dirty());
    assert_eq!(
        reloaded
            .color_rules
            .iter()
            .map(|rule| rule.id.clone())
            .collect::<Vec<_>>(),
        ids
    );
    assert_eq!(reloaded.color_filter_revision, "9");
    assert_eq!(reloaded.color_rules_revision, "6");
    let _ = fs::remove_file(path);
}

#[test]
fn replacement_ids_use_raw_rows_and_original_indexes_without_displacing_valid_ids() {
    let path = temp_file("stable-raw-ids");
    let first = json!({"schemaVersion":2,"id":"","name":"Later","enabled":false,"target":"any","expression":"","caseSensitive":false,"foregroundColorHex":"#112233","backgroundColorHex":null,"priority":20});
    let duplicate = json!({"schemaVersion":2,"id":"kept","name":"Duplicate","enabled":false,"target":"any","expression":"","caseSensitive":false,"foregroundColorHex":"#223344","backgroundColorHex":null,"priority":1});
    let expected_first_id = replacement_id(&first, 0);
    let legitimate = json!({"schemaVersion":2,"id":expected_first_id,"name":"Legitimate","enabled":false,"target":"any","expression":"","caseSensitive":false,"foregroundColorHex":"#334455","backgroundColorHex":null,"priority":2});
    let kept = json!({"schemaVersion":2,"id":"kept","name":"Kept","enabled":false,"target":"any","expression":"","caseSensitive":false,"foregroundColorHex":"#445566","backgroundColorHex":null,"priority":30});
    let rows = vec![
        first.clone(),
        duplicate.clone(),
        legitimate.clone(),
        kept.clone(),
    ];
    fs::write(
        &path,
        serde_json::to_vec(&json!({"colorRuleSchemaVersion":2,"colorRules":rows})).unwrap(),
    )
    .expect("write identity fixture");

    let store = MetadataStore::load_from(path.clone()).expect("migrate identities");
    let by_name = store
        .color_rules
        .iter()
        .map(|rule| (rule.name.as_str(), rule.id.as_str()))
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(by_name["Legitimate"], expected_first_id);
    assert_eq!(by_name["Duplicate"], "kept");
    assert_eq!(by_name["Kept"], replacement_id(&kept, 3));
    assert_ne!(by_name["Later"], expected_first_id);
    assert!(by_name["Later"].starts_with("legacy-"));

    let _ = fs::remove_file(path);
}

#[test]
fn migration_enforces_expression_hard_limits_for_enabled_and_disabled_v2_rows() {
    for (label, enabled, expression) in [
        ("whitespace", false, format!("{}*.txt", " ".repeat(1020))),
        (
            "tokens",
            false,
            std::iter::repeat("Name == x")
                .take(65)
                .collect::<Vec<_>>()
                .join(" OR "),
        ),
        (
            "depth-disabled",
            false,
            format!("{}Name == x", "NOT ".repeat(24)),
        ),
        (
            "depth-enabled",
            true,
            format!("{}Name == x", "NOT ".repeat(24)),
        ),
    ] {
        let path = temp_file(label);
        let row = json!({
            "schemaVersion": 2,
            "id": label,
            "name": label,
            "enabled": enabled,
            "target": "any",
            "expression": expression,
            "caseSensitive": false,
            "foregroundColorHex": "#112233",
            "backgroundColorHex": null,
            "priority": 1
        });
        fs::write(
            &path,
            serde_json::to_vec(&json!({"colorRuleSchemaVersion":2,"colorRules":[row]})).unwrap(),
        )
        .expect("write hard-limit fixture");
        let store = MetadataStore::load_from(path.clone()).expect("load hard-limit fixture");
        assert!(!store.color_rules[0].enabled, "{label}");
        assert!(
            store.color_rules[0]
                .migration_diagnostic
                .as_deref()
                .is_some_and(|message| message.contains("exceeds")),
            "{label}"
        );
        assert_eq!(store.color_rules[0].expression, "", "{label}");
        assert_eq!(store.color_rules[0].migration_source, None, "{label}");
        let _ = fs::remove_file(path);
    }
}

#[test]
fn migration_enforces_rule_count_limit_without_losing_overflow_rows() {
    for count in [256, 257] {
        let path = temp_file(&format!("rule-count-{count}"));
        let rows = (0..count)
            .map(|index| {
                json!({
                    "schemaVersion": 2,
                    "id": format!("rule-{index}"),
                    "name": format!("Rule {index}"),
                    "enabled": false,
                    "target": "any",
                    "expression": "",
                    "caseSensitive": false,
                    "foregroundColorHex": "#112233",
                    "backgroundColorHex": null,
                    "priority": index + 1
                })
            })
            .collect::<Vec<_>>();
        fs::write(
            &path,
            serde_json::to_vec(&json!({"colorRuleSchemaVersion":2,"colorRules":rows})).unwrap(),
        )
        .expect("write count fixture");

        let mut store = MetadataStore::load_from(path.clone()).expect("load count fixture");
        assert_eq!(store.color_rules.len(), count.min(256));
        if count == 256 {
            assert!(!store.color_rules_migration_dirty());
        } else {
            let overflow = store.color_rules.last().expect("overflow diagnostic");
            assert!(!overflow.enabled);
            assert!(overflow
                .migration_diagnostic
                .as_deref()
                .is_some_and(|message| message.contains("exceeds 256")));
            assert!(overflow.migration_source.is_some());
            assert!(store.color_rules_migration_dirty());
            commit_color_rule_startup_migration(&mut store).expect("persist count diagnostic");
            let reloaded = MetadataStore::load_from(path.clone()).expect("reload count diagnostic");
            assert_eq!(reloaded.color_rules, store.color_rules);
            assert!(!reloaded.color_rules_migration_dirty());
        }
        let _ = fs::remove_file(path);
    }
}

#[test]
fn migration_enforces_unicode_name_limit_for_v2_and_legacy_rows_idempotently() {
    for (label, row) in [
        (
            "long-v2-name",
            json!({
                "schemaVersion": 2,
                "id": "long-v2",
                "name": "界".repeat(129),
                "enabled": true,
                "target": "file",
                "expression": "*.txt",
                "caseSensitive": false,
                "foregroundColorHex": "#112233",
                "backgroundColorHex": null,
                "priority": 1
            }),
        ),
        (
            "long-legacy-name",
            json!({
                "id": "long-legacy",
                "name": "界".repeat(129),
                "mode": "extension",
                "pattern": "txt",
                "colorHex": "#112233",
                "priority": 1
            }),
        ),
    ] {
        let path = temp_file(label);
        fs::write(
            &path,
            serde_json::to_vec(&json!({"colorRuleSchemaVersion":2,"colorRules":[row]})).unwrap(),
        )
        .expect("write name fixture");

        let mut store = MetadataStore::load_from(path.clone()).expect("load name fixture");
        assert_eq!(store.color_rules[0].name.chars().count(), 128);
        assert!(!store.color_rules[0].enabled);
        assert!(store.color_rules[0]
            .migration_diagnostic
            .as_deref()
            .is_some_and(|message| message.contains("name exceeds 128")));
        assert!(store.color_rules[0].migration_source.is_some());
        commit_color_rule_startup_migration(&mut store).expect("persist name diagnostic");
        let reloaded = MetadataStore::load_from(path.clone()).expect("reload name diagnostic");
        assert_eq!(reloaded.color_rules, store.color_rules);
        assert!(!reloaded.color_rules_migration_dirty());
        let _ = fs::remove_file(path);
    }
}

#[test]
fn migrated_windows_path_contains_rule_matches_backslash_paths() {
    let path = temp_file("legacy-windows-path");
    fs::write(
        &path,
        r##"{"colorRules":[{"id":"archive","name":"Archive","mode":"pathContains","pattern":"C:\\work\\Archive","colorHex":"#112233","priority":1}]}"##,
    )
    .expect("write legacy path rule");
    let store = MetadataStore::load_from(path.clone()).expect("migrate path rule");
    let facts = EntryFacts {
        name: "report.txt".into(),
        path: r"C:\work\Archive\report.txt".into(),
        extension: Some(".txt".into()),
        kind: EntryKind::File,
        size: Some(1),
        created_at: None,
        modified_at: None,
        accessed_at: None,
        attributes: AttributeFacts::default(),
    };
    assert!(compile_rules(&store.color_rules, chrono::Utc::now())
        .style_for(&facts)
        .is_some());
    let _ = fs::remove_file(path);
}

#[test]
fn empty_legacy_extension_patterns_migrate_to_the_empty_extension() {
    for pattern in ["", ".", "..."] {
        let path = temp_file("empty-extension");
        fs::write(
            &path,
            format!(
                r##"{{"colorRules":[{{"id":"empty","name":"Empty","mode":"extension","pattern":"{pattern}","colorHex":"#112233","priority":1}}]}}"##
            ),
        )
        .expect("write legacy extension rule");
        let store = MetadataStore::load_from(path.clone()).expect("migrate extension rule");
        assert_eq!(store.color_rules[0].expression, "Extension == \"\"");
        let _ = fs::remove_file(path);
    }
}

#[test]
fn mixed_v2_and_legacy_signatures_use_v2_fields_and_record_ignored_legacy_fields() {
    let path = temp_file("mixed-signature");
    fs::write(
        &path,
        r##"{
          "colorRuleSchemaVersion":2,
          "colorRules":[{
            "id":"mixed","name":"Mixed","enabled":true,"target":"file",
            "expression":"*.log","caseSensitive":true,
            "foregroundColorHex":"#112233","backgroundColorHex":null,"priority":7,
            "mode":"extension","pattern":"txt","colorHex":"#ffffff"
          }]
        }"##,
    )
    .expect("write mixed signature metadata");

    let mut store = MetadataStore::load_from(path.clone()).expect("load mixed signature rule");
    let rule = &store.color_rules[0];
    assert_eq!(rule.id, "mixed");
    assert_eq!(rule.expression, "*.log");
    assert!(rule.case_sensitive);
    assert_eq!(rule.foreground_color_hex.as_deref(), Some("#112233"));
    assert!(rule
        .migration_diagnostic
        .as_deref()
        .is_some_and(|message| message.contains("mode") && message.contains("pattern")));
    assert!(store.color_rules_migration_dirty());

    commit_color_rule_startup_migration(&mut store).expect("persist mixed signature normalization");
    let reloaded = MetadataStore::load_from(path.clone()).expect("reload mixed signature rule");
    assert!(!reloaded.color_rules_migration_dirty());
    assert_eq!(reloaded.color_rules[0].expression, "*.log");
    assert!(reloaded.color_rules[0].migration_diagnostic.is_some());
    let _ = fs::remove_file(path);
}

#[test]
fn malformed_v2_row_keeps_valid_identity_and_does_not_block_neighboring_rows() {
    let path = temp_file("isolated-malformed-row");
    fs::write(
        &path,
        r##"{
          "colorRuleSchemaVersion":2,
          "colorRules":[
            {"schemaVersion":2,"id":"good","name":"Good","enabled":true,"target":"file","expression":"*.txt","caseSensitive":false,"foregroundColorHex":"#123456","backgroundColorHex":null,"priority":1},
            {"schemaVersion":2,"id":"repair-me","name":"Repair Me","enabled":"yes","target":"file","expression":"*.log","caseSensitive":false,"foregroundColorHex":"#654321","backgroundColorHex":null,"priority":2}
          ]
        }"##,
    )
    .expect("write malformed V2 row");

    let store = MetadataStore::load_from(path.clone()).expect("load rows independently");
    assert_eq!(store.color_rules.len(), 2);
    assert!(store
        .color_rules
        .iter()
        .any(|rule| rule.id == "good" && rule.enabled));
    let malformed = store
        .color_rules
        .iter()
        .find(|rule| rule.id == "repair-me")
        .expect("retain repairable identity");
    assert_eq!(malformed.name, "Repair Me");
    assert!(!malformed.enabled);
    assert!(malformed.migration_diagnostic.is_some());
    let _ = fs::remove_file(path);
}

#[test]
fn persisted_rules_over_the_text_scan_budget_become_repairable_disabled_rows() {
    let path = temp_file("text-scan-budget");
    let rows = (0..17)
        .map(|index| {
            json!({
                "schemaVersion": 2,
                "id": format!("scan-{index}"),
                "name": format!("Scan {index}"),
                "enabled": true,
                "target": "any",
                "expression": "Path == \"*?archive*\"",
                "caseSensitive": false,
                "foregroundColorHex": "#123456",
                "backgroundColorHex": null,
                "priority": index + 1
            })
        })
        .collect::<Vec<_>>();
    fs::write(
        &path,
        serde_json::to_vec_pretty(&json!({
            "colorRuleSchemaVersion": 2,
            "colorRules": rows
        }))
        .unwrap(),
    )
    .expect("write over-budget rules");

    let mut store = MetadataStore::load_from(path.clone()).expect("load over-budget rules");
    assert_eq!(
        store.color_rules.iter().filter(|rule| rule.enabled).count(),
        16
    );
    let overflow = &store.color_rules[16];
    assert!(!overflow.enabled);
    assert!(overflow
        .migration_diagnostic
        .as_deref()
        .is_some_and(|message| message.contains("16") && message.contains("Name/Extension/Path")));
    assert!(overflow.migration_source.is_some());
    assert!(store.color_rules_migration_dirty());

    commit_color_rule_startup_migration(&mut store).expect("persist budget recovery");
    let reloaded = MetadataStore::load_from(path.clone()).expect("reload budget recovery");
    assert_eq!(
        reloaded
            .color_rules
            .iter()
            .filter(|rule| rule.enabled)
            .count(),
        16
    );
    assert!(!reloaded.color_rules_migration_dirty());
    let _ = fs::remove_file(path);
}

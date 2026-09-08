use std::{
    cell::Cell,
    fs,
    path::PathBuf,
    sync::{mpsc, Arc, RwLock},
    thread,
};

use super::{emit_changed_with, replace_rules_in_store, set_enabled_in_store};
use crate::{
    domain::color_filter::{
        ColorRuleInput, ColorRuleTarget, ReplaceColorRulesRequest, ReplaceColorRulesResult,
    },
    services::metadata_store::MetadataStore,
};

fn store(name: &str) -> MetadataStore {
    store_with_path(name).0
}

fn store_with_path(name: &str) -> (MetadataStore, PathBuf) {
    let path = std::env::temp_dir().join(format!(
        "athenaeum-color-command-{name}-{}.json",
        uuid::Uuid::new_v4()
    ));
    (
        MetadataStore::load_from(path.clone()).expect("create metadata store"),
        path,
    )
}

fn input(id: &str, expression: &str) -> ColorRuleInput {
    ColorRuleInput {
        id: id.into(),
        name: id.into(),
        enabled: true,
        target: ColorRuleTarget::Any,
        expression: expression.into(),
        case_sensitive: false,
        foreground_color_hex: Some("#112233".into()),
        background_color_hex: None,
    }
}

fn request(id: &str, base_rules_revision: &str) -> ReplaceColorRulesRequest {
    ReplaceColorRulesRequest {
        rules: vec![input(id, "*.txt")],
        base_rules_revision: base_rules_revision.into(),
        force: false,
    }
}

#[test]
fn toggle_changes_only_the_aggregate_revision() {
    let mut metadata = store("toggle");
    let snapshot = set_enabled_in_store(&mut metadata, false).expect("toggle");

    assert!(!snapshot.enabled);
    assert_eq!(snapshot.revision, "1");
    assert_eq!(snapshot.rules_revision, "0");
    assert_eq!(metadata.color_filter_revision, "1");
    assert_eq!(metadata.color_rules_revision, "0");
}

#[test]
fn committed_event_failure_returns_an_observable_warning_without_rolling_back() {
    let (mut metadata, path) = store_with_path("event-failure");
    let snapshot = set_enabled_in_store(&mut metadata, false).expect("commit toggle");
    let attempts = Cell::new(0);

    let warnings = emit_changed_with(|| {
        attempts.set(attempts.get() + 1);
        Err("event channel unavailable".to_string())
    });

    assert_eq!(attempts.get(), 1);
    assert_eq!(warnings.len(), 1);
    assert!(warnings[0].contains("failed to emit color filter change"));
    assert!(warnings[0].contains("event channel unavailable"));
    assert_eq!(snapshot.revision, "1");
    assert!(!metadata.color_filter_enabled);
    let persisted = MetadataStore::load_from(path).expect("reload committed toggle");
    assert!(!persisted.color_filter_enabled);
    assert_eq!(persisted.color_filter_revision, "1");
}

#[test]
fn stale_rule_replacement_conflicts_without_mutating_state() {
    let mut metadata = store("conflict");
    replace_rules_in_store(
        &mut metadata,
        ReplaceColorRulesRequest {
            rules: vec![input("first", "*.txt")],
            base_rules_revision: "0".into(),
            force: false,
        },
    )
    .expect("first replace");

    let result = replace_rules_in_store(
        &mut metadata,
        ReplaceColorRulesRequest {
            rules: vec![input("stale", "*.log")],
            base_rules_revision: "0".into(),
            force: false,
        },
    )
    .expect("typed conflict");

    let ReplaceColorRulesResult::Conflict { snapshot, .. } = result else {
        panic!("expected conflict");
    };
    assert_eq!(snapshot.rules[0].id, "first");
    assert_eq!(metadata.color_filter_revision, "1");
    assert_eq!(metadata.color_rules_revision, "1");
}

#[test]
fn explicit_overwrite_uses_latest_enabled_state_and_increments_both_revisions() {
    let mut metadata = store("overwrite");
    set_enabled_in_store(&mut metadata, false).expect("toggle");

    let result = replace_rules_in_store(
        &mut metadata,
        ReplaceColorRulesRequest {
            rules: vec![input("forced", "Size >= 20MB")],
            base_rules_revision: "99".into(),
            force: true,
        },
    )
    .expect("force replace");

    let ReplaceColorRulesResult::Applied { snapshot, .. } = result else {
        panic!("expected applied");
    };
    assert!(!snapshot.enabled);
    assert_eq!(snapshot.revision, "2");
    assert_eq!(snapshot.rules_revision, "1");
    assert_eq!(snapshot.rules[0].priority, 1);
}

#[test]
fn invalid_enabled_rule_leaves_disk_and_memory_unchanged() {
    let mut metadata = store("invalid");
    let before = metadata.color_filter_snapshot();
    let error = replace_rules_in_store(
        &mut metadata,
        ReplaceColorRulesRequest {
            rules: vec![input("invalid", "Szie >= 20MB")],
            base_rules_revision: "0".into(),
            force: false,
        },
    )
    .expect_err("invalid expression");

    assert!(error.contains("Szie"));
    assert_eq!(metadata.color_filter_snapshot(), before);
}

#[test]
fn future_rule_source_survives_unchanged_save_and_is_removed_after_edit_or_delete() {
    let path = std::env::temp_dir().join(format!(
        "athenaeum-color-command-future-{}.json",
        uuid::Uuid::new_v4()
    ));
    fs::write(
        &path,
        r##"{
          "colorFilterRevision":"4","colorRulesRevision":"3","colorRuleSchemaVersion":2,
          "colorRules":[{
            "schemaVersion":3,"id":"future","name":"Future","enabled":true,
            "target":"file","expression":"*.future","caseSensitive":true,
            "foregroundColorHex":"#123456","backgroundColorHex":null,"priority":1,
            "vendorPayload":{"level":7}
          }]
        }"##,
    )
    .expect("write future metadata");
    let mut metadata = MetadataStore::load_from(path.clone()).expect("load future metadata");
    let placeholder = metadata.color_rules[0].clone();
    let unchanged = ColorRuleInput {
        id: placeholder.id.clone(),
        name: placeholder.name.clone(),
        enabled: placeholder.enabled,
        target: placeholder.target.clone(),
        expression: placeholder.expression.clone(),
        case_sensitive: placeholder.case_sensitive,
        foreground_color_hex: placeholder.foreground_color_hex.clone(),
        background_color_hex: placeholder.background_color_hex.clone(),
    };

    replace_rules_in_store(
        &mut metadata,
        ReplaceColorRulesRequest {
            rules: vec![unchanged.clone()],
            base_rules_revision: "3".into(),
            force: false,
        },
    )
    .expect("save unchanged diagnostic rule");
    let disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        disk["colorRules"][0]["migrationSource"]["vendorPayload"]["level"],
        7
    );
    assert!(metadata.color_rules[0].migration_diagnostic.is_some());

    replace_rules_in_store(
        &mut metadata,
        ReplaceColorRulesRequest {
            rules: vec![ColorRuleInput {
                name: "Repaired".into(),
                ..unchanged
            }],
            base_rules_revision: "4".into(),
            force: false,
        },
    )
    .expect("save edited diagnostic rule");
    let disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert!(disk["colorRules"][0].get("migrationSource").is_none());
    assert!(metadata.color_rules[0].migration_diagnostic.is_none());

    replace_rules_in_store(
        &mut metadata,
        ReplaceColorRulesRequest {
            rules: vec![],
            base_rules_revision: "5".into(),
            force: false,
        },
    )
    .expect("delete repaired diagnostic rule");
    let disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(disk["colorRules"].as_array().map(Vec::len), Some(0));

    let _ = fs::remove_file(path);
}

#[test]
fn disabled_rules_still_enforce_expression_storage_limits() {
    let mut metadata = store("disabled-limits");
    let oversized = ColorRuleInput {
        enabled: false,
        expression: "x".repeat(1025),
        ..input("oversized", "")
    };
    let error = replace_rules_in_store(
        &mut metadata,
        ReplaceColorRulesRequest {
            rules: vec![oversized],
            base_rules_revision: "0".into(),
            force: false,
        },
    )
    .expect_err("disabled expressions must obey storage limits");
    assert!(error.contains("1024"));

    let whitespace_padded = ColorRuleInput {
        enabled: false,
        expression: format!("{}*.txt", " ".repeat(1020)),
        ..input("whitespace-padded", "")
    };
    let error = replace_rules_in_store(
        &mut metadata,
        ReplaceColorRulesRequest {
            rules: vec![whitespace_padded],
            base_rules_revision: "0".into(),
            force: false,
        },
    )
    .expect_err("stored whitespace counts toward the expression limit");
    assert!(error.contains("1024"));

    let disabled_invalid = ColorRuleInput {
        enabled: false,
        expression: "ordinary invalid syntax".into(),
        ..input("disabled-invalid", "")
    };
    assert!(replace_rules_in_store(
        &mut metadata,
        ReplaceColorRulesRequest {
            rules: vec![disabled_invalid],
            base_rules_revision: "0".into(),
            force: false,
        },
    )
    .is_ok());
}

#[test]
fn enabled_text_comparisons_over_the_aggregate_budget_are_rejected_atomically() {
    let (mut metadata, path) = store_with_path("text-scan-budget");
    let before = metadata.color_filter_snapshot();
    let rules = (0..17)
        .map(|index| input(&format!("scan-{index}"), "Path == \"*?archive*\""))
        .collect();

    let error = replace_rules_in_store(
        &mut metadata,
        ReplaceColorRulesRequest {
            rules,
            base_rules_revision: "0".into(),
            force: false,
        },
    )
    .expect_err("aggregate text-scan budget must be enforced");

    assert!(error.contains("16"));
    assert!(error.contains("Name/Extension/Path"));
    assert_eq!(metadata.color_filter_snapshot(), before);
    assert!(!path.exists());
}

#[test]
fn overlong_trimmed_rule_names_return_a_precise_error() {
    let mut metadata = store("name-length");
    let overlong = ColorRuleInput {
        name: format!(" {} ", "x".repeat(129)),
        ..input("overlong-name", "*.txt")
    };
    let error = replace_rules_in_store(
        &mut metadata,
        ReplaceColorRulesRequest {
            rules: vec![overlong],
            base_rules_revision: "0".into(),
            force: false,
        },
    )
    .expect_err("overlong trimmed rule name");

    assert!(error.contains("name exceeds 128 Unicode scalar values"));
}

#[test]
fn toggle_and_rule_replacement_serialize_without_false_conflicts_in_both_lock_orders() {
    for toggle_first in [true, false] {
        let (store, path) = store_with_path(if toggle_first {
            "toggle-first"
        } else {
            "replace-first"
        });
        let metadata = Arc::new(RwLock::new(store));
        let (first_locked_tx, first_locked_rx) = mpsc::channel();
        let (second_attempted_tx, second_attempted_rx) = mpsc::channel();
        let (release_first_tx, release_first_rx) = mpsc::channel();

        let first_store = Arc::clone(&metadata);
        let first = thread::spawn(move || {
            let mut guard = first_store.write().expect("first metadata lock");
            first_locked_tx.send(()).unwrap();
            release_first_rx.recv().unwrap();
            if toggle_first {
                set_enabled_in_store(&mut guard, false).map(|_| ())
            } else {
                replace_rules_in_store(&mut guard, request("first-rule", "0")).map(|_| ())
            }
        });

        first_locked_rx.recv().unwrap();
        let second_store = Arc::clone(&metadata);
        let second = thread::spawn(move || {
            second_attempted_tx.send(()).unwrap();
            let mut guard = second_store.write().expect("second metadata lock");
            if toggle_first {
                replace_rules_in_store(&mut guard, request("second-rule", "0")).map(|_| ())
            } else {
                set_enabled_in_store(&mut guard, false).map(|_| ())
            }
        });
        second_attempted_rx.recv().unwrap();
        release_first_tx.send(()).unwrap();
        first.join().unwrap().expect("first mutation");
        second.join().unwrap().expect("second mutation");

        let guard = metadata.read().expect("final metadata lock");
        assert!(!guard.color_filter_enabled);
        assert_eq!(guard.color_filter_revision, "2");
        assert_eq!(guard.color_rules_revision, "1");
        assert_eq!(guard.color_rules.len(), 1);
        let reloaded = MetadataStore::load_from(path).expect("reload serialized mutations");
        assert_eq!(
            reloaded.color_filter_snapshot(),
            guard.color_filter_snapshot()
        );
    }
}

#[test]
fn racing_rule_replacements_commit_once_and_return_one_conflict() {
    let (store, path) = store_with_path("replace-race");
    let metadata = Arc::new(RwLock::new(store));
    let (first_locked_tx, first_locked_rx) = mpsc::channel();
    let (second_attempted_tx, second_attempted_rx) = mpsc::channel();
    let (release_first_tx, release_first_rx) = mpsc::channel();

    let first_store = Arc::clone(&metadata);
    let first = thread::spawn(move || {
        let mut guard = first_store.write().expect("first metadata lock");
        first_locked_tx.send(()).unwrap();
        release_first_rx.recv().unwrap();
        replace_rules_in_store(&mut guard, request("winner", "0"))
    });
    first_locked_rx.recv().unwrap();

    let second_store = Arc::clone(&metadata);
    let second = thread::spawn(move || {
        second_attempted_tx.send(()).unwrap();
        let mut guard = second_store.write().expect("second metadata lock");
        replace_rules_in_store(&mut guard, request("stale", "0"))
    });
    second_attempted_rx.recv().unwrap();
    release_first_tx.send(()).unwrap();

    assert!(matches!(
        first.join().unwrap().expect("winner replacement"),
        ReplaceColorRulesResult::Applied { .. }
    ));
    assert!(matches!(
        second.join().unwrap().expect("stale replacement"),
        ReplaceColorRulesResult::Conflict { .. }
    ));
    let guard = metadata.read().expect("final metadata lock");
    assert_eq!(guard.color_filter_revision, "1");
    assert_eq!(guard.color_rules_revision, "1");
    assert_eq!(guard.color_rules[0].id, "winner");
    let reloaded = MetadataStore::load_from(path).expect("reload winning replacement");
    assert_eq!(
        reloaded.color_filter_snapshot(),
        guard.color_filter_snapshot()
    );
}

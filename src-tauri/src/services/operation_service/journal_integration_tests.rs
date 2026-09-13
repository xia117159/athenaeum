use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

use super::{journal::journal_backup_path, OperationStore};
use crate::domain::models::{
    OperationIntent, OperationIntentKind, OperationPathRef, OperationRequestSource,
    OperationTaskStatus,
};

fn unique_temp_path(label: &str) -> std::path::PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time went backwards")
        .as_nanos();
    std::env::temp_dir().join(format!("athenaeum-operation-{label}-{unique}"))
}

fn local(path: &std::path::Path) -> OperationPathRef {
    OperationPathRef::Local {
        path: path.to_string_lossy().into_owned(),
    }
}

fn copy_intent(source: &std::path::Path, destination: &std::path::Path) -> OperationIntent {
    OperationIntent {
        request_id: "request-copy".into(),
        source: OperationRequestSource::Paste,
        panel_id: None,
        tab_id: None,
        kind: OperationIntentKind::Copy,
        sources: Some(vec![local(source)]),
        destination: Some(local(destination)),
        source_path: None,
        new_name: None,
        parent: None,
        name: None,
        undo_record_id: None,
        conflict_policy: None,
    }
}

#[test]
fn operation_journal_persists_history_and_undo_payloads() {
    let root = unique_temp_path("journal-roundtrip");
    let source = root.join("source");
    let destination = root.join("destination");
    fs::create_dir_all(&source).expect("create source");
    fs::create_dir_all(&destination).expect("create destination");
    fs::write(source.join("report.txt"), "hello").expect("write source");
    let journal_path = root.join("operation-journal.json");

    let mut store = OperationStore::load_from(journal_path.clone()).expect("load empty journal");
    let result = store.start_operation(
        copy_intent(&source.join("report.txt"), &destination),
        Some(root.clone()),
    );

    assert_eq!(result.snapshot.status, OperationTaskStatus::Succeeded);
    assert!(journal_path.exists());
    assert_eq!(store.list_history().records.len(), 1);

    let mut reloaded = OperationStore::load_from(journal_path).expect("reload journal");
    assert_eq!(reloaded.list_history().records.len(), 1);

    let undo = reloaded
        .undo_latest("request-undo-after-reload".into())
        .expect("undo after reload");
    assert_eq!(undo.snapshot.status, OperationTaskStatus::Succeeded);
    assert!(!destination.join("report.txt").exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn operation_journal_load_recovers_a_missing_canonical_from_backup() {
    let root = unique_temp_path("journal-backup-reload");
    let source = root.join("source");
    let destination = root.join("destination");
    fs::create_dir_all(&source).expect("create source");
    fs::create_dir_all(&destination).expect("create destination");
    fs::write(source.join("report.txt"), "hello").expect("write source");
    let journal_path = root.join("operation-journal.json");
    let mut store = OperationStore::load_from(journal_path.clone()).expect("load journal");
    store.start_operation(
        copy_intent(&source.join("report.txt"), &destination),
        Some(root.clone()),
    );
    let history_before = store.list_history();
    let payload_ids_before = store.undo_payloads.keys().cloned().collect::<Vec<_>>();
    fs::rename(&journal_path, journal_backup_path(&journal_path))
        .expect("simulate missing canonical journal");

    let reloaded = OperationStore::load_from(journal_path.clone()).expect("recover backup");

    assert_eq!(reloaded.list_history(), history_before);
    assert_eq!(
        reloaded.undo_payloads.keys().cloned().collect::<Vec<_>>(),
        payload_ids_before
    );
    assert!(journal_path.exists());
    let _ = fs::remove_dir_all(root);
}

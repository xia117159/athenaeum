use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use super::{
    journal::{UndoAction, UndoPayload},
    OperationStore,
};
use crate::domain::models::{
    OperationClearRequest, OperationClearScope, OperationHistoryRecord, OperationHistoryStatus,
    OperationIntentKind,
};

fn unique_temp_path(label: &str) -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time went backwards")
        .as_nanos();
    std::env::temp_dir().join(format!("athenaeum-operation-{label}-{unique}"))
}

fn insert_history_payload(
    store: &mut OperationStore,
    record_id: &str,
    status: OperationHistoryStatus,
    trash_path: PathBuf,
    original_path: PathBuf,
) {
    let now = chrono::Utc::now();
    store.history.push(OperationHistoryRecord {
        record_id: record_id.into(),
        task_id: record_id.into(),
        kind: OperationIntentKind::Delete,
        label: record_id.into(),
        status,
        created_at: now,
        updated_at: now,
        undo_task_id: None,
        blocked_reason: None,
        payload_expires_at: None,
        affected_roots: Vec::new(),
    });
    store.undo_payloads.insert(
        record_id.into(),
        UndoPayload {
            actions: vec![UndoAction::RestoreTrash {
                trash_path,
                original_path,
            }],
        },
    );
}

#[test]
fn cleanup_protects_retained_payload_referenced_through_a_case_alias() {
    let root = unique_temp_path("cleanup-protected-case-alias");
    let trash_root = root.join("operation-trash");
    let task_root = trash_root.join("task-a");
    let retained_path = task_root.join("Payload.bin");
    let removed_alias = task_root.join("payload.bin");
    fs::create_dir_all(&task_root).expect("create task trash root");
    fs::write(&retained_path, "undo payload").expect("write retained payload");
    assert!(
        removed_alias.exists(),
        "test requires case-insensitive Windows path lookup"
    );
    let mut store = OperationStore::load_from(root.join("operation-journal.json"))
        .expect("create operation store");
    insert_history_payload(
        &mut store,
        "retained",
        OperationHistoryStatus::Undoable,
        retained_path.clone(),
        root.join("retained-original"),
    );
    insert_history_payload(
        &mut store,
        "removed",
        OperationHistoryStatus::Failed,
        removed_alias,
        root.join("removed-original"),
    );

    let outcome = store
        .clear_records(
            OperationClearRequest {
                scope: OperationClearScope::Problems,
                confirm_undo_loss: false,
            },
            Some(&trash_root),
        )
        .expect("clear failed history record");

    assert_eq!(outcome.removed_record_ids, vec!["removed"]);
    assert_eq!(outcome.cleanup_warnings.len(), 1);
    assert!(retained_path.exists(), "retained undo payload must survive");
    assert!(store.undo_payloads.contains_key("retained"));
    let _ = fs::remove_dir_all(root);
}

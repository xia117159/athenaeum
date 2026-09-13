use super::*;
use crate::services::{metadata_store::MetadataStore, settings_store::SettingsStore};

#[path = "recovery_tests.rs"]
mod recovery;

struct Fixture {
    root: PathBuf,
    state: AppState,
    request: CreateTemplateItemsRequest,
}
impl Fixture {
    fn assert_no_visible_copies(&self) {
        use std::os::windows::fs::MetadataExt;
        let visible = fs::read_dir(self.root.join("destination"))
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .metadata()
                    .unwrap()
                    .file_attributes()
                    & 2
                    == 0
            })
            .count();
        assert_eq!(
            visible,
            0,
            "{:?}",
            self.state.operations.lock().unwrap().history
        );
    }
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("sfm-template-task-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("library/project")).unwrap();
        fs::create_dir(root.join("destination")).unwrap();
        fs::write(root.join("library/project/one.txt"), "one").unwrap();
        fs::write(root.join("library/two.txt"), "two").unwrap();
        let state = AppState::new(MetadataStore::default(), SettingsStore::default());
        *state.operations.lock().unwrap() =
            OperationStore::load_from(root.join("history.json")).unwrap();
        let request = CreateTemplateItemsRequest {
            request_id: "create".into(),
            template_root: root.join("library").to_string_lossy().into_owned(),
            relative_paths: vec!["project".into(), "two.txt".into()],
            destination: root.join("destination").to_string_lossy().into_owned(),
            panel_id: None,
            tab_id: None,
        };
        Self {
            root,
            state,
            request,
        }
    }
    fn create(&self) -> OperationServiceResult {
        let (queued, execute) = self
            .state
            .operations
            .lock()
            .unwrap()
            .queue_template_creation(&self.request)
            .unwrap();
        assert!(execute);
        let (duplicate, execute) = self
            .state
            .operations
            .lock()
            .unwrap()
            .queue_template_creation(&self.request)
            .unwrap();
        assert!(!execute);
        assert_eq!(duplicate.snapshot.task_id, queued.snapshot.task_id);
        execute_creation(
            &self.state,
            &queued.snapshot.task_id,
            self.request.clone(),
            &self.request.template_root,
            &|_| {},
        )
        .unwrap();
        queued
    }
    fn undo(&self) {
        let (_, execution) = self
            .state
            .operations
            .lock()
            .unwrap()
            .prepare_undo_latest(Uuid::new_v4().to_string())
            .unwrap();
        execute_workspace_undo(&self.state, execution, &|_| {}).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn template_undone_recovery_survives_reload_and_clear_requires_physical_cleanup_confirmation() {
    use crate::domain::models::{OperationClearRequest, OperationClearScope, OperationClearStatus};
    let f = Fixture::new();
    f.create();
    f.undo();
    let mut store = OperationStore::load_from(f.root.join("history.json")).unwrap();
    let record = &store.history[0];
    assert_eq!(record.status, OperationHistoryStatus::Undone, "{record:?}");
    assert!(
        store.undo_payloads.contains_key(&record.record_id),
        "Undone must retain its recovery assets after restart"
    );
    assert_eq!(record.recovery_items.len(), 2);
    assert!(record
        .recovery_items
        .iter()
        .all(|item| Path::new(&item.recovery_path).exists()));
    let before = fs::read_dir(f.root.join("destination")).unwrap().count();
    let pending = store
        .clear_records(
            OperationClearRequest {
                recovery_confirmation: None,
                scope: OperationClearScope::History,
                confirm_undo_loss: false,
            },
            None,
        )
        .unwrap();
    assert_eq!(pending.status, OperationClearStatus::ConfirmationRequired);
    let value = serde_json::to_value(&pending).unwrap();
    assert_eq!(value["eligibleUndoableCount"], 0);
    assert_eq!(value["eligibleRecoveryCount"], 2);
    assert_eq!(
        fs::read_dir(f.root.join("destination")).unwrap().count(),
        before
    );
    let cleared = store
        .clear_records(
            OperationClearRequest {
                recovery_confirmation: pending.recovery_confirmation,
                scope: OperationClearScope::History,
                confirm_undo_loss: true,
            },
            None,
        )
        .unwrap();
    assert!(
        cleared.cleanup_warnings.is_empty(),
        "{:?}",
        cleared.cleanup_warnings
    );
    assert!(store.history.is_empty());
    assert_eq!(fs::read_dir(f.root.join("destination")).unwrap().count(), 0);
}

#[test]
fn template_task_is_one_durable_undo_record_and_undo_can_retry() {
    let f = Fixture::new();
    f.create();
    {
        let store = f.state.operations.lock().unwrap();
        assert_eq!(store.history.len(), 1);
        assert_eq!(store.history[0].status, OperationHistoryStatus::Undoable);
        assert_eq!(store.tasks[0].entry_results.len(), 2);
    }
    fs::write(f.root.join("destination/project/external.txt"), "external").unwrap();
    f.undo();
    assert!(
        f.root.join("destination/two.txt").exists(),
        "batch preflight prevents partial deletion on validation failure"
    );
    assert_eq!(
        f.state.operations.lock().unwrap().history[0].status,
        OperationHistoryStatus::Undoable
    );
    fs::remove_file(f.root.join("destination/project/external.txt")).unwrap();
    *f.state.operations.lock().unwrap() =
        OperationStore::load_from(f.root.join("history.json")).unwrap();
    f.undo();
    f.assert_no_visible_copies();
    assert_eq!(
        f.state.operations.lock().unwrap().history[0].status,
        OperationHistoryStatus::Undone
    );
    assert!(f.root.join("library/project/one.txt").exists());
}

#[test]
fn template_undoing_journal_failure_never_starts_deleting() {
    let f = Fixture::new();
    f.create();
    let mut store = f.state.operations.lock().unwrap();
    store.journal_persist_failure_for_test = Some(JournalPersistStep::TempWrite);
    assert!(store.prepare_undo_latest("undo-fail".into()).is_err());
    assert_eq!(store.history[0].status, OperationHistoryStatus::Undoable);
    assert!(f.root.join("destination/two.txt").exists());
}

#[test]
fn template_creation_history_write_failure_reports_created_copies() {
    let f = Fixture::new();
    f.state
        .operations
        .lock()
        .unwrap()
        .journal_persist_failure_for_test = Some(JournalPersistStep::TempWrite);
    f.create();
    let store = f.state.operations.lock().unwrap();
    assert!(store.tasks[0]
        .message
        .as_deref()
        .unwrap_or("")
        .contains("历史保存失败"));
    assert_eq!(store.history.len(), 1);
    assert_eq!(store.tasks[0].entry_results.len(), 2);
    assert!(f.root.join("destination/two.txt").exists());
}

#[test]
fn template_creation_emits_without_holding_the_operation_store() {
    let f = Fixture::new();
    let (queued, _) = f
        .state
        .operations
        .lock()
        .unwrap()
        .queue_template_creation(&f.request)
        .unwrap();
    execute_creation(
        &f.state,
        &queued.snapshot.task_id,
        f.request.clone(),
        &f.request.template_root,
        &|_| {
            assert!(
                f.state.operations.try_lock().is_ok(),
                "event consumers must be able to access tasks"
            );
        },
    )
    .unwrap();
}

#[test]
fn template_undo_delete_phase_refuses_late_cancellation() {
    let f = Fixture::new();
    f.create();
    let (_, execution) = f
        .state
        .operations
        .lock()
        .unwrap()
        .prepare_undo_latest("undo".into())
        .unwrap();
    execute_workspace_undo(&f.state, execution, &|event| {
        if event.snapshot.message.as_deref() == Some("正在移除副本…") {
            let mut store = f.state.operations.lock().unwrap();
            let task = store.cancel_task(&event.snapshot.task_id).unwrap();
            assert_eq!(task.snapshot.status, OperationTaskStatus::Running);
            assert!(!store
                .operation_cancellation(&event.snapshot.task_id)
                .unwrap()
                .load(Ordering::SeqCst));
        }
    })
    .unwrap();
    f.assert_no_visible_copies();
}

#[test]
fn template_interrupted_undo_reloads_and_handles_already_removed_members() {
    let f = Fixture::new();
    f.create();
    let _prepared = f
        .state
        .operations
        .lock()
        .unwrap()
        .prepare_undo_latest("interrupted".into())
        .unwrap();
    fs::remove_file(f.root.join("destination/project/one.txt")).unwrap();
    fs::remove_file(f.root.join("destination/two.txt")).unwrap();
    *f.state.operations.lock().unwrap() =
        OperationStore::load_from(f.root.join("history.json")).unwrap();
    assert_eq!(
        f.state.operations.lock().unwrap().history[0].status,
        OperationHistoryStatus::Undoable
    );
    f.undo();
    f.assert_no_visible_copies();
}

#[test]
fn template_final_undo_journal_failure_retains_retry_payload_after_restart() {
    let f = Fixture::new();
    f.create();
    let (_, execution) = f
        .state
        .operations
        .lock()
        .unwrap()
        .prepare_undo_latest("undo".into())
        .unwrap();
    execute_workspace_undo(&f.state, execution, &|event| {
        // The prepared-location checkpoint succeeds; only the final commit fails.
        if event.snapshot.message.as_deref() == Some("正在移除副本…") {
            f.state
                .operations
                .lock()
                .unwrap()
                .journal_persist_failure_for_test = Some(JournalPersistStep::TempWrite);
        }
    })
    .unwrap();
    {
        let store = f.state.operations.lock().unwrap();
        assert_eq!(store.history[0].status, OperationHistoryStatus::Undoable);
        assert!(store.history[0]
            .blocked_reason
            .as_deref()
            .unwrap()
            .contains("撤销历史保存失败"));
        assert!(store
            .undo_payloads
            .contains_key(&store.history[0].record_id));
        assert_eq!(
            store.history[0].recovery_items.len(),
            2,
            "failed final commit must still publish the actual recovery locations"
        );
    }
    f.assert_no_visible_copies();
    *f.state.operations.lock().unwrap() =
        OperationStore::load_from(f.root.join("history.json")).unwrap();
    assert_eq!(
        f.state.operations.lock().unwrap().history[0]
            .recovery_items
            .len(),
        2,
        "a prepared journal must recover display locations before the next undo attempt"
    );
    f.undo();
    assert_eq!(
        f.state.operations.lock().unwrap().history[0].status,
        OperationHistoryStatus::Undone
    );
}

#[test]
fn template_undo_checksum_cancellation_preserves_the_whole_batch_and_history() {
    let mut f = Fixture::new();
    f.request.relative_paths.reverse();
    f.create();
    let (_, execution) = f
        .state
        .operations
        .lock()
        .unwrap()
        .prepare_undo_latest("undo-cancel".into())
        .unwrap();
    let id = execution.task_id.clone();
    execute_workspace_undo(&f.state, execution, &|event| {
        if event.snapshot.cancelable && event.snapshot.completed_bytes.unwrap_or(0) > 0 {
            f.state.operations.lock().unwrap().cancel_task(&id);
        }
    })
    .unwrap();
    assert!(f.root.join("destination/project/one.txt").exists());
    assert!(f.root.join("destination/two.txt").exists());
    let store = f.state.operations.lock().unwrap();
    assert_eq!(
        store
            .tasks
            .iter()
            .find(|task| task.task_id == id)
            .unwrap()
            .status,
        OperationTaskStatus::Cancelled
    );
    assert_eq!(store.history[0].status, OperationHistoryStatus::Undoable);
}

#[test]
fn template_clearing_history_never_cleans_user_copies() {
    use crate::domain::models::{OperationClearRequest, OperationClearScope, OperationClearStatus};
    let f = Fixture::new();
    f.create();
    let result = f
        .state
        .operations
        .lock()
        .unwrap()
        .clear_records(
            OperationClearRequest {
                recovery_confirmation: None,
                scope: OperationClearScope::All,
                confirm_undo_loss: true,
            },
            Some(&f.root.join("trash")),
        )
        .unwrap();
    assert_eq!(result.status, OperationClearStatus::Cleared);
    assert!(f.state.operations.lock().unwrap().history.is_empty());
    assert_eq!(
        fs::read_to_string(f.root.join("destination/project/one.txt")).unwrap(),
        "one"
    );
    assert_eq!(
        fs::read_to_string(f.root.join("destination/two.txt")).unwrap(),
        "two"
    );
}

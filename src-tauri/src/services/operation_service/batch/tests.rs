use super::*;
use crate::domain::models::{OperationClearRequest, OperationClearScope, OperationRequestSource};
use crate::services::batch_rename::{
    native, plan,
    transaction::{self, recovery::RecoveryLog, Checkpoint},
};

struct Fixture {
    root: PathBuf,
    journal: PathBuf,
    logs: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("athenaeum-batch-store-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("a.txt"), "A").unwrap();
        fs::write(root.join("b.txt"), "B").unwrap();
        Self {
            journal: root.join("operation-journal.json"),
            logs: root.join("batch-rename-recovery"),
            root,
        }
    }
    fn store(&self) -> OperationStore {
        let mut store = OperationStore::load_from(self.journal.clone()).unwrap();
        store.persist_journal().unwrap();
        store
    }
    fn plan(&self) -> RenamePlan {
        let sources = ["a.txt", "b.txt"]
            .iter()
            .map(|name| native::snapshot(&self.root.join(name)).unwrap())
            .collect::<Vec<_>>();
        plan::plan_names(
            &sources,
            vec![Ok("new-a.txt".into()), Ok("new-b.txt".into())],
        )
        .1
        .unwrap()
    }
    fn intent(&self) -> OperationIntent {
        OperationIntent {
            request_id: Uuid::new_v4().to_string(),
            source: OperationRequestSource::Shortcut,
            panel_id: Some("panel-1".into()),
            tab_id: Some("tab-1".into()),
            kind: OperationIntentKind::Rename,
            sources: Some(
                ["a.txt", "b.txt"]
                    .iter()
                    .map(|name| OperationPathRef::Local {
                        path: self.root.join(name).to_string_lossy().into_owned(),
                    })
                    .collect(),
            ),
            destination: None,
            source_path: None,
            new_name: None,
            parent: None,
            name: None,
            undo_record_id: None,
            conflict_policy: None,
        }
    }
    fn execute(&self, store: &mut OperationStore, payload: BatchPayload) -> OperationServiceResult {
        let before = payload
            .entries
            .iter()
            .map(|entry| entry.current_path.clone())
            .collect::<Vec<_>>();
        let _ = store.mark_operation_running(&payload.attempt_task_id);
        let outcome = transaction::run(
            payload,
            &self.logs,
            &AtomicBool::new(false),
            &mut |payload| store.commit_batch_success(payload).map(|_| ()),
            &mut |_, _| Ok(()),
        );
        store.finish_batch(outcome, &before).unwrap()
    }
    fn forward(&self, store: &mut OperationStore) -> OperationServiceResult {
        let (_, payload) = store.queue_batch(self.intent(), &self.plan()).unwrap();
        self.execute(store, payload.unwrap())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

fn seed(store: &mut OperationStore, payload: BatchPayload, status: OperationHistoryStatus) {
    store.history.push(OperationHistoryRecord {
        record_id: payload.batch_id.clone(),
        task_id: payload.task_id.clone(),
        kind: OperationIntentKind::Rename,
        label: "批量重命名 2 个项目".into(),
        status,
        created_at: payload.created_at,
        updated_at: Utc::now(),
        undo_task_id: None,
        blocked_reason: None,
        payload_expires_at: None,
        affected_roots: vec![],
    });
    store.undo_payloads.insert(
        payload.batch_id.clone(),
        UndoPayload {
            actions: vec![UndoAction::BatchRename {
                payload: Box::new(payload),
            }],
        },
    );
    store.persist_journal().unwrap();
}

#[test]
fn a_batch_has_one_durable_history_record_and_one_retryable_undo() {
    let fixture = Fixture::new();
    let mut store = fixture.store();
    let result = fixture.forward(&mut store);
    assert_eq!(result.snapshot.status, OperationTaskStatus::Succeeded);
    assert_eq!(store.history.len(), 1);
    assert_eq!(store.history[0].status, OperationHistoryStatus::Undoable);
    let id = store.history[0].record_id.clone();
    drop(store);
    let mut store = OperationStore::load_from(fixture.journal.clone()).unwrap();
    fs::write(fixture.root.join("a.txt"), "external occupant").unwrap();
    let (_, undo) = store
        .prepare_undo_record(id.clone(), Uuid::new_v4().to_string())
        .unwrap();
    assert!(
        store.undo_payloads.get(&id).unwrap().batch().is_some(),
        "starting undo must not remove the payload"
    );
    let failed = fixture.execute(&mut store, undo.payload.batch().unwrap().clone());
    assert_eq!(failed.snapshot.status, OperationTaskStatus::Failed);
    assert_eq!(store.history[0].status, OperationHistoryStatus::Undoable);
    fs::remove_file(fixture.root.join("a.txt")).unwrap();
    let (_, undo) = store
        .prepare_undo_record(id, Uuid::new_v4().to_string())
        .unwrap();
    let restored = fixture.execute(&mut store, undo.payload.batch().unwrap().clone());
    assert_eq!(restored.snapshot.status, OperationTaskStatus::Succeeded);
    assert_eq!(store.history[0].status, OperationHistoryStatus::Undone);
    assert_eq!(fs::read_to_string(fixture.root.join("a.txt")).unwrap(), "A");
    assert_eq!(fs::read_to_string(fixture.root.join("b.txt")).unwrap(), "B");
}

#[test]
fn reloading_an_interrupted_batch_undo_preserves_the_payload() {
    let fixture = Fixture::new();
    let mut store = fixture.store();
    let payload = BatchPayload::forward(
        &fixture.plan(),
        &Uuid::new_v4().to_string(),
        &Uuid::new_v4().to_string(),
    );
    let id = payload.batch_id.clone();
    seed(&mut store, payload, OperationHistoryStatus::Undoing);
    let restored = OperationStore::load_from(fixture.journal.clone()).unwrap();
    assert_eq!(restored.history[0].status, OperationHistoryStatus::Undoable);
    assert!(restored.undo_payloads.get(&id).unwrap().batch().is_some());
}

#[test]
fn clearing_history_protects_recovery_and_committed_records_with_remaining_logs() {
    for recovery in [false, true] {
        let fixture = Fixture::new();
        let mut store = fixture.store();
        let mut payload = BatchPayload::forward(
            &fixture.plan(),
            &Uuid::new_v4().to_string(),
            &Uuid::new_v4().to_string(),
        );
        payload.pending_recovery = recovery;
        if !recovery {
            payload.committed_attempts.push(payload.attempt_id.clone());
        }
        let id = payload.batch_id.clone();
        let log = RecoveryLog::create(&fixture.logs, &payload).unwrap();
        drop(log);
        seed(&mut store, payload, OperationHistoryStatus::Undoable);
        let cleared = store
            .clear_records(
                OperationClearRequest {
                    scope: OperationClearScope::All,
                    confirm_undo_loss: true,
                },
                None,
            )
            .unwrap();
        assert!(cleared.removed_record_ids.is_empty());
        assert!(cleared.protected_record_ids.contains(&id));
        assert_eq!(fs::read_to_string(fixture.root.join("a.txt")).unwrap(), "A");
    }
}

#[test]
fn failed_history_commit_cannot_report_success_or_lose_names() {
    let fixture = Fixture::new();
    let mut store = fixture.store();
    let (_, payload) = store
        .queue_batch(fixture.intent(), &fixture.plan())
        .unwrap();
    store.journal_persist_failure_for_test = Some(JournalPersistStep::CommitReplace);
    let result = fixture.execute(&mut store, payload.unwrap());
    assert_eq!(result.snapshot.status, OperationTaskStatus::Failed);
    assert!(store.history.is_empty());
    assert_eq!(fs::read_to_string(fixture.root.join("a.txt")).unwrap(), "A");
    assert_eq!(fs::read_to_string(fixture.root.join("b.txt")).unwrap(), "B");
}

#[test]
fn restored_undo_keeps_its_log_until_the_new_mapping_is_durable() {
    let fixture = Fixture::new();
    let mut store = fixture.store();
    assert_eq!(
        fixture.forward(&mut store).snapshot.status,
        OperationTaskStatus::Succeeded
    );
    let id = store.history[0].record_id.clone();
    let (_, undo) = store
        .prepare_undo_record(id.clone(), Uuid::new_v4().to_string())
        .unwrap();
    let payload = undo.batch_payload().unwrap();
    let log_path = recovery::log_path(&fixture.logs, &payload.attempt_id).unwrap();
    let before = payload
        .entries
        .iter()
        .map(|entry| entry.current_path.clone())
        .collect::<Vec<_>>();
    store.journal_persist_failure_for_test = Some(JournalPersistStep::CommitReplace);
    let outcome = transaction::run(
        payload,
        &fixture.logs,
        &AtomicBool::new(false),
        &mut |payload| store.commit_batch_success(payload).map(|_| ()),
        &mut |point, _| {
            if point == Checkpoint::AfterRename {
                bail!("injected undo interruption");
            }
            Ok(())
        },
    );
    assert!(outcome.restored);
    let result = store.finish_batch(outcome, &before).unwrap();
    assert_eq!(result.snapshot.status, OperationTaskStatus::Failed);
    assert!(
        log_path.exists(),
        "a RAM-only acknowledgment must not delete the durable recovery mapping"
    );
    let cleared = store
        .clear_records(
            OperationClearRequest {
                scope: OperationClearScope::All,
                confirm_undo_loss: true,
            },
            None,
        )
        .unwrap();
    assert!(cleared.protected_record_ids.contains(&id));
    drop(store);
    let reloaded = OperationStore::load_from(fixture.journal.clone()).unwrap();
    assert_eq!(reloaded.history[0].status, OperationHistoryStatus::Undoable);
    assert!(
        !log_path.exists(),
        "cleanup becomes safe after persisting the restored mapping"
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("new-a.txt")).unwrap(),
        "A"
    );
}

#[test]
fn workspace_undo_dispatch_restores_the_entire_batch() {
    let fixture = Fixture::new();
    let state = crate::services::AppState::new(
        crate::services::metadata_store::MetadataStore::load_default(),
        crate::services::settings_store::SettingsStore::load_default(),
    );
    *state.operations.lock().unwrap() = fixture.store();
    let (_, payload) = state
        .operations
        .lock()
        .unwrap()
        .queue_batch(fixture.intent(), &fixture.plan())
        .unwrap();
    assert_eq!(
        execute_batch(&state, payload.unwrap(), &|_| {})
            .unwrap()
            .snapshot
            .status,
        OperationTaskStatus::Succeeded
    );
    let (_, undo) = state
        .operations
        .lock()
        .unwrap()
        .prepare_undo_latest(Uuid::new_v4().to_string())
        .unwrap();
    execute_workspace_undo(&state, undo, &|_| {}).unwrap();
    assert_eq!(fs::read_to_string(fixture.root.join("a.txt")).unwrap(), "A");
    assert_eq!(fs::read_to_string(fixture.root.join("b.txt")).unwrap(), "B");
    assert_eq!(
        state.operations.lock().unwrap().history[0].status,
        OperationHistoryStatus::Undone
    );
}

#[test]
fn repeated_batch_cancellation_waits_for_the_worker_to_finish() {
    let fixture = Fixture::new();
    let mut store = fixture.store();
    let (queued, _) = store
        .queue_batch(fixture.intent(), &fixture.plan())
        .unwrap();
    let id = queued.snapshot.task_id;
    store.mark_operation_running(&id);
    assert_eq!(
        store.cancel_task(&id).unwrap().snapshot.status,
        OperationTaskStatus::Cancelling
    );
    assert_eq!(
        store.cancel_task(&id).unwrap().snapshot.status,
        OperationTaskStatus::Cancelling
    );
    assert!(store.operation_cancellation(&id).is_some());
}

#[test]
fn restart_imports_a_partial_forward_attempt_as_a_recovery_action() {
    let fixture = Fixture::new();
    let mut store = fixture.store();
    let (_, payload) = store
        .queue_batch(fixture.intent(), &fixture.plan())
        .unwrap();
    let payload = payload.unwrap();
    let id = payload.batch_id.clone();
    let interrupted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        transaction::run(
            payload,
            &fixture.logs,
            &AtomicBool::new(false),
            &mut |_| Ok(()),
            &mut |point, _| {
                if point == Checkpoint::AfterRename {
                    panic!("simulate process interruption");
                }
                Ok(())
            },
        )
    }));
    assert!(interrupted.is_err());
    drop(store);
    let mut recovered = OperationStore::load_from(fixture.journal.clone()).unwrap();
    assert_eq!(recovered.history.len(), 1);
    assert_eq!(
        recovered.history[0].status,
        OperationHistoryStatus::Undoable
    );
    assert!(recovered.history[0].label.contains("恢复"));
    let (_, undo) = recovered
        .prepare_undo_record(id, Uuid::new_v4().to_string())
        .unwrap();
    let result = fixture.execute(&mut recovered, undo.payload.batch().unwrap().clone());
    assert_eq!(result.snapshot.status, OperationTaskStatus::Succeeded);
    assert_eq!(fs::read_to_string(fixture.root.join("a.txt")).unwrap(), "A");
    assert_eq!(fs::read_to_string(fixture.root.join("b.txt")).unwrap(), "B");
}

#[test]
fn committed_forward_and_undo_logs_cannot_resurrect_a_cleared_or_undone_batch() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = Fixture::new();
    let mut store = fixture.store();
    let (_, payload) = store
        .queue_batch(fixture.intent(), &fixture.plan())
        .unwrap();
    let payload = payload.unwrap();
    let id = payload.batch_id.clone();
    let before = payload
        .entries
        .iter()
        .map(|entry| entry.current_path.clone())
        .collect::<Vec<_>>();
    let mut forward_lock = None;
    store.mark_operation_running(&payload.attempt_task_id);
    let outcome = transaction::run(
        payload,
        &fixture.logs,
        &AtomicBool::new(false),
        &mut |payload| store.commit_batch_success(payload).map(|_| ()),
        &mut |point, state| {
            if point == Checkpoint::BeforeCommit {
                forward_lock = Some(
                    fs::OpenOptions::new()
                        .read(true)
                        .share_mode(3)
                        .open(transaction::recovery::log_path(
                            &fixture.logs,
                            &state.attempt_id,
                        )?)
                        .unwrap(),
                );
            }
            Ok(())
        },
    );
    assert!(outcome.committed);
    assert!(outcome.cleanup_warning.is_some());
    store.finish_batch(outcome, &before).unwrap();
    let request_id = Uuid::new_v4().to_string();
    let (_, undo) = store
        .prepare_undo_record(id.clone(), request_id.clone())
        .unwrap();
    let (_, duplicate) = store.prepare_undo_record(id.clone(), request_id).unwrap();
    assert!(duplicate.already_started);
    let payload = undo.payload.batch().unwrap().clone();
    let before = payload
        .entries
        .iter()
        .map(|entry| entry.current_path.clone())
        .collect::<Vec<_>>();
    let mut undo_lock = None;
    let outcome = transaction::run(
        payload,
        &fixture.logs,
        &AtomicBool::new(false),
        &mut |payload| store.commit_batch_success(payload).map(|_| ()),
        &mut |point, state| {
            if point == Checkpoint::BeforeCommit {
                undo_lock = Some(
                    fs::OpenOptions::new()
                        .read(true)
                        .share_mode(3)
                        .open(transaction::recovery::log_path(
                            &fixture.logs,
                            &state.attempt_id,
                        )?)
                        .unwrap(),
                );
            }
            Ok(())
        },
    );
    assert!(outcome.committed);
    assert!(outcome.cleanup_warning.is_some());
    store.finish_batch(outcome, &before).unwrap();
    let cleared = store
        .clear_records(
            OperationClearRequest {
                scope: OperationClearScope::All,
                confirm_undo_loss: true,
            },
            None,
        )
        .unwrap();
    assert!(cleared.protected_record_ids.contains(&id));
    assert_eq!(store.history[0].status, OperationHistoryStatus::Undone);
    drop(forward_lock);
    drop(undo_lock);
    drop(store);
    let mut reloaded = OperationStore::load_from(fixture.journal.clone()).unwrap();
    assert_eq!(reloaded.history.len(), 1);
    assert_eq!(reloaded.history[0].status, OperationHistoryStatus::Undone);
    assert!(fixture.logs.read_dir().unwrap().next().is_none());
    let cleared = reloaded
        .clear_records(
            OperationClearRequest {
                scope: OperationClearScope::All,
                confirm_undo_loss: true,
            },
            None,
        )
        .unwrap();
    assert!(cleared.removed_record_ids.contains(&id));
    assert_eq!(fs::read_to_string(fixture.root.join("a.txt")).unwrap(), "A");
}

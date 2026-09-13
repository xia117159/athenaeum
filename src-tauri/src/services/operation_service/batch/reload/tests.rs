use super::*;
use crate::domain::models::{OperationClearRequest, OperationClearScope, OperationRequestSource};
use crate::services::batch_rename::{
    plan,
    transaction::{self, Checkpoint},
};

struct Fixture {
    root: PathBuf,
    data: PathBuf,
    journal: PathBuf,
    logs: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("athenaeum-reload-{}", Uuid::new_v4()));
        let data = root.join("data");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("a.txt"), "A").unwrap();
        fs::write(data.join("b.txt"), "B").unwrap();
        Self {
            journal: root.join("operation-journal.json"),
            logs: root.join("batch-rename-recovery"),
            root,
            data,
        }
    }
    fn load(&self) -> OperationStore {
        OperationStore::load_from(self.journal.clone()).unwrap()
    }
    fn queued(&self) -> (OperationStore, BatchPayload) {
        let mut store = self.load();
        store.persist_journal().unwrap();
        let sources = ["a.txt", "b.txt"]
            .iter()
            .map(|name| native::snapshot(&self.data.join(name)).unwrap())
            .collect::<Vec<_>>();
        let plan = plan::plan_names(
            &sources,
            vec![Ok("new-a.txt".into()), Ok("new-b.txt".into())],
        )
        .1
        .unwrap();
        let intent = OperationIntent {
            request_id: Uuid::new_v4().to_string(),
            source: OperationRequestSource::Shortcut,
            panel_id: Some("panel-1".into()),
            tab_id: Some("tab-1".into()),
            kind: OperationIntentKind::Rename,
            sources: None,
            destination: None,
            source_path: None,
            new_name: None,
            parent: None,
            name: None,
            undo_record_id: None,
            conflict_policy: None,
        };
        let (_, payload) = store.queue_batch(intent, &plan).unwrap();
        (store, payload.unwrap())
    }
    fn interrupt_payload(&self, payload: BatchPayload, checkpoint: Checkpoint) {
        let interrupted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            transaction::run(
                payload,
                &self.logs,
                &AtomicBool::new(false),
                &mut |_| Ok(()),
                &mut |point, _| {
                    if point == checkpoint {
                        panic!("simulate process interruption");
                    }
                    Ok(())
                },
            );
        }));
        assert!(interrupted.is_err());
    }
    fn interrupt(&self, checkpoint: Checkpoint) -> String {
        let (_store, payload) = self.queued();
        let id = payload.batch_id.clone();
        self.interrupt_payload(payload, checkpoint);
        id
    }
    fn restore(&self, store: &mut OperationStore, id: String) {
        let (_, undo) = store
            .prepare_undo_record(id, Uuid::new_v4().to_string())
            .unwrap();
        let payload = undo.batch_payload().unwrap();
        let before = payload
            .entries
            .iter()
            .map(|entry| entry.current_path.clone())
            .collect::<Vec<_>>();
        let outcome = transaction::run(
            payload,
            &self.logs,
            &AtomicBool::new(false),
            &mut |payload| store.commit_batch_success(payload).map(|_| ()),
            &mut |_, _| Ok(()),
        );
        let result = store.finish_batch(outcome, &before).unwrap();
        assert_eq!(result.snapshot.status, OperationTaskStatus::Succeeded);
        assert_eq!(fs::read_to_string(self.data.join("a.txt")).unwrap(), "A");
        assert_eq!(fs::read_to_string(self.data.join("b.txt")).unwrap(), "B");
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn temporarily_unavailable_sources_can_be_verified_again_and_recovered() {
    for checkpoint in [Checkpoint::AfterApplied, Checkpoint::AfterRename] {
        let fixture = Fixture::new();
        let id = fixture.interrupt(checkpoint);
        let away = fixture.root.join("offline");
        fs::rename(&fixture.data, &away).unwrap();
        let blocked = fixture.load();
        assert_eq!(blocked.history.len(), 1);
        assert_eq!(blocked.history[0].status, OperationHistoryStatus::Blocked);
        drop(blocked);
        fs::rename(&away, &fixture.data).unwrap();
        let mut ready = fixture.load();
        assert_eq!(ready.history.len(), 1);
        assert_eq!(ready.history[0].record_id, id);
        assert_eq!(ready.history[0].status, OperationHistoryStatus::Undoable,
            "a fresh, reliable identity check must replace the temporary unavailable state: {checkpoint:?}");
        fixture.restore(&mut ready, id);
    }
}

#[test]
fn a_replacement_or_ambiguous_pending_identity_stays_blocked() {
    for ambiguous in [false, true] {
        let fixture = Fixture::new();
        let id = fixture.interrupt(Checkpoint::AfterRename);
        let original = fs::read_dir(&fixture.data)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(".athenaeum-")
            })
            .unwrap();
        if ambiguous {
            fs::hard_link(&original, fixture.data.join("a.txt")).unwrap();
        } else {
            fs::rename(&original, fixture.data.join("actual-original.txt")).unwrap();
            fs::write(&original, "unrelated occupant").unwrap();
        }
        for _ in 0..2 {
            let mut blocked = fixture.load();
            assert_eq!(blocked.history[0].status, OperationHistoryStatus::Blocked);
            assert!(blocked
                .prepare_undo_record(id.clone(), Uuid::new_v4().to_string())
                .is_err());
        }
        let contents = fs::read_to_string(&original).unwrap();
        assert_eq!(contents, if ambiguous { "A" } else { "unrelated occupant" });
    }
}

#[test]
fn temporary_log_read_errors_disappear_only_after_the_real_mapping_is_durable() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = Fixture::new();
    let id = fixture.interrupt(Checkpoint::AfterApplied);
    let path = fs::read_dir(&fixture.logs)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let diagnostic_id = path.file_stem().unwrap().to_str().unwrap().to_owned();
    let lock = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&path)
        .unwrap();
    let mut blocked = fixture.load();
    assert_eq!(blocked.history.len(), 1);
    assert_eq!(blocked.history[0].record_id, diagnostic_id);
    drop(lock);
    blocked.journal_persist_failure_for_test = Some(JournalPersistStep::CommitReplace);
    blocked.recover_batch_logs().unwrap();
    assert!(
        blocked
            .history
            .iter()
            .any(|record| record.record_id == diagnostic_id),
        "a failed replacement commit must retain the diagnostic evidence"
    );
    drop(blocked);
    let mut ready = fixture.load();
    assert_eq!(
        ready.history.len(),
        1,
        "a readable log replaces its temporary diagnostic record"
    );
    assert_eq!(ready.history[0].record_id, id);
    fixture.restore(&mut ready, id);
    let result = ready
        .clear_records(
            OperationClearRequest {
                scope: OperationClearScope::All,
                confirm_undo_loss: true,
            },
            None,
        )
        .unwrap();
    assert!(result.protected_record_ids.is_empty());
    assert!(fixture.load().history.is_empty());
}

#[test]
fn a_recovered_log_directory_clears_its_unavailable_placeholder() {
    let fixture = Fixture::new();
    let id = fixture.interrupt(Checkpoint::AfterApplied);
    let away = fixture.root.join("logs-away");
    fs::rename(&fixture.logs, &away).unwrap();
    fs::write(&fixture.logs, "temporary directory access failure").unwrap();
    let blocked = fixture.load();
    assert_eq!(blocked.history[0].record_id, "batch-recovery-unavailable");
    drop(blocked);
    fs::remove_file(&fixture.logs).unwrap();
    fs::rename(&away, &fixture.logs).unwrap();
    let mut ready = fixture.load();
    assert_eq!(
        ready.history.len(),
        1,
        "directory access is restored and only the actual batch remains"
    );
    assert_eq!(ready.history[0].record_id, id);
    fixture.restore(&mut ready, id);
}

#[test]
fn actual_undo_and_recovery_attempts_remain_retryable_at_each_durable_boundary() {
    for recovery_attempt in [false, true] {
        for checkpoint in [
            Checkpoint::BeforeRename,
            Checkpoint::AfterRename,
            Checkpoint::AfterApplied,
            Checkpoint::BeforeCommit,
        ] {
            let fixture = Fixture::new();
            let (mut store, payload) = fixture.queued();
            let id = payload.batch_id.clone();
            if recovery_attempt {
                fixture.interrupt_payload(payload, Checkpoint::AfterApplied);
                drop(store);
                store = fixture.load();
            } else {
                let before = payload
                    .entries
                    .iter()
                    .map(|entry| entry.current_path.clone())
                    .collect::<Vec<_>>();
                let outcome = transaction::run(
                    payload,
                    &fixture.logs,
                    &AtomicBool::new(false),
                    &mut |payload| store.commit_batch_success(payload).map(|_| ()),
                    &mut |_, _| Ok(()),
                );
                assert_eq!(
                    store
                        .finish_batch(outcome, &before)
                        .unwrap()
                        .snapshot
                        .status,
                    OperationTaskStatus::Succeeded
                );
            }
            let (_, undo) = store
                .prepare_undo_record(id.clone(), Uuid::new_v4().to_string())
                .unwrap();
            assert_eq!(store.history[0].status, OperationHistoryStatus::Undoing);
            fixture.interrupt_payload(undo.batch_payload().unwrap(), checkpoint);
            drop(store);
            let mut restored = fixture.load();
            assert_eq!(restored.history.len(), 1);
            assert_eq!(restored.history[0].record_id, id);
            assert_eq!(
                restored.history[0].status,
                OperationHistoryStatus::Undoable,
                "{recovery_attempt} / {checkpoint:?}"
            );
            fixture.restore(&mut restored, id);
        }
    }
}

#[test]
fn a_restored_attempt_rechecks_unavailable_identities_after_its_log_is_gone() {
    for recovery_attempt in [false, true] {
        for replaced in [false, true] {
            let fixture = Fixture::new();
            let (mut store, payload) = fixture.queued();
            let id = payload.batch_id.clone();
            let forward_attempt = payload.attempt_id.clone();
            if recovery_attempt {
                fixture.interrupt_payload(payload, Checkpoint::AfterApplied);
                drop(store);
                store = fixture.load();
            } else {
                let before = payload
                    .entries
                    .iter()
                    .map(|entry| entry.current_path.clone())
                    .collect::<Vec<_>>();
                let outcome = transaction::run(
                    payload,
                    &fixture.logs,
                    &AtomicBool::new(false),
                    &mut |payload| store.commit_batch_success(payload).map(|_| ()),
                    &mut |_, _| Ok(()),
                );
                assert_eq!(
                    store
                        .finish_batch(outcome, &before)
                        .unwrap()
                        .snapshot
                        .status,
                    OperationTaskStatus::Succeeded
                );
            }
            let (_, undo) = store
                .prepare_undo_record(id.clone(), Uuid::new_v4().to_string())
                .unwrap();
            assert_eq!(
                undo.batch_payload().unwrap().direction,
                if recovery_attempt {
                    Direction::Recovery
                } else {
                    Direction::Undo
                }
            );
            let outcome = transaction::run(
                undo.batch_payload().unwrap(),
                &fixture.logs,
                &AtomicBool::new(false),
                &mut |payload| store.commit_batch_success(payload).map(|_| ()),
                &mut |point, _| {
                    if point == Checkpoint::AfterApplied {
                        bail!("simulate an undo failure");
                    }
                    Ok(())
                },
            );
            assert!(!outcome.committed && outcome.restored);
            let current_path = outcome.payload.entries[0].current_path.clone();
            let log_path = recovery::log_path(&fixture.logs, &outcome.payload.attempt_id).unwrap();
            assert!(
                recovery::read_log(&fixture.logs, &outcome.payload.attempt_id)
                    .unwrap()
                    .restored
            );
            // Interrupt after the durable Restored marker, before finish_batch can commit the mapping.
            drop(outcome);
            drop(store);
            let away = fixture.root.join("offline");
            fs::rename(&fixture.data, &away).unwrap();
            let blocked = fixture.load();
            assert_eq!(blocked.history[0].status, OperationHistoryStatus::Blocked);
            assert!(
                !log_path.exists(),
                "the journal now owns the complete restored mapping"
            );
            if recovery_attempt {
                let payload = blocked
                    .undo_payloads
                    .get(&id)
                    .and_then(UndoPayload::batch)
                    .unwrap();
                assert!(payload.pending_recovery);
                assert!(
                    !payload.committed_attempts.contains(&forward_attempt),
                    "the incomplete forward attempt is not a committed rename"
                );
                assert!(recovery::log_path(&fixture.logs, &forward_attempt)
                    .unwrap()
                    .exists());
            }
            drop(blocked);
            fs::rename(&away, &fixture.data).unwrap();
            if replaced {
                fs::rename(&current_path, fixture.data.join("actual-original.txt")).unwrap();
                fs::write(&current_path, "unrelated occupant").unwrap();
            }
            for _ in 0..2 {
                let mut reloaded = fixture.load();
                assert_eq!(reloaded.history.len(), 1);
                assert_eq!(reloaded.history[0].record_id, id);
                if recovery_attempt {
                    let payload = reloaded
                        .undo_payloads
                        .get(&id)
                        .and_then(UndoPayload::batch)
                        .unwrap();
                    assert!(payload.pending_recovery);
                    assert!(!payload.committed_attempts.contains(&forward_attempt));
                    assert!(recovery::log_path(&fixture.logs, &forward_attempt)
                        .unwrap()
                        .exists());
                }
                if replaced {
                    assert_eq!(reloaded.history[0].status, OperationHistoryStatus::Blocked);
                    assert!(reloaded
                        .prepare_undo_record(id.clone(), Uuid::new_v4().to_string())
                        .is_err());
                } else {
                    assert_eq!(
                    reloaded.history[0].status,
                    OperationHistoryStatus::Undoable,
                    "a verified journal mapping must become retryable without its own log: recovery={recovery_attempt}"
                );
                }
            }
            if replaced {
                assert_eq!(
                    fs::read_to_string(&current_path).unwrap(),
                    "unrelated occupant"
                );
                assert_eq!(
                    fs::read_to_string(fixture.data.join("actual-original.txt")).unwrap(),
                    "A"
                );
            } else {
                fixture.restore(&mut fixture.load(), id);
                assert!(
                    !recovery::log_path(&fixture.logs, &forward_attempt)
                        .unwrap()
                        .exists(),
                    "successful recovery retires the old evidence after durable completion"
                );
            }
        }
    }
}

#[test]
fn resolved_logs_wait_for_diagnostic_retirement_to_commit() {
    use std::os::windows::fs::OpenOptionsExt;
    for acknowledged in [false, true] {
        let fixture = Fixture::new();
        let (mut store, payload) = fixture.queued();
        let batch_id = payload.batch_id.clone();
        let attempt = payload.attempt_id.clone();
        let path = recovery::log_path(&fixture.logs, &attempt).unwrap();
        if acknowledged {
            let before = payload
                .entries
                .iter()
                .map(|entry| entry.current_path.clone())
                .collect::<Vec<_>>();
            let mut delete_lock = None;
            let outcome = transaction::run(
                payload,
                &fixture.logs,
                &AtomicBool::new(false),
                &mut |payload| {
                    store.commit_batch_success(payload)?;
                    // Keep the actual committed log by denying deletion through both cleanup calls.
                    delete_lock = Some(
                        fs::OpenOptions::new()
                            .read(true)
                            .share_mode(3)
                            .open(&path)?,
                    );
                    Ok(())
                },
                &mut |_, _| Ok(()),
            );
            assert!(outcome.committed);
            store.finish_batch(outcome, &before).unwrap();
            assert!(path.exists());
            drop(delete_lock);
            // Model a diagnostic retained by an earlier failed retirement commit.
            let diagnostic = diagnostic_payload(&attempt, "previous temporary read failure".into());
            assert!(store.retain_recovered_batch(
                &diagnostic,
                OperationHistoryStatus::Blocked,
                diagnostic.recovery_diagnostic.clone()
            ));
        } else {
            drop(recovery::RecoveryLog::create(&fixture.logs, &payload).unwrap());
            let read_lock = fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&path)
                .unwrap();
            store = fixture.load();
            assert_eq!(store.history[0].record_id, attempt);
            drop(read_lock);
        }
        // A one-shot error may recover in the same pass through another cleanup entry.
        // The acknowledged variant holds a real replace-denying handle for the whole pass.
        let journal_lock = acknowledged.then(|| {
            fs::OpenOptions::new()
                .read(true)
                .share_mode(3)
                .open(&fixture.journal)
                .unwrap()
        });
        if !acknowledged {
            store.journal_persist_failure_for_test = Some(JournalPersistStep::CommitReplace);
        }
        store.recover_batch_logs().unwrap();
        assert!(store
            .history
            .iter()
            .any(|record| record.record_id == attempt));
        assert!(
            path.exists(),
            "failed diagnostic retirement must retain the trigger for a safe retry"
        );
        drop(journal_lock);
        drop(store);
        let mut ready = fixture.load();
        assert!(!path.exists());
        assert!(
            !ready
                .history
                .iter()
                .any(|record| record.record_id == attempt),
            "the placeholder must be retired after journal writes recover"
        );
        if acknowledged {
            fixture.restore(&mut ready, batch_id);
        } else {
            assert!(ready.history.is_empty());
        }
        assert_eq!(fs::read_to_string(fixture.data.join("a.txt")).unwrap(), "A");
        assert_eq!(fs::read_to_string(fixture.data.join("b.txt")).unwrap(), "B");
    }
}

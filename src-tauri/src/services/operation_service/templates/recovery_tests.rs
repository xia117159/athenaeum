use super::*;
use crate::domain::models::{OperationClearRequest, OperationClearScope, OperationClearStatus};

fn clear(
    store: &mut OperationStore,
    confirm: bool,
) -> Result<crate::domain::models::OperationClearOutcome> {
    let recovery_confirmation = if confirm {
        let preview = clear(store, false)?;
        if preview.status == OperationClearStatus::Cleared {
            return Ok(preview);
        }
        preview.recovery_confirmation
    } else {
        None
    };
    store.clear_records(
        OperationClearRequest {
            recovery_confirmation,
            scope: OperationClearScope::History,
            confirm_undo_loss: confirm,
        },
        None,
    )
}

#[test]
fn template_recovery_confirmation_rejects_new_assets_and_same_count_replacements() {
    fn confirm_snapshot(
        store: &mut OperationStore,
        snapshot: &crate::domain::models::OperationClearOutcome,
    ) -> crate::domain::models::OperationClearOutcome {
        let json = serde_json::to_value(snapshot).unwrap();
        let request = serde_json::from_value(
            serde_json::json!({ "scope": "history", "confirmUndoLoss": true,
            "recoveryConfirmation": json.get("recoveryConfirmation") }),
        )
        .unwrap();
        store.clear_records(request, None).unwrap()
    }
    for scenario in ["zero-to-some", "growing", "same-count-replacement"] {
        let mut f = Fixture::new();
        f.create();
        if scenario != "zero-to-some" {
            f.undo();
        }
        let preview;
        if scenario == "same-count-replacement" {
            let mut store = f.state.operations.lock().unwrap();
            preview = clear(&mut store, false).unwrap();
            assert_eq!(
                confirm_snapshot(&mut store, &preview).status,
                OperationClearStatus::Cleared
            );
            drop(store);
            f.request.request_id = "second".into();
            f.create();
            f.undo();
        } else {
            if scenario == "growing" {
                f.request.request_id = "second".into();
                f.create();
            }
            let (_, execution) = f
                .state
                .operations
                .lock()
                .unwrap()
                .prepare_undo_latest("late-undo".into())
                .unwrap();
            if scenario == "zero-to-some" {
                f.request.request_id = "second".into();
                f.create();
            }
            preview = clear(&mut f.state.operations.lock().unwrap(), false).unwrap();
            assert_eq!(preview.status, OperationClearStatus::ConfirmationRequired);
            assert_eq!(
                preview.eligible_recovery_count,
                if scenario == "growing" { 2 } else { 0 }
            );
            execute_workspace_undo(&f.state, execution, &|_| {}).unwrap();
        }
        let mut store = f.state.operations.lock().unwrap();
        let locations = store
            .history
            .iter()
            .flat_map(|record| record.recovery_items.clone())
            .collect::<Vec<_>>();
        let before = store.history.len();
        let revised = confirm_snapshot(&mut store, &preview);
        assert_eq!(
            revised.status,
            OperationClearStatus::ConfirmationRequired,
            "{scenario}: stale approval cannot authorize newly eligible recovery copies"
        );
        assert_eq!(revised.eligible_recovery_count, locations.len());
        assert_eq!(store.history.len(), before);
        assert!(locations
            .iter()
            .all(|item| Path::new(&item.recovery_path).exists()));
        assert!(revised.removed_record_ids.is_empty());
        let cleared = confirm_snapshot(&mut store, &revised);
        assert_eq!(cleared.status, OperationClearStatus::Cleared);
        assert!(cleared.cleanup_warnings.is_empty());
        assert!(store.history.is_empty());
    }
}

#[test]
fn template_checkpoint_journal_failure_keeps_every_copy_and_retry_information() {
    let f = Fixture::new();
    f.create();
    let (_, execution) = f
        .state
        .operations
        .lock()
        .unwrap()
        .prepare_undo_latest("checkpoint".into())
        .unwrap();
    f.state
        .operations
        .lock()
        .unwrap()
        .journal_persist_failure_for_test = Some(JournalPersistStep::TempWrite);
    execute_workspace_undo(&f.state, execution, &|_| {}).unwrap();
    assert_eq!(
        fs::read(f.root.join("destination/two.txt")).unwrap(),
        b"two"
    );
    assert_eq!(
        fs::read(f.root.join("destination/project/one.txt")).unwrap(),
        b"one"
    );
    let store = f.state.operations.lock().unwrap();
    let record = &store.history[0];
    assert_eq!(record.status, OperationHistoryStatus::Undoable);
    assert!(store.undo_payloads[&record.record_id]
        .templates()
        .unwrap()
        .iter()
        .all(|tree| !tree.recovery_prepared));
}

#[test]
fn template_recovery_clear_retains_history_on_partial_cleanup_and_can_retry_after_restart() {
    use std::os::windows::fs::OpenOptionsExt;
    let mut f = Fixture::new();
    f.request.relative_paths.reverse();
    f.create();
    f.undo();
    let mut store = OperationStore::load_from(f.root.join("history.json")).unwrap();
    let locations = store.history[0].recovery_items.clone();
    let first = PathBuf::from(&locations[0].recovery_path);
    let folder = PathBuf::from(&locations[1].recovery_path);
    let lock = fs::OpenOptions::new()
        .write(true)
        .share_mode(0)
        .open(folder.join("one.txt"))
        .unwrap();
    let cleared = clear(&mut store, true).unwrap();
    assert!(!cleared.cleanup_warnings.is_empty());
    assert!(cleared.removed_record_ids.is_empty());
    assert_eq!(store.history.len(), 1);
    assert!(
        !first.exists(),
        "the first recovery copy was cleaned before the second failed"
    );
    assert!(folder.join("one.txt").exists());
    drop(lock);
    let mut reloaded = OperationStore::load_from(f.root.join("history.json")).unwrap();
    assert_eq!(reloaded.history.len(), 1);
    let cleared = clear(&mut reloaded, true).unwrap();
    assert!(cleared.cleanup_warnings.is_empty());
    assert!(reloaded.history.is_empty());
    assert!(!folder.exists());
}

#[test]
fn template_recovery_clear_final_journal_failure_leaves_a_retryable_record() {
    let f = Fixture::new();
    f.create();
    f.undo();
    let mut store = OperationStore::load_from(f.root.join("history.json")).unwrap();
    let locations = store.history[0].recovery_items.clone();
    store.journal_persist_failure_for_test = Some(JournalPersistStep::CommitReplace);
    assert!(clear(&mut store, true).is_err());
    assert_eq!(store.history.len(), 1);
    assert!(locations
        .iter()
        .all(|location| !Path::new(&location.recovery_path).exists()));
    let mut reloaded = OperationStore::load_from(f.root.join("history.json")).unwrap();
    assert_eq!(reloaded.history.len(), 1);
    assert!(clear(&mut reloaded, true)
        .unwrap()
        .cleanup_warnings
        .is_empty());
    assert!(reloaded.history.is_empty());
    assert_eq!(fs::read(f.root.join("library/two.txt")).unwrap(), b"two");
}

#[test]
fn template_clear_does_not_adopt_an_unused_reserved_recovery_name() {
    let f = Fixture::new();
    f.create();
    let mut store = f.state.operations.lock().unwrap();
    let trees = store.undo_payloads[&store.history[0].record_id]
        .templates()
        .unwrap();
    let unowned = trees[0].recovery_path.clone();
    fs::write(&unowned, "unowned").unwrap();
    assert!(clear(&mut store, true).unwrap().cleanup_warnings.is_empty());
    assert_eq!(fs::read(&unowned).unwrap(), b"unowned");
    assert_eq!(
        fs::read(f.root.join("destination/two.txt")).unwrap(),
        b"two"
    );
}

#[test]
fn template_recovery_clear_requires_confirmation_for_registered_locations_even_if_absent() {
    let f = Fixture::new();
    f.create();
    f.undo();
    let mut store = OperationStore::load_from(f.root.join("history.json")).unwrap();
    for (index, item) in store.history[0].recovery_items.iter().enumerate() {
        fs::rename(
            &item.recovery_path,
            f.root.join(format!("temporarily-moved-{index}")),
        )
        .unwrap();
    }
    // Existence at prompt time cannot prove that a registered location will stay absent
    // until cleanup. The user must authorize cleanup before any physical purge is tried.
    let pending = clear(&mut store, false).unwrap();
    assert_eq!(pending.status, OperationClearStatus::ConfirmationRequired);
    assert_eq!(pending.eligible_recovery_count, 2);
    assert_eq!(store.history.len(), 1);
}

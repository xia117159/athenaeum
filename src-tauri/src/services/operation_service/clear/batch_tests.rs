use std::{
    cell::Cell,
    fs,
    path::{Path, PathBuf},
    rc::Rc,
    time::{SystemTime, UNIX_EPOCH},
};

use super::{
    artifact::set_resolved_entry_key_failure, cleanup_candidate_with_hooks,
    set_cleanup_before_candidate_hook, set_cleanup_preflight_metadata_failure,
};
use crate::{
    domain::models::{
        OperationClearRequest, OperationClearScope, OperationHistoryRecord, OperationHistoryStatus,
        OperationIntentKind,
    },
    services::operation_service::{journal::UndoPayload, OperationStore, UndoAction},
};

fn unique_temp_path(label: &str) -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time went backwards")
        .as_nanos();
    std::env::temp_dir().join(format!("athenaeum-operation-{label}-{unique}"))
}

fn insert_payload(
    store: &mut OperationStore,
    record_id: &str,
    status: OperationHistoryStatus,
    trash_path: PathBuf,
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
                original_path: PathBuf::from(format!("original-{record_id}")),
            }],
        },
    );
}

fn insert_failed_payload(store: &mut OperationStore, record_id: &str, trash_path: PathBuf) {
    insert_payload(store, record_id, OperationHistoryStatus::Failed, trash_path);
}

fn clear_problems(store: &mut OperationStore, trash_root: &Path) -> Vec<String> {
    store
        .clear_records(
            OperationClearRequest {
                scope: OperationClearScope::Problems,
                confirm_undo_loss: false,
            },
            Some(trash_root),
        )
        .expect("clear failed records")
        .cleanup_warnings
}

#[test]
fn cleanup_rejects_enumerated_child_identity_replacements() {
    #[derive(Clone, Copy)]
    enum Replacement {
        DirectoryToDirectory,
        DirectoryToFile,
        FileToFile,
    }

    for (label, replacement) in [
        ("child-dir-to-dir", Replacement::DirectoryToDirectory),
        ("child-dir-to-file", Replacement::DirectoryToFile),
        ("child-file-to-file", Replacement::FileToFile),
    ] {
        let root = unique_temp_path(label);
        let trash_root = root.join("operation-trash");
        let candidate = trash_root.join("candidate");
        let child = candidate.join("child");
        let displaced = trash_root.join("displaced");
        fs::create_dir_all(&candidate).expect("create candidate");
        match replacement {
            Replacement::DirectoryToDirectory | Replacement::DirectoryToFile => {
                fs::create_dir(&child).expect("create original child directory");
                fs::write(child.join("original.txt"), "original")
                    .expect("write original child content");
            }
            Replacement::FileToFile => {
                fs::write(&child, "original").expect("create original child file")
            }
        }
        let mut replaced = false;

        let result = cleanup_candidate_with_hooks(
            &trash_root,
            &candidate,
            &[],
            None,
            || {},
            |inspected| {
                if replaced || inspected != child {
                    return;
                }
                fs::rename(&child, &displaced).expect("displace inspected child");
                match replacement {
                    Replacement::DirectoryToDirectory => {
                        fs::create_dir(&child).expect("create replacement child directory");
                        fs::write(child.join("replacement.txt"), "replacement")
                            .expect("write replacement child content");
                    }
                    Replacement::DirectoryToFile | Replacement::FileToFile => {
                        fs::write(&child, "replacement").expect("create replacement child file")
                    }
                }
                replaced = true;
            },
        );

        assert!(result.is_err(), "{label} replacement must be rejected");
        assert!(child.exists(), "{label} replacement must survive");
        assert!(displaced.exists(), "{label} original must remain displaced");
        let _ = fs::remove_dir_all(root);
    }
}

#[test]
fn cleanup_bounds_warning_details_without_skipping_later_candidates() {
    let root = unique_temp_path("clear-warning-bound");
    let trash_root = root.join("operation-trash");
    let valid = trash_root.join("valid.txt");
    fs::create_dir_all(&trash_root).expect("create trash root");
    fs::write(&valid, "remove").expect("write valid payload");
    let mut store = OperationStore::load_from(root.join("operation-journal.json"))
        .expect("create operation store");
    for index in 0..25 {
        insert_failed_payload(
            &mut store,
            &format!("invalid-{index}"),
            root.join("outside")
                .join("nested")
                .join(format!("item-{index}")),
        );
    }
    insert_failed_payload(&mut store, "valid", valid.clone());

    let warnings = clear_problems(&mut store, &trash_root);

    assert!(!valid.exists());
    assert_eq!(warnings.len(), 20);
    assert!(warnings[19].contains("additional cleanup warnings"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn cleanup_treats_a_candidate_missing_before_planning_as_already_removed() {
    let root = unique_temp_path("cleanup-initially-missing");
    let trash_root = root.join("operation-trash");
    let missing = trash_root.join("missing.txt");
    fs::create_dir_all(&trash_root).expect("create trash root");
    let mut store = OperationStore::load_from(root.join("operation-journal.json"))
        .expect("create operation store");
    insert_failed_payload(&mut store, "missing", missing);

    let warnings = clear_problems(&mut store, &trash_root);

    assert!(warnings.is_empty());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn cleanup_warns_when_the_authoritative_root_was_renamed_before_planning() {
    let root = unique_temp_path("cleanup-root-renamed-before-plan");
    let trash_root = root.join("operation-trash");
    let displaced_root = root.join("displaced-operation-trash");
    let candidate = trash_root.join("payload.txt");
    fs::create_dir_all(&trash_root).expect("create trash root");
    fs::write(&candidate, "preserve").expect("write payload");
    let mut store = OperationStore::load_from(root.join("operation-journal.json"))
        .expect("create operation store");
    insert_failed_payload(&mut store, "payload", candidate);
    fs::rename(&trash_root, &displaced_root).expect("rename authoritative root");

    let warnings = clear_problems(&mut store, &trash_root);

    assert_eq!(warnings.len(), 1);
    assert!(warnings[0].contains("operation-trash root"));
    assert!(displaced_root.join("payload.txt").exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn cleanup_rejects_a_non_directory_authoritative_root() {
    let root = unique_temp_path("cleanup-root-not-directory");
    let trash_root = root.join("operation-trash");
    let candidate = trash_root.join("payload.txt");
    fs::create_dir_all(&root).expect("create app data root");
    fs::write(&trash_root, "not a directory").expect("write invalid trash root");
    let mut store = OperationStore::load_from(root.join("operation-journal.json"))
        .expect("create operation store");
    insert_failed_payload(&mut store, "payload", candidate);

    let warnings = clear_problems(&mut store, &trash_root);

    assert_eq!(warnings.len(), 1);
    assert!(warnings[0].contains("not an ordinary directory"));
    assert!(trash_root.is_file());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn cleanup_rejects_root_identity_replacement_after_planning() {
    let root = unique_temp_path("cleanup-root-replaced-after-plan");
    let trash_root = root.join("operation-trash");
    let displaced_root = root.join("displaced-operation-trash");
    let candidate = trash_root.join("payload.txt");
    fs::create_dir_all(&trash_root).expect("create trash root");
    fs::write(&candidate, "original").expect("write original payload");
    let mut store = OperationStore::load_from(root.join("operation-journal.json"))
        .expect("create operation store");
    insert_failed_payload(&mut store, "payload", candidate.clone());
    let replaced = Rc::new(Cell::new(false));
    let hook_replaced = replaced.clone();
    let hook_root = trash_root.clone();
    let hook_displaced_root = displaced_root.clone();
    let hook_candidate = candidate.clone();
    set_cleanup_before_candidate_hook(Some(Box::new(move |_| {
        if hook_replaced.get() {
            return;
        }
        fs::rename(&hook_root, &hook_displaced_root).expect("displace planned root");
        fs::create_dir(&hook_root).expect("create replacement root");
        fs::write(&hook_candidate, "replacement").expect("write replacement payload");
        hook_replaced.set(true);
    })));

    let warnings = clear_problems(&mut store, &trash_root);
    set_cleanup_before_candidate_hook(None);

    assert!(replaced.get());
    assert_eq!(warnings.len(), 1);
    assert!(warnings[0].contains("identity changed since planning"));
    assert!(candidate.exists(), "replacement payload must survive");
    assert!(
        displaced_root.join("payload.txt").exists(),
        "original payload must survive"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn missing_after_planning_blocks_its_ancestor_but_not_an_unrelated_candidate() {
    let root = unique_temp_path("cleanup-batch-missing-after-plan");
    let trash_root = root.join("operation-trash");
    let parent = trash_root.join("parent");
    let child = parent.join("child.txt");
    let displaced = trash_root.join("displaced-child.txt");
    let unrelated = trash_root.join("unrelated.txt");
    fs::create_dir_all(&parent).expect("create parent candidate");
    fs::write(&child, "original").expect("write child candidate");
    fs::write(&unrelated, "remove").expect("write unrelated candidate");
    let mut store = OperationStore::load_from(root.join("operation-journal.json"))
        .expect("create operation store");
    insert_failed_payload(&mut store, "child", child.clone());
    insert_failed_payload(&mut store, "parent", parent.clone());
    insert_failed_payload(&mut store, "unrelated", unrelated.clone());
    let displaced_once = Rc::new(Cell::new(false));
    let hook_displaced_once = displaced_once.clone();
    let hook_child = child.clone();
    let hook_displaced = displaced.clone();
    set_cleanup_before_candidate_hook(Some(Box::new(move |candidate| {
        if hook_displaced_once.get() || candidate != hook_child {
            return;
        }
        fs::rename(&hook_child, &hook_displaced).expect("displace planned child");
        hook_displaced_once.set(true);
    })));

    let warnings = clear_problems(&mut store, &trash_root);
    set_cleanup_before_candidate_hook(None);

    assert!(displaced_once.get());
    assert_eq!(warnings.len(), 2);
    assert!(warnings[0].contains("disappeared since planning"));
    assert!(warnings[1].contains("overlaps an earlier failed cleanup"));
    assert!(parent.exists(), "the overlapping ancestor must survive");
    assert!(displaced.exists(), "the renamed payload must survive");
    assert!(
        !unrelated.exists(),
        "an unrelated candidate must still be removed"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn entry_key_planning_failure_blocks_its_ancestor_but_not_an_unrelated_candidate() {
    let root = unique_temp_path("cleanup-entry-key-plan-failure");
    let trash_root = root.join("operation-trash");
    let parent = trash_root.join("parent");
    let child = parent.join("child.txt");
    let unrelated = trash_root.join("unrelated.txt");
    fs::create_dir_all(&parent).expect("create parent candidate");
    fs::write(&child, "preserve").expect("write child candidate");
    fs::write(&unrelated, "remove").expect("write unrelated candidate");
    let mut store = OperationStore::load_from(root.join("operation-journal.json"))
        .expect("create operation store");
    insert_failed_payload(&mut store, "child", child.clone());
    insert_failed_payload(&mut store, "parent", parent.clone());
    insert_failed_payload(&mut store, "unrelated", unrelated.clone());
    set_resolved_entry_key_failure(Some(child.clone()));

    let warnings = clear_problems(&mut store, &trash_root);
    set_resolved_entry_key_failure(None);

    assert_eq!(warnings.len(), 2);
    assert!(warnings[0].contains("cannot safely plan cleanup path"));
    assert!(warnings[1].contains("overlaps an earlier failed cleanup"));
    assert!(parent.exists(), "the overlapping ancestor must survive");
    assert!(child.exists(), "the unresolved child must survive");
    assert!(
        !unrelated.exists(),
        "an unrelated candidate must be removed"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn prefixless_preflight_failure_aborts_all_physical_cleanup() {
    let root = unique_temp_path("cleanup-preflight-plan-failure");
    let trash_root = root.join("operation-trash");
    let parent = trash_root.join("parent");
    let child = parent.join("child.txt");
    let unrelated = trash_root.join("unrelated.txt");
    fs::create_dir_all(&parent).expect("create parent candidate");
    fs::write(&child, "preserve").expect("write child candidate");
    fs::write(&unrelated, "preserve").expect("write unrelated candidate");
    let mut store = OperationStore::load_from(root.join("operation-journal.json"))
        .expect("create operation store");
    insert_failed_payload(&mut store, "child", child.clone());
    insert_failed_payload(&mut store, "parent", parent.clone());
    insert_failed_payload(&mut store, "unrelated", unrelated.clone());
    set_cleanup_preflight_metadata_failure(Some(child.clone()));

    let warnings = clear_problems(&mut store, &trash_root);
    set_cleanup_preflight_metadata_failure(None);

    assert_eq!(warnings.len(), 1);
    assert!(warnings[0].contains("cannot inspect cleanup path"));
    assert!(parent.exists(), "the candidate ancestor must survive");
    assert!(child.exists(), "the unresolved child must survive");
    assert!(
        unrelated.exists(),
        "a prefixless planning failure must abort unrelated cleanup"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn failed_descendant_cleanup_blocks_a_later_deleted_ancestor() {
    let root = unique_temp_path("cleanup-batch-descendant-barrier");
    let trash_root = root.join("operation-trash");
    let parent = trash_root.join("parent");
    let child = parent.join("child");
    let displaced = trash_root.join("displaced-child");
    fs::create_dir_all(&child).expect("create child candidate");
    fs::write(child.join("original.txt"), "original").expect("write original child");
    let mut store = OperationStore::load_from(root.join("operation-journal.json"))
        .expect("create operation store");
    insert_failed_payload(&mut store, "child", child.clone());
    insert_failed_payload(&mut store, "parent", parent.clone());
    let replaced = Rc::new(Cell::new(false));
    let hook_replaced = replaced.clone();
    let hook_child = child.clone();
    let hook_displaced = displaced.clone();
    set_cleanup_before_candidate_hook(Some(Box::new(move |candidate| {
        if hook_replaced.get() || candidate != hook_child {
            return;
        }
        fs::rename(&hook_child, &hook_displaced).expect("displace inspected child");
        fs::create_dir(&hook_child).expect("create replacement child");
        fs::write(hook_child.join("replacement.txt"), "replacement")
            .expect("write replacement child");
        hook_replaced.set(true);
    })));

    let warnings = clear_problems(&mut store, &trash_root);
    set_cleanup_before_candidate_hook(None);

    assert!(replaced.get());
    assert_eq!(warnings.len(), 2);
    assert!(
        child.exists(),
        "replacement child must survive the whole batch"
    );
    assert!(displaced.exists(), "displaced original must survive");
    let _ = fs::remove_dir_all(root);
}

#[cfg(windows)]
#[test]
fn failed_windows_alias_is_not_retried_through_a_second_deleted_alias() {
    let root = unique_temp_path("cleanup-batch-case-alias-barrier");
    let trash_root = root.join("operation-trash");
    let task_root = trash_root.join("task");
    let upper = task_root.join("Payload.bin");
    let lower = task_root.join("payload.bin");
    let displaced = trash_root.join("displaced-payload.bin");
    fs::create_dir_all(&task_root).expect("create task root");
    fs::write(&upper, "original").expect("write original payload");
    assert!(
        lower.exists(),
        "test requires case-insensitive Windows path lookup"
    );
    let mut store = OperationStore::load_from(root.join("operation-journal.json"))
        .expect("create operation store");
    insert_failed_payload(&mut store, "upper", upper.clone());
    insert_failed_payload(&mut store, "lower", lower);
    let replaced = Rc::new(Cell::new(false));
    let hook_replaced = replaced.clone();
    let hook_displaced = displaced.clone();
    set_cleanup_before_candidate_hook(Some(Box::new(move |candidate| {
        if hook_replaced.get() {
            return;
        }
        fs::rename(candidate, &hook_displaced).expect("displace inspected alias");
        fs::write(candidate, "replacement").expect("create alias replacement");
        hook_replaced.set(true);
    })));

    let warnings = clear_problems(&mut store, &trash_root);
    set_cleanup_before_candidate_hook(None);

    assert!(replaced.get());
    assert_eq!(warnings.len(), 2);
    assert!(
        upper.exists(),
        "replacement alias must survive the whole batch"
    );
    assert!(displaced.exists(), "displaced original must survive");
    let _ = fs::remove_dir_all(root);
}

#[cfg(windows)]
#[test]
fn successful_windows_alias_cleanup_satisfies_the_second_planned_alias() {
    let root = unique_temp_path("cleanup-batch-successful-case-alias");
    let trash_root = root.join("operation-trash");
    let task_root = trash_root.join("task");
    let upper = task_root.join("Payload.bin");
    let lower = task_root.join("payload.bin");
    fs::create_dir_all(&task_root).expect("create task root");
    fs::write(&upper, "remove").expect("write payload");
    assert!(
        lower.exists(),
        "test requires case-insensitive Windows path lookup"
    );
    let mut store = OperationStore::load_from(root.join("operation-journal.json"))
        .expect("create operation store");
    insert_failed_payload(&mut store, "upper", upper.clone());
    insert_failed_payload(&mut store, "lower", lower.clone());

    let warnings = clear_problems(&mut store, &trash_root);

    assert!(warnings.is_empty());
    assert!(!upper.exists());
    assert!(!lower.exists());
    let _ = fs::remove_dir_all(root);
}

#[cfg(windows)]
#[test]
fn cleanup_unlinks_both_removed_same_parent_hard_links() {
    let root = unique_temp_path("cleanup-same-parent-hard-links");
    let trash_root = root.join("operation-trash");
    let task_root = trash_root.join("task");
    let first = task_root.join("first.bin");
    let second = task_root.join("second.bin");
    fs::create_dir_all(&task_root).expect("create task root");
    fs::write(&first, "remove").expect("write first hard link");
    fs::hard_link(&first, &second).expect("create second hard link");
    let mut store = OperationStore::load_from(root.join("operation-journal.json"))
        .expect("create operation store");
    insert_failed_payload(&mut store, "first", first.clone());
    insert_failed_payload(&mut store, "second", second.clone());

    let warnings = clear_problems(&mut store, &trash_root);

    assert!(warnings.is_empty());
    assert!(!first.exists());
    assert!(!second.exists());
    let _ = fs::remove_dir_all(root);
}

#[cfg(windows)]
#[test]
fn retained_same_parent_hard_link_does_not_block_removed_sibling() {
    let root = unique_temp_path("cleanup-retained-hard-link-sibling");
    let trash_root = root.join("operation-trash");
    let task_root = trash_root.join("task");
    let removed = task_root.join("removed.bin");
    let retained = task_root.join("retained.bin");
    fs::create_dir_all(&task_root).expect("create task root");
    fs::write(&removed, "retained content").expect("write removed hard link");
    fs::hard_link(&removed, &retained).expect("create retained hard link");
    let mut store = OperationStore::load_from(root.join("operation-journal.json"))
        .expect("create operation store");
    insert_failed_payload(&mut store, "removed", removed.clone());
    insert_payload(
        &mut store,
        "retained",
        OperationHistoryStatus::Undoable,
        retained.clone(),
    );

    let warnings = clear_problems(&mut store, &trash_root);

    assert!(warnings.is_empty());
    assert!(!removed.exists());
    assert_eq!(
        fs::read_to_string(&retained).expect("read retained hard link"),
        "retained content"
    );
    let _ = fs::remove_dir_all(root);
}

#[cfg(windows)]
#[test]
fn cleanup_keeps_different_parent_hard_link_entries_independent() {
    let root = unique_temp_path("cleanup-different-parent-hard-links");
    let trash_root = root.join("operation-trash");
    let first = trash_root.join("left").join("payload.bin");
    let second = trash_root.join("right").join("payload.bin");
    fs::create_dir_all(first.parent().expect("first parent")).expect("create first parent");
    fs::create_dir_all(second.parent().expect("second parent")).expect("create second parent");
    fs::write(&first, "remove").expect("write first hard link");
    fs::hard_link(&first, &second).expect("create second hard link");
    let mut store = OperationStore::load_from(root.join("operation-journal.json"))
        .expect("create operation store");
    insert_failed_payload(&mut store, "first", first.clone());
    insert_failed_payload(&mut store, "second", second.clone());

    let warnings = clear_problems(&mut store, &trash_root);

    assert!(warnings.is_empty());
    assert!(!first.exists());
    assert!(!second.exists());
    let _ = fs::remove_dir_all(root);
}

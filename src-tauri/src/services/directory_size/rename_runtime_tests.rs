use super::*;
use crate::{domain::models::*, services::{AppState, batch_rename::{native, plan, transaction}, operation_service::{self, OperationStore}}};
use std::sync::atomic::AtomicBool;

fn start(service: &DirectorySizeService) -> (Arc<Mutex<Vec<DirectorySizeSnapshot>>>, Arc<EventSink>) {
    let events = Arc::new(Mutex::new(vec![])); let observed = events.clone();
    let sink: Arc<EventSink> = Arc::new(move |_, event| observed.lock().unwrap().push(event));
    service.open_owner("main"); service.start(Arc::downgrade(&sink)); (events, sink)
}
fn subscribe_path(service: &DirectorySizeService, id: &str, path: &std::path::Path, refresh: bool) {
    service.subscribe(service.owner_token("main").unwrap(), SubscribeDirectorySizesRequest { consumer_id: id.into(),
        target: DirectorySizeTarget::Local { path: path.to_str().unwrap().into() }, refresh }, None).unwrap();
}
fn cache(service: &DirectorySizeService, path: &std::path::Path) -> Option<DirectorySizeCache> {
    let mut listing = crate::services::fs_service::list_directory(path, &[], |_| (vec![], None)).unwrap();
    service.attach_listing_cache(&mut listing); listing.directory_size_cache
}
fn intent(source: &std::path::Path, new_name: &str) -> OperationIntent {
    OperationIntent { request_id: uuid::Uuid::new_v4().to_string(), source: OperationRequestSource::Shortcut, panel_id: None, tab_id: None,
        kind: OperationIntentKind::Rename, sources: None, destination: None,
        source_path: Some(OperationPathRef::Local { path: source.to_str().unwrap().into() }), new_name: Some(new_name.into()),
        parent: None, name: None, undo_record_id: None, conflict_policy: None }
}

#[test]
fn rename_runtime_single_task_moves_cached_root_and_independent_descendant_without_scanning() {
    for include_parent in [false, true] {
        let root = TestRoot::new(); let old = root.0.join("old"); let new = root.0.join("new");
        let journal = TestRoot::new();
        fs::create_dir_all(old.join("deep")).unwrap(); fs::write(old.join("deep/data"), [0; 60]).unwrap();
        let service = DirectorySizeService::default(); let (events, _sink) = start(&service);
        if include_parent { subscribe_path(&service, "parent", &root.0, false); await_complete(&events, "parent", "60", 0); }
        subscribe_path(&service, "old", &old, true); await_complete(&events, "old", "60", 0);
        subscribe_path(&service, "deep", &old.join("deep"), true); await_complete(&events, "deep", "60", 0);
        let before = service.debug_counts();
        let mut store = OperationStore::load_from(journal.0.join("journal.json")).unwrap();
        let request = intent(&old, "new"); let (queued, _) = store.queue_operation(request.clone());
        let execution = operation_service::execute_operation_task_with_sizes(&queued.snapshot.task_id, &request, None,
            Arc::new(AtomicBool::new(false)), None, Some(&service));
        let terminal = store.finish_operation(&queued.snapshot.task_id, &request, execution).unwrap();
        assert_eq!(terminal.snapshot.status, OperationTaskStatus::Succeeded, "{:?}", terminal.snapshot);
        assert!(!old.exists()); assert!(new.join("deep/data").exists());
        assert!(cache(&service, &new).is_some()); assert!(cache(&service, &new.join("deep")).is_some());
        if include_parent { assert!(cache(&service, &root.0).is_some()); }
        assert_eq!(service.debug_counts(), before, "own-watch zero-pair rename must move roots, not allocate or rescan");
        subscribe_path(&service, "new", &new, false); await_complete(&events, "new", "60", 0);
        assert_eq!(service.debug_counts(), before);
        fs::write(new.join("deep/data"), [0; 90]).unwrap();
        await_complete(&events, "new", "90", 0);
        service.shutdown();
    }
}

#[test]
fn rename_runtime_batch_worker_reuses_one_root_for_ten_directories_file_and_unchanged_item() {
    let root = TestRoot::new(); let data = root.0.join("data"); fs::create_dir(&data).unwrap();
    let mut sources = vec![]; let mut targets = vec![];
    for index in 0..10 {
        let path = data.join(format!("old{index}")); fs::create_dir_all(path.join("deep")).unwrap();
        fs::write(path.join("deep/data"), [0; 60]).unwrap(); sources.push(native::snapshot(&path).unwrap()); targets.push(Ok(format!("new{index}")));
    }
    fs::write(data.join("file"), [0; 7]).unwrap(); sources.push(native::snapshot(&data.join("file")).unwrap()); targets.push(Ok("renamed-file".into()));
    fs::create_dir(data.join("same")).unwrap(); sources.push(native::snapshot(&data.join("same")).unwrap()); targets.push(Ok("same".into()));
    let plan = plan::plan_names(&sources, targets).1.unwrap();
    let state = AppState::new(crate::services::metadata_store::MetadataStore::load_default(), crate::services::settings_store::SettingsStore::load_default());
    *state.operations.lock().unwrap() = OperationStore::load_from(root.0.join("journal.json")).unwrap();
    let mut request = intent(&data, "unused"); request.source_path = None; request.new_name = None;
    request.sources = Some(sources.iter().map(|source| OperationPathRef::Local { path: source.path.to_str().unwrap().into() }).collect());
    let (_, payload) = state.operations.lock().unwrap().queue_batch(request, &plan).unwrap();
    let (events, _sink) = start(&state.directory_sizes); subscribe_path(&state.directory_sizes, "parent", &data, false);
    await_complete(&events, "parent", "607", 0); let before = state.directory_sizes.debug_counts();
    let result = operation_service::batch::execute_batch(&state, payload.unwrap(), &|event| {
        if event.snapshot.status == OperationTaskStatus::Succeeded {
            assert!(cache(&state.directory_sizes, &data).is_some(), "terminal event must follow cache commit");
        }
    }).unwrap();
    assert_eq!(result.snapshot.status, OperationTaskStatus::Succeeded);
    let parent = cache(&state.directory_sizes, &data).unwrap();
    assert_eq!(parent.directories.len(), 12);
    for index in 0..10 {
        let child = cache(&state.directory_sizes, &data.join(format!("new{index}"))).unwrap();
        assert!(child.directories.iter().all(|record| record.bytes.as_deref() == Some("60")));
    }
    assert_eq!(state.directory_sizes.debug_counts(), before);
    assert_eq!(before.0, 1, "more than 8 renamed directories still share one root");
    // Existing undo goes through the production worker but cannot preserve the forward cache.
    let (_, undo) = state.operations.lock().unwrap().prepare_undo_latest(uuid::Uuid::new_v4().to_string()).unwrap();
    operation_service::execute_workspace_undo(&state, undo, &|_| {}).unwrap();
    assert!(cache(&state.directory_sizes, &data).is_none());
    assert!(data.join("old0/deep/data").exists()); state.directory_sizes.shutdown();
}

#[test]
fn rename_runtime_batch_rollback_or_concurrent_content_write_abandons_optimization() {
    for inject_write in [false, true] {
        let root = TestRoot::new(); let data = root.0.join("data"); let old = data.join("old"); let new = data.join("new");
        fs::create_dir_all(old.join("deep")).unwrap(); fs::write(old.join("deep/data"), [0; 60]).unwrap();
        let plan = plan::plan_names(&[native::snapshot(&old).unwrap()], vec![Ok("new".into())]).1.unwrap();
        let payload = transaction::BatchPayload::forward(&plan, "task", "batch");
        let service = DirectorySizeService::default(); let (events, _sink) = start(&service);
        subscribe_path(&service, "parent", &data, false); await_complete(&events, "parent", "60", 0);
        let before = service.debug_counts(); let mut session = service.begin_rename(&[(old.clone(), new.clone())], true);
        let outcome = transaction::run_with_size_session(payload, &root.0.join("logs"), &AtomicBool::new(false), &mut |_| Ok(()),
            &mut |point, payload| {
                if point == transaction::Checkpoint::BeforeCommit {
                    if inject_write { fs::write(payload.entries[0].current_path.join("deep/data"), [0; 99]).unwrap(); }
                    else { anyhow::bail!("injected commit failure"); }
                }
                Ok(())
            }, Some(&mut session));
        assert_eq!(outcome.committed, inject_write);
        assert_eq!(service.debug_counts(), before, "fence remains until the real worker finishes");
        assert!(!session.finish(outcome.committed));
        assert!(cache(&service, &data).is_none());
        assert!(if inject_write { new.exists() } else { old.exists() }); service.shutdown();
    }
}

#[test]
fn rename_runtime_panic_drop_cancels_cache_without_holding_the_core_lock() {
    let root = TestRoot::new(); let old = root.0.join("old"); let new = root.0.join("new");
    fs::create_dir_all(old.join("deep")).unwrap(); fs::write(old.join("deep/data"), [0; 60]).unwrap();
    let service = DirectorySizeService::default(); let (events, _sink) = start(&service);
    subscribe_path(&service, "parent", &root.0, false); await_complete(&events, "parent", "60", 0);
    let failed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut session = service.begin_rename(&[(old.clone(), new.clone())], true);
        session.step(&old, &new, || -> anyhow::Result<()> { panic!("injected operation panic") }).unwrap();
    }));
    assert!(failed.is_err()); assert!(cache(&service, &root.0).is_none());
    let start = Instant::now(); service.shutdown(); assert!(start.elapsed() < Duration::from_secs(1));
}

#[test]
fn rename_runtime_handoff_coverage_rejects_content_changes_with_only_a_descendant_cache() {
    let root = TestRoot::new(); let old = root.0.join("old"); let new = root.0.join("new");
    fs::create_dir_all(old.join("deep")).unwrap(); fs::write(old.join("deep/data"), [0; 60]).unwrap();
    let service = DirectorySizeService::default(); let (events, _sink) = start(&service);
    subscribe_path(&service, "deep", &old.join("deep"), false); await_complete(&events, "deep", "60", 0);
    let before = service.debug_counts(); let mut session = service.begin_rename(&[(old.clone(), new.clone())], true);
    fs::write(old.join("deep/data"), [0; 90]).unwrap();
    session.step(&old, &new, || Ok(fs::rename(&old, &new)?)).unwrap();
    assert!(!session.finish(true)); assert_eq!(service.debug_counts(), before);
    assert!(cache(&service, &new.join("deep")).is_none()); service.shutdown();
}

#[test]
fn rename_runtime_pending_open_timeout_never_calls_the_filesystem_action() {
    use crate::services::watch_registry::{WatchClass, WatchRegistration};
    let root = TestRoot::new(); let old = root.0.join("old"); let new = root.0.join("new");
    fs::create_dir_all(old.join("deep")).unwrap();
    // A reservation models a scan worker still inside the native open, before Prepared.
    let opening = WatchRegistration::reserve(old.join("deep").to_str().unwrap(), WatchClass::Size, None).unwrap();
    let service = DirectorySizeService::default(); let called = AtomicBool::new(false);
    let result = service.rename_with(&old, &new, true, || { called.store(true, std::sync::atomic::Ordering::SeqCst); Ok(fs::rename(&old, &new)?) });
    assert!(result.is_err()); assert!(!called.load(std::sync::atomic::Ordering::SeqCst));
    assert!(opening.retired()); assert!(old.exists() && !new.exists());
    drop(opening); service.rename_file(&old, &new, true).unwrap();
}

#[test]
fn rename_runtime_single_undo_keeps_object_identity_with_descendant_watches() {
    let root = TestRoot::new(); let journal = TestRoot::new(); let old = root.0.join("old"); let new = root.0.join("new");
    fs::create_dir_all(old.join("deep")).unwrap(); fs::write(old.join("deep/data"), [0; 60]).unwrap();
    let original = native::snapshot(&old).unwrap().identity;
    let child = native::snapshot(&old.join("deep")).unwrap().identity;
    let state = AppState::new(crate::services::metadata_store::MetadataStore::load_default(), crate::services::settings_store::SettingsStore::load_default());
    *state.operations.lock().unwrap() = OperationStore::load_from(journal.0.join("journal.json")).unwrap();
    let service = &state.directory_sizes; let (events, _sink) = start(service);
    subscribe_path(service, "own", &old, true); await_complete(&events, "own", "60", 0);
    subscribe_path(service, "deep", &old.join("deep"), true); await_complete(&events, "deep", "60", 0);
    let request = intent(&old, "new"); let (queued, _) = state.operations.lock().unwrap().queue_operation(request.clone());
    let execution = operation_service::execute_operation_task_with_sizes(&queued.snapshot.task_id, &request, None,
        Arc::new(AtomicBool::new(false)), None, Some(service));
    let terminal = state.operations.lock().unwrap().finish_operation(&queued.snapshot.task_id, &request, execution).unwrap();
    assert_eq!(terminal.snapshot.status, OperationTaskStatus::Succeeded);
    assert!(cache(service, &new.join("deep")).is_some());
    let (_, undo) = state.operations.lock().unwrap().prepare_undo_latest(uuid::Uuid::new_v4().to_string()).unwrap();
    operation_service::execute_workspace_undo(&state, undo, &|_| {}).unwrap();
    assert!(old.exists() && !new.exists());
    assert_eq!(native::snapshot(&old).unwrap().identity, original, "undo must rename the original object, not copy and delete the tree");
    assert_eq!(native::snapshot(&old.join("deep")).unwrap().identity, child);
    assert!(cache(service, &old).is_none()); service.shutdown();
}

#[test]
fn rename_runtime_replace_backup_preserves_the_watched_destination_objects() {
    let root = TestRoot::new(); let journal = TestRoot::new(); let old = root.0.join("old"); let target = root.0.join("target");
    fs::create_dir_all(&old).unwrap(); fs::write(old.join("source"), b"source").unwrap();
    fs::create_dir_all(target.join("deep")).unwrap(); fs::write(target.join("deep/data"), [0; 60]).unwrap();
    let original = native::snapshot(&target).unwrap().identity;
    let child = native::snapshot(&target.join("deep")).unwrap().identity;
    let service = DirectorySizeService::default(); let (events, _sink) = start(&service);
    subscribe_path(&service, "target-deep", &target.join("deep"), false); await_complete(&events, "target-deep", "60", 0);
    operation_service::execute_operation_task_with_sizes("replace", &intent(&old, "target"), Some(journal.0.clone()),
        Arc::new(AtomicBool::new(false)), Some(OperationConflictResolution { conflict_id: "replace".into(), resolution: ConflictResolutionKind::Replace, apply_to_all: false, new_name: None }), Some(&service));
    let backup = journal.0.join("operation-trash/replace/target");
    assert!(target.join("source").exists() && !old.exists());
    assert_eq!(native::snapshot(&backup).unwrap().identity, original, "backing up the destination must not copy and delete it");
    assert_eq!(native::snapshot(&backup.join("deep")).unwrap().identity, child);
    service.shutdown();
}

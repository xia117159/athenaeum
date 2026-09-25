use super::{DirectorySizeService, EventSink};
use crate::domain::directory_sizes::*;
use std::{fs, path::PathBuf, sync::{Arc, Mutex}, time::{Duration, Instant}};
#[cfg(windows)]
#[path = "rename_runtime_tests.rs"]
mod rename_tests;

struct TestRoot(PathBuf);
impl TestRoot {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("athenaeum-size-runtime-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap(); Self(path)
    }
}
impl Drop for TestRoot { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

#[test]
fn size_runtime_diagnostics_distinguishes_exact_disk_hit_miss_pending_and_unavailable() {
    use super::storage::{Store, ScanHeader, StoredDirectory};
    let root = TestRoot::new(); let directory = root.0.join("data"); fs::create_dir(&directory).unwrap();
    let service = DirectorySizeService::default(); service.open_owner("main");
    let report = || serde_json::to_value(service.diagnostics(service.owner_token("main").unwrap(), directory.to_str().unwrap()).unwrap()).unwrap();
    assert_eq!(report()["diskRead"], "unavailable");
    let pending = Store::paused_for_test(8192, 2048); *service.storage.lock().unwrap() = Some(pending);
    assert_eq!(report()["diskRead"], "pending");
    let await_disk = |expected: &str| {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let observed = report();
            if observed["diskRead"] == expected { break; }
            assert_eq!(observed["diskRead"], "pending", "{observed}");
            assert!(Instant::now() < deadline, "disk read did not settle to {expected}");
        }
    };
    let store = Store::start(root.0.join("cache")); *service.storage.lock().unwrap() = Some(store.clone());
    store.flush(Duration::from_secs(2)).unwrap();
    await_disk("miss");
    let path = super::target::normalize_local_path(directory.to_str().unwrap()).unwrap();
    let header = ScanHeader { id: "persisted".into(), session: "session".into(), root: path.clone(), generation: 1,
        captured_at: chrono::Utc::now(), policy_version: 2 };
    assert!(store.append(header.clone(), vec![StoredDirectory { path, artifact_capture: None, size: super::scan::DirectorySize {
        bytes: 73, complete: true, created_at: fs::metadata(&directory).unwrap().created().ok().map(Into::into), fingerprint: None,
        stats: super::scan::ScanStats { directories: 1, ..Default::default() } } }]));
    assert!(store.accept(header, 1)); store.flush(Duration::from_secs(2)).unwrap();
    await_disk("hit");
    assert_eq!(report()["scanJobsStarted"], "0", "diagnostics reads must not schedule recursive scans");
    store.shutdown(Duration::from_secs(2)).unwrap();
    assert_eq!(report()["diskRead"], "unavailable");
}

#[test]
fn size_runtime_shutdown_tolerates_a_poisoned_storage_handle() {
    let service = DirectorySizeService::default();
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = service.storage.lock().unwrap(); panic!("injected caller panic");
    }));
    service.shutdown();
}

#[test]
fn size_runtime_startup_summary_is_available_without_reading_database() {
    let root = TestRoot::new(); let directory = root.0.join("data"); fs::create_dir(&directory).unwrap();
    let child = directory.join("child"); fs::create_dir(&child).unwrap();
    let created_at = fs::metadata(&child).unwrap().created().ok().map(Into::into);
    let cache = root.0.join("cache"); fs::create_dir(&cache).unwrap();
    let path = super::target::normalize_local_path(child.to_str().unwrap()).unwrap();
    let hit = super::storage::StoredHit { record: super::storage::StoredDirectory {
        path, artifact_capture: None, size: super::scan::DirectorySize { bytes: 73, complete: true,
            created_at, fingerprint: None, stats: super::scan::ScanStats { directories: 1, ..Default::default() } }
    }, scan_id: "summary-only".into(), source: 1, publication: 1, captured_at: chrono::Utc::now(), policy_version: 2 };
    fs::write(cache.join("startup.json"), serde_json::to_vec(&serde_json::json!({ "version": 1, "records": [hit] })).unwrap()).unwrap();
    // Invalid SQLite proves this assertion cannot be satisfied by the database fallback.
    fs::write(cache.join("sizes.sqlite3"), b"invalid database").unwrap();
    let service = DirectorySizeService::default(); service.initialize_storage(cache);
    let mut listing = crate::services::fs_service::list_directory(&directory, &[], |_| (vec![], None)).unwrap();
    service.attach_listing_cache(&mut listing);
    assert_eq!(listing.directory_size_cache.unwrap().directories[0].bytes.as_deref(), Some("73"));
    assert_eq!(service.core.lock().unwrap().jobs_started, 0);
}

#[cfg(windows)]
#[test]
fn size_runtime_rename_persists_descendants_without_another_scan() {
    let root = TestRoot::new(); let directory = root.0.join("data");
    let old = directory.join("old"); let new = directory.join("new");
    fs::create_dir_all(old.join("deep")).unwrap(); fs::write(old.join("deep/payload"), b"content").unwrap();
    let service = DirectorySizeService::default(); service.initialize_storage(root.0.join("cache"));
    let events = Arc::new(Mutex::new(vec![])); let captured = events.clone();
    let sink: Arc<EventSink> = Arc::new(move |_, event| captured.lock().unwrap().push(event));
    service.open_owner("main"); service.start(Arc::downgrade(&sink));
    service.subscribe(service.owner_token("main").unwrap(), SubscribeDirectorySizesRequest {
        consumer_id: "rename-storage".into(), target: DirectorySizeTarget::Local { path: directory.to_string_lossy().into_owned() }, refresh: false, handoff: None,
    }, None).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !events.lock().unwrap().iter().any(|event| event.phase == DirectorySizePhase::Complete) {
        assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(10));
    }
    service.storage.lock().unwrap().as_ref().unwrap().flush(Duration::from_secs(2)).unwrap();
    let jobs = service.core.lock().unwrap().jobs_started;
    service.rename_file(&old, &new, true).unwrap();
    service.storage.lock().unwrap().as_ref().unwrap().flush(Duration::from_secs(2)).unwrap();
    let result = service.storage.lock().unwrap().as_ref().unwrap().lookup(vec![new.join("deep").to_string_lossy().into_owned()], None).unwrap()
        .recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
    assert_eq!(result.len(), 1, "accepted rename must migrate disk-only descendant paths");
    assert_eq!(result[0].record.size.bytes, 7);
    assert_eq!(service.core.lock().unwrap().jobs_started, jobs);
    service.shutdown();
}

#[cfg(windows)]
#[test]
fn size_runtime_cache_artifacts_count_actual_bytes_without_rescanning_on_commits() {
    let root = TestRoot::new(); let cache = root.0.join("cache");
    fs::write(root.0.join("ordinary"), [0_u8; 20]).unwrap();
    let service = DirectorySizeService::default(); service.initialize_storage(cache.clone());
    service.storage.lock().unwrap().as_ref().unwrap().flush(Duration::from_secs(2)).unwrap();
    let events = Arc::new(Mutex::new(vec![])); let observed = events.clone();
    let sink: Arc<EventSink> = Arc::new(move |_, snapshot| observed.lock().unwrap().push(snapshot));
    service.open_owner("main"); service.start(Arc::downgrade(&sink));
    service.subscribe(service.owner_token("main").unwrap(), SubscribeDirectorySizesRequest {
        consumer_id: "artifacts".into(), target: DirectorySizeTarget::Local { path: root.0.to_str().unwrap().into() }, refresh: false, handoff: None,
    }, None).unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    while !events.lock().unwrap().iter().any(|event| event.phase == DirectorySizePhase::Complete) {
        assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(20));
    }
    let jobs = service.core.lock().unwrap().jobs_started;
    for ticket in 1..=3 {
        let store = service.storage.lock().unwrap().clone().unwrap();
        let header = super::storage::ScanHeader { id: format!("other-scan-{ticket}"), session: "other-scans".into(),
            root: "C:\\other".into(), generation: ticket, captured_at: chrono::Utc::now(), policy_version: 2 };
        assert!(store.append(header.clone(), vec![super::storage::StoredDirectory { path: "C:\\other".into(), artifact_capture: None,
            size: super::scan::DirectorySize { bytes: ticket, complete: true, fingerprint: None, created_at: Some(chrono::Utc::now()),
                stats: super::scan::ScanStats { directories: 1, ..Default::default() } } }]));
        assert!(store.accept(header, ticket));
        service.storage.lock().unwrap().as_ref().unwrap().flush(Duration::from_secs(2)).unwrap();
        std::thread::sleep(Duration::from_millis(300));
    }
    assert_eq!(service.core.lock().unwrap().jobs_started, jobs, "cache commits/checkpoints cannot recursively rescan their own ancestor");
    let artifact_bytes: u64 = fs::read_dir(&cache).unwrap().map(|entry| entry.unwrap().metadata().unwrap().len()).sum();
    let latest = events.lock().unwrap().last().unwrap().clone();
    assert_eq!(latest.phase, DirectorySizePhase::Complete);
    assert_eq!(latest.total_bytes.as_deref(), Some((artifact_bytes + 20).to_string().as_str()));
    assert_eq!(latest.files, 1 + fs::read_dir(&cache).unwrap().count() as u64);
    fs::write(root.0.join("ordinary"), [0_u8; 70]).unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    while service.core.lock().unwrap().jobs_started == jobs {
        assert!(Instant::now() < deadline, "ordinary file edits still invalidate cached sizes");
        std::thread::sleep(Duration::from_millis(20));
    }
    service.shutdown();
}
fn await_complete(events: &Mutex<Vec<DirectorySizeSnapshot>>, consumer: &str, bytes: &str, min_generation: u64) -> DirectorySizeSnapshot {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        if let Some(snapshot) = events.lock().unwrap().iter().rev().find(|snapshot| snapshot.consumer_id == consumer
            && snapshot.phase == DirectorySizePhase::Complete && snapshot.total_bytes.as_deref() == Some(bytes) && snapshot.generation >= min_generation).cloned() { return snapshot; }
        assert!(Instant::now() < deadline, "background service did not publish {consumer}/{bytes}: {:?}", events.lock().unwrap());
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn size_runtime_persists_accepted_scan_without_waiting_for_shutdown() {
    let root = TestRoot::new(); let cache = TestRoot::new();
    fs::create_dir_all(root.0.join("child/deep")).unwrap();
    fs::write(root.0.join("child/deep/payload"), [0_u8; 60]).unwrap();
    let service = DirectorySizeService::default(); service.initialize_storage(cache.0.clone());
    let events = Arc::new(Mutex::new(vec![])); let observed = events.clone();
    let sink: Arc<EventSink> = Arc::new(move |_, snapshot| observed.lock().unwrap().push(snapshot));
    service.open_owner("main"); service.start(Arc::downgrade(&sink));
    service.subscribe(service.owner_token("main").unwrap(), SubscribeDirectorySizesRequest {
        consumer_id: "persist".into(), target: DirectorySizeTarget::Local { path: root.0.to_str().unwrap().into() }, refresh: false, handoff: None,
    }, None).unwrap();
    await_complete(&events, "persist", "60", 0);
    let reader = super::storage::Store::start(cache.0.clone());
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let hits = reader.lookup(vec![root.0.join("child/deep").to_str().unwrap().into()], None).unwrap()
            .recv_timeout(Duration::from_secs(1)).unwrap();
        if hits.is_ok_and(|hits| hits.len() == 1 && hits[0].record.size.bytes == 60) { break; }
        assert!(Instant::now() < deadline, "running service did not persist its accepted descendants");
        std::thread::sleep(Duration::from_millis(25));
    }
    reader.shutdown(Duration::from_secs(1)).unwrap(); service.shutdown();
    let restarted = DirectorySizeService::default(); restarted.initialize_storage(cache.0.clone());
    let mut listing = crate::services::fs_service::list_directory(&root.0, &[], |_| (vec![], None)).unwrap();
    restarted.attach_listing_cache(&mut listing);
    let cache = listing.directory_size_cache.expect("a ready indexed store must enrich the first listing before any scan");
    assert!(cache.historical);
    assert_eq!(cache.directories[0].bytes.as_deref(), Some("60"));
    assert_eq!(restarted.core.lock().unwrap().jobs_started, 0);
    restarted.open_owner("lookup"); let owner = restarted.owner_token("lookup").unwrap();
    let request = LookupDirectorySizeCacheRequest { path: root.0.to_str().unwrap().into(), request_version: 7,
        entries: vec![DirectorySizeCacheObject { path: listing.entries[0].path.clone(), created_at: listing.entries[0].created_at.unwrap() }] };
    let response = restarted.lookup_cache(owner.clone(), request.clone()).unwrap();
    assert_eq!(response.request_version, 7);
    assert_eq!(response.entries[0].status, DirectorySizeCacheStatus::Hit);
    let mut replaced = request.clone(); replaced.entries[0].created_at = chrono::DateTime::UNIX_EPOCH;
    assert_eq!(restarted.lookup_cache(owner.clone(), replaced).unwrap().entries[0].status, DirectorySizeCacheStatus::Miss);
    restarted.close_owner("lookup"); restarted.open_owner("lookup");
    assert!(restarted.lookup_cache(owner, request).is_err(), "old window epochs cannot receive enrichment");
    restarted.shutdown();
}

#[cfg(windows)]
#[test]
fn size_runtime_listing_carries_scanned_grandchildren_without_new_generation() {
    let root = TestRoot::new();
    let child = root.0.join("child");
    fs::create_dir_all(child.join("deep")).unwrap();
    fs::write(child.join("deep").join("payload"), [0_u8; 60]).unwrap();
    let service = DirectorySizeService::default();
    let events = Arc::new(Mutex::new(vec![])); let observed = events.clone();
    let sink: Arc<EventSink> = Arc::new(move |_, snapshot| observed.lock().unwrap().push(snapshot));
    service.open_owner("main"); service.start(Arc::downgrade(&sink));
    service.subscribe(service.owner_token("main").unwrap(), SubscribeDirectorySizesRequest {
        consumer_id: "parent".into(), target: DirectorySizeTarget::Local { path: root.0.to_str().unwrap().into() }, refresh: false, handoff: None
    }, None).unwrap();
    let parent = await_complete(&events, "parent", "60", 0);
    let mut listing = crate::services::fs_service::list_directory(&child, &[], |_| (vec![], None)).unwrap();
    service.attach_listing_cache(&mut listing);
    let cache = listing.directory_size_cache.as_ref().expect("first listing must carry cached grandchildren");
    assert_eq!(cache.generation, parent.generation);
    assert_eq!(cache.directories.len(), 2);
    assert!(cache.directories.iter().all(|record| record.bytes.as_deref() == Some("60")));
    service.subscribe(service.owner_token("main").unwrap(), SubscribeDirectorySizesRequest {
        consumer_id: "child".into(), target: DirectorySizeTarget::Local { path: child.to_str().unwrap().into() }, refresh: false, handoff: None
    }, None).unwrap();
    let scoped = await_complete(&events, "child", "60", 0);
    assert_eq!(scoped.generation, parent.generation);
    assert_eq!(scoped.directories, 2);
    listing.size_fingerprint = Some("different".into());
    service.attach_listing_cache(&mut listing);
    assert!(listing.directory_size_cache.is_none());
    service.shutdown();
}

#[cfg(windows)]
#[test]
fn size_runtime_streams_real_local_results_normalizes_lookup_and_recomputes_deep_changes() {
    let root = TestRoot::new();
    fs::create_dir(root.0.join("Folder")).unwrap();
    fs::write(root.0.join("Folder").join(".Hidden"), [0_u8; 60]).unwrap();
    fs::write(root.0.join("a"), [0_u8; 30]).unwrap();
    fs::write(root.0.join("b"), [0_u8; 10]).unwrap();
    let service = DirectorySizeService::default();
    let events = Arc::new(Mutex::new(vec![]));
    let observed = events.clone();
    let sink: Arc<EventSink> = Arc::new(move |owner, snapshot| { assert_eq!(owner, "main"); observed.lock().unwrap().push(snapshot); });
    service.open_owner("main"); service.open_owner("settings");
    service.start(Arc::downgrade(&sink));
    let request = SubscribeDirectorySizesRequest { consumer_id: "main-test".into(), target: DirectorySizeTarget::Local {
        path: root.0.to_str().unwrap().into() }, refresh: false, handoff: None };
    service.subscribe(service.owner_token("main").unwrap(), request.clone(), None).unwrap();
    let ready = await_complete(&events, "main-test", "100", 0);
    assert_eq!(ready.freshness, DirectorySizeFreshness::Monitored);
    let lookup = service.lookup("main", LookupDirectorySizesRequest { consumer_id: "main-test".into(), generation: ready.generation,
        paths: vec![root.0.to_str().unwrap().into(), root.0.join("Folder").to_str().unwrap().into()] }).unwrap();
    assert_eq!(lookup.directories[1].bytes.as_deref(), Some("60"));
    let listing = crate::services::fs_service::list_directory(&root.0, &[], |_| (vec![], None)).unwrap();
    assert_eq!(lookup.directories[0].size_fingerprint, listing.size_fingerprint);
    service.close_owner("settings");
    fs::write(root.0.join("Folder").join(".Hidden"), [0_u8; 120]).unwrap();
    let updated = await_complete(&events, "main-test", "160", ready.generation + 1);
    service.release("main", "main-test").unwrap();
    let cached = service.subscribe(service.owner_token("main").unwrap(), SubscribeDirectorySizesRequest { consumer_id: "cache-test".into(), ..request }, None).unwrap();
    assert_eq!(cached.phase, DirectorySizePhase::Queued);
    let verified = await_complete(&events, "cache-test", "160", updated.generation);
    assert_eq!(verified.generation, updated.generation, "cache validation must not traverse again");
    service.shutdown();
}

#[test]
fn size_runtime_contract_uses_typed_targets_camel_case_and_decimal_bytes() {
    let request: SubscribeDirectorySizesRequest = serde_json::from_value(serde_json::json!({
        "consumerId": "a", "target": { "kind": "remote", "profileId": "r", "path": "/root" }, "refresh": true
    })).unwrap();
    assert!(matches!(request.target, DirectorySizeTarget::Remote { profile_id, .. } if profile_id == "r"));
    let snapshot = DirectorySizeSnapshot { known_bytes: u64::MAX.to_string(), total_bytes: Some(u64::MAX.to_string()),
        phase: DirectorySizePhase::Complete, ..Default::default() };
    let json = serde_json::to_value(snapshot).unwrap();
    assert_eq!(json["knownBytes"], "18446744073709551615");
    assert_eq!(json["totalBytes"], "18446744073709551615");
    assert_eq!(json["phase"], "complete");
}

#[cfg(windows)]
#[test]
fn size_runtime_legacy_rename_preserves_parent_and_new_subtree_cache() {
    let root = TestRoot::new();
    fs::create_dir_all(root.0.join("old/deep")).unwrap();
    fs::write(root.0.join("old/deep/data"), [0; 60]).unwrap();
    let service = DirectorySizeService::default();
    let events = Arc::new(Mutex::new(vec![])); let observed = events.clone();
    let sink: Arc<EventSink> = Arc::new(move |_, event| observed.lock().unwrap().push(event));
    service.open_owner("main"); service.start(Arc::downgrade(&sink));
    service.subscribe(service.owner_token("main").unwrap(), SubscribeDirectorySizesRequest {
        consumer_id: "parent".into(), target: DirectorySizeTarget::Local { path: root.0.to_str().unwrap().into() }, refresh: false, handoff: None
    }, None).unwrap();
    let before = await_complete(&events, "parent", "60", 0);
    let counts = service.debug_counts();
    crate::services::fs_service::rename_entry_with_sizes(&root.0.join("old"), "new", &service).unwrap();
    for path in [&root.0, &root.0.join("new")] {
        let mut listing = crate::services::fs_service::list_directory(path, &[], |_| (vec![], None)).unwrap();
        service.attach_listing_cache(&mut listing);
        let cache = listing.directory_size_cache.expect("successful rename must keep the parent and descendant cache");
        assert!(cache.generation > before.generation);
        assert!(cache.directories.iter().all(|record| record.bytes.as_deref() == Some("60")));
    }
    assert_eq!(service.debug_counts(), counts, "rename reuses the existing root without a scan job");
    service.shutdown();
}

#[test]
fn size_runtime_profile_update_guard_releases_error_paths_and_keeps_nested_fences() {
    use crate::domain::models::{LocationKind, RemoteAuthKind, RemoteProfile};
    let service = DirectorySizeService::default();
    service.open_owner("main");
    let owner = service.owner_token("main").unwrap();
    let profile = RemoteProfile { id: "fake-profile".into(), name: "Fake".into(), protocol: LocationKind::Sftp,
        host: "example.invalid".into(), port: 22, username: "test".into(), root_path: "/".into(),
        auth_kind: RemoteAuthKind::Password, private_key_path: None, passive_mode: true, ignore_host_key: false,
        connect_timeout_secs: 1, command_timeout_secs: 1, credential_target: None, password: None };
    let request = SubscribeDirectorySizesRequest { consumer_id: "test-guard".into(),
        target: DirectorySizeTarget::Remote { profile_id: profile.id.clone(), path: "/root".into() }, refresh: false, handoff: None };
    let outer = service.profile_update(&profile.id);
    let failed_save = (|| -> Result<(), &str> {
        let _inner = service.profile_update(&profile.id);
        assert!(service.subscribe(owner.clone(), request.clone(), Some(profile.clone())).is_err());
        Err("simulated save failure without any credential I/O")
    })();
    assert!(failed_save.is_err());
    assert!(service.subscribe(owner.clone(), request.clone(), Some(profile.clone())).is_err(), "outer save is still active");
    drop(outer);
    assert!(service.subscribe(owner.clone(), request.clone(), Some(profile.clone())).is_ok(), "error-path Drop released both fences");
    let during_shutdown = service.profile_update(&profile.id);
    service.shutdown(); drop(during_shutdown);
    assert!(service.subscribe(owner, request, Some(profile)).is_err(), "dropping an update guard never reopens a stopped service");
    // No worker was started: this exercises acquisition/RAII without a server or secrets.
}

#[cfg(windows)]
#[test]
fn size_runtime_preserves_unicode_roots_and_discovered_directory_spellings() {
    let root = TestRoot::new();
    for (name, bytes) in [("İ", 60), ("i\u{307}", 90)] {
        fs::create_dir_all(root.0.join(name).join("Nested")).unwrap();
        fs::write(root.0.join(name).join("Nested").join("payload"), vec![0_u8; bytes]).unwrap();
    }
    let service = DirectorySizeService::default();
    let events = Arc::new(Mutex::new(vec![])); let observed = events.clone();
    let sink: Arc<EventSink> = Arc::new(move |_, snapshot| observed.lock().unwrap().push(snapshot));
    service.open_owner("main"); service.start(Arc::downgrade(&sink));
    for (id, path) in [("dotted", root.0.join("İ")), ("decomposed", root.0.join("i\u{307}")), ("parent", root.0.clone())] {
        service.subscribe(service.owner_token("main").unwrap(), SubscribeDirectorySizesRequest {
            consumer_id: id.into(), target: DirectorySizeTarget::Local { path: path.to_str().unwrap().into() }, refresh: false, handoff: None
        }, None).unwrap();
    }
    let dotted = await_complete(&events, "dotted", "60", 0);
    let decomposed = await_complete(&events, "decomposed", "90", 0);
    assert_ne!(dotted.generation, decomposed.generation, "different filesystem roots cannot share a scan");
    let parent = await_complete(&events, "parent", "150", 0);
    let paths = vec![root.0.to_str().unwrap().into(), root.0.join("İ").to_str().unwrap().into(), root.0.join("i\u{307}").to_str().unwrap().into()];
    let lookup = service.lookup("main", LookupDirectorySizesRequest { consumer_id: "parent".into(), generation: parent.generation, paths }).unwrap();
    assert_eq!(lookup.directories.iter().map(|record| record.bytes.as_deref()).collect::<Vec<_>>(), [Some("150"), Some("60"), Some("90")]);
    let listing = crate::services::fs_service::list_directory(&root.0, &[], |_| (vec![], None)).unwrap();
    assert_eq!(lookup.directories[0].size_fingerprint, listing.size_fingerprint);
    service.shutdown();
}

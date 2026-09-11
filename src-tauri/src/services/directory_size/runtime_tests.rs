use super::{DirectorySizeService, EventSink};
use crate::domain::directory_sizes::*;
use std::{fs, path::PathBuf, sync::{Arc, Mutex}, time::{Duration, Instant}};

struct TestRoot(PathBuf);
impl TestRoot {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("athenaeum-size-runtime-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap(); Self(path)
    }
}
impl Drop for TestRoot { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
fn await_complete(events: &Mutex<Vec<DirectorySizeSnapshot>>, consumer: &str, bytes: &str, min_generation: u64) -> DirectorySizeSnapshot {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        if let Some(snapshot) = events.lock().unwrap().iter().rev().find(|snapshot| snapshot.consumer_id == consumer
            && snapshot.phase == DirectorySizePhase::Complete && snapshot.total_bytes.as_deref() == Some(bytes) && snapshot.generation >= min_generation).cloned() { return snapshot; }
        assert!(Instant::now() < deadline, "background service did not publish {consumer}/{bytes}: {:?}", events.lock().unwrap());
        std::thread::sleep(Duration::from_millis(20));
    }
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
        path: root.0.to_str().unwrap().into() }, refresh: false };
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
        target: DirectorySizeTarget::Remote { profile_id: profile.id.clone(), path: "/root".into() }, refresh: false };
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
            consumer_id: id.into(), target: DirectorySizeTarget::Local { path: path.to_str().unwrap().into() }, refresh: false
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

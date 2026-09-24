use super::{DirectorySizeService, EventSink};
use crate::domain::directory_sizes::*;
use std::{fs, path::PathBuf, sync::{Arc, Mutex}, time::{Duration, Instant}};

struct TestRoot(PathBuf);
impl TestRoot {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("athenaeum-size-history-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(path.join("child")).unwrap(); Self(path)
    }
}
impl Drop for TestRoot { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
fn start(service: &DirectorySizeService) -> (Arc<Mutex<Vec<DirectorySizeSnapshot>>>, Arc<EventSink>) {
    let events = Arc::new(Mutex::new(vec![])); let observed = events.clone();
    let sink: Arc<EventSink> = Arc::new(move |_, event| observed.lock().unwrap().push(event));
    service.open_owner("main"); service.start(Arc::downgrade(&sink)); (events, sink)
}
fn subscribe(service: &DirectorySizeService, root: &std::path::Path) {
    service.subscribe(service.owner_token("main").unwrap(), SubscribeDirectorySizesRequest {
        consumer_id: "history".into(), target: DirectorySizeTarget::Local { path: root.to_str().unwrap().into() }, refresh: false,
    }, None).unwrap();
}
fn await_size(events: &Mutex<Vec<DirectorySizeSnapshot>>, bytes: &str) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if events.lock().unwrap().iter().any(|event| event.phase == DirectorySizePhase::Complete && event.total_bytes.as_deref() == Some(bytes)) { return; }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("scan did not finish: {:?}", events.lock().unwrap());
}
fn listing(service: &DirectorySizeService, path: &std::path::Path) -> crate::domain::models::DirectoryListing {
    let mut value = crate::services::fs_service::list_directory(path, &[], |_| (vec![], None)).unwrap();
    service.attach_listing_cache(&mut value); value
}

#[test]
fn history_restart_displays_old_child_size_before_any_new_scan_and_refreshes() {
    let root = TestRoot::new(); let cache = root.0.join("sizes.ndjson");
    fs::write(root.0.join("child/payload"), [0; 60]).unwrap();
    let service = DirectorySizeService::default(); service.initialize_history(cache.clone());
    let (events, _sink) = start(&service); subscribe(&service, &root.0); await_size(&events, "60");
    assert!(!cache.exists(), "writing under the watched root must not cause self-refresh loops");
    service.shutdown();
    assert!(cache.exists(), "an orderly close must save accepted size summaries");
    let saved = fs::read(&cache).unwrap(); service.shutdown(); assert_eq!(fs::read(&cache).unwrap(), saved);
    fs::write(root.0.join("child/payload"), [0; 120]).unwrap();
    let restarted = DirectorySizeService::default(); restarted.initialize_history(cache);
    let cached = listing(&restarted, &root.0).directory_size_cache.expect("history precedes a lease or scan");
    let child = cached.directories.iter().find(|record| record.path.ends_with("child")).unwrap();
    assert_eq!(child.bytes.as_deref(), Some("60"));
    let (events, _sink2) = start(&restarted); subscribe(&restarted, &root.0.join("child")); await_size(&events, "120");
    let refreshed = listing(&restarted, &root.0).directory_size_cache.unwrap();
    assert_eq!(refreshed.directories.iter().find(|record| record.path.ends_with("child")).unwrap().bytes.as_deref(), Some("120"));
    restarted.shutdown();
}

#[test]
fn corrupt_history_does_not_block_listing_or_service_creation() {
    let root = TestRoot::new(); let cache = root.0.join("sizes.ndjson");
    fs::write(&cache, b"{broken\n").unwrap();
    let service = DirectorySizeService::default(); service.initialize_history(cache);
    assert!(listing(&service, &root.0).directory_size_cache.is_none());
    service.shutdown();
}

#[test]
fn sparse_live_listing_preserves_history_for_evicted_child_details() {
    use super::{core::SizeWatch, history::HistoricalSize, local::LocalMetadataSource,
        scan::{scan_directory, ScanLimits}, target::normalize_local_path, watch::{RootIdentity, WatchPoll}};
    struct QuietWatch;
    impl SizeWatch for QuietWatch { fn poll(&mut self) -> WatchPoll { WatchPoll::Quiet } }
    let root = TestRoot::new();
    fs::write(root.0.join("child/payload"), [0; 60]).unwrap();
    let service = DirectorySizeService::default(); service.open_owner("main");
    subscribe(&service, &root.0);
    let raw = listing(&service, &root.0);
    let child = &raw.entries[0];
    {
        let mut core = service.core.lock().unwrap();
        core.history_enabled = true;
        core.history.insert(Arc::from(normalize_local_path(&child.path).unwrap()), HistoricalSize {
            bytes: 50, complete: true, created_at: child.created_at.unwrap(), cached_at: chrono::DateTime::UNIX_EPOCH,
        }, 4096);
        let job = core.take_jobs(0).remove(0);
        let identity = Some(RootIdentity([1, 2, 3, 4]));
        core.prepared(&job, identity, Some(Box::new(QuietWatch)), 0);
        let result = scan_directory(&job.target.path, &mut LocalMetadataSource, &job.cancelled,
            ScanLimits { max_directories: 1, ..Default::default() }, |_| {});
        core.finished(&job, result, identity, 1);
    }
    let cache = listing(&service, &root.0).directory_size_cache.unwrap();
    assert!(cache.directories.iter().any(|record| record.path == child.path && record.bytes.as_deref() == Some("50")),
        "a retained root total must not suppress historical child values whose live details were evicted");
    assert!(cache.historical, "a mixed display cannot certify a live generation");
    service.shutdown();
}

#[test]
fn history_stream_limits_identity_and_atomic_failure_keep_bounded_valid_data() {
    use super::{history::{History, HistoricalSize}, target::normalize_local_path};
    let root = TestRoot::new(); let cache = root.0.join("sizes.ndjson");
    let path = normalize_local_path(root.0.join("child").to_str().unwrap()).unwrap();
    let size = HistoricalSize { bytes: 12, complete: true, created_at: chrono::DateTime::UNIX_EPOCH, cached_at: chrono::Utc::now() };
    let mut history = History::default();
    for i in 0..1000 { history.insert(Arc::from(format!("{path}\\d{i}")), size.clone(), 4096); }
    assert!(history.bytes <= 4096);
    history.insert(Arc::from(path.as_str()), size.clone(), 4096);
    history.save(&cache).unwrap();
    let loaded = History::load(&cache, 1024).unwrap(); assert!(loaded.bytes <= 1024);
    assert_eq!(loaded.get(&path).unwrap().bytes, 12);
    let service = DirectorySizeService::default(); service.initialize_history(cache.clone());
    assert!(listing(&service, &root.0).directory_size_cache.is_none(), "a different creation stamp is not reusable");
    service.shutdown();
    for invalid in [b"{\"directorySizeHistoryVersion\":99}\n".to_vec(),
        [b"{\"directorySizeHistoryVersion\":1}\n".as_slice(), &vec![b'x'; 256 * 1024 + 1]].concat()] {
        fs::write(&cache, invalid).unwrap(); assert!(History::load(&cache, 4096).is_err());
    }
    let file = fs::File::create(&cache).unwrap(); file.set_len(256 * 1024 * 1024 + 1).unwrap(); drop(file);
    assert!(History::load(&cache, 4096).is_err());
    history.save(&cache).unwrap(); let previous = fs::read(&cache).unwrap();
    let failure = crate::services::atomic_file::write_atomically_stream(&cache, |file| {
        use std::io::Write; file.write_all(b"incomplete")?; anyhow::bail!("injected stream failure")
    });
    assert!(failure.is_err()); assert_eq!(fs::read(&cache).unwrap(), previous);
}

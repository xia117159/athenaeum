use std::{fs, path::PathBuf, sync::atomic::AtomicBool, time::{Duration, Instant}};
use super::{local::LocalMetadataSource, scan::{scan_directory, ScanLimits, ScanOutcome}, watch::{read_root_identity, RecursiveWatch, WatchPoll}};

struct TestRoot(PathBuf);
impl TestRoot {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("athenaeum-size-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for TestRoot { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

#[test]
fn local_size_streams_completed_subtrees_even_when_memory_retains_only_the_root() {
    use super::scan::{DirectoryCursor, DirectorySize, MetadataSource};
    struct RecordingSource { records: Vec<(String, u64)> }
    impl MetadataSource for RecordingSource {
        fn read_directory(&mut self, _: &str, _: &AtomicBool, _: &mut dyn FnMut(super::metadata::MetadataEntry) -> bool) -> Result<(), String> { unreachable!() }
        fn open_directory(&mut self, path: &str, cancelled: &AtomicBool) -> Option<Result<DirectoryCursor, String>> {
            LocalMetadataSource.open_directory(path, cancelled)
        }
        fn directory_completed(&mut self, path: &str, size: &DirectorySize) {
            self.records.push((path.into(), size.bytes));
        }
    }
    let root = TestRoot::new(); fs::create_dir_all(root.0.join("child/deep")).unwrap();
    fs::write(root.0.join("child/deep/payload"), [0_u8; 60]).unwrap();
    let mut source = RecordingSource { records: vec![] };
    let result = scan_directory(root.0.to_str().unwrap(), &mut source, &AtomicBool::new(false),
        ScanLimits { max_directories: 1, ..Default::default() }, |_| {});
    assert_eq!(result.outcome, ScanOutcome::Complete);
    assert_eq!(result.directories.len(), 1);
    assert_eq!(source.records.len(), 3);
    assert!(source.records.iter().all(|(_, bytes)| *bytes == 60));
    assert_eq!(source.records.last().unwrap().0, root.0.to_str().unwrap());
}

#[test]
fn local_size_scan_matches_raw_listing_fingerprint_and_includes_hidden_and_empty() {
    let root = TestRoot::new();
    fs::create_dir(root.0.join("folder")).unwrap();
    fs::create_dir(root.0.join("empty")).unwrap();
    fs::write(root.0.join("folder").join(".hidden"), [0_u8; 60]).unwrap();
    fs::write(root.0.join("a"), [0_u8; 30]).unwrap();
    fs::write(root.0.join("b"), [0_u8; 10]).unwrap();
    let result = scan_directory(root.0.to_str().unwrap(), &mut LocalMetadataSource, &AtomicBool::new(false), ScanLimits::default(), |_| {});
    assert_eq!(result.outcome, ScanOutcome::Complete);
    assert_eq!(result.stats.known_bytes, 100);
    let listing = crate::services::fs_service::list_directory(&root.0, &[], |_| (vec![], None)).unwrap();
    let serialized = serde_json::to_value(&listing).unwrap();
    assert_eq!(serialized.get("sizeFingerprint").and_then(|value| value.as_str()), result.directories[root.0.to_str().unwrap()].fingerprint.as_deref());
    assert!(serialized.get("sizeFingerprint").and_then(|value| value.as_str()).is_some());
    assert!(result.directories[root.0.join("empty").to_str().unwrap()].complete);
}

#[test]
fn local_size_identity_changes_when_a_root_is_renamed_and_replaced_even_if_empty() {
    let container = TestRoot::new();
    let root = container.0.join("root");
    fs::create_dir(&root).unwrap();
    let before = read_root_identity(&root).expect("directory identity should be available");
    fs::rename(&root, container.0.join("root-old")).unwrap();
    fs::create_dir(&root).unwrap();
    let after = read_root_identity(&root).unwrap();
    assert_ne!(before, after);
    assert_eq!(after, read_root_identity(&root).unwrap());
    fs::remove_dir(&root).unwrap();
    assert!(read_root_identity(&root).is_err());
    fs::create_dir(&root).unwrap();
    assert_ne!(after, read_root_identity(&root).unwrap());
}

#[cfg(windows)]
#[test]
fn local_size_recursive_watch_observes_deep_content_changes_without_root_listing_changes() {
    let root = TestRoot::new();
    let deep = root.0.join("a").join("b");
    fs::create_dir_all(&deep).unwrap();
    fs::write(deep.join("file"), [0_u8; 1]).unwrap();
    let mut watch = RecursiveWatch::open(root.0.to_str().unwrap()).expect("recursive watcher must be available");
    assert_eq!(watch.poll(), WatchPoll::Quiet);
    fs::write(deep.join("file"), [0_u8; 21]).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if watch.poll() == WatchPoll::Changed { break; }
        assert!(Instant::now() < deadline, "deep change notification not observed");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(windows)]
#[test]
fn local_size_scan_excludes_directory_junctions_and_rejects_a_link_root() {
    use std::os::windows::process::CommandExt;
    let root = TestRoot::new();
    let outside = TestRoot::new();
    fs::write(outside.0.join("not-counted"), [0_u8; 100]).unwrap();
    let junction = root.0.join("junction");
    let output = std::process::Command::new("cmd.exe").args(["/c", "mklink", "/J"])
        .arg(&junction).arg(&outside.0).creation_flags(0x08000000).output().unwrap();
    assert!(output.status.success(), "test junction creation failed");
    let result = scan_directory(root.0.to_str().unwrap(), &mut LocalMetadataSource, &AtomicBool::new(false), ScanLimits::default(), |_| {});
    assert_eq!(result.outcome, ScanOutcome::Complete);
    assert_eq!(result.stats.known_bytes, 0);
    assert_eq!(result.stats.skipped_links, 1);
    assert!(read_root_identity(&junction).is_err());
    let rejected = scan_directory(junction.to_str().unwrap(), &mut LocalMetadataSource, &AtomicBool::new(false), ScanLimits::default(), |_| {});
    assert_eq!(rejected.outcome, ScanOutcome::Failed);
    assert_eq!(rejected.stats.files, 0);
    let listing = crate::services::fs_service::list_directory(&root.0, &[], |_| (vec![], None)).unwrap();
    assert!(listing.entries[0].is_symlink);
    fs::remove_dir(&junction).unwrap();
    assert!(outside.0.join("not-counted").exists());
}
#[cfg(windows)]
#[test]
fn local_size_watch_reports_actual_rename_names_and_keeps_watching_the_same_tree() {
    use super::watch::{ChangeKind, RecursiveWatch};
    use std::time::{Duration, Instant};
    let path = std::env::temp_dir().join(format!("athenaeum-size-events-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(path.join("old").join("deep")).unwrap();
    let mut watch = RecursiveWatch::open(path.to_str().unwrap()).unwrap();
    std::fs::rename(path.join("old"), path.join("new")).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut events = vec![];
    while Instant::now() < deadline {
        let changes = watch.take_changes();
        assert!(!changes.lost, "ordinary rename must retain detailed monitoring");
        events.extend(changes.events);
        if events.iter().any(|event| event.kind == ChangeKind::RenameNew) { break; }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(events.iter().any(|event| event.kind == ChangeKind::RenameOld && event.path == "old"));
    assert!(events.iter().any(|event| event.kind == ChangeKind::RenameNew && event.path == "new"));
    std::fs::write(path.join("new/deep/payload"), b"new bytes").unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut saw_payload = false;
    while Instant::now() < deadline {
        let changes = watch.take_changes();
        assert!(!changes.lost);
        if changes.events.iter().any(|event| event.path.ends_with("payload")) { saw_payload = true; break; }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(saw_payload);
    drop(watch);
    std::fs::remove_dir_all(path).unwrap();
}

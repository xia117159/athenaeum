use super::{database::{Database, ScanHeader, StoredDirectory}, maintenance::{Maintenance, Protection}, worker::Store};
use super::super::scan::{DirectorySize, ScanStats};
use std::{fs, path::PathBuf, sync::atomic::Ordering, time::{Duration, Instant}};

struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("athenaeum-size-idle-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap(); Self(path)
    }
}
impl Drop for Root { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
fn header(id: &str) -> ScanHeader {
    ScanHeader { id: id.into(), session: "session".into(), root: "C:\\root".into(), generation: 1,
        captured_at: chrono::Utc::now(), policy_version: 1 }
}
fn record(path: &str) -> StoredDirectory {
    StoredDirectory { path: path.into(), artifact_capture: None, size: DirectorySize { bytes: 60, complete: true,
        fingerprint: Some("stamp".into()), created_at: Some(chrono::DateTime::from_timestamp(1000, 0).unwrap()),
        stats: ScanStats { known_bytes: 60, files: 1, directories: 1, ..Default::default() } } }
}
fn wait_until(what: &str, timeout: Duration, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn scan_count(root: &Root, id: &str) -> Option<u64> {
    Database::open(&root.0).ok()?.connection.query_row("SELECT count(*) FROM scans WHERE id=?1", [id], |row| row.get(0)).ok()
}

#[test]
fn size_storage_worker_blocks_without_wakeups_or_writes_when_idle() {
    let root = Root::new(); let store = Store::start_for_test(root.0.clone());
    assert!(store.append(header("saved"), vec![record("C:\\root\\child")])); assert!(store.accept(header("saved"), 1));
    store.flush(Duration::from_secs(2)).unwrap();
    wait_until("an untimed idle wait", Duration::from_secs(10), || store.idle_for_test());
    let (iterations, writes) = (store.iterations_for_test(), store.vfs_writes_for_test());
    std::thread::sleep(Duration::from_millis(600));
    assert!(store.idle_for_test());
    assert_eq!(store.iterations_for_test(), iterations, "an idle worker must not wake up");
    assert_eq!(store.vfs_writes_for_test(), writes, "an idle worker must not write the cache files");
    store.shutdown(Duration::from_secs(2)).unwrap();
}

#[test]
fn size_storage_unchanged_protection_does_not_wake_the_worker() {
    let root = Root::new(); let store = Store::start_for_test(root.0.clone());
    store.protect("session", vec!["a".into(), "b".into()]);
    wait_until("an untimed idle wait", Duration::from_secs(10), || store.idle_for_test());
    let iterations = store.iterations_for_test();
    store.protect("session", vec!["b".into(), "a".into()]);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(store.iterations_for_test(), iterations, "the same pin set in another order is not a change");
    store.shutdown(Duration::from_secs(2)).unwrap();
}

#[test]
fn size_storage_failing_maintenance_gives_up_after_its_retry_budget_and_recovers_on_a_new_trigger() {
    let root = Root::new();
    let mut db = Database::open(&root.0).unwrap();
    db.append(&header("cancelled"), &[record("C:\\root\\child")]).unwrap(); drop(db);
    let store = Store::paused_for_test(8192, 2048);
    store.fail_maintenance_for_test(true);
    store.resume_with_retry_for_test(root.0.clone(), [1, 2, 5, 10, 30]);
    wait_until("maintenance to give up", Duration::from_secs(5), || store.idle_for_test());
    assert_eq!(store.maintenance_attempts_for_test(), 6, "one attempt plus one per retry interval");
    assert!(store.diagnostics().last_error.is_some());
    assert_eq!(scan_count(&root, "cancelled"), Some(1));
    store.fail_maintenance_for_test(false);
    store.protect("session", vec!["unrelated".into()]);
    wait_until("the cancelled scan to be swept", Duration::from_secs(5), || scan_count(&root, "cancelled") == Some(0));
    wait_until("an untimed idle wait", Duration::from_secs(5), || store.idle_for_test());
    store.shutdown(Duration::from_secs(2)).unwrap();
}

#[test]
fn size_maintenance_does_not_write_when_nothing_is_reclaimable() {
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    let rows: Vec<_> = (0..200).map(|index| record(&format!("C:\\root\\{index:03}"))).collect();
    db.append(&header("saved"), &rows).unwrap(); db.publish("saved", 1).unwrap();
    let temporary: Vec<_> = (0..1000).map(|index| record(&format!("C:\\root\\t{index:04}{}", "x".repeat(200)))).collect();
    db.append(&header("temporary"), &temporary).unwrap();
    db.connection.execute_batch("DELETE FROM records WHERE scan_id='temporary'; DELETE FROM scans WHERE id='temporary';").unwrap();
    db.checkpoint().unwrap();
    let free: u64 = db.connection.query_row("PRAGMA freelist_count", [], |row| row.get(0)).unwrap();
    assert!(free > 0 && free * 4096 < 32 << 20, "the fixture needs free pages below the shrink threshold");
    let writes = db.vfs_writes(); let before = writes.load(Ordering::SeqCst);
    let protection = Protection { session: "session".into(), ..Default::default() };
    let mut maintenance = Maintenance::default();
    maintenance.opened(false);
    assert!(maintenance.run_until_idle(&mut db, &protection).unwrap() > 0);
    assert_eq!(writes.load(Ordering::SeqCst), before, "maintenance without garbage must not move pages or write the WAL");
}

fn query(root: &Root, sql: &str) -> Option<u64> {
    Database::open(&root.0).ok()?.connection.query_row(sql, [], |row| row.get(0)).ok()
}
fn versioned(id: &str, generation: u64) -> ScanHeader { ScanHeader { generation, ..header(id) } }

#[test]
fn size_storage_released_pins_are_swept_and_the_worker_returns_to_idle() {
    let root = Root::new(); let store = Store::start_for_test(root.0.clone());
    store.protect("session", vec!["pinned".into()]);
    assert!(store.append(header("pinned"), vec![record("C:\\root\\child")])); store.flush(Duration::from_secs(2)).unwrap();
    wait_until("an untimed idle wait", Duration::from_secs(10), || store.idle_for_test());
    assert_eq!(scan_count(&root, "pinned"), Some(1), "a pinned unpublished scan is kept");
    store.protect("session", vec![]);
    wait_until("the released scan to be swept", Duration::from_secs(10), || scan_count(&root, "pinned") == Some(0));
    assert_eq!(query(&root, "SELECT count(*) FROM records"), Some(0));
    wait_until("an untimed idle wait", Duration::from_secs(5), || store.idle_for_test());
    store.shutdown(Duration::from_secs(2)).unwrap();
}

#[test]
fn size_storage_commits_after_the_idle_deadline_without_a_flush() {
    let root = Root::new(); let store = Store::start_for_test(root.0.clone());
    assert!(store.append(header("saved"), vec![record("C:\\root\\child")])); assert!(store.accept(header("saved"), 1));
    wait_until("the debounced commit", Duration::from_secs(5), || store.diagnostics().last_commit.is_some());
    store.shutdown(Duration::from_secs(2)).unwrap();
}

#[test]
fn size_storage_released_versions_converge_at_runtime_and_after_reopening() {
    let versions = |root: &Root| query(root, "SELECT count(*) FROM records");
    let root = Root::new(); let store = Store::start_for_test(root.0.clone());
    store.protect("session", vec!["v1".into()]);
    for ticket in 1..=3 {
        let id = format!("v{ticket}");
        assert!(store.append(versioned(&id, ticket), vec![record("C:\\root")])); assert!(store.accept(versioned(&id, ticket), ticket));
    }
    store.flush(Duration::from_secs(2)).unwrap();
    wait_until("an untimed idle wait", Duration::from_secs(10), || store.idle_for_test());
    assert_eq!(versions(&root), Some(3), "a pinned third version survives turnover");
    store.protect("session", vec![]);
    wait_until("the released version to retire", Duration::from_secs(10), || versions(&root) == Some(2) && scan_count(&root, "v1") == Some(0));
    wait_until("an untimed idle wait", Duration::from_secs(5), || store.idle_for_test());
    store.protect("session", vec!["v2".into()]);
    for ticket in 4..=5 {
        let id = format!("v{ticket}");
        assert!(store.append(versioned(&id, ticket), vec![record("C:\\root")])); assert!(store.accept(versioned(&id, ticket), ticket));
    }
    store.shutdown(Duration::from_secs(2)).unwrap();
    assert!(versions(&root).unwrap() > 2, "pins kept extra versions until shutdown");
    let reopened = Store::start_for_test(root.0.clone());
    wait_until("the store to reopen", Duration::from_secs(5), || reopened.diagnostics().ready);
    wait_until("versions to converge after reopening", Duration::from_secs(10), || versions(&root) == Some(2));
    reopened.shutdown(Duration::from_secs(2)).unwrap();
}

#[test]
fn size_storage_appends_that_raise_pressure_start_eviction() {
    use super::super::target::normalize_local_path;
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    let cold: Vec<_> = (0..256).map(|index| record(&format!("C:\\root\\cold\\{index:04}-{}", "x".repeat(600)))).collect();
    db.append(&header("old"), &cold).unwrap(); db.publish("old", 1).unwrap(); db.checkpoint().unwrap();
    let pages: u32 = db.connection.query_row("PRAGMA page_count", [], |row| row.get(0)).unwrap(); drop(db);
    let store = Store::paused_for_test(1 << 20, 4096); store.protect("session", vec!["new".into()]);
    store.resume_with_page_limit_for_test(root.0.clone(), pages * 5 / 4);
    store.flush(Duration::from_secs(2)).unwrap();
    assert!(!store.diagnostics().capacity_pressure, "the fixture opens below the pressure line");
    let fresh: Vec<_> = (0..24).map(|index| StoredDirectory {
        path: normalize_local_path(&format!("C:\\root\\fresh\\{index:04}-{}", "y".repeat(600))).unwrap(), ..record("C:\\root") }).collect();
    assert!(store.append(header("new"), fresh)); store.flush(Duration::from_secs(2)).unwrap();
    wait_until("eviction to relieve pressure", Duration::from_secs(10), || {
        query(&root, "SELECT count(*) FROM records WHERE scan_id='old'").is_some_and(|rows| rows < 256) && !store.diagnostics().capacity_pressure
    });
    wait_until("an untimed idle wait", Duration::from_secs(5), || store.idle_for_test());
    store.shutdown(Duration::from_secs(2)).unwrap();
}

#[test]
fn size_storage_operation_copies_that_raise_pressure_start_eviction() {
    use super::operations::{Operation, RenamePath};
    use super::super::target::normalize_local_path;
    let path = |path: &str| normalize_local_path(path).unwrap();
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    let rows = |prefix: &str, count: usize| -> Vec<_> { (0..count).map(|index| StoredDirectory {
        path: path(&format!("{prefix}\\{index:04}-{}", "x".repeat(600))), ..record("C:\\root") }).collect() };
    db.append(&header("cold"), &rows("C:\\root\\cold", 256)).unwrap(); db.publish("cold", 1).unwrap();
    db.append(&header("saved"), &rows("C:\\root\\old", 40)).unwrap(); db.publish("saved", 2).unwrap();
    db.checkpoint().unwrap();
    let pages: u32 = db.connection.query_row("PRAGMA page_count", [], |row| row.get(0)).unwrap(); drop(db);
    let store = Store::paused_for_test(1 << 20, 4096);
    store.resume_with_page_limit_for_test(root.0.clone(), pages * 5 / 4);
    wait_until("the store to open", Duration::from_secs(5), || store.diagnostics().ready);
    assert!(!store.diagnostics().capacity_pressure, "the fixture opens below the pressure line");
    let rename = Operation { id: "rename".into(), session: "session".into(), generation: 2,
        paths: vec![RenamePath { from: path("C:\\root\\old"), to: path("C:\\root\\new") }], scans: vec!["saved".into()], patches: vec![] };
    store.prepare_operation(rename.clone(), Duration::from_secs(2)).unwrap(); assert!(store.authorize_operation(rename));
    wait_until("the copy's pressure to start eviction", Duration::from_secs(10), || {
        query(&root, "SELECT count(*) FROM records WHERE scan_id='cold'").is_some_and(|rows| rows < 256)
    });
    wait_until("the operation to complete", Duration::from_secs(10), || scan_count(&root, "saved") == Some(0));
    wait_until("an untimed idle wait", Duration::from_secs(10), || store.idle_for_test());
    assert!(!store.diagnostics().capacity_pressure, "eviction ended once the copy's pressure was relieved");
    store.shutdown(Duration::from_secs(2)).unwrap();
}

#[test]
fn size_storage_late_appends_after_cancellation_are_swept() {
    let root = Root::new(); let store = Store::start_for_test(root.0.clone());
    store.protect("session", vec!["late".into()]); store.protect("session", vec![]);
    // Let open and the pin change finish their own sweeps first.
    wait_until("an untimed idle wait", Duration::from_secs(10), || store.idle_for_test());
    assert!(store.append(header("late"), vec![record("C:\\root\\child")])); store.flush(Duration::from_secs(2)).unwrap();
    wait_until("the late scan to be swept", Duration::from_secs(10), || scan_count(&root, "late") == Some(0));
    store.shutdown(Duration::from_secs(2)).unwrap();
}

#[test]
fn size_storage_operation_and_open_events_start_cleanup() {
    use super::operations::{Operation, RenamePath};
    use super::super::target::normalize_local_path;
    let barriers = |root: &Root| query(root, "SELECT count(*) FROM barriers");
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    db.append(&header("crashed"), &[record("C:\\root\\crashed")]).unwrap(); drop(db);
    let store = Store::start_for_test(root.0.clone());
    // Opening the file first would take the writer lock from the store.
    wait_until("the store to open", Duration::from_secs(5), || store.diagnostics().ready);
    assert!(!store.diagnostics().read_only);
    wait_until("open to sweep a crashed scan", Duration::from_secs(10), || scan_count(&root, "crashed") == Some(0));
    assert!(store.append(header("saved"), vec![record("C:\\root\\old"), record("C:\\root\\gone")])); assert!(store.accept(header("saved"), 1));
    store.flush(Duration::from_secs(2)).unwrap();
    store.protect("session", vec![]); // The runtime replaces the acceptance pin on its next tick.
    wait_until("an untimed idle wait", Duration::from_secs(10), || store.idle_for_test());
    let path = |path: &str| normalize_local_path(path).unwrap();
    let delete = Operation { id: "delete".into(), session: "session".into(), generation: 2,
        paths: vec![RenamePath { from: path("C:\\root\\gone"), to: path("C:\\root\\gone") }], scans: vec![], patches: vec![] };
    store.prepare_operation(delete, Duration::from_secs(2)).unwrap(); assert!(store.abort_operation("delete".into()));
    wait_until("abort to scrub its barrier", Duration::from_secs(10), || barriers(&root) == Some(0));
    let rename = Operation { id: "rename".into(), session: "session".into(), generation: 3,
        paths: vec![RenamePath { from: path("C:\\root\\old"), to: path("C:\\root\\new") }], scans: vec!["saved".into()], patches: vec![] };
    store.prepare_operation(rename.clone(), Duration::from_secs(2)).unwrap(); assert!(store.authorize_operation(rename));
    wait_until("the completed operation to drop its source scan", Duration::from_secs(10), || scan_count(&root, "saved") == Some(0));
    wait_until("an untimed idle wait", Duration::from_secs(10), || store.idle_for_test());
    store.shutdown(Duration::from_secs(2)).unwrap();
}

fn crashed_scan(root: &Root) {
    let mut db = Database::open(&root.0).unwrap();
    let rows: Vec<_> = (0..1000).map(|index| record(&format!("C:\\root\\{index:04}"))).collect();
    db.append(&header("crashed"), &rows).unwrap();
}

#[test]
fn size_storage_flush_does_not_wait_for_pending_maintenance_which_resumes_afterwards() {
    let root = Root::new(); crashed_scan(&root);
    let store = Store::start_for_test(root.0.clone());
    let started = Instant::now(); store.flush(Duration::from_secs(2)).unwrap();
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(scan_count(&root, "crashed"), Some(1), "the sweep needs several paced steps");
    wait_until("the sweep to resume after the flush", Duration::from_secs(15), || scan_count(&root, "crashed") == Some(0));
    wait_until("an untimed idle wait", Duration::from_secs(5), || store.idle_for_test());
    store.shutdown(Duration::from_secs(2)).unwrap();
}

#[test]
fn size_storage_shutdown_abandons_pending_maintenance() {
    let root = Root::new(); crashed_scan(&root);
    let store = Store::start_for_test(root.0.clone());
    wait_until("the store to open", Duration::from_secs(5), || store.diagnostics().ready);
    let started = Instant::now(); store.shutdown(Duration::from_secs(2)).unwrap();
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(scan_count(&root, "crashed"), Some(1), "unfinished work converges on the next open");
}

#[test]
fn size_storage_worker_waits_while_the_database_cannot_open() {
    let root = Root::new(); let blocked = root.0.join("not-a-directory");
    fs::write(&blocked, b"").unwrap();
    let store = Store::start_for_test(blocked);
    assert!(store.abort_operation("pending".into()), "a control write drains immediately");
    wait_until("the first failed open", Duration::from_secs(5), || store.diagnostics().last_error.is_some());
    let before = store.iterations_for_test();
    std::thread::sleep(Duration::from_millis(300));
    assert!(store.iterations_for_test() - before < 10, "a queued write must not spin the worker before the next open attempt");
    let _ = store.shutdown(Duration::from_secs(2));
}

#[test]
fn size_storage_an_operation_sweeps_its_source_after_completion() {
    use super::operations::{Operation, RenamePath};
    use super::super::target::normalize_local_path;
    let source = |root: &Root| query(root, "SELECT count(*) FROM records WHERE scan_id='saved'");
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    let rows: Vec<_> = (0..200).map(|index| record(&format!("C:\\root\\old\\{index:05}"))).collect();
    db.append(&header("saved"), &rows).unwrap();
    db.publish("saved", 1).unwrap(); drop(db);
    let store = Store::start_for_test(root.0.clone());
    wait_until("the store to open", Duration::from_secs(5), || store.diagnostics().ready);
    store.protect("session", vec![]);
    wait_until("an untimed idle wait", Duration::from_secs(10), || store.idle_for_test());
    let path = |path: &str| normalize_local_path(path).unwrap();
    // Holding the copy lets the sweep requested by authorization finish first,
    // so only the completion trigger can retire the source afterwards.
    store.hold_operations_for_test(true);
    let rename = Operation { id: "rename".into(), session: "session".into(), generation: 2,
        paths: vec![RenamePath { from: path("C:\\root\\old"), to: path("C:\\root\\new") }], scans: vec!["saved".into()], patches: vec![] };
    store.prepare_operation(rename.clone(), Duration::from_secs(2)).unwrap(); assert!(store.authorize_operation(rename));
    // The worker is awake while it commits the authorization, so a later idle
    // flag is fresh: the sweep it requested has finished.
    let authorized = |root: &Root| query(root, "SELECT count(*) FROM cache_operations WHERE id='rename' AND state=1") == Some(1);
    wait_until("the authorization sweep to finish", Duration::from_secs(10), || authorized(&root) && store.idle_for_test());
    assert_eq!(source(&root), Some(200), "the source is still published until the copy completes");
    store.hold_operations_for_test(false);
    wait_until("completion to sweep the retired source", Duration::from_secs(10), || source(&root) == Some(0));
    store.shutdown(Duration::from_secs(2)).unwrap();
}

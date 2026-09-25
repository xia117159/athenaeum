use super::{database::{Database, ScanHeader, StoredDirectory}, worker::{Store, Schedule}};
use super::super::scan::{DirectorySize, ScanStats};
use std::{fs, path::PathBuf, time::{Duration, Instant}};

struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("athenaeum-size-worker-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap(); Self(path)
    }
}
impl Drop for Root { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
fn header(id: &str) -> ScanHeader {
    ScanHeader { id: id.into(), session: "session".into(), root: "C:\\root".into(), generation: 1,
        source: 1, captured_at: chrono::Utc::now(), policy_version: 1 }
}
fn record() -> StoredDirectory {
    StoredDirectory { path: "C:\\root\\child".into(), artifact_capture: None, size: DirectorySize { bytes: 60, complete: true,
        fingerprint: Some("stamp".into()), created_at: Some(chrono::DateTime::from_timestamp(1000, 0).unwrap()),
        stats: ScanStats { known_bytes: 60, files: 1, directories: 1, ..Default::default() } } }
}
#[test]
fn size_storage_retained_replies_share_a_bounded_budget_until_consumed() {
    let root = Root::new(); let store = Store::start(root.0.clone());
    let rows: Vec<_> = (0..64).map(|index| StoredDirectory { path: format!("C:\\root\\{index:02}{}", "x".repeat(8000)), ..record() }).collect();
    for chunk in rows.chunks(16) { assert!(store.append(header("saved"), chunk.to_vec())); }
    assert!(store.accept(header("saved"), 1)); store.flush(Duration::from_secs(2)).unwrap();
    let paths: Vec<_> = rows.iter().map(|row| row.path.clone()).collect();
    let mut replies = Vec::new(); let mut rejected = 0;
    for _ in 0..24 {
        match store.lookup(paths.clone(), None).unwrap().recv_timeout(Duration::from_secs(2)).unwrap() {
            Ok(reply) => replies.push(reply), Err(_) => rejected += 1,
        }
    }
    assert!(rejected > 0 && !replies.is_empty(), "consumer-held replies cannot grow beyond the shared cache budget");
    drop(replies);
    assert_eq!(store.lookup(paths, None).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap().len(), 64, "consuming replies returns the budget");
    store.shutdown(Duration::from_secs(2)).unwrap();
}

#[test]
fn size_storage_queue_rotates_the_first_page_between_visible_scopes() {
    use crate::domain::directory_sizes::DirectorySizeViewScope;
    use super::super::target::normalize_local_path;
    let root = Root::new(); let store = Store::paused_for_test(8192, 2048);
    let a = normalize_local_path("C:\\root\\a").unwrap(); let b = normalize_local_path("C:\\root\\b").unwrap();
    store.update_views(std::sync::Arc::new(vec![DirectorySizeViewScope { path: a.clone(), priority: 0 }, DirectorySizeViewScope { path: b.clone(), priority: 0 }]));
    for index in 0..30 {
        if !store.append(header("queued"), vec![StoredDirectory { path: format!("{a}\\{index:02}"), ..record() }]) { break; }
    }
    assert!(store.append(header("queued"), vec![StoredDirectory { path: format!("{b}\\00"), ..record() }]),
        "a wide view must yield a later row for a second view's first row");
    assert!(store.accept(header("queued"), 1)); store.resume_for_test(root.0.clone()); let _ = store.flush(Duration::from_secs(2));
    let hits = store.lookup(vec![format!("{a}\\00"), format!("{b}\\00")], None).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
    assert_eq!(hits.len(), 2); let _ = store.shutdown(Duration::from_secs(2));
}

#[test]
fn size_storage_exhausted_migration_retries_keep_fences_until_restart_import() {
    use super::{operations::{Operation, RenamePath}, super::{history::{History, HistoricalSize}, target::normalize_local_path}};
    let root = Root::new(); let legacy = root.0.join("history.ndjson"); let deleted = normalize_local_path("C:\\removed\\child").unwrap();
    let at = chrono::Utc::now(); let mut history = History::default();
    history.insert(std::sync::Arc::from(deleted.as_str()), HistoricalSize { bytes: 60, complete: true, created_at: at,
        cached_at: at, artifact_capture: None }, 8192); history.save(&legacy).unwrap();
    let directory = root.0.join("cache"); let mut db = Database::open(&directory).unwrap();
    db.prepare_operation(&Operation { id: "deleted".into(), session: "operation-session".into(), generation: 2,
        paths: vec![RenamePath { from: deleted.clone(), to: deleted.clone() }], scans: vec![], patches: vec![] }).unwrap();
    db.abort_operation("deleted").unwrap();
    // A real transaction error before the first migration cursor is committed.
    db.connection.execute_batch("CREATE TRIGGER fail_legacy BEFORE INSERT ON scans WHEN NEW.source=0 BEGIN SELECT RAISE(ABORT,'legacy temporarily unavailable'); END").unwrap();
    drop(db);
    let store = Store::paused_for_test(65536, 4096); store.resume_legacy_with_retry_for_test(directory.clone(), legacy.clone());
    let deadline = Instant::now() + Duration::from_secs(5);
    while store.migration_steps_for_test() < 6 { assert!(Instant::now() < deadline, "migration did not exhaust its retry budget"); std::thread::sleep(Duration::from_millis(10)); }
    // Allow ordinary maintenance to run after retries stop; reads keep the worker responsive.
    let until = Instant::now() + Duration::from_millis(1100);
    while Instant::now() < until {
        store.lookup(vec![deleted.clone()], None).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(store.migration_steps_for_test(), 6, "protection must not restart an exhausted retry loop");
    assert!(legacy.exists()); store.shutdown(Duration::from_secs(2)).unwrap();
    let db = Database::open(&directory).unwrap();
    assert_eq!(db.connection.query_row("SELECT count(*) FROM migrations", [], |row| row.get::<_, u32>(0)).unwrap(), 0);
    db.connection.execute_batch("DROP TRIGGER fail_legacy").unwrap(); drop(db);
    let reopened = Store::start_with_legacy(directory, Some(legacy.clone()), std::sync::Arc::new(|_, _, _| {}));
    let deadline = Instant::now() + Duration::from_secs(5);
    while legacy.exists() { assert!(Instant::now() < deadline, "restart migration did not finish"); std::thread::sleep(Duration::from_millis(10)); }
    assert!(reopened.lookup(vec![deleted], None).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap().is_empty(),
        "a failed migration must keep namespace fences for next startup");
    reopened.shutdown(Duration::from_secs(2)).unwrap();
}

#[test]
fn size_storage_full_reclaim_preserves_namespace_fences_before_first_legacy_batch() {
    use super::{operations::{Operation, RenamePath}, super::{history::{History, HistoricalSize}, target::normalize_local_path}};
    let root = Root::new(); let legacy = root.0.join("history.ndjson"); let deleted = normalize_local_path("C:\\removed\\child").unwrap();
    let at = chrono::Utc::now(); let mut history = History::default();
    history.insert(std::sync::Arc::from(deleted.as_str()), HistoricalSize { bytes: 60, complete: true, created_at: at,
        cached_at: at, artifact_capture: None }, 8192); history.save(&legacy).unwrap();
    let directory = root.0.join("cache"); let mut db = Database::open(&directory).unwrap();
    let mut scopes: Vec<_> = (0..16).map(|index| crate::domain::directory_sizes::DirectorySizeViewScope {
        path: normalize_local_path(&format!("C:\\root\\tab{index:02}")).unwrap(), priority: 2,
    }).collect();
    let cold: Vec<_> = scopes.iter().flat_map(|scope| (0..16).map(move |index| StoredDirectory {
        path: format!("{}\\{index:02}{}", scope.path, "x".repeat(600)), ..record()
    })).collect();
    db.append(&header("old"), &cold).unwrap(); db.publish("old", 1).unwrap();
    db.prepare_operation(&Operation { id: "deleted".into(), session: "operation-session".into(), generation: 2,
        paths: vec![RenamePath { from: deleted.clone(), to: deleted.clone() }], scans: vec![], patches: vec![] }).unwrap();
    db.abort_operation("deleted").unwrap(); db.checkpoint().unwrap();
    assert_eq!(db.connection.query_row("SELECT count(*) FROM migrations", [], |row| row.get::<_, u32>(0)).unwrap(), 0);
    let pages: u32 = db.connection.query_row("PRAGMA page_count", [], |row| row.get(0)).unwrap(); drop(db);
    let store = Store::paused_for_test(65536, 4096); store.protect("session", vec!["old".into()]);
    let visible = normalize_local_path(&format!("C:\\root\\visible{}", "x".repeat(6000))).unwrap();
    scopes.push(crate::domain::directory_sizes::DirectorySizeViewScope { path: visible.clone(), priority: 0 });
    store.update_views(std::sync::Arc::new(scopes));
    assert!(store.append(header("new"), vec![StoredDirectory { path: visible, ..record() }])); assert!(store.accept(header("new"), 2));
    store.resume_legacy_with_page_limit_for_test(directory, legacy.clone(), pages); store.flush(Duration::from_secs(2)).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while legacy.exists() { assert!(Instant::now() < deadline, "legacy migration did not complete"); std::thread::sleep(Duration::from_millis(10)); }
    assert!(store.lookup(vec![deleted], None).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap().is_empty(),
        "hard-full reclaim must not let legacy rows resurrect a deleted namespace");
    store.shutdown(Duration::from_secs(2)).unwrap();
}

#[test]
fn size_storage_full_protected_pages_yield_to_new_visible_root() {
    use crate::domain::directory_sizes::DirectorySizeViewScope;
    use super::super::target::normalize_local_path;
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    let mut scopes: Vec<_> = (0..16).map(|index| DirectorySizeViewScope {
        path: normalize_local_path(&format!("C:\\root\\tab{index:02}")).unwrap(), priority: 2,
    }).collect();
    let old: Vec<_> = scopes.iter().flat_map(|scope| (0..16).map(move |index| StoredDirectory {
        path: format!("{}\\{index:02}{}", scope.path, "x".repeat(600)), ..record()
    })).collect();
    db.append(&header("old"), &old).unwrap(); db.publish("old", 1).unwrap(); db.checkpoint().unwrap();
    let pages: u32 = db.connection.query_row("PRAGMA page_count", [], |row| row.get(0)).unwrap(); drop(db);
    let store = Store::paused_for_test(65536, 4096); store.protect("session", vec!["old".into()]);
    let visible = normalize_local_path(&format!("C:\\root\\visible{}", "x".repeat(6000))).unwrap();
    scopes.push(DirectorySizeViewScope { path: visible.clone(), priority: 0 });
    store.update_views(std::sync::Arc::new(scopes));
    let rows = vec![StoredDirectory { path: visible.clone(), ..record() }, StoredDirectory { path: format!("{visible}\\child"), ..record() }];
    assert!(store.append(header("new"), rows.clone())); assert!(store.accept(header("new"), 2));
    store.resume_with_page_limit_for_test(root.0.clone(), pages);
    let flush = store.flush(Duration::from_secs(2));
    let hits = store.lookup(rows.iter().map(|row| row.path.clone()).collect(), None).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
    assert_eq!(hits.len(), 2, "old first pages cannot pin all capacity ahead of a new visible root: {flush:?}");
    let first_rows: Vec<_> = old.iter().step_by(16).map(|row| row.path.clone()).collect();
    assert_eq!(store.lookup(first_rows, None).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap().len(), 16,
        "later rows should yield before another tab's first row");
    assert!(flush.is_ok()); store.shutdown(Duration::from_secs(2)).unwrap();
}

#[test]
fn size_storage_full_reclaim_searches_past_two_pages_of_protected_roots() {
    use crate::domain::directory_sizes::DirectorySizeViewScope;
    use super::super::target::normalize_local_path;
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    let mut scopes: Vec<_> = (0..64).map(|index| DirectorySizeViewScope {
        path: normalize_local_path(&format!("C:\\root\\a{index:02}{}", "x".repeat(600))).unwrap(), priority: 0,
    }).collect();
    let protected: Vec<_> = scopes.iter().map(|scope| StoredDirectory { path: scope.path.clone(), ..record() }).collect();
    db.append(&header("old"), &protected).unwrap();
    let cold: Vec<_> = (0..256).map(|index| StoredDirectory { path: format!("C:\\root\\z{index:04}{}", "x".repeat(600)), ..record() }).collect();
    db.append(&header("old"), &cold).unwrap(); db.publish("old", 1).unwrap(); db.checkpoint().unwrap();
    let pages: u32 = db.connection.query_row("PRAGMA page_count", [], |row| row.get(0)).unwrap(); drop(db);
    let store = Store::paused_for_test(131072, 4096); store.protect("session", vec!["old".into()]);
    let visible = normalize_local_path(&format!("C:\\root\\visible{}", "x".repeat(6000))).unwrap();
    scopes.push(DirectorySizeViewScope { path: visible.clone(), priority: 0 }); store.update_views(std::sync::Arc::new(scopes));
    let rows = vec![StoredDirectory { path: visible.clone(), ..record() }, StoredDirectory { path: format!("{visible}\\child"), ..record() }];
    assert!(store.append(header("new"), rows.clone())); assert!(store.accept(header("new"), 2));
    store.resume_with_page_limit_for_test(root.0.clone(), pages); store.flush(Duration::from_secs(2)).unwrap();
    assert_eq!(store.lookup(rows.iter().map(|row| row.path.clone()).collect(), None).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap().len(), 2);
    assert_eq!(store.lookup(protected.iter().map(|row| row.path.clone()).collect(), None).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap().len(), 64,
        "protected roots need not be evicted when cold rows exist later in the index");
    store.shutdown(Duration::from_secs(2)).unwrap();
}

#[test]
fn size_storage_force_flush_reclaims_a_full_database_for_new_view_records() {
    use crate::domain::directory_sizes::DirectorySizeViewScope;
    use super::super::target::normalize_local_path;
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    let cold: Vec<_> = (0..256).map(|index| StoredDirectory { path: format!("C:\\root\\cold\\{index:04}-{}", "x".repeat(600)), ..record() }).collect();
    db.append(&header("old"), &cold).unwrap(); db.publish("old", 1).unwrap(); db.checkpoint().unwrap();
    let pages: u32 = db.connection.query_row("PRAGMA page_count", [], |row| row.get(0)).unwrap(); drop(db);
    let store = Store::paused_for_test(65536, 4096); store.protect("session", vec!["old".into()]);
    let path = normalize_local_path(&format!("C:\\root\\visible{}", "x".repeat(6000))).unwrap();
    store.update_views(std::sync::Arc::new(vec![DirectorySizeViewScope { path: path.clone(), priority: 0 }]));
    let rows = vec![StoredDirectory { path: path.clone(), ..record() }, StoredDirectory { path: format!("{path}\\child"), ..record() }];
    assert!(store.append(header("new"), rows.clone())); assert!(store.accept(header("new"), 2));
    store.resume_with_page_limit_for_test(root.0.clone(), pages);
    let flush = store.flush(Duration::from_secs(2));
    let hits = store.lookup(rows.iter().map(|row| row.path.clone()).collect(), None).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
    assert_eq!(hits.len(), 2, "even forced flush must reclaim cold pinned details before refusing visible data: {flush:?}");
    assert!(flush.is_ok()); store.shutdown(Duration::from_secs(2)).unwrap();
}

#[test]
fn size_storage_full_queue_admits_view_roots_and_children_over_cold_details() {
    use crate::domain::directory_sizes::DirectorySizeViewScope;
    use super::super::target::normalize_local_path;
    let root = Root::new(); let store = Store::paused_for_test(8192, 2048);
    let paths: Vec<_> = ["C:\\root\\a", "C:\\root\\b"].iter().map(|path| normalize_local_path(path).unwrap()).collect();
    store.update_views(std::sync::Arc::new(paths.iter().map(|path| DirectorySizeViewScope { path: path.clone(), priority: 0 }).collect()));
    for index in 0..30 {
        let mut cold = record(); cold.path = format!("C:\\root\\cold\\deep\\{index}");
        if !store.append(header("queued"), vec![cold]) { break; }
    }
    let rows: Vec<_> = paths.iter().flat_map(|path| [path.clone(), format!("{path}\\child")])
        .map(|path| StoredDirectory { path, ..record() }).collect();
    assert!(store.append(header("queued"), rows.clone()), "late roots and direct rows must displace provisional cold details");
    assert!(store.accept(header("queued"), 1)); assert!(store.queued_bytes() <= 8192);
    store.resume_for_test(root.0.clone()); let _ = store.flush(Duration::from_secs(2));
    let hits = store.lookup(rows.iter().map(|row| row.path.clone()).collect(), None).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
    assert_eq!(hits.len(), rows.len()); let _ = store.shutdown(Duration::from_secs(2));
}

#[test]
fn size_storage_rejected_controls_and_oversized_batches_are_reported_by_flush() {
    for oversized in [false, true] {
        let root = Root::new(); let store = Store::paused_for_test(4096, 2048);
        if oversized { assert!(!store.append(header("too-many"), vec![record(); 1025])); }
        else { for index in 0..100 { if !store.accept(header(&format!("scan{index}")), index + 1) { break; } } }
        assert!(store.diagnostics().last_error.is_some(), "discarded writes need a diagnostic, including zero-row control writes");
        store.resume_for_test(root.0.clone()); assert!(store.shutdown(Duration::from_secs(2)).is_err(), "flush cannot acknowledge all writes after a rejection");
    }
}

#[test]
fn size_storage_schedule_debounces_and_bounds_oldest_dirty_age() {
    let mut schedule = Schedule::default();
    assert!(!schedule.due(100_000, 0, 0));
    schedule.dirty(100);
    assert!(!schedule.due(2099, 1, 1));
    assert!(schedule.due(2100, 1, 1));
    for now in (1000..10_000).step_by(1000) { schedule.dirty(now); }
    assert!(!schedule.due(10_099, 1, 1));
    assert!(schedule.due(10_100, 1, 1), "continuous scans cannot starve the oldest record");
    assert!(schedule.due(9000, 1024, 1));
    assert!(schedule.due(9000, 1, 1 << 20));
}
#[test]
fn size_storage_worker_persists_before_exit_and_flushes_only_accepted_results() {
    let root = Root::new(); let store = Store::start(root.0.clone());
    assert!(store.append(header("accepted"), vec![record()]));
    assert!(store.accept(header("accepted"), 1));
    assert!(store.append(header("cancelled"), vec![record()]));
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let hits = store.lookup(vec![record().path], None).unwrap().recv_timeout(Duration::from_secs(1)).unwrap();
        if hits.is_ok_and(|hits| hits.len() == 1 && hits[0].scan_id == "accepted") { break; }
        assert!(Instant::now() < deadline, "accepted scan was not saved while service was running");
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(store.flush(Duration::from_secs(2)).is_ok());
    assert!(store.shutdown(Duration::from_secs(2)).is_ok());
    let db = Database::open(&root.0).unwrap();
    assert!(db.writable(), "shutdown releases the writer lock before acknowledging");
    assert_eq!(db.lookup(&[record().path], None).unwrap()[0].scan_id, "accepted");
    assert!(db.lookup(&[record().path], Some("cancelled")).is_err());
}

#[test]
fn size_storage_worker_flushes_latest_views_and_does_not_rewrite_clean_summary() {
    use crate::domain::directory_sizes::DirectorySizeViewScope;
    let root = Root::new(); let store = Store::start(root.0.clone());
    assert!(store.append(header("accepted"), vec![record()])); assert!(store.accept(header("accepted"), 1));
    store.update_views(std::sync::Arc::new(vec![DirectorySizeViewScope { path: "C:\\root".into(), priority: 0 }]));
    store.flush(Duration::from_secs(2)).unwrap();
    assert_eq!(super::startup::load(&root.0).unwrap().len(), 1);
    let before = fs::metadata(root.0.join("startup.json")).unwrap().modified().unwrap();
    store.flush(Duration::from_secs(2)).unwrap();
    assert_eq!(before, fs::metadata(root.0.join("startup.json")).unwrap().modified().unwrap());
    store.update_views(std::sync::Arc::new(vec![DirectorySizeViewScope { path: "D:\\empty".into(), priority: 0 }]));
    store.shutdown(Duration::from_secs(2)).unwrap();
    assert!(super::startup::load(&root.0).unwrap().is_empty());
}

#[test]
fn size_storage_worker_saves_new_summary_after_an_earlier_rejected_write() {
    use crate::domain::directory_sizes::DirectorySizeViewScope;
    let root = Root::new(); let store = Store::start(root.0.clone());
    let mut invalid = header("invalid"); invalid.id.clear();
    assert!(store.append(invalid, vec![record()]));
    assert!(store.flush(Duration::from_secs(2)).is_err());
    assert!(store.append(header("recovered"), vec![record()])); assert!(store.accept(header("recovered"), 1));
    store.update_views(std::sync::Arc::new(vec![DirectorySizeViewScope { path: "C:\\root".into(), priority: 0 }]));
    let _ = store.shutdown(Duration::from_secs(2));
    assert_eq!(super::startup::load(&root.0).unwrap().len(), 1, "an earlier lost batch cannot permanently disable future summaries");
}

#[test]
fn size_storage_worker_finishes_shadow_before_acknowledging_flush() {
    use super::operations::{Operation, RenamePath};
    use super::super::target::normalize_local_path;
    let root = Root::new(); let store = Store::start(root.0.clone());
    assert!(store.append(header("accepted"), vec![record()])); assert!(store.accept(header("accepted"), 1));
    store.flush(Duration::from_secs(2)).unwrap();
    let operation = Operation { id: "rename".into(), session: "session".into(), generation: 2,
        paths: vec![RenamePath { from: normalize_local_path(&record().path).unwrap(), to: normalize_local_path("C:\\root\\new").unwrap() }],
        scans: vec!["accepted".into()], patches: vec![] };
    store.prepare_operation(operation.clone(), Duration::from_secs(2)).unwrap();
    assert!(store.authorize_operation(operation));
    store.shutdown(Duration::from_secs(2)).unwrap();
    let db = Database::open(&root.0).unwrap();
    assert_eq!(db.lookup(&["C:\\root\\new".into()], None).unwrap()[0].record.size.bytes, 60);
}

#[test]
fn size_storage_diagnostics_reports_commits_capacity_and_read_only_ownership() {
    let root = Root::new(); let store = Store::start(root.0.clone());
    assert!(store.append(header("accepted"), vec![record()])); assert!(store.accept(header("accepted"), 1));
    store.flush(Duration::from_secs(2)).unwrap();
    let status = store.diagnostics();
    assert!(status.ready && !status.read_only);
    assert!(status.last_commit.is_some()); assert_eq!(status.queue_bytes, "0");
    let other = Store::start(root.0.clone());
    other.lookup(vec![record().path], None).unwrap().recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
    assert!(other.diagnostics().read_only);
    assert!(!other.append(header("rejected"), vec![record()]), "read-only instances should not queue unwritable batches");
    assert_ne!(other.diagnostics().dropped_records, "0");
    assert!(other.shutdown(Duration::from_secs(2)).is_err()); store.shutdown(Duration::from_secs(2)).unwrap();
}
#[test]
fn size_storage_queue_reserves_acceptance_space_and_rejects_data_without_blocking() {
    let store = Store::paused_for_test(4096, 2048);
    let mut admitted = 0;
    while store.append(header("queued"), vec![record()]) { admitted += 1; }
    assert!(admitted > 0 && admitted < 10);
    assert!(store.accept(header("queued"), 1), "data pressure must leave room for terminal control");
    assert!(store.queued_bytes() <= 4096);
    let deadline = Instant::now() + Duration::from_millis(200);
    for _ in 0..100 { assert!(!store.append(header("queued"), vec![record()])); }
    assert!(Instant::now() < deadline);
}

#[test]
fn size_storage_queued_read_cannot_bypass_a_later_namespace_fence() {
    use super::operations::{Operation, RenamePath};
    use super::super::target::normalize_local_path;
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    db.append(&header("saved"), &[record()]).unwrap(); db.publish("saved", 1).unwrap(); drop(db);
    let store = Store::paused_for_test(8192, 2048);
    let read = store.lookup(vec![record().path], None).unwrap();
    let path = normalize_local_path(&record().path).unwrap();
    let operation = Operation { id: "delete".into(), session: "session".into(), generation: 2,
        paths: vec![RenamePath { from: path.clone(), to: path }], scans: vec![], patches: vec![] };
    assert!(store.prepare_operation(operation, Duration::ZERO).is_err());
    store.resume_for_test(root.0.clone());
    let result = read.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(result.is_err() || result.unwrap().is_empty(), "reads queued before prepare must be rechecked at dispatch");
    store.shutdown(Duration::from_secs(2)).unwrap();
}

#[test]
fn size_storage_failed_shadow_copy_has_a_finite_retry_budget() {
    use super::operations::{Operation, RenamePath};
    use super::super::target::normalize_local_path;
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    let mut destination = record(); destination.path = "C:\\root\\existing".into();
    db.append(&header("saved"), &[record(), destination.clone()]).unwrap(); db.publish("saved", 1).unwrap(); drop(db);
    let store = Store::paused_for_test(8192, 2048);
    let operation = Operation { id: "corrupt-copy".into(), session: "session".into(), generation: 2,
        paths: vec![RenamePath { from: normalize_local_path(&record().path).unwrap(), to: normalize_local_path(&destination.path).unwrap() }],
        scans: vec!["saved".into()], patches: vec![] };
    assert!(store.prepare_operation(operation.clone(), Duration::ZERO).is_err()); store.authorize_operation(operation);
    store.resume_with_retry_for_test(root.0.clone(), [1, 2, 5, 10, 30]);
    let deadline = Instant::now() + Duration::from_secs(3);
    while !store.diagnostics().ready {
        assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(5));
    }
    loop {
        let state = Database::open(&root.0).ok().and_then(|db| db.connection.query_row(
            "SELECT state FROM cache_operations WHERE id='corrupt-copy'", [], |row| row.get::<_, u32>(0)).ok());
        if state == Some(3) { break; }
        assert!(Instant::now() < deadline, "failed shadow copy kept retrying past its budget");
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(store.diagnostics().last_error.is_some()); let _ = store.shutdown(Duration::from_secs(2));
}

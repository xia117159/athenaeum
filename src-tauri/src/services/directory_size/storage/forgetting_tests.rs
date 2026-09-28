use super::{database::{Database, ScanHeader, StoredDirectory}, startup};
use super::super::{forget::ForgetItem, scan::{DirectorySize, ScanStats}, target::normalize_local_path};
use crate::domain::directory_sizes::DirectorySizeViewScope;
use std::{fs, path::PathBuf};

struct Fixture(PathBuf);
impl Fixture { fn new() -> Self {
    let path = std::env::temp_dir().join(format!("athenaeum-forget-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&path).unwrap(); Self(path)
} }
impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
fn path(value: &str) -> String { normalize_local_path(value).unwrap() }
fn header(id: &str, time: i64) -> ScanHeader { ScanHeader {
    id: id.into(), session: "session".into(), root: path("C:\\root"), generation: time as u64,
    captured_at: chrono::DateTime::from_timestamp_micros(time).unwrap(), policy_version: 2,
} }
fn row(name: &str, bytes: u64) -> StoredDirectory { StoredDirectory {
    path: path(&format!("C:\\root\\{name}")), artifact_capture: None,
    size: DirectorySize { bytes, complete: true, fingerprint: Some("stamp".into()),
        created_at: Some(chrono::DateTime::UNIX_EPOCH),
        stats: ScanStats { known_bytes: bytes, files: 1, directories: 1, ..Default::default() } },
} }

#[test]
fn size_forget_late_append_cannot_republish_deleted_history_after_restart() {
    let fixture = Fixture::new(); let mut db = Database::open(&fixture.0).unwrap();
    let old = header("old", 1); let delayed = header("delayed", 2);
    db.append(&old, &[row("a", 10), row("a2", 20), row("a\\deep", 30)]).unwrap();
    db.publish(&old.id, 1).unwrap();
    db.forget(&[ForgetItem::Prefix(path("C:\\root\\a"))], 10).unwrap();
    db.append(&delayed, &[row("a", 10), row("a\\deep", 30)]).unwrap();
    db.publish(&delayed.id, 2).unwrap();
    drop(db);
    let mut db = Database::open(&fixture.0).unwrap();
    assert!(db.lookup(&[row("a", 0).path, row("a\\deep", 0).path], None).unwrap().is_empty(),
        "successful Forget must also reject later writes from scans that started before it");
    assert_eq!(db.lookup(&[row("a2", 0).path], None).unwrap()[0].record.size.bytes, 20);
    let fresh = header("fresh", 11);
    db.append(&fresh, &[row("a", 99)]).unwrap(); db.publish(&fresh.id, 3).unwrap();
    assert_eq!(db.lookup(&[row("a", 0).path], None).unwrap()[0].record.size.bytes, 99);
}

#[test]
fn size_forget_old_startup_summary_is_filtered_before_it_can_restore_history() {
    let fixture = Fixture::new(); let mut db = Database::open(&fixture.0).unwrap();
    let scan = header("saved", 1);
    db.append(&scan, &[row("a", 10), row("b", 20)]).unwrap(); db.publish(&scan.id, 1).unwrap();
    startup::save(&mut db, &fixture.0, &[DirectorySizeViewScope { path: path("C:\\root"), priority: 0 }], 4096).unwrap();
    assert_eq!(startup::load(&fixture.0).unwrap().len(), 2);
    db.forget(&[ForgetItem::Exact(row("a", 0).path)], 10).unwrap();
    drop(db); // Simulate the committed deletion preceding the next summary rewrite.
    let hits = startup::load(&fixture.0).unwrap();
    assert_eq!(hits.len(), 1, "old startup JSON must not undo a committed Forget");
    assert_eq!(hits[0].record.path, row("b", 0).path);
}

#[test]
fn size_forget_does_not_delete_a_newer_scan_that_finished_before_the_queued_forget() {
    let fixture = Fixture::new(); let mut db = Database::open(&fixture.0).unwrap();
    let scan = header("fresh", 11);
    db.append(&scan, &[row("a", 55)]).unwrap(); db.publish(&scan.id, 1).unwrap();
    db.forget(&[ForgetItem::Exact(row("a", 0).path)], 10).unwrap();
    assert_eq!(db.lookup(&[row("a", 0).path], None).unwrap()[0].record.size.bytes, 55);
}

#[test]
fn size_forget_reader_observes_a_floor_committed_after_it_opened() {
    let fixture = Fixture::new(); let mut writer = Database::open(&fixture.0).unwrap();
    let old = header("old", 1);
    writer.append(&old, &[row("a", 10)]).unwrap(); writer.publish(&old.id, 1).unwrap();
    let reader = Database::open(&fixture.0).unwrap();
    assert_eq!(reader.lookup(&[row("a", 0).path], None).unwrap().len(), 1);
    let items: Vec<_> = (0..4097).map(|index| ForgetItem::Exact(path(&format!("C:\\root\\else{index}")))).collect();
    for batch in items.chunks(256) { writer.forget(batch, 10).unwrap(); }
    assert!(writer.connection.query_row("SELECT count(*) FROM records", [], |r| r.get::<_, usize>(0)).unwrap() > 0,
        "this regression intentionally retains the row hidden by the floor");
    assert!(reader.lookup(&[row("a", 0).path], None).unwrap().is_empty());
    let fresh = header("new", 11);
    writer.append(&fresh, &[row("a", 99)]).unwrap(); writer.publish(&fresh.id, 2).unwrap();
    assert_eq!(reader.lookup(&[row("a", 0).path], None).unwrap()[0].record.size.bytes, 99);
}

#[test]
fn size_forget_floor_does_not_hide_an_earlier_publication_from_a_newer_scan() {
    let fixture = Fixture::new(); let mut db = Database::open(&fixture.0).unwrap();
    let fresh = header("fresh", 11); let late = header("late", 1);
    db.append(&fresh, &[row("a", 99)]).unwrap(); db.publish(&fresh.id, 1).unwrap();
    db.append(&late, &[row("a", 10)]).unwrap(); db.publish(&late.id, 2).unwrap();
    let items: Vec<_> = (0..4097).map(|index| ForgetItem::Exact(path(&format!("C:\\root\\else{index}")))).collect();
    for batch in items.chunks(256) { db.forget(batch, 10).unwrap(); }
    let hits = db.lookup(&[row("a", 0).path], None).unwrap();
    assert_eq!(hits.len(), 1, "discard a blocked publication before choosing the latest eligible row");
    assert_eq!(hits[0].record.size.bytes, 99);
}

#[test]
fn size_forget_rejected_queue_entry_does_not_poison_flush() {
    use super::worker::Store;
    use std::time::Duration;
    let fixture = Fixture::new(); let store = Store::paused_for_test(128, 0);
    assert!(!store.forget(vec![ForgetItem::Exact(row("a", 0).path)], 10));
    assert!(store.diagnostics().last_error.is_some());
    assert_eq!(store.write_flags_for_test(), (false, false), "a rejected Forget neither drains nor loses a write");
    let roomy = Store::paused_for_test(8192, 0);
    assert!(roomy.forget(vec![ForgetItem::Exact(row("a", 0).path)], 10));
    assert_eq!(roomy.write_flags_for_test(), (false, false), "a queued Forget rides the batch schedule");
    store.resume_for_test(fixture.0.clone());
    store.flush(Duration::from_secs(5)).unwrap();
    store.shutdown(Duration::from_secs(5)).unwrap();
}

#[test]
fn size_forget_migration_preserves_version_two_history() {
    let fixture = Fixture::new(); let mut db = Database::open(&fixture.0).unwrap();
    let scan = header("legacy", 1);
    db.append(&scan, &[row("a", 10)]).unwrap(); db.publish(&scan.id, 1).unwrap();
    db.connection.execute_batch("DROP TABLE size_forgets; DROP TABLE size_forget_floor;
        ALTER TABLE scans DROP COLUMN captured_micros; PRAGMA user_version=2;").unwrap();
    drop(db);
    let mut db = Database::open(&fixture.0).unwrap();
    assert_eq!(db.lookup(&[row("a", 0).path], None).unwrap()[0].record.size.bytes, 10);
    db.forget(&[ForgetItem::Exact(row("a", 0).path)], 10).unwrap();
    assert!(db.lookup(&[row("a", 0).path], None).unwrap().is_empty());
}

#[test]
fn size_forget_store_fifo_filters_late_stream_writes() {
    use super::worker::Store;
    use std::time::Duration;
    let fixture = Fixture::new(); let store = Store::start_for_test(fixture.0.clone());
    assert!(store.append(header("saved", 1), vec![row("a", 10)]));
    assert!(store.accept(header("saved", 1), 1)); store.flush(Duration::from_secs(5)).unwrap();
    assert!(store.forget(vec![ForgetItem::Prefix(row("a", 0).path)], 10));
    assert!(store.append(header("late", 2), vec![row("a", 10), row("a\\deep", 20)]));
    assert!(store.accept(header("late", 2), 2)); store.flush(Duration::from_secs(5)).unwrap();
    let hits = store.lookup(vec![row("a", 0).path, row("a\\deep", 0).path], None).unwrap()
        .recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
    assert!(hits.is_empty(), "Store must actually schedule persistent Forget before later appends");
    store.shutdown(Duration::from_secs(5)).unwrap();
}

#[test]
fn size_forget_rename_copies_obey_source_and_destination_fences() {
    use super::operations::{Operation, RenamePath};
    for copy_first_page in [false, true] {
        let fixture = Fixture::new(); let mut db = Database::open(&fixture.0).unwrap();
        let old = header("old", 1);
        let rows: Vec<_> = (0..80).map(|index| row(&format!("a\\item{index:02}"), 1)).collect();
        db.append(&old, &rows).unwrap(); db.publish(&old.id, 1).unwrap();
        let op = Operation { id: "rename".into(), session: "session".into(), generation: 2,
            paths: vec![RenamePath { from: row("a", 0).path, to: row("renamed", 0).path }],
            scans: vec![old.id.clone()], patches: vec![] };
        db.prepare_operation(&op).unwrap(); db.authorize_operation(&op).unwrap();
        if copy_first_page { assert!(db.advance_operation().unwrap()); }
        db.forget(&[ForgetItem::Prefix(row("a", 0).path)], 10).unwrap();
        while db.advance_operation().unwrap() {}
        let mut late = header("late", 2); late.generation = 9;
        db.append(&late, &[row("renamed\\item00", 1)]).unwrap(); db.publish(&late.id, 2).unwrap();
        drop(db);
        let db = Database::open(&fixture.0).unwrap();
        assert!(db.lookup(&[row("renamed\\item00", 0).path], None).unwrap().is_empty(),
            "copy_first_page={copy_first_page}: renamed cache must inherit invalidation");
    }
}

#[test]
fn size_forget_prefix_respects_sibling_boundaries_and_drive_roots() {
    let fixture = Fixture::new(); let mut db = Database::open(&fixture.0).unwrap();
    let old = header("old", 1);
    let names = ["a", "a\\deep", "a2", "a-x", "a2\\deep", "b"];
    db.append(&old, &names.map(|name| row(name, 10))).unwrap(); db.publish(&old.id, 1).unwrap();
    db.forget(&[ForgetItem::Prefix(path("C:\\root\\a"))], 10).unwrap();
    let count = |db: &Database, name: &str| db.connection.query_row(
        "SELECT count(*) FROM records WHERE path=?1", [row(name, 0).path], |r| r.get::<_, usize>(0)).unwrap();
    for (name, kept) in [("a", 0), ("a\\deep", 0), ("a2", 1), ("a-x", 1), ("a2\\deep", 1), ("b", 1)] {
        assert_eq!(count(&db, name), kept, "{name}: only P and P\\... rows are physically deleted");
        assert_eq!(db.lookup(&[row(name, 0).path], None).unwrap().len(), kept, "{name}: lookup matches deletion");
    }
    db.forget(&[ForgetItem::Prefix(path("C:\\"))], 10).unwrap();
    assert!(names.iter().all(|name| count(&db, name) == 0), "a drive-root prefix covers the whole volume");
    let fresh = header("fresh", 11);
    db.append(&fresh, &[row("b", 99)]).unwrap(); db.publish(&fresh.id, 2).unwrap();
    assert_eq!(db.lookup(&[row("b", 0).path], None).unwrap()[0].record.size.bytes, 99);
}

#[test]
fn size_forget_flushed_store_summary_excludes_forgotten_paths() {
    use super::worker::Store;
    use std::time::Duration;
    let fixture = Fixture::new(); let store = Store::start_for_test(fixture.0.clone());
    store.update_views(std::sync::Arc::new(vec![DirectorySizeViewScope { path: path("C:\\root"), priority: 0 }]));
    assert!(store.append(header("saved", 1), vec![row("a", 10), row("b", 20)]));
    assert!(store.accept(header("saved", 1), 1)); store.flush(Duration::from_secs(5)).unwrap();
    assert!(startup::load(&fixture.0).unwrap().iter().any(|hit| hit.record.path == row("a", 0).path), "precondition: summarized");
    assert!(store.forget(vec![ForgetItem::Exact(row("a", 0).path)], 10));
    store.flush(Duration::from_secs(5)).unwrap();
    store.shutdown(Duration::from_secs(5)).unwrap();
    let hits = startup::load(&fixture.0).unwrap();
    assert!(hits.iter().all(|hit| hit.record.path != row("a", 0).path), "SPEC-004: the forgotten path is gone from the summary");
    assert!(hits.iter().any(|hit| hit.record.path == row("b", 0).path));
}

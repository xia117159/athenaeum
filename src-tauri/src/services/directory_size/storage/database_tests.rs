use super::database::{Database, ScanHeader, StoredDirectory};
use super::super::scan::{DirectorySize, ScanStats};
use std::{fs, path::PathBuf};

struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("athenaeum-size-store-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap(); Self(path)
    }
}
impl Drop for Root { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
fn header(id: &str, legacy: bool) -> ScanHeader {
    ScanHeader { id: id.into(), session: if legacy { "legacy".into() } else { "session".into() }, root: "C:\\root".into(),
        generation: 1, source: u8::from(!legacy), captured_at: chrono::Utc::now(), policy_version: 1 }
}
fn record(bytes: u64) -> StoredDirectory {
    StoredDirectory { path: "C:\\root\\child".into(), artifact_capture: None, size: DirectorySize { bytes, complete: true,
        fingerprint: Some("stamp".into()), created_at: Some(chrono::DateTime::from_timestamp(1000, 0).unwrap()),
        stats: ScanStats { known_bytes: bytes, files: 1, directories: 1, ..Default::default() } } }
}

#[test]
fn size_storage_rejects_malformed_persistent_fields_before_returning_hits() {
    for field in ["scan", "source", "fingerprint", "policy", "publication"] {
        let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
        db.append(&header("saved", false), &[record(70)]).unwrap(); db.publish("saved", 1).unwrap();
        match field {
            "scan" => {
                db.connection.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
                let id = "x".repeat(193);
                db.connection.execute("UPDATE scans SET id=?1", [&id]).unwrap();
                db.connection.execute("UPDATE records SET scan_id=?1", [&id]).unwrap();
            }
            "source" => { db.connection.execute_batch("PRAGMA ignore_check_constraints=ON; UPDATE scans SET source=2").unwrap(); }
            "publication" => { db.connection.execute_batch("UPDATE scans SET publication=0").unwrap(); }
            _ => {
                let mut row = record(70); row.path = super::super::target::normalize_local_path(&row.path).unwrap();
                if field == "fingerprint" { row.size.fingerprint = Some("x".repeat(129)); }
                else { row.artifact_capture = Some(super::super::artifacts::Capture { policy: "x".repeat(129), contribution: Default::default() }); }
                db.connection.execute("UPDATE records SET payload=?1", [serde_json::to_string(&row).unwrap()]).unwrap();
            }
        }
        assert!(db.lookup(&[record(0).path], None).is_err(), "malformed {field} bypassed the bounded database contract");
    }
}

#[test]
fn size_storage_publish_is_atomic_idempotent_and_legacy_cannot_replace_a_scan() {
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    assert!(db.writable());
    db.append(&header("new", false), &[record(u64::MAX)]).unwrap();
    assert!(db.lookup(&[record(0).path.clone()], None).unwrap().is_empty(), "provisional is invisible");
    let first = db.publish("new", 1).unwrap();
    assert!(first > 0);
    assert_eq!(db.publish("new", 1).unwrap(), first, "replay must not issue a new publication sequence");
    db.append(&header("old", true), &[record(10)]).unwrap(); db.publish("old", 1).unwrap();
    assert_eq!(db.lookup(&[record(0).path.clone()], None).unwrap()[0].record.size.bytes, u64::MAX);
    assert_eq!(db.lookup(&[record(0).path.clone()], Some("old")).unwrap()[0].record.size.bytes, 10);
    drop(db);
    let mut reopened = Database::open(&root.0).unwrap();
    reopened.append(&header("next", false), &[record(20)]).unwrap();
    assert!(reopened.publish("next", 2).unwrap() > first);
    assert_eq!(reopened.lookup(&[record(0).path.clone()], None).unwrap()[0].record.size.bytes, 20);
}

#[test]
fn size_storage_second_connection_is_read_only_and_abandoned_scans_never_appear() {
    let root = Root::new(); let mut writer = Database::open(&root.0).unwrap();
    writer.append(&header("abandoned", false), &[record(88)]).unwrap();
    let mut reader = Database::open(&root.0).unwrap();
    assert!(!reader.writable());
    assert!(reader.append(&header("other", false), &[record(99)]).is_err());
    assert!(reader.lookup(&[record(0).path.clone()], None).unwrap().is_empty());
    drop(reader); drop(writer);
    let reopened = Database::open(&root.0).unwrap();
    assert!(reopened.lookup(&[record(0).path.clone()], None).unwrap().is_empty());
}

#[test]
fn size_storage_concurrent_reopen_during_writer_handoff_keeps_mappings_valid() {
    let root = Root::new(); let mut first = Database::open(&root.0).unwrap();
    first.append(&header("saved", false), &[record(73)]).unwrap(); first.publish("saved", 1).unwrap();
    let directory = root.0.clone();
    let reader = std::thread::spawn(move || {
        for _ in 0..100 {
            // Ownership and SHM can be between generations. A controlled not-ready
            // error is allowed; a successful read must preserve the prior commit.
            if let Ok(db) = Database::open(&directory) {
                if let Ok(hits) = db.lookup(&[record(0).path], None) { assert_eq!(hits[0].record.size.bytes, 73); }
            }
            std::thread::yield_now();
        }
    });
    drop(first);
    for _ in 0..100 { let _ = Database::open(&root.0); std::thread::yield_now(); }
    reader.join().unwrap();
    let db = Database::open(&root.0).unwrap();
    assert_eq!(db.connection.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0)).unwrap(), "ok");
}

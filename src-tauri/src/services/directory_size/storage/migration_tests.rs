use super::{database::{Database, ScanHeader, StoredDirectory}, migration};
use super::super::{history::{History, HistoricalSize}, scan::{DirectorySize, ScanStats}, target::normalize_local_path};
use std::{fs, path::PathBuf, sync::Arc};
struct Root(PathBuf);
impl Root { fn new() -> Self { let path = std::env::temp_dir().join(format!("size-migrate-{}", uuid::Uuid::new_v4())); fs::create_dir(&path).unwrap(); Self(path) } }
impl Drop for Root { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
#[test]
fn size_migration_resumes_committed_cursor_and_normal_scan_outranks_import() {
    let root = Root::new(); let legacy = root.0.join("directory-size-history.ndjson");
    let path = normalize_local_path("C:\\root\\child").unwrap();
    let at = chrono::Utc::now(); let mut history = History::default();
    for i in 0..300 { history.insert(Arc::from(format!("{path}{i:03}")), HistoricalSize { bytes: 5, complete: true, created_at: at, cached_at: at, artifact_capture: None }, 1 << 20); }
    history.save(&legacy).unwrap(); let mut db = Database::open(&root.0.join("cache")).unwrap();
    let header = ScanHeader { id: "normal".into(), session: "s".into(), root: "C:\\root".into(), generation: 1, source: 1, captured_at: at, policy_version: 2 };
    db.append(&header, &[StoredDirectory { path: format!("{path}000"), artifact_capture: None, size: DirectorySize { bytes: 99, complete: true, fingerprint: None,
        created_at: Some(at), stats: ScanStats { directories: 1, ..Default::default() } } }]).unwrap(); db.publish("normal", 1).unwrap();
    assert!(!migration::step(&mut db, &legacy).unwrap());
    let count: u64 = db.connection.query_row("SELECT count(*) FROM records", [], |row| row.get(0)).unwrap();
    assert_eq!(count, 257); drop(db);
    let mut db = Database::open(&root.0.join("cache")).unwrap();
    assert!(migration::step(&mut db, &legacy).unwrap());
    assert!(!legacy.exists(), "recognized original is removed only after completion is committed");
    assert_eq!(db.lookup(&[format!("{path}000")], None).unwrap()[0].record.size.bytes, 99);
    let count: u64 = db.connection.query_row("SELECT count(*) FROM records", [], |row| row.get(0)).unwrap(); assert_eq!(count, 301);
}
#[test]
fn size_migration_invalid_source_is_preserved() {
    let root = Root::new(); let legacy = root.0.join("directory-size-history.ndjson");
    fs::write(&legacy, "user data").unwrap(); let mut db = Database::open(&root.0.join("cache")).unwrap();
    assert!(migration::step(&mut db, &legacy).is_err()); assert!(legacy.exists());
}

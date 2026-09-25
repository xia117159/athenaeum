use super::{database::{Database, ScanHeader, StoredDirectory}, operations::{Operation, RenamePath}};
use super::super::{scan::{DirectorySize, ScanStats}, target::normalize_local_path};
use std::{fs, path::PathBuf};
struct Root(PathBuf);
impl Root { fn new() -> Self { let path = std::env::temp_dir().join(format!("size-op-{}", uuid::Uuid::new_v4())); fs::create_dir(&path).unwrap(); Self(path) } }
impl Drop for Root { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
fn header(id: &str, generation: u64) -> ScanHeader { ScanHeader { id: id.into(), session: "s".into(), root: "C:\\root".into(), generation,
    source: 1, captured_at: chrono::Utc::now(), policy_version: 2 } }
fn record(path: &str, bytes: u64) -> StoredDirectory { StoredDirectory { path: normalize_local_path(path).unwrap(), artifact_capture: None,
    size: DirectorySize { bytes, complete: true, fingerprint: Some("stamp".into()), created_at: Some(chrono::Utc::now()), stats: ScanStats { directories: 1, ..Default::default() } } } }
fn operation() -> Operation { Operation { id: "rename".into(), session: "s".into(), generation: 2, paths: vec![RenamePath {
    from: normalize_local_path("C:\\root\\old").unwrap(), to: normalize_local_path("C:\\root\\new").unwrap(),
}], scans: vec!["original".into()], patches: vec![] } }

#[test]
fn size_operation_barrier_fences_late_old_scan_and_shadow_is_atomic() {
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    let old = record("C:\\root\\old", 50); let deep = record("C:\\root\\old\\child", 50);
    let sibling = record("C:\\root\\older", 20);
    db.append(&header("original", 1), &[old.clone(), deep.clone(), sibling.clone()]).unwrap(); db.publish("original", 1).unwrap();
    let operation = operation(); db.prepare_operation(&operation).unwrap();
    assert!(db.lookup(&[old.path.clone()], None).unwrap().is_empty());
    assert_eq!(db.lookup(&[sibling.path.clone()], None).unwrap().len(), 1, "prefix components must not hide a similarly named sibling");
    db.append(&header("late", 1), &[old.clone()]).unwrap(); db.publish("late", 2).unwrap();
    db.authorize_operation(&operation).unwrap();
    let new = record("C:\\root\\new", 50).path;
    assert!(db.lookup(&[new.clone()], None).unwrap().is_empty());
    while db.advance_operation().unwrap() {}
    assert_eq!(db.lookup(&[new.clone()], None).unwrap()[0].record.size.bytes, 50);
    assert!(db.lookup(&[old.path.clone()], None).unwrap().is_empty(), "late publication cannot resurrect the old namespace");
    db.append(&header("replacement", 3), &[record("C:\\root\\old", 99)]).unwrap(); db.publish("replacement", 3).unwrap();
    assert_eq!(db.lookup(&[old.path], None).unwrap()[0].record.size.bytes, 99, "fresh objects may reuse the old name");
}

#[test]
fn size_operation_restart_abandons_partial_shadow_and_preserves_barriers() {
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    db.append(&header("original", 1), &[record("C:\\root\\old", 50)]).unwrap(); db.publish("original", 1).unwrap();
    let operation = operation(); db.prepare_operation(&operation).unwrap(); db.authorize_operation(&operation).unwrap(); drop(db);
    let db = Database::open(&root.0).unwrap();
    assert!(db.lookup(&[record("C:\\root\\old", 0).path, record("C:\\root\\new", 0).path], None).unwrap().is_empty());
}

#[test]
fn size_operation_retries_are_idempotent_and_cannot_change_the_prepared_namespace() {
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    db.append(&header("original", 1), &[record("C:\\root\\old", 50)]).unwrap(); db.publish("original", 1).unwrap();
    let operation = operation(); db.prepare_operation(&operation).unwrap();
    db.prepare_operation(&operation).expect("retrying a committed prepare must succeed");
    let mut changed = operation.clone(); changed.paths[0].to = normalize_local_path("C:\\elsewhere").unwrap();
    assert!(db.authorize_operation(&changed).is_err(), "authorization must use the fenced namespace");
    db.authorize_operation(&operation).unwrap();
    db.authorize_operation(&operation).expect("retrying authorization must not reserve a second publication");
    while db.advance_operation().unwrap() {}
    db.authorize_operation(&operation).unwrap();
    assert_eq!(db.lookup(&[record("C:\\root\\new", 0).path], None).unwrap()[0].publication, 2);
}

#[test]
fn size_operation_repeated_renames_keep_bounded_revision_ids() {
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    db.append(&header("original", 1), &[record("C:\\root\\old", 50)]).unwrap(); db.publish("original", 1).unwrap();
    let mut scan = "original".to_string(); let mut from = record("C:\\root\\old", 0).path;
    for generation in 2..20 {
        let to = record(&format!("C:\\root\\name{generation}"), 0).path;
        let operation = Operation { id: uuid::Uuid::new_v4().to_string(), session: "s".into(), generation,
            paths: vec![RenamePath { from, to: to.clone() }], scans: vec![scan.clone()], patches: vec![] };
        db.prepare_operation(&operation).unwrap(); db.authorize_operation(&operation).unwrap();
        while db.advance_operation().unwrap() {}
        assert_eq!(db.lookup(&[to.clone()], None).unwrap()[0].record.size.bytes, 50);
        scan = operation.shadow(&scan); assert!(scan.len() <= 192); from = to;
    }
}

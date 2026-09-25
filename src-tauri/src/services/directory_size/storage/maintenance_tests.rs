use super::{database::{Database, ScanHeader, StoredDirectory}, maintenance::{Maintenance, Protection}};
use super::super::{scan::{DirectorySize, ScanStats}, target::normalize_local_path};
use crate::domain::directory_sizes::DirectorySizeViewScope;
use std::{fs, path::PathBuf, sync::Arc};
struct Root(PathBuf);
impl Root { fn new() -> Self { let path = std::env::temp_dir().join(format!("size-gc-{}", uuid::Uuid::new_v4())); fs::create_dir(&path).unwrap(); Self(path) } }
impl Drop for Root { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
#[test]
fn size_maintenance_pressure_reclaims_pinned_deep_rows_but_keeps_two_view_front_pages() {
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    let mut protection = Protection { session: "current".into(), ..Default::default() };
    for (index, scope) in ["C:\\one", "D:\\two"].iter().enumerate() {
        let id = format!("scan{index}"); protection.scans.push(id.clone());
        let header = ScanHeader { id: id.clone(), session: "current".into(), root: (*scope).into(), generation: 1,
            source: 1, captured_at: chrono::Utc::now(), policy_version: 2 };
        let records: Vec<_> = [format!("{scope}\\child\\cold"), format!("{scope}\\child"), scope.to_string()].into_iter().map(|path| StoredDirectory {
            path: normalize_local_path(&path).unwrap(), artifact_capture: None,
            size: DirectorySize { bytes: 9, complete: true, fingerprint: None, created_at: None, stats: ScanStats::default() },
        }).collect();
        db.append(&header, &records).unwrap();
        if index == 1 { db.publish(&id, 1).unwrap(); } // both running and accepted references
    }
    protection.scopes = Arc::new(["C:\\one", "D:\\two"].iter().map(|path| DirectorySizeViewScope { path: normalize_local_path(path).unwrap(), priority: 0 }).collect());
    let mut maintenance = Maintenance::default();
    for _ in 0..3 { maintenance.step(&mut db, &protection, true).unwrap(); }
    let paths: Vec<String> = db.connection.prepare("SELECT path FROM records ORDER BY path").unwrap().query_map([], |row| row.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
    assert_eq!(paths.len(), 4, "live scan identity must not pin cold descendants under pressure");
    assert!(!paths.iter().any(|path| path.ends_with("cold")));
    assert_eq!(db.connection.query_row("SELECT count(*) FROM scans", [], |row| row.get::<_, u32>(0)).unwrap(), 2, "references retain scan identity for later appends and publication");
}
#[test]
fn size_maintenance_reclaims_cancelled_scans_in_the_current_session() {
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    let record = StoredDirectory { path: normalize_local_path("C:\\root\\child").unwrap(), artifact_capture: None,
        size: DirectorySize { bytes: 1, complete: true, fingerprint: None, created_at: None, stats: ScanStats::default() } };
    for id in ["cancelled", "running"] {
        db.append(&ScanHeader { id: id.into(), session: "current".into(), root: "C:\\root".into(), generation: 1,
            source: 1, captured_at: chrono::Utc::now(), policy_version: 2 }, &[record.clone()]).unwrap();
    }
    let protection = Protection { session: "current".into(), scans: vec!["running".into()], ..Default::default() };
    let mut maintenance = Maintenance::default();
    for _ in 0..3 { maintenance.step(&mut db, &protection, false).unwrap(); }
    let ids = db.connection.prepare("SELECT id FROM scans ORDER BY id").unwrap()
        .query_map([], |row| row.get::<_, String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    assert_eq!(ids, vec!["running"], "a cancelled scan must not remain pinned for the whole process lifetime");
}

#[test]
fn size_maintenance_retires_namespace_barriers_after_scrubbing_old_records() {
    use super::operations::{Operation, RenamePath};
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    let path = normalize_local_path("C:\\root\\deleted").unwrap();
    let record = StoredDirectory { path: path.clone(), artifact_capture: None,
        size: DirectorySize { bytes: 1, complete: true, fingerprint: None, created_at: None, stats: ScanStats::default() } };
    db.append(&ScanHeader { id: "old".into(), session: "current".into(), root: "C:\\root".into(), generation: 1,
        source: 1, captured_at: chrono::Utc::now(), policy_version: 2 }, &[record]).unwrap(); db.publish("old", 1).unwrap();
    db.prepare_operation(&Operation { id: "delete".into(), session: "current".into(), generation: 2,
        paths: vec![RenamePath { from: path.clone(), to: path.clone() }], scans: vec![], patches: vec![] }).unwrap();
    db.abort_operation("delete").unwrap();
    let mut maintenance = Maintenance::default(); let protection = Protection { session: "current".into(), ..Default::default() };
    for _ in 0..5 { maintenance.step(&mut db, &protection, false).unwrap(); }
    assert_eq!(db.connection.query_row("SELECT count(*) FROM barriers", [], |row| row.get::<_, u32>(0)).unwrap(), 0);
    assert!(db.lookup(&[path], None).unwrap().is_empty(), "retiring the fence must not resurrect the deleted namespace");
}
#[test]
fn size_maintenance_keeps_two_versions_plus_live_reference_and_evicts_whole_path() {
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    let path = normalize_local_path("C:\\root\\child").unwrap();
    let record = StoredDirectory { path: path.clone(), artifact_capture: None, size: DirectorySize { bytes: 1, complete: true, fingerprint: None,
        created_at: Some(chrono::Utc::now()), stats: ScanStats { directories: 1, ..Default::default() } } };
    for ticket in 1..=5 {
        let header = ScanHeader { id: format!("scan{ticket}"), session: "old".into(), root: "C:\\root".into(), generation: ticket,
            source: u8::from(ticket > 1), captured_at: chrono::Utc::now(), policy_version: 2 };
        db.append(&header, &[record.clone()]).unwrap(); db.publish(&header.id, ticket).unwrap();
    }
    let mut protection = Protection { session: "new".into(), scans: vec!["scan2".into()], scopes: Arc::new(vec![]), hot: vec![], migrating: false, reclaim: None };
    let mut maintenance = Maintenance::default();
    for _ in 0..3 { maintenance.step(&mut db, &protection, false).unwrap(); }
    let count: u64 = db.connection.query_row("SELECT count(*) FROM records", [], |row| row.get(0)).unwrap(); assert_eq!(count, 3);
    assert_eq!(db.lookup(&[path.clone()], Some("scan2")).unwrap().len(), 1);
    protection.scans.clear(); protection.scopes = Arc::new(vec![DirectorySizeViewScope { path: normalize_local_path("C:\\root").unwrap(), priority: 0 }]);
    for _ in 0..3 { maintenance.step(&mut db, &protection, true).unwrap(); }
    assert_eq!(db.lookup(&[path.clone()], None).unwrap().len(), 1, "open direct children outrank cold history");
    protection.scopes = Arc::new(vec![]);
    for _ in 0..3 { maintenance.step(&mut db, &protection, true).unwrap(); }
    assert!(db.lookup(&[path], None).unwrap().is_empty(), "eviction must not reveal a previously shadowed legacy value");
}

use super::{database::{Database, ScanHeader, StoredDirectory}, startup};
use super::super::{scan::{DirectorySize, ScanStats}, artifacts::Registry};
use crate::domain::directory_sizes::DirectorySizeViewScope;
use std::{fs, path::PathBuf};
struct Root(PathBuf);
impl Root { fn new() -> Self { let path = std::env::temp_dir().join(format!("size-startup-{}", uuid::Uuid::new_v4())); fs::create_dir(&path).unwrap(); Self(path) } }
impl Drop for Root { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
fn record(path: &str) -> StoredDirectory { StoredDirectory { path: path.into(), artifact_capture: None, size: DirectorySize {
    bytes: 70, complete: true, fingerprint: Some("stamp".into()), created_at: Some(chrono::Utc::now()),
    stats: ScanStats { directories: 1, ..Default::default() },
} } }
#[test]
fn size_startup_long_paths_across_many_scopes_have_a_bounded_working_set() {
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap(); let mut scopes = Vec::new();
    for index in 0..48 {
        let scope = format!("C:\\view{index:02}");
        let header = ScanHeader { id: format!("scan{index}"), session: "session".into(), root: scope.clone(), generation: 1,
            source: 1, captured_at: chrono::Utc::now(), policy_version: 2 };
        let rows: Vec<_> = (0..16).map(|child| record(&format!("{scope}\\{child:02}{}", "x".repeat(28_000)))).collect();
        for chunk in rows.chunks(8) { db.append(&header, chunk).unwrap(); }
        db.publish(&header.id, index + 1).unwrap(); scopes.push(DirectorySizeViewScope { path: scope, priority: 0 });
    }
    let mut peak = 0;
    startup::save_tracked(&mut db, &root.0, &scopes, startup::MAX_BYTES, Some(&mut |bytes| peak = peak.max(bytes))).unwrap();
    assert!(peak <= 12 << 20, "summary retained {peak} bytes of paths/buffers for only a 4 MiB file");
    eprintln!("summary retained path/buffer capacity peak: {peak} bytes (48 scopes, 28000-byte child paths)");
    let hits = startup::load(&root.0).unwrap();
    for scope in scopes {
        assert!(hits.iter().any(|hit| std::path::Path::new(&hit.record.path).parent().and_then(std::path::Path::to_str)
            == super::super::target::normalize_local_path(&scope.path).ok().as_deref()), "each view gets a first row");
    }
}

#[test]
fn size_startup_fair_bounded_summary_contains_only_accepted_roots_and_direct_children() {
    let root = Root::new(); let registry = Registry::register(&root.0).unwrap();
    let mut db = Database::open(&root.0).unwrap();
    for (ticket, scope) in ["C:\\wide", "D:\\small"].iter().enumerate() {
        let header = ScanHeader { id: scope.to_string(), session: "session".into(), root: scope.to_string(),
            generation: 1, source: 1, captured_at: chrono::Utc::now(), policy_version: 2 };
        let mut records = vec![record(scope), record(&format!("{scope}\\direct")), record(&format!("{scope}\\direct\\deep"))];
        if ticket == 0 { records.extend((0..100).map(|i| record(&format!("{scope}\\child{i:03}")))); }
        db.append(&header, &records).unwrap(); db.publish(&header.id, ticket as u64 + 1).unwrap();
    }
    let scopes = [DirectorySizeViewScope { path: "C:\\wide".into(), priority: 0 }, DirectorySizeViewScope { path: "D:\\small".into(), priority: 1 }];
    startup::save(&mut db, &root.0, &scopes, 4500).unwrap();
    let hits = startup::load(&root.0).unwrap();
    assert!(hits.iter().any(|hit| hit.record.path.ends_with("small\\direct")), "one wide root cannot consume the whole summary");
    assert!(!hits.iter().any(|hit| hit.record.path.ends_with("deep")));
    assert!(fs::metadata(root.0.join("startup.json")).unwrap().len() <= 4500);
    startup::save(&mut db, &root.0, &scopes, 4500).unwrap();
    let snapshot = registry.sample();
    let canonical = super::super::target::normalize_local_path(root.0.to_str().unwrap()).unwrap();
    assert!(snapshot.suppress(&canonical, "startup.json"), "atomic replacement must have an identity receipt");
    assert!(!root.0.join("startup.next").exists());
    let mut reader = Database::open(&root.0).unwrap();
    assert!(startup::save(&mut reader, &root.0, &[], 4500).is_err());
    assert!(!startup::load(&root.0).unwrap().is_empty());
}
#[test]
fn size_startup_rejects_oversized_input_before_decode() {
    let root = Root::new();
    let file = fs::File::create(root.0.join("startup.json")).unwrap(); file.set_len((4 << 20) + 1).unwrap();
    assert!(startup::load(&root.0).is_err());
}

#[test]
fn size_startup_rejects_a_malicious_field_even_inside_the_file_budget() {
    let root = Root::new();
    let mut row = record(&super::super::target::normalize_local_path("C:\\root").unwrap());
    row.size.fingerprint = Some("x".repeat(128 << 10));
    let hit = super::database::StoredHit { record: row, scan_id: "scan".into(), source: 1, publication: 1,
        captured_at: chrono::Utc::now(), policy_version: 2 };
    fs::write(root.0.join("startup.json"), serde_json::to_vec(&serde_json::json!({ "version": 1, "records": [hit] })).unwrap()).unwrap();
    assert!(startup::load(&root.0).is_err(), "bounded files still need individual record limits");
}

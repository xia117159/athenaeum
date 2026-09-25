//! Opt-in real SQLite workload; does not purge the machine's OS page cache.
use std::{fs, path::PathBuf, time::Instant};
use super::{database::{Database, ScanHeader, StoredDirectory}, startup};
use super::super::scan::{DirectorySize, ScanStats};
use crate::domain::directory_sizes::DirectorySizeViewScope;
struct Root(PathBuf);
impl Drop for Root { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
fn percentile(values: &mut [f64], percent: usize) -> f64 { values.sort_by(f64::total_cmp); values[(values.len() - 1) * percent / 100] }

#[test]
#[ignore = "fills a disposable ~208 MiB cache for release performance evidence"]
fn size_storage_full_budget_benchmark() {
    let root = Root(std::env::temp_dir().join(format!("size-bench-{}", uuid::Uuid::new_v4())));
    let mut db = Database::open(&root.0).unwrap();
    let header = ScanHeader { id: "benchmark".into(), session: "bench".into(), root: "C:\\root".into(), generation: 1,
        source: 1, captured_at: chrono::Utc::now(), policy_version: 2 };
    let created = chrono::DateTime::UNIX_EPOCH; let mut count = 0;
    let start = Instant::now();
    loop {
        let batch = (count..count + 256).map(|index| StoredDirectory {
            path: format!("C:\\root\\{index:08}-{}", "x".repeat(160)), artifact_capture: None,
            size: DirectorySize { bytes: index, complete: true, fingerprint: Some(format!("v1:1:{}", "0".repeat(64))),
                created_at: Some(created), stats: ScanStats { directories: 1, files: 1, known_bytes: index, ..Default::default() } }
        }).collect::<Vec<_>>();
        db.append(&header, &batch).unwrap(); count += 256;
        let pages: u64 = db.connection.query_row("PRAGMA page_count", [], |row| row.get(0)).unwrap();
        if pages * 4096 >= 200 << 20 { break; }
    }
    db.publish(&header.id, 1).unwrap(); db.checkpoint().unwrap();
    let fill_secs = start.elapsed().as_secs_f64();
    let paths = (count - 16..count).map(|index| format!("C:\\root\\{index:08}-{}", "x".repeat(160))).collect::<Vec<_>>();
    let plan: String = db.connection.prepare("EXPLAIN QUERY PLAN SELECT path FROM records WHERE path=?1").unwrap()
        .query_map([&paths[0]], |row| row.get::<_, String>(3)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap().join(" ");
    assert!(plan.contains("SEARCH records USING PRIMARY KEY"), "{plan}");
    startup::save(&mut db, &root.0, &[DirectorySizeViewScope { path: "C:\\root".into(), priority: 0 }], startup::MAX_BYTES).unwrap();
    let summary_bytes = fs::metadata(root.0.join("startup.json")).unwrap().len();
    assert!(summary_bytes <= 4 << 20); drop(db);
    let mut opens = vec![]; let mut reads = vec![]; let mut summaries = vec![];
    for _ in 0..20 {
        let start = Instant::now(); let db = Database::open(&root.0).unwrap(); opens.push(start.elapsed().as_secs_f64() * 1000.0);
        let start = Instant::now(); assert_eq!(db.lookup(&paths, None).unwrap().len(), 16); reads.push(start.elapsed().as_secs_f64() * 1000.0);
        let start = Instant::now(); assert!(!startup::load(&root.0).unwrap().is_empty()); summaries.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    let bytes = fs::metadata(root.0.join("sizes.sqlite3")).unwrap().len();
    assert!((200 << 20..=208 << 20).contains(&bytes));
    println!("rows={count} database_bytes={bytes} summary_bytes={summary_bytes} fill_secs={fill_secs:.2} samples=20 os_cache=warm connection_cache=fresh");
    println!("open_ms p50={:.3} p95={:.3}; lookup16_ms p50={:.3} p95={:.3}; summary_ms p50={:.3} p95={:.3}",
        percentile(&mut opens, 50), percentile(&mut opens, 95), percentile(&mut reads, 50), percentile(&mut reads, 95), percentile(&mut summaries, 50), percentile(&mut summaries, 95));
}

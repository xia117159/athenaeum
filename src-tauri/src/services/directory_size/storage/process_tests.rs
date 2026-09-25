use super::database::{Database, ScanHeader, StoredDirectory};
use super::super::scan::{DirectorySize, ScanStats};
use std::{fs, path::PathBuf, process::{Child, Command}, time::{Duration, Instant}};
struct Process { child: Child, directory: PathBuf }
impl Drop for Process { fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); let _ = fs::remove_dir_all(&self.directory); } }

#[test]
fn size_storage_child_process_entry() {
    let Some(path) = std::env::var_os("SFM_SIZE_CACHE_CHILD_PATH") else { return; };
    let directory = PathBuf::from(path); let mut db = Database::open(&directory).unwrap();
    let header = ScanHeader { id: "scan".into(), session: "child".into(), root: "C:\\root".into(), generation: 1, source: 1,
        captured_at: chrono::Utc::now(), policy_version: 2 };
    db.append(&header, &[StoredDirectory { path: "C:\\root".into(), artifact_capture: None, size: DirectorySize { bytes: 91, complete: true,
        fingerprint: None, created_at: Some(chrono::Utc::now()), stats: ScanStats { directories: 1, ..Default::default() } } }]).unwrap();
    if std::env::var("SFM_SIZE_CACHE_CHILD_ACCEPTED").as_deref() == Ok("1") { db.publish("scan", 1).unwrap(); }
    fs::write(directory.join("child-ready"), "ready").unwrap();
    loop { std::thread::sleep(Duration::from_millis(100)); }
}

#[test]
fn size_storage_separate_process_lock_and_forced_crash_recover_only_committed_scans() {
    for accepted in [false, true] {
        let directory = std::env::temp_dir().join(format!("size-process-{}", uuid::Uuid::new_v4())); fs::create_dir(&directory).unwrap();
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "services::directory_size::storage::process_tests::size_storage_child_process_entry", "--nocapture"])
            .env("SFM_SIZE_CACHE_CHILD_PATH", &directory).env("SFM_SIZE_CACHE_CHILD_ACCEPTED", if accepted { "1" } else { "0" }).spawn().unwrap();
        let mut process = Process { child, directory };
        let deadline = Instant::now() + Duration::from_secs(10);
        while !process.directory.join("child-ready").exists() {
            assert!(process.child.try_wait().unwrap().is_none(), "storage child exited before readiness");
            assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(10));
        }
        let reader = Database::open(&process.directory).unwrap(); assert!(!reader.writable());
        assert!(reader.checkpoint().is_err());
        assert_eq!(reader.lookup(&["C:\\root".into()], None).unwrap().len(), usize::from(accepted));
        drop(reader); process.child.kill().unwrap(); process.child.wait().unwrap();
        let recovered = Database::open(&process.directory).unwrap(); assert!(recovered.writable());
        assert_eq!(recovered.lookup(&["C:\\root".into()], None).unwrap().len(), usize::from(accepted));
        assert_eq!(recovered.connection.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0)).unwrap(), "ok");
        drop(recovered);
    }
}

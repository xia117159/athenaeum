use super::quota::{Limits, Quota};
use std::{fs, path::PathBuf};

struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("athenaeum-quota-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap(); Self(path)
    }
}
impl Drop for Root { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

#[test]
fn size_storage_quota_refuses_wal_growth_before_writing_and_recovers_committed_rows() {
    let root = Root::new(); let path = root.0.join("sizes.sqlite3");
    let limits = Limits { database: 1 << 20, wal: 64 << 10, shm: 64 << 10, journal: 64 << 10 };
    let quota = Quota::register(&path, limits).unwrap();
    let writer = quota.open(true).unwrap();
    writer.execute_batch("PRAGMA page_size=4096; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        PRAGMA wal_autocheckpoint=0; CREATE TABLE items(id INTEGER PRIMARY KEY, value BLOB);
        INSERT INTO items(value) VALUES(zeroblob(4096)); PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    let reader = quota.open(false).unwrap();
    reader.execute_batch("BEGIN; SELECT * FROM items;").unwrap();
    let mut committed = 1;
    let mut refused = false;
    for _ in 0..64 {
        match writer.execute("INSERT INTO items(value) VALUES(zeroblob(4096))", []) {
            Ok(_) => committed += 1,
            Err(error) => {
                assert_eq!(error.sqlite_error_code(), Some(rusqlite::ErrorCode::DiskFull), "{error}");
                refused = true; break;
            }
        }
    }
    assert!(refused, "a reader pinning WAL must not bypass its physical byte cap");
    assert!(fs::metadata(root.0.join("sizes.sqlite3-wal")).unwrap().len() <= limits.wal);
    assert_eq!(writer.query_row("SELECT count(*) FROM items", [], |row| row.get::<_, u64>(0)).unwrap(), committed);
    reader.execute_batch("ROLLBACK").unwrap(); drop(reader);
    writer.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap(); drop(writer);
    let recovered = quota.open(true).unwrap();
    assert_eq!(recovered.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0)).unwrap(), "ok");
    assert_eq!(recovered.query_row("SELECT count(*) FROM items", [], |row| row.get::<_, u64>(0)).unwrap(), committed);
    recovered.execute("INSERT INTO items(value) VALUES(zeroblob(4096))", []).unwrap();
}

#[test]
fn size_storage_quota_spill_failure_rolls_back_the_whole_transaction() {
    let root = Root::new(); let path = root.0.join("sizes.sqlite3");
    let quota = Quota::register(&path, Limits { wal: 64 << 10, ..Limits::default() }).unwrap();
    let mut writer = quota.open(true).unwrap();
    writer.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0;
        PRAGMA cache_size=2; CREATE TABLE items(value BLOB); INSERT INTO items VALUES(x'01'); PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
    let tx = writer.transaction().unwrap();
    let failed = (0..64).any(|_| tx.execute("INSERT INTO items VALUES(zeroblob(8192))", []).is_err());
    assert!(failed); drop(tx);
    assert!(fs::metadata(root.0.join("sizes.sqlite3-wal")).unwrap().len() <= 64 << 10);
    assert_eq!(writer.query_row("SELECT count(*) FROM items", [], |row| row.get::<_, u64>(0)).unwrap(), 1);
    assert_eq!(writer.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0)).unwrap(), "ok");
}

#[test]
fn size_storage_quota_short_wal_writes_preserve_the_previous_commit_after_reopen() {
    for fault in 0..3 {
        let root = Root::new(); let path = root.0.join("sizes.sqlite3");
        let quota = Quota::register(&path, Limits::default()).unwrap();
        let writer = quota.open(true).unwrap();
        writer.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0;
            CREATE TABLE items(value INTEGER); INSERT INTO items VALUES(1); PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
        quota.fail_after_writes(fault);
        assert!(writer.execute("INSERT INTO items VALUES(2)", []).is_err(), "fault {fault} must reach an OS write");
        quota.fail_after_writes(-1); drop(writer);
        let recovered = quota.open(true).unwrap();
        assert_eq!(recovered.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0)).unwrap(), "ok");
        assert_eq!(recovered.query_row("SELECT sum(value) FROM items", [], |row| row.get::<_, u64>(0)).unwrap(), 1);
    }
}

#[test]
fn size_storage_quota_caps_main_file_and_rejects_unregistered_databases() {
    let root = Root::new(); let path = root.0.join("sizes.sqlite3");
    let quota = Quota::register(&path, Limits { database: 64 << 10, ..Limits::default() }).unwrap();
    let writer = quota.open(true).unwrap();
    writer.execute_batch("CREATE TABLE items(value BLOB)").unwrap();
    let error = writer.execute("INSERT INTO items VALUES(zeroblob(131072))", []).unwrap_err();
    assert_eq!(error.sqlite_error_code(), Some(rusqlite::ErrorCode::DiskFull));
    assert!(fs::metadata(&path).unwrap().len() <= 64 << 10);
    assert_eq!(writer.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0)).unwrap(), "ok");
    let unknown = root.0.join("unregistered.sqlite3");
    assert!(writer.execute("ATTACH DATABASE ?1 AS other", [unknown.to_str().unwrap()]).is_err());
    assert!(!unknown.exists());
}

#[test]
fn size_storage_quota_covers_preallocation_truncation_and_shm_growth() {
    use rusqlite::ffi;
    let root = Root::new(); let path = root.0.join("sizes.sqlite3");
    let limits = Limits { database: 64 << 10, shm: 32 << 10, ..Limits::default() };
    let quota = Quota::register(&path, limits).unwrap(); let writer = quota.open(true).unwrap();
    writer.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE items(value INTEGER)").unwrap();
    unsafe {
        let mut file: *mut ffi::sqlite3_file = std::ptr::null_mut();
        assert_eq!(ffi::sqlite3_file_control(writer.handle(), c"main".as_ptr(), ffi::SQLITE_FCNTL_FILE_POINTER,
            (&mut file as *mut *mut ffi::sqlite3_file).cast()), ffi::SQLITE_OK);
        let methods = &*(*file).pMethods;
        let mut hint = limits.database as i64 + 1;
        assert_eq!(methods.xFileControl.unwrap()(file, ffi::SQLITE_FCNTL_SIZE_HINT, (&mut hint as *mut i64).cast()), ffi::SQLITE_FULL);
        assert_eq!(methods.xTruncate.unwrap()(file, hint), ffi::SQLITE_FULL);
        let mut mapped = std::ptr::null_mut();
        assert_eq!(methods.xShmMap.unwrap()(file, 1, 32 << 10, 1, &mut mapped), ffi::SQLITE_IOERR_SHMSIZE);
        assert!(mapped.is_null());
    }
    assert!(fs::metadata(&path).unwrap().len() <= limits.database);
    assert!(fs::metadata(root.0.join("sizes.sqlite3-shm")).unwrap().len() <= limits.shm);
    let reader = quota.open(false).unwrap();
    unsafe {
        let mut file: *mut ffi::sqlite3_file = std::ptr::null_mut();
        assert_eq!(ffi::sqlite3_file_control(reader.handle(), c"main".as_ptr(), ffi::SQLITE_FCNTL_FILE_POINTER,
            (&mut file as *mut *mut ffi::sqlite3_file).cast()), ffi::SQLITE_OK);
        let mut mapped = std::ptr::null_mut();
        assert_eq!((*(*file).pMethods).xShmMap.unwrap()(file, 0, 32 << 10, 1, &mut mapped), ffi::SQLITE_IOERR_SHMMAP);
    }
}

#[test]
fn size_storage_read_only_open_requires_existing_initialized_shm() {
    let root = Root::new(); let quota = Quota::register(&root.0.join("sizes.sqlite3"), Limits::default()).unwrap();
    let writer = quota.open(true).unwrap();
    writer.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE items(value INTEGER); PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
    drop(writer);
    // Simulate a missing sidecar, independently of the writer's retention policy.
    let _ = fs::remove_file(root.0.join("sizes.sqlite3-shm"));
    assert!(quota.open(false).is_err(), "a reader must wait for the writer to initialize shared memory");
    assert!(!root.0.join("sizes.sqlite3-shm").exists(), "read-only startup cannot create a sidecar");
}

#[test]
fn size_storage_writer_close_with_an_unmapped_reader_keeps_sidecars_without_retrying_deletion() {
    let root = Root::new(); let path = root.0.join("sizes.sqlite3");
    let quota = Quota::register(&path, Limits::default()).unwrap();
    let writer = quota.open(true).unwrap();
    writer.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE items(value INTEGER); INSERT INTO items VALUES(7)").unwrap();
    let reader = quota.open(false).unwrap(); // pins the name, but has no SQLite SHM mapping yet
    let closing = std::time::Instant::now();
    drop(writer);
    assert!(closing.elapsed() < std::time::Duration::from_secs(1), "writer close entered Windows deletion retries while holding SQLite's global SHM lock");
    drop(reader);
    assert!(root.0.join("sizes.sqlite3-shm").exists(), "writer close must retain the fixed sidecar instead of retrying a blocked deletion");
    let before = fs::read(root.0.join("sizes.sqlite3-shm")).unwrap();
    let reader = quota.open(false).unwrap();
    let _ = reader.query_row("SELECT value FROM items", [], |row| row.get::<_, i64>(0));
    drop(reader);
    assert_eq!(fs::read(root.0.join("sizes.sqlite3-shm")).unwrap(), before, "an ownerless reader must never initialize existing SHM");
    let writer = quota.open(true).unwrap();
    assert_eq!(writer.query_row("SELECT value FROM items", [], |row| row.get::<_, i64>(0)).unwrap(), 7);
}

#[test]
fn size_storage_read_only_queries_do_not_modify_existing_shm() {
    let root = Root::new(); let path = root.0.join("sizes.sqlite3");
    let quota = Quota::register(&path, Limits::default()).unwrap();
    let writer = quota.open(true).unwrap();
    writer.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE items(value INTEGER); INSERT INTO items VALUES(7)").unwrap();
    let shm = root.0.join("sizes.sqlite3-shm");
    let before = fs::read(&shm).unwrap();
    let reader = quota.open(false).unwrap();
    assert_eq!(reader.query_row("SELECT value FROM items", [], |row| row.get::<_, i64>(0)).unwrap(), 7);
    drop(reader);
    assert_eq!(fs::read(&shm).unwrap(), before, "read-only lookup must not rewrite SQLite shared memory");
    drop(writer);
}

#[test]
fn size_storage_preserves_literal_percent_and_verbatim_paths() {
    let root = Root::new(); let directory = root.0.join("literal%20缓存"); fs::create_dir(&directory).unwrap();
    let path = fs::canonicalize(&directory).unwrap().join("sizes.sqlite3");
    let quota = Quota::register(&path, Limits::default()).unwrap();
    let writer = quota.open(true).unwrap();
    writer.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE items(value INTEGER); INSERT INTO items VALUES(7)").unwrap();
    let reader = quota.open(false).unwrap();
    assert_eq!(reader.query_row("SELECT value FROM items", [], |row| row.get::<_, i64>(0)).unwrap(), 7);
}

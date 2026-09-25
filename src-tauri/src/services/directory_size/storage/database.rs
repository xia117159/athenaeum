use std::{fs::{File, OpenOptions, TryLockError}, path::{Path, PathBuf}, time::Duration};
use anyhow::{Context, Result, ensure};
use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use super::quota::{Limits, Quota, QuotaConnection};
use super::super::{scan::DirectorySize, target::normalize_local_path};

#[derive(Clone, Debug)]
pub(in crate::services::directory_size) struct ScanHeader {
    pub id: String, pub session: String, pub root: String, pub generation: u64,
    pub captured_at: DateTime<Utc>, pub policy_version: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(in crate::services::directory_size) struct StoredDirectory {
    pub path: String, pub size: DirectorySize,
    #[serde(default)] pub artifact_capture: Option<super::super::artifacts::Capture>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(in crate::services::directory_size) struct StoredHit {
    pub record: StoredDirectory, pub scan_id: String, pub source: u8,
    pub publication: u64, pub captured_at: DateTime<Utc>, pub policy_version: u32,
}
impl StoredHit {
    pub(super) fn checked_bytes(&self) -> Result<usize> {
        ensure!(self.source <= 1 && self.publication > 0 && !self.scan_id.is_empty() && self.scan_id.len() <= 192
            && (1..=2).contains(&self.policy_version) && self.record.path.len() <= 65_536
            && self.record.size.fingerprint.as_ref().is_none_or(|value| value.len() <= 128)
            && self.record.artifact_capture.as_ref().is_none_or(|value| value.policy.len() <= 128), "invalid stored size record");
        ensure!(normalize_local_path(&self.record.path).ok().as_deref() == Some(self.record.path.as_str()), "invalid stored size path");
        Ok(1024 + self.record.path.capacity() + self.scan_id.capacity()
            + self.record.size.fingerprint.as_ref().map_or(0, String::capacity)
            + self.record.artifact_capture.as_ref().map_or(0, |capture| capture.policy.capacity()))
    }
}
pub(super) struct Database {
    // Connections close before the OS writer lock and the quota registration.
    pub(super) connection: QuotaConnection, owner: Option<File>, directory: PathBuf,
}
const MAX_RECORD_BYTES: usize = 128 << 10;
pub(super) const LOOKUP: &str = "SELECT r.payload,s.id,s.source,s.publication,s.captured_at,s.policy_version
    FROM records r JOIN scans s ON s.id=r.scan_id WHERE r.path=?1 AND s.state=1
    AND s.source=1
    AND NOT EXISTS(SELECT 1 FROM barriers b WHERE (r.path=b.prefix OR substr(r.path,1,length(b.prefix)+1)=b.prefix||char(92))
        AND (b.state=0 OR s.publication<=b.cutoff OR (s.session=b.session AND CAST(s.generation AS INTEGER)<=b.generation)))
    AND (?2 IS NULL OR s.id=?2) ORDER BY s.publication DESC LIMIT 1";

impl Database {
    pub fn open(directory: &Path) -> Result<Self> {
        std::fs::create_dir_all(directory)?;
        let lock_path = directory.join("writer.lock");
        if let Ok(metadata) = std::fs::symlink_metadata(&lock_path) {
            ensure!(metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() <= 1 << 20, "invalid cache lock file");
        }
        let receipt = super::super::artifacts::Creation::begin(&lock_path);
        let file = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(lock_path)?;
        receipt.finish();
        let owner = match file.try_lock() {
            Ok(()) => Some(file), Err(TryLockError::WouldBlock) => None, Err(TryLockError::Error(error)) => return Err(error.into()),
        };
        let quota = Quota::register(&directory.join("sizes.sqlite3"), Limits::default())?;
        let connection = quota.open(owner.is_some())?;
        connection.busy_timeout(Duration::from_millis(25))?;
        connection.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-4096;
            PRAGMA mmap_size=0; PRAGMA foreign_keys=ON;")?;
        unsafe {
            rusqlite::ffi::sqlite3_limit(connection.handle(), rusqlite::ffi::SQLITE_LIMIT_LENGTH, MAX_RECORD_BYTES as i32);
            rusqlite::ffi::sqlite3_limit(connection.handle(), rusqlite::ffi::SQLITE_LIMIT_ATTACHED, 0);
        }
        let version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        ensure!(version <= 2, "unsupported directory size cache schema");
        let mut db = Self { connection, owner, directory: directory.into() };
        if db.writable() {
            if version == 0 {
                let tables: u64 = db.connection.query_row("SELECT count(*) FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'", [], |row| row.get(0))?;
                ensure!(tables == 0, "unrecognized existing cache database");
                db.initialize()?;
            }
            db.connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
                PRAGMA wal_autocheckpoint=0; PRAGMA max_page_count=53248;")?;
            if version == 1 { db.upgrade_operations()?; }
            db.recover_operations()?;
        } else {
            ensure!(version == 2, "cache writer is still initializing");
            db.connection.execute_batch("PRAGMA query_only=ON")?;
        }
        Ok(db)
    }
    fn initialize(&mut self) -> Result<()> {
        self.connection.execute_batch("PRAGMA page_size=4096; PRAGMA auto_vacuum=INCREMENTAL;
            PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA max_page_count=53248;
            BEGIN IMMEDIATE;
            CREATE TABLE metadata(id INTEGER PRIMARY KEY CHECK(id=1), sequence INTEGER NOT NULL);
            INSERT INTO metadata VALUES(1,0);
            CREATE TABLE sessions(id TEXT PRIMARY KEY, ticket INTEGER NOT NULL) WITHOUT ROWID;
            CREATE TABLE scans(id TEXT PRIMARY KEY, session TEXT NOT NULL, root_path TEXT NOT NULL,
                generation TEXT NOT NULL, source INTEGER NOT NULL CHECK(source IN(0,1)), state INTEGER NOT NULL DEFAULT 0,
                ticket INTEGER, publication INTEGER, captured_at TEXT NOT NULL, policy_version INTEGER NOT NULL) WITHOUT ROWID;
            CREATE TABLE records(path TEXT NOT NULL, scan_id TEXT NOT NULL REFERENCES scans(id), parent_path TEXT NOT NULL,
                created_at TEXT, payload TEXT NOT NULL, PRIMARY KEY(path,scan_id)) WITHOUT ROWID;
            CREATE INDEX records_scan ON records(scan_id);
            CREATE INDEX records_parent ON records(parent_path,path);
            CREATE TABLE barriers(prefix TEXT PRIMARY KEY, operation_id TEXT NOT NULL, state INTEGER NOT NULL,
                cutoff INTEGER NOT NULL, session TEXT NOT NULL, generation INTEGER NOT NULL) WITHOUT ROWID;
            CREATE TABLE cache_operations(id TEXT PRIMARY KEY, state INTEGER NOT NULL, spec TEXT NOT NULL, publication INTEGER) WITHOUT ROWID;
            CREATE TABLE operation_copies(operation_id TEXT NOT NULL, old_scan TEXT NOT NULL, shadow_scan TEXT NOT NULL,
                cursor TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(operation_id,old_scan)) WITHOUT ROWID;
            PRAGMA user_version=2;
            COMMIT;")?;
        Ok(())
    }
    pub fn writable(&self) -> bool { self.owner.is_some() }
    pub fn checkpoint(&self) -> Result<()> {
        self.admit()?;
        let (busy, _, _): (u32, u32, u32) = self.connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;
        ensure!(busy == 0, "cache checkpoint is waiting for a reader"); Ok(())
    }
    pub(super) fn admit(&self) -> Result<()> {
        ensure!(self.writable(), "directory size cache is owned by another process");
        if std::fs::metadata(self.directory.join("sizes.sqlite3-wal")).map_or(0, |meta| meta.len()) >= 16 << 20 {
            let (busy, _, _): (u32, u32, u32) = self.connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
            ensure!(busy == 0, "cache WAL checkpoint is waiting for a reader");
        }
        Ok(())
    }
    pub fn append(&mut self, header: &ScanHeader, records: &[StoredDirectory]) -> Result<()> {
        self.admit()?;
        ensure!(!header.id.is_empty() && header.id.len() <= 192 && !header.session.is_empty() && header.session.len() <= 192, "invalid scan identity");
        ensure!(records.len() <= 1024, "cache batch is too large");
        let root = normalize_local_path(&header.root).map_err(anyhow::Error::msg)?;
        let mut encoded = Vec::with_capacity(records.len()); let mut total = 0;
        for record in records {
            let path = normalize_local_path(&record.path).map_err(anyhow::Error::msg)?;
            ensure!(Path::new(&path).starts_with(&root), "record outside scan scope");
            if self.write_blocked(&path, header)? { continue; }
            let payload = serde_json::to_string(&StoredDirectory { path: path.clone(), ..record.clone() })?;
            total += path.len() * 2 + payload.len();
            ensure!(path.len() * 2 + payload.len() < MAX_RECORD_BYTES && total <= 1 << 20, "cache batch byte limit");
            let parent = Path::new(&path).parent().and_then(Path::to_str).unwrap_or(&path).to_owned();
            encoded.push((path, parent, record.size.created_at.map(|at| at.to_rfc3339()), payload));
        }
        let tx = self.connection.transaction()?;
        tx.execute("INSERT OR IGNORE INTO scans(id,session,root_path,generation,source,captured_at,policy_version) VALUES(?1,?2,?3,?4,1,?5,?6)",
            params![header.id,header.session,root,header.generation.to_string(),header.captured_at.to_rfc3339(),header.policy_version])?;
        let (state, session, saved_root): (u32, String, String) = tx.query_row("SELECT state,session,root_path FROM scans WHERE id=?1", [&header.id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;
        ensure!(session == header.session && saved_root == root, "scan identity collision");
        if state == 0 {
            let mut statement = tx.prepare_cached("INSERT OR IGNORE INTO records(path,scan_id,parent_path,created_at,payload) VALUES(?1,?2,?3,?4,?5)")?;
            for (path,parent,created,payload) in encoded { statement.execute(params![path,header.id,parent,created,payload])?; }
        }
        tx.commit()?; Ok(())
    }
    pub fn publish(&mut self, scan: &str, acceptance_ticket: u64) -> Result<u64> {
        self.admit()?;
        let ticket = i64::try_from(acceptance_ticket).context("acceptance ticket overflow")?;
        let tx = self.connection.transaction()?;
        let (state, previous, session, saved_ticket): (u32, Option<u64>, String, Option<i64>) = tx.query_row(
            "SELECT state,publication,session,ticket FROM scans WHERE id=?1", [scan], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))?;
        if state == 1 {
            ensure!(saved_ticket == Some(ticket), "conflicting acceptance replay");
            return previous.context("published scan missing sequence");
        }
        ensure!(state == 0, "retired scan cannot be published");
        let last: Option<i64> = tx.query_row("SELECT ticket FROM sessions WHERE id=?1", [&session], |row| row.get(0)).optional()?;
        ensure!(last.is_none_or(|last| ticket > last), "late acceptance ticket");
        let sequence: i64 = tx.query_row("UPDATE metadata SET sequence=sequence+1 WHERE id=1 AND sequence<9223372036854775807 RETURNING sequence", [], |row| row.get(0))?;
        tx.execute("UPDATE scans SET state=1,publication=?2,ticket=?3 WHERE id=?1", params![scan,sequence,ticket])?;
        tx.execute("INSERT INTO sessions VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET ticket=excluded.ticket", params![session,ticket])?;
        tx.commit()?; Ok(sequence as u64)
    }
    pub fn lookup(&self, paths: &[String], scan: Option<&str>) -> Result<Vec<StoredHit>> {
        ensure!(paths.len() <= 256, "cache lookup path limit");
        if let Some(scan) = scan {
            let state: Option<u32> = self.connection.query_row("SELECT state FROM scans WHERE id=?1", [scan], |row| row.get(0)).optional()?;
            ensure!(state != Some(0), "cache scan publication is pending");
            // A scan still in the bounded writer queue has no database manifest yet.
            ensure!(state.is_some(), "cache scan publication is pending");
        }
        let mut query = self.connection.prepare_cached(LOOKUP)?;
        let mut output = Vec::new(); let mut decoded = 0;
        for path in paths {
            let path = normalize_local_path(path).map_err(anyhow::Error::msg)?;
            let row = query.query_row(params![path,scan], |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,
                row.get::<_, u8>(2)?,row.get::<_, u64>(3)?,row.get::<_, String>(4)?,row.get::<_, u32>(5)?))).optional()?;
            if let Some((payload, scan_id, source, publication, captured_at, policy_version)) = row {
                ensure!(payload.len() < MAX_RECORD_BYTES, "cache record decode limit");
                let record: StoredDirectory = serde_json::from_str(&payload)?;
                ensure!(record.path == path, "cache record path mismatch");
                let hit = StoredHit { record, scan_id, source, publication,
                    captured_at: DateTime::parse_from_rfc3339(&captured_at)?.with_timezone(&Utc), policy_version };
                decoded += hit.checked_bytes()?;
                ensure!(decoded <= 1 << 20, "cache lookup response byte limit");
                output.push(hit);
            }
        }
        Ok(output)
    }
}

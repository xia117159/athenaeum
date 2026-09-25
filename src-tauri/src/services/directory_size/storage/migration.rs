//! One bounded import transaction per idle worker turn. The old file is never rewritten.
use std::{fs::{self, File}, io::{BufRead, BufReader, Read, Seek, SeekFrom}, path::Path};
use anyhow::{Result, ensure};
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};
use super::database::{Database, StoredDirectory};
use super::super::{artifacts, history::HistoricalSize, scan::{DirectorySize, ScanStats}, target::normalize_local_path};
const HEADER: &[u8] = b"{\"directorySizeHistoryVersion\":1}\n";
pub(super) fn recognized(path: &Path) -> bool {
    if identity(path).is_err() { return false; }
    let mut header = vec![0; HEADER.len()];
    File::open(path).and_then(|mut file| file.read_exact(&mut header)).is_ok() && header == HEADER
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Legacy { path: String, size: HistoricalSize }

fn identity(path: &Path) -> Result<String> {
    let path = normalize_local_path(path.to_str().ok_or_else(|| anyhow::anyhow!("invalid legacy path"))?).map_err(anyhow::Error::msg)?;
    let (identity, length) = artifacts::file_fact(&path).ok_or_else(|| anyhow::anyhow!("legacy cache identity unavailable"))?;
    ensure!(length <= 256 << 20, "legacy cache file too large");
    let modified = fs::metadata(&path)?.modified()?.duration_since(std::time::UNIX_EPOCH)?;
    Ok(format!("{:x}", Sha256::digest(format!("{path}\0{:?}\0{length}\0{modified:?}", identity.0))))
}

pub(super) fn step(database: &mut Database, path: &Path) -> Result<bool> {
    if !path.try_exists()? { return Ok(true); }
    database.admit()?;
    let source = identity(path)?;
    let mut reader = BufReader::with_capacity(64 << 10, File::open(path)?);
    let mut line = vec![]; (&mut reader).take(256 << 10).read_until(b'\n', &mut line)?;
    ensure!(line == HEADER, "unsupported legacy cache header");
    let previous: Option<(u64, bool)> = database.connection.query_row("SELECT cursor,complete FROM migrations WHERE source_id=?1", [&source], |row| Ok((row.get(0)?,row.get(1)?))).optional()?;
    if previous.is_some_and(|(_, complete)| complete) {
        ensure!(identity(path)? == source, "legacy source changed before removal");
        let receipt = artifacts::Removal::begin(path); fs::remove_file(path)?; receipt.finish(); return Ok(true);
    }
    let cursor = previous.map_or(HEADER.len() as u64, |(cursor, _)| cursor);
    ensure!(cursor <= reader.get_ref().metadata()?.len(), "legacy cursor outside source");
    reader.seek(SeekFrom::Start(cursor))?;
    let mut records = vec![]; let mut bytes = 0; let mut next = cursor; let mut complete = false;
    while records.len() < 256 && bytes < 768 << 10 {
        line.clear(); let count = (&mut reader).take((256 << 10) + 1).read_until(b'\n', &mut line)?;
        if count == 0 { complete = true; break; }
        ensure!(count <= 256 << 10, "legacy record decode limit");
        let legacy: Legacy = serde_json::from_slice(&line)?;
        let canonical = normalize_local_path(&legacy.path).map_err(anyhow::Error::msg)?;
        ensure!(canonical == legacy.path, "noncanonical legacy record");
        let record = StoredDirectory { path: canonical, artifact_capture: None, size: DirectorySize {
            bytes: legacy.size.bytes, complete: legacy.size.complete, fingerprint: None, created_at: Some(legacy.size.created_at),
            stats: ScanStats { known_bytes: legacy.size.bytes, directories: 1, errors: u64::from(!legacy.size.complete), ..Default::default() },
        } };
        let payload = serde_json::to_string(&record)?;
        ensure!(payload.len() + record.path.len() * 2 < 128 << 10, "legacy cache payload too large");
        let parent = Path::new(&record.path).parent().and_then(Path::to_str).unwrap_or(&record.path).to_string();
        bytes += payload.len() + record.path.len() * 2; next += count as u64;
        records.push((record.path, parent, payload, legacy.size.created_at, legacy.size.cached_at));
    }
    ensure!(identity(path)? == source, "legacy source changed during import");
    database.admit()?;
    let tx = database.connection.transaction()?;
    let sequence: u64 = tx.query_row("UPDATE metadata SET sequence=sequence+1 WHERE id=1 AND sequence<9223372036854775807 RETURNING sequence", [], |row| row.get(0))?;
    // Per-record timestamps stay exact; deterministic IDs make cursor replay idempotent.
    for (index, (path, parent, payload, created, captured)) in records.iter().enumerate() {
        let scan = format!("legacy:{source}:{cursor}:{index}");
        tx.execute("INSERT OR IGNORE INTO scans(id,session,root_path,generation,source,state,ticket,publication,captured_at,policy_version)
            VALUES(?1,?2,?3,'0',0,1,0,?4,?5,1)", params![scan,source,parent,sequence,captured.to_rfc3339()])?;
        tx.execute("INSERT OR IGNORE INTO records(path,scan_id,parent_path,created_at,payload) VALUES(?1,?2,?3,?4,?5)", params![path,scan,parent,created.to_rfc3339(),payload])?;
    }
    tx.execute("INSERT INTO migrations(source_id,cursor,complete) VALUES(?1,?2,?3)
        ON CONFLICT(source_id) DO UPDATE SET cursor=excluded.cursor,complete=excluded.complete", params![source,next,complete])?;
    tx.commit()?;
    if complete {
        ensure!(identity(path)? == source, "legacy source changed before removal");
        let receipt = artifacts::Removal::begin(path); fs::remove_file(path)?; receipt.finish();
    }
    Ok(complete)
}

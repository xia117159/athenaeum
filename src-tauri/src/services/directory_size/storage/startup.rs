//! A bounded startup view, constructed by the sole database writer.
use std::{collections::{HashSet, VecDeque}, fs::{self, File, OpenOptions}, io::{Read, Write}, path::Path};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use super::database::{Database, StoredHit};
use super::super::{artifacts::{Creation, Replacement}, target::normalize_local_path};
use crate::domain::directory_sizes::DirectorySizeViewScope;

pub const MAX_BYTES: usize = 4 << 20;
const MAX_ROWS: usize = 8192;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Summary { version: u32, #[serde(deserialize_with = "bounded_records")] records: Vec<StoredHit> }

fn bounded_records<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Vec<StoredHit>, D::Error> {
    struct Rows;
    impl<'de> serde::de::Visitor<'de> for Rows {
        type Value = Vec<StoredHit>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result { formatter.write_str("a bounded directory startup summary") }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut sequence: A) -> Result<Self::Value, A::Error> {
            use serde::de::Error;
            let mut output = Vec::new(); let mut accounted = 0;
            while let Some(hit) = sequence.next_element::<StoredHit>()? {
                if output.len() >= MAX_ROWS { return Err(A::Error::custom("startup summary row limit")); }
                accounted += hit.checked_bytes().map_err(A::Error::custom)?;
                if accounted > 12 << 20 { return Err(A::Error::custom("startup decoded size limit")); }
                output.push(hit);
            }
            Ok(output)
        }
    }
    deserializer.deserialize_seq(Rows)
}

pub fn load(directory: &Path) -> Result<Vec<StoredHit>> {
    let path = directory.join("startup.json");
    let file = match File::open(&path) { Ok(file) => file, Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]), Err(error) => return Err(error.into()) };
    ensure!(file.metadata()?.is_file() && file.metadata()?.len() <= MAX_BYTES as u64, "startup summary byte limit");
    let mut bytes = Vec::with_capacity(file.metadata()?.len() as usize + 1); file.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= MAX_BYTES, "startup summary grew beyond limit");
    let summary: Summary = serde_json::from_slice(&bytes)?;
    ensure!(summary.version == 1 && summary.records.len() <= MAX_ROWS, "unsupported startup summary");
    Ok(summary.records)
}

impl Database {
    /// Keyset pagination uses records_parent; a deep subtree is never traversed.
    fn summary_children(&self, path: &str, after: &str) -> Result<Vec<String>> {
        let mut query = self.connection.prepare_cached("SELECT DISTINCT r.path FROM records r
            WHERE r.parent_path=?1 AND r.path>?2 AND EXISTS(SELECT 1 FROM scans s WHERE s.id=r.scan_id AND s.state=1)
            ORDER BY r.path LIMIT 1")?;
        let paths = query.query_map(rusqlite::params![path,after], |row| row.get::<_, String>(0))?;
        let mut result = vec![]; let mut bytes = 0;
        for path in paths { let path = path?; bytes += path.len(); ensure!(bytes <= 1 << 20, "summary page limit"); result.push(path); }
        Ok(result)
    }
}

pub(super) fn save(database: &mut Database, directory: &Path, scopes: &[DirectorySizeViewScope], limit: usize) -> Result<()> {
    save_tracked(database, directory, scopes, limit, None)
}

pub(super) fn save_tracked(database: &mut Database, directory: &Path, scopes: &[DirectorySizeViewScope], limit: usize,
    mut observe: Option<&mut dyn FnMut(usize)>) -> Result<()> {
    database.admit()?;
    ensure!(limit <= MAX_BYTES && limit >= 128 && scopes.len() <= 1024, "invalid startup budget");
    let mut lanes = VecDeque::new();
    let mut scopes = scopes.to_vec(); scopes.sort_by_key(|scope| scope.priority);
    for scope in scopes {
        let path = normalize_local_path(&scope.path).map_err(anyhow::Error::msg)?;
        lanes.push_back((path, String::new(), VecDeque::<String>::new(), false));
    }
    let mut bytes = Vec::with_capacity(limit); bytes.extend_from_slice(b"{\"version\":1,\"records\":[");
    let mut seen = HashSet::new(); let mut seen_bytes = 0; let mut count = 0; let mut steps = 0;
    // One record per scope per turn. Bounded missed/duplicate rows cannot spin.
    while let Some((path, mut after, mut page, mut root_done)) = lanes.pop_front() {
        steps += 1; if count >= MAX_ROWS || steps > MAX_ROWS * 4 { break; }
        let next = if !root_done { root_done = true; path.clone() } else {
            if page.is_empty() {
                page.extend(database.summary_children(&path, &after)?);
                if page.is_empty() { continue; }
            }
            let next = page.pop_front().unwrap(); after = next.clone(); next
        };
        if !seen.contains(&next) {
            // Misses also consume path storage. A bounded output file alone
            // cannot bound retained keys or one page per every open scope.
            seen_bytes += next.len() + 128;
            if seen_bytes > 2 << 20 { break; }
            seen.insert(next.clone());
            if let Some(hit) = database.lookup(&[next], None)?.pop() {
                let record = serde_json::to_vec(&hit)?;
                if bytes.len() + record.len() + usize::from(count > 0) + 2 <= limit {
                    if count > 0 { bytes.push(b','); } bytes.extend_from_slice(&record); count += 1;
                } else { continue; }
            }
        }
        lanes.push_back((path, after, page, root_done));
        if let Some(observe) = &mut observe {
            observe(bytes.capacity() + seen.capacity() * 64 + seen.iter().map(String::capacity).sum::<usize>()
                + lanes.capacity() * 128 + lanes.iter().map(|(path, after, page, _)| path.capacity() + after.capacity()
                    + page.capacity() * 32 + page.iter().map(String::capacity).sum::<usize>()).sum::<usize>());
        }
    }
    bytes.extend_from_slice(b"]}");
    let destination = directory.join("startup.json"); let next = directory.join("startup.next");
    for path in [&destination, &next] {
        if let Ok(meta) = fs::symlink_metadata(path) { ensure!(meta.is_file() && !meta.file_type().is_symlink() && meta.len() <= MAX_BYTES as u64, "invalid startup slot"); }
    }
    let receipt = Creation::begin(&next);
    let mut file = OpenOptions::new().write(true).create(true).truncate(true).open(&next)?; receipt.finish();
    file.write_all(&bytes)?; file.sync_all()?; drop(file);
    let receipt = Replacement::begin(&next, &destination);
    install_summary(&next, &destination)?;
    receipt.finish();
    #[cfg(not(windows))]
    File::open(directory)?.sync_all()?;
    Ok(())
}

fn install_summary(next: &Path, destination: &Path) -> Result<()> {
    // Both names are in our private cache directory. Preserve the new file's
    // inherited ACL: ReplaceFile merges the old ACL and emits SECURITY even
    // for our own writes, forcing the recursive watcher to retire.
    #[cfg(windows)] {
        use std::os::windows::ffi::OsStrExt;
        use windows::{core::PCWSTR, Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH}};
        let from: Vec<_> = next.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<_> = destination.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe { MoveFileExW(PCWSTR(from.as_ptr()), PCWSTR(to.as_ptr()), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)?; }
    }
    #[cfg(not(windows))] fs::rename(next, destination)?;
    Ok(())
}

//! Advisory local size history. Never used as a live scan/freshness certificate.
use std::{collections::{BTreeMap, HashMap}, io::{BufWriter, Write}, path::Path, sync::Arc};
#[cfg(test)]
use std::{fs::File, io::{BufRead, BufReader, Read}};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use super::scan::DirectorySize;
#[cfg(test)]
use super::target::normalize_local_path;

const ENTRY_ACCOUNT_BYTES: usize = 384;
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_LINE_BYTES: u64 = 256 * 1024;
const HEADER: &[u8] = b"{\"directorySizeHistoryVersion\":1}\n";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct HistoricalSize {
    pub bytes: u64, pub complete: bool, pub created_at: DateTime<Utc>, pub cached_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_capture: Option<super::artifacts::Capture>,
}
impl HistoricalSize {
    pub fn display_bytes(&self, path: &str, snapshot: &super::artifacts::Snapshot) -> u64 {
        self.bytes.saturating_add(self.artifact_capture.as_ref().map_or(0, |capture| {
            if capture.policy == snapshot.policy { snapshot.contribution(path).bytes } else { capture.contribution.bytes }
        }))
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record { path: String, size: HistoricalSize }
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum HistoryRank {
    #[cfg(test)] Legacy(DateTime<Utc>),
    Stored(u8, u64), Accepted(u64),
}
struct Entry { size: HistoricalSize, order: (usize, u64), rank: HistoryRank }

#[derive(Default)]
pub(super) struct History {
    values: HashMap<Arc<str>, Entry>,
    order: BTreeMap<(usize, u64), Arc<str>>,
    next: u64,
    scopes: HashMap<String, u8>,
    pub bytes: usize,
}
impl History {
    fn priority(&self, path: &str) -> usize {
        let cold = 7 + path.bytes().filter(|byte| matches!(byte, b'/' | b'\\')).count();
        let exact = self.scopes.get(path).map_or(cold, |priority| *priority as usize);
        let direct = Path::new(path).parent().and_then(Path::to_str).and_then(|parent| self.scopes.get(parent))
            .filter(|priority| **priority < 3).map_or(cold, |priority| 3 + *priority as usize);
        exact.min(direct)
    }
    pub fn prioritize(&mut self, scopes: HashMap<String, u8>) {
        if scopes == self.scopes { return; }
        self.scopes = scopes;
        let priorities: Vec<_> = self.values.keys().map(|path| (path.clone(), self.priority(path))).collect();
        self.order.clear();
        for (path, priority) in priorities {
            let entry = self.values.get_mut(&path).unwrap(); entry.order.0 = priority;
            self.order.insert(entry.order, path);
        }
    }
    pub fn get(&self, path: &str) -> Option<&HistoricalSize> { self.values.get(path).map(|entry| &entry.size) }
    pub fn trim(&mut self, budget: usize) {
        while self.bytes > budget {
            let Some((_, path)) = self.order.pop_last() else { break; };
            self.values.remove(&path); self.bytes -= ENTRY_ACCOUNT_BYTES + path.len();
        }
    }
    #[cfg(test)]
    pub fn insert(&mut self, path: Arc<str>, size: HistoricalSize, budget: usize) {
        let rank = HistoryRank::Legacy(size.cached_at);
        self.insert_ranked(path, size, rank, budget);
    }
    pub fn insert_ranked(&mut self, path: Arc<str>, size: HistoricalSize, rank: HistoryRank, budget: usize) {
        if self.values.get(&path).is_some_and(|old| old.rank >= rank) { return; }
        let depth = self.priority(&path);
        let cost = ENTRY_ACCOUNT_BYTES + path.len();
        if cost > budget { return; }
        // Decide admission before changing any existing display record. A
        // rejected long row must not first evict a smaller cold row and then
        // discover that the remaining high-priority rows cannot yield space.
        let replaced = self.values.get(&path).map_or(0, |_| cost);
        let needed = self.bytes.saturating_sub(replaced).saturating_add(cost).saturating_sub(budget);
        let mut reclaimed = 0;
        let mut victims = Vec::new();
        for ((old_priority, _), old_path) in self.order.iter().rev() {
            if reclaimed >= needed || *old_priority < depth { break; }
            if old_path == &path { continue; }
            reclaimed += ENTRY_ACCOUNT_BYTES + old_path.len();
            victims.push(old_path.clone());
        }
        if reclaimed < needed { return; }
        if let Some(old) = self.values.remove(&path) {
            self.order.remove(&old.order); self.bytes -= cost;
        }
        for path in victims {
            let old = self.values.remove(&path).unwrap();
            self.order.remove(&old.order); self.bytes -= ENTRY_ACCOUNT_BYTES + path.len();
        }
        self.next += 1; let order = (depth, u64::MAX - self.next);
        self.bytes += cost; self.order.insert(order, path.clone()); self.values.insert(path, Entry { size, order, rank });
    }
    pub fn capture_ranked(&mut self, path: Arc<str>, size: &DirectorySize, cached_at: DateTime<Utc>, rank: HistoryRank,
        artifact_capture: Option<super::artifacts::Capture>, budget: usize) {
        if let Some(created_at) = size.created_at.filter(|_| size.visited()) {
            self.insert_ranked(path, HistoricalSize { bytes: size.bytes, complete: size.complete, created_at, cached_at, artifact_capture }, rank, budget);
        }
    }
    #[cfg(test)]
    pub fn load(path: &Path, budget: usize) -> anyhow::Result<Self> {
        let file = match File::open(path) {
            Ok(file) => file, Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(error) => return Err(error.into()),
        };
        anyhow::ensure!(file.metadata()?.len() <= MAX_FILE_BYTES, "directory size history file exceeds limit");
        let mut reader = BufReader::with_capacity(64 * 1024, file);
        let mut line = Vec::new();
        (&mut reader).take(MAX_LINE_BYTES + 1).read_until(b'\n', &mut line)?;
        anyhow::ensure!(line == HEADER, "unsupported directory size history schema");
        let mut history = Self::default(); let mut consumed = line.len() as u64;
        loop {
            line.clear();
            let length = (&mut reader).take(MAX_LINE_BYTES + 1).read_until(b'\n', &mut line)?;
            if length == 0 { break; }
            consumed += length as u64;
            anyhow::ensure!(length as u64 <= MAX_LINE_BYTES && consumed <= MAX_FILE_BYTES, "directory size history decode limit");
            let record: Record = serde_json::from_slice(&line)?;
            anyhow::ensure!(normalize_local_path(&record.path).ok().as_deref() == Some(record.path.as_str()), "noncanonical history path");
            history.insert(Arc::from(record.path), record.size, budget);
        }
        Ok(history)
    }
    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        crate::services::atomic_file::write_atomically_stream(path, |file| {
            let mut writer = BufWriter::with_capacity(64 * 1024, file);
            writer.write_all(HEADER)?; let mut written = HEADER.len() as u64;
            // Shallow paths survive first if the serialized file reaches its independent cap.
            for path in self.order.values() {
                let value = &self.values[path].size;
                let mut line = serde_json::to_vec(&Record { path: path.to_string(), size: value.clone() })?;
                line.push(b'\n');
                if line.len() as u64 > MAX_LINE_BYTES || written + line.len() as u64 > MAX_FILE_BYTES { continue; }
                writer.write_all(&line)?; written += line.len() as u64;
            }
            writer.flush()?; Ok(())
        })
    }
}

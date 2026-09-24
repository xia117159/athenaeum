//! Advisory local size history. Never used as a live scan/freshness certificate.
use std::{collections::{BTreeMap, HashMap}, fs::File, io::{BufRead, BufReader, BufWriter, Read, Write}, path::Path, sync::Arc};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use super::{scan::DirectorySize, target::normalize_local_path};

const ENTRY_ACCOUNT_BYTES: usize = 384;
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_LINE_BYTES: u64 = 256 * 1024;
const HEADER: &[u8] = b"{\"directorySizeHistoryVersion\":1}\n";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct HistoricalSize {
    pub bytes: u64, pub complete: bool, pub created_at: DateTime<Utc>, pub cached_at: DateTime<Utc>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record { path: String, size: HistoricalSize }
struct Entry { size: HistoricalSize, order: (usize, u64) }

#[derive(Default)]
pub(super) struct History {
    values: HashMap<Arc<str>, Entry>,
    order: BTreeMap<(usize, u64), Arc<str>>,
    next: u64,
    pub bytes: usize,
}
impl History {
    pub fn get(&self, path: &str) -> Option<&HistoricalSize> { self.values.get(path).map(|entry| &entry.size) }
    pub fn trim(&mut self, budget: usize) {
        while self.bytes > budget {
            let Some((_, path)) = self.order.pop_last() else { break; };
            self.values.remove(&path); self.bytes -= ENTRY_ACCOUNT_BYTES + path.len();
        }
    }
    pub fn insert(&mut self, path: Arc<str>, size: HistoricalSize, budget: usize) {
        if self.get(&path).is_some_and(|old| old.cached_at > size.cached_at) { return; }
        let depth = path.bytes().filter(|byte| matches!(byte, b'/' | b'\\')).count();
        let cost = ENTRY_ACCOUNT_BYTES + path.len();
        if cost > budget { return; }
        if let Some(old) = self.values.remove(&path) {
            self.order.remove(&old.order); self.bytes -= cost;
        }
        while self.bytes.saturating_add(cost) > budget {
            if self.order.last_key_value().is_some_and(|((old_depth, _), _)| *old_depth < depth) { return; }
            let Some((_, old)) = self.order.pop_last() else { return; };
            self.values.remove(&old); self.bytes -= ENTRY_ACCOUNT_BYTES + old.len();
        }
        self.next += 1; let order = (depth, self.next);
        self.bytes += cost; self.order.insert(order, path.clone()); self.values.insert(path, Entry { size, order });
    }
    pub fn capture(&mut self, path: Arc<str>, size: &DirectorySize, cached_at: DateTime<Utc>, budget: usize) {
        if let Some(created_at) = size.created_at.filter(|_| size.visited()) {
            self.insert(path, HistoricalSize { bytes: size.bytes, complete: size.complete, created_at, cached_at }, budget);
        }
    }
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

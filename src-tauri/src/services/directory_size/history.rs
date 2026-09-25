//! Advisory local size history. Never used as a live scan/freshness certificate.
use std::{collections::{BTreeMap, HashMap}, path::Path, sync::Arc};
use chrono::{DateTime, Utc};
use super::scan::DirectorySize;

const ENTRY_ACCOUNT_BYTES: usize = 384;

#[derive(Clone)]
pub(super) struct HistoricalSize {
    pub bytes: u64, pub complete: bool, pub created_at: DateTime<Utc>, pub cached_at: DateTime<Utc>,
    pub artifact_capture: Option<super::artifacts::Capture>,
}
impl HistoricalSize {
    pub fn display_bytes(&self, path: &str, snapshot: &super::artifacts::Snapshot) -> u64 {
        self.bytes.saturating_add(self.artifact_capture.as_ref().map_or(0, |capture| {
            if capture.policy == snapshot.policy { snapshot.contribution(path).bytes } else { capture.contribution.bytes }
        }))
    }
}
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum HistoryRank {
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
}

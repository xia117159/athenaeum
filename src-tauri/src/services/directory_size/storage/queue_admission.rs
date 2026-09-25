//! Bounded row admission preserves control order and the useful end of a DFS scan.
use super::*;
use std::{cmp::Reverse, collections::HashSet, path::Path};

pub(super) fn row_cost(row: &StoredDirectory) -> usize {
    640 + row.path.capacity() + row.size.fingerprint.as_ref().map_or(0, String::capacity)
        + row.artifact_capture.as_ref().map_or(0, |capture| capture.policy.capacity())
}

impl Queue {
    pub(super) fn rejected(&mut self, records: usize, reason: &str) {
        self.dropped_records += records as u64;
        self.last_error = Some(reason.into()); self.lost_write = Some(reason.into());
    }
    pub(super) fn priority(&self, header: &ScanHeader, row: &StoredDirectory) -> u8 {
        let path = super::super::super::target::normalize_local_path(&row.path).unwrap_or_else(|_| row.path.clone());
        let root = super::super::super::target::normalize_local_path(&header.root).unwrap_or_else(|_| header.root.clone());
        if let Some(scope) = self.views.iter().find(|scope| scope.path == path) { return scope.priority; }
        if path == root { return 2; }
        let parent = Path::new(&path).parent();
        if let Some(scope) = self.views.iter().find(|scope| parent == Some(Path::new(&scope.path))) { return 3 + scope.priority; }
        if self.protection.hot.contains(&path) { return 6; }
        if parent == Some(Path::new(&root)) { return 7; }
        8
    }
    pub(super) fn admit(&mut self, incoming: &mut Write) -> bool {
        let cost = incoming.cost();
        let mut excess = self.bytes.saturating_add(cost).saturating_sub(self.max_bytes);
        if incoming.data() {
            excess = excess.max(self.data_bytes.saturating_add(cost).saturating_sub(self.max_bytes.saturating_sub(self.reserved)));
        }
        if excess == 0 { return true; }
        self.capacity_pressure = true;
        let incoming_index = self.writes.len();
        let mut candidates = Vec::new();
        let mut children = Vec::new();
        for (index, work) in self.writes.iter().map(|pending| &pending.work).chain(std::iter::once(&*incoming)).enumerate() {
            if let Write::Append(header, rows) = work {
                for (row_index, row) in rows.iter().enumerate() {
                    let priority = self.priority(header, row);
                    if (3..=5).contains(&priority) { children.push((row.path.as_str(), index, row_index)); }
                    candidates.push((Reverse(priority), Reverse(0), Reverse(index), row_index, row_cost(row)));
                }
            }
        }
        children.sort_unstable();
        let mut positions = HashMap::new(); let mut parent = None; let mut previous = None; let mut position = 0;
        for (path, index, row_index) in children {
            let next_parent = Path::new(path).parent();
            if next_parent != parent { parent = next_parent; previous = None; position = 0; }
            if previous.is_some_and(|previous| previous != path) { position += 1; }
            positions.insert((index, row_index), position); previous = Some(path);
        }
        for (_, slot, Reverse(index), row_index, _) in &mut candidates {
            *slot = Reverse(positions.get(&(*index, *row_index)).copied().unwrap_or(0));
        }
        // At equal priority keep already queued rows. A rejected append must
        // not displace an older useful batch merely to be rejected itself.
        candidates.sort_unstable();
        let mut removed = HashSet::new(); let mut incoming_removed = 0;
        for (_, _, Reverse(index), row_index, bytes) in candidates {
            if excess == 0 { break; }
            removed.insert((index, row_index)); excess = excess.saturating_sub(bytes);
            incoming_removed += usize::from(index == incoming_index);
        }
        if excess != 0 || incoming.data() && incoming_removed == incoming.records() { return false; }
        let mut dropped = 0;
        for (index, pending) in self.writes.iter_mut().enumerate() {
            if let Write::Append(_, rows) = &mut pending.work {
                let before = rows.len(); let mut row_index = 0;
                rows.retain(|_| { let keep = !removed.contains(&(index, row_index)); row_index += 1; keep });
                if before == rows.len() { continue; }
                rows.shrink_to_fit(); let count = before - rows.len();
                dropped += count; self.records -= count;
                let cost = pending.work.cost(); self.bytes -= pending.cost - cost; self.data_bytes -= pending.cost - cost;
                pending.cost = cost;
            }
        }
        if let Write::Append(_, rows) = incoming {
            let mut index = 0;
            rows.retain(|_| { let keep = !removed.contains(&(incoming_index, index)); index += 1; keep });
            rows.shrink_to_fit(); dropped += incoming_removed;
        }
        if dropped > 0 { self.rejected(dropped, "cache queue capacity: lower-priority records were discarded"); }
        true
    }
}

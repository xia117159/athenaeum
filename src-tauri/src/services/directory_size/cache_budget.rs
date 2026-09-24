use super::*;
use std::{cmp::Reverse, collections::HashSet};
use super::super::scan::NODE_ACCOUNT_BYTES;

fn relative_depth(root: &str, path: &str) -> usize {
    path.strip_prefix(root.trim_end_matches(['/', '\\'])).unwrap_or(path)
        .bytes().filter(|byte| matches!(byte, b'/' | b'\\')).count()
}

impl Core {
    #[cfg(test)]
    pub(crate) fn allocated_detail_slots(&self) -> usize {
        self.roots.values().filter_map(|root| root.result.as_ref()).map(|result| result.directories.capacity()).sum()
    }

    /// Reclaim only enough detail space, deepest first across existing and new
    /// results. Protected roots/leases retain their aggregates; rename guards
    /// retain their entire candidate data. Arc candidates do not copy strings.
    pub(super) fn compact_live_details(&mut self, incoming: &mut ScanResult, target: &ScanTarget) {
        let mut excess = self.live_cache_bytes().saturating_add(incoming.accounted_bytes).saturating_sub(self.limits.cache_bytes);
        if excess == 0 { return; }
        let mut roots: Vec<_> = self.roots.iter().filter(|(_, root)| root.guard.is_none() && root.result.is_some())
            .map(|(key, root)| (root.last_used, key.clone())).collect();
        roots.sort(); // Equal-depth details from older results are evicted first.
        let mut candidates: Vec<(Reverse<usize>, usize, Arc<str>)> = Vec::new();
        let mut collect = |index, key: &str, path: &str, result: &ScanResult| {
            let protected: HashSet<_> = std::iter::once(path).chain(self.leases.values()
                .filter(|lease| lease.key == key).map(|lease| lease.scope.path.as_str())).collect();
            for candidate in result.directories.keys().filter(|path| !protected.contains(path.as_ref())) {
                candidates.push((Reverse(relative_depth(path, candidate)), index, candidate.clone()));
            }
        };
        for (index, (_, key)) in roots.iter().enumerate() {
            let root = &self.roots[key];
            collect(index, key, &root.target.path, root.result.as_ref().unwrap());
        }
        collect(roots.len(), &target.key, &target.path, incoming);
        candidates.sort_unstable();
        let mut compacted = vec![false; roots.len() + 1];
        for (_, index, path) in candidates {
            if excess == 0 { break; }
            let result = if index == roots.len() { &mut *incoming }
                else { self.roots.get_mut(&roots[index].1).unwrap().result.as_mut().unwrap() };
            if result.directories.remove(&path).is_some() {
                compacted[index] = true;
                let cost = NODE_ACCOUNT_BYTES + path.len();
                result.accounted_bytes = result.accounted_bytes.saturating_sub(cost);
                excess = excess.saturating_sub(cost);
            }
        }
        // Removing entries alone retains the old bucket allocation. Reclaim it
        // too, so the remaining record count still bounds the retained memory.
        for (index, changed) in compacted.into_iter().enumerate() {
            if !changed { continue; }
            let result = if index == roots.len() { &mut *incoming }
                else { self.roots.get_mut(&roots[index].1).unwrap().result.as_mut().unwrap() };
            result.directories.shrink_to_fit();
        }
    }
}

use super::*;

impl Core {
    pub(super) fn capture_live_history(&mut self, key: &str) {
        if !self.history_enabled { return; }
        let budget = self.limits.cache_bytes.saturating_sub(self.live_cache_bytes());
        let Some(root) = self.roots.get(key).filter(|root| root.target.profile.is_none()) else { return; };
        let (Some(result), Some(at)) = (&root.result, root.captured_at) else { return; };
        for (path, size) in &result.directories { self.history.capture(path.clone(), size, at, budget); }
    }
    pub(super) fn retire_result(&mut self, key: &str) {
        let Some(root) = self.roots.get_mut(key) else { return; };
        let Some(result) = root.result.take() else { return; };
        if !self.history_enabled || root.target.profile.is_some() { return; }
        let Some(at) = root.captured_at else { return; };
        // Transfer records incrementally: the unconsumed result still occupies memory.
        let mut remaining = result.accounted_bytes;
        let base = self.live_cache_bytes();
        for (path, size) in result.directories {
            remaining = remaining.saturating_sub(super::super::scan::NODE_ACCOUNT_BYTES + path.len());
            let budget = self.limits.cache_bytes.saturating_sub(base).saturating_sub(remaining);
            self.history.trim(budget);
            self.history.capture(path, &size, at, budget);
        }
    }
    pub(super) fn keep_result_paths(result: &mut ScanResult, paths: &[&str]) {
        let mut directories = HashMap::new();
        for path in paths { if let Some((path, value)) = result.directories.remove_entry(*path) { directories.insert(path, value); } }
        result.accounted_bytes = directories.keys().map(|path| super::super::scan::NODE_ACCOUNT_BYTES + path.len()).sum();
        result.directories = directories;
    }
    pub(super) fn compact_live_details(&mut self) {
        for (key, root) in &mut self.roots {
            if root.guard.is_some() { continue; }
            let paths: Vec<_> = std::iter::once(root.target.path.as_str()).chain(self.leases.values()
                .filter(|lease| lease.key == *key).map(|lease| lease.scope.path.as_str())).collect();
            if let Some(result) = &mut root.result { Self::keep_result_paths(result, &paths); }
        }
    }
}

use super::*;

impl Core {
    pub(super) fn capture_live_history(&mut self, key: &str) {
        if !self.history_enabled { return; }
        self.history.prioritize(self.detail_scopes());
        let budget = self.limits.cache_bytes.saturating_sub(self.live_cache_bytes());
        let Some(root) = self.roots.get(key).filter(|root| root.target.profile.is_none()) else { return; };
        let (Some(result), Some(at)) = (&root.result, root.captured_at) else { return; };
        let rank = super::super::history::HistoryRank::Accepted(root.acceptance);
        for (path, size) in &result.directories { self.history.capture_ranked(path.clone(), size, at, rank, self.artifacts.capture(path), budget); }
    }
    pub(super) fn retire_result(&mut self, key: &str) {
        self.history.prioritize(self.detail_scopes());
        let Some(root) = self.roots.get_mut(key) else { return; };
        let Some(result) = root.result.take() else { return; };
        if !self.history_enabled || root.target.profile.is_some() { return; }
        let Some(at) = root.captured_at else { return; };
        let rank = super::super::history::HistoryRank::Accepted(root.acceptance);
        // Transfer records incrementally: the unconsumed result still occupies memory.
        let mut remaining = result.accounted_bytes;
        let base = self.live_cache_bytes();
        for (path, size) in result.directories {
            remaining = remaining.saturating_sub(super::super::scan::NODE_ACCOUNT_BYTES + path.len());
            let budget = self.limits.cache_bytes.saturating_sub(base).saturating_sub(remaining);
            self.history.trim(budget);
            let capture = self.artifacts.capture(&path);
            self.history.capture_ranked(path, &size, at, rank, capture, budget);
        }
    }
    pub fn install_stored(&mut self, hits: &[super::super::storage::StoredHit]) {
        if self.stopped { return; }
        self.history.prioritize(self.detail_scopes());
        let budget = self.limits.cache_bytes.saturating_sub(self.live_cache_bytes());
        let mut changed = false;
        for hit in hits {
            let previous = self.history.get(&hit.record.path).map(|size| (size.bytes, size.created_at, size.cached_at));
            self.history.capture_ranked(Arc::from(hit.record.path.as_str()), &hit.record.size, hit.captured_at,
                super::super::history::HistoryRank::Stored(hit.source, hit.publication), hit.record.artifact_capture.clone(), budget);
            changed |= previous != self.history.get(&hit.record.path).map(|size| (size.bytes, size.created_at, size.cached_at));
        }
        if changed {
            self.cache_revision += 1;
            for lease in self.leases.values().filter(|lease| lease.scope.profile.is_none()) {
                if hits.iter().any(|hit| std::path::Path::new(&hit.record.path).parent() == Some(std::path::Path::new(&lease.scope.path))) {
                    self.cache_events.insert((lease.owner.label.clone(), lease.scope.path.clone()), DirectorySizeCacheUpdated {
                        path: lease.scope.path.clone(), revision: self.cache_revision.to_string(), owner_epoch: lease.owner.epoch.to_string(),
                    });
                }
            }
        }
    }
}

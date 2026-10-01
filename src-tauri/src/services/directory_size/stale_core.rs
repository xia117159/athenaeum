use super::*;
use super::super::{forget::ForgetItem, stale::parent, watch::WatchChanges};

impl Core {
    #[cfg(test)]
    pub(crate) fn forgotten_paths(&self) -> impl Iterator<Item = (&str, bool, i64)> { self.forgotten.entries() }

    pub(super) fn apply_changes(&mut self, key: &str, changes: WatchChanges, now: u64) {
        let Some(root) = self.roots.get_mut(key) else { return; };
        if root.running.is_some() {
            root.pending.add_changes(&root.target.path, &changes);
            if changes.lost { root.watch = None; root.identity = None; root.last_identity_ok = None;
                root.reason = Some("扫描期间目录变化过多或实时监控失效，结果可能已过期，可重新计算".into()); }
            return;
        }
        let Some(result) = root.result.as_ref() else { return; };
        let before = root.stale.clone();
        // Concrete events still forget their paths when the same batch loses monitoring.
        root.stale.apply_events(&changes, &root.target.path, result);
        let items = root.stale.additions(&before, &root.target.path);
        if changes.lost { root.stale.all = true; root.watch = None; root.identity = None; root.last_identity_ok = None;
            root.reason = Some("目录实时监控已失效，结果可能已过期".into()); }
        if root.stale != before { root.stale_revision += 1; }
        self.forget_paths(items);
        if !self.has_leases(key) { self.retire_result(key); self.roots.remove(key); return; }
        self.schedule_stale_auto(key, now); self.emit(key);
    }
    pub(super) fn finish_pending_changes(&mut self, key: &str, now: u64) {
        let root = self.roots.get_mut(key).unwrap();
        let mut pending = std::mem::take(&mut root.pending);
        let all = pending.all; pending.all = false;
        let before = root.stale.clone(); root.stale = Default::default();
        if let Some(result) = &root.result { root.stale.apply(&pending, &root.target.path, result); }
        let items = root.stale.additions(&Default::default(), &root.target.path);
        if all { root.stale.all = true; }
        if before != root.stale { root.stale_revision += 1; }
        for lease in self.leases.values_mut().filter(|lease| lease.key == key) {
            if root.result.as_ref().is_some_and(|result| result.directories.contains_key(lease.scope.path.as_str())) { lease.unavailable = false; }
        }
        self.forget_paths(items); self.schedule_stale_auto(key, now);
    }
    pub(super) fn accept_advisory_result(&mut self, key: &str) {
        let root = self.roots.get_mut(key).unwrap();
        if root.result.is_none() || root.watch.is_some() || root.target.profile.is_some() || root.identity_expired { return; }
        if !root.stale.all { root.stale.all = true; root.stale_revision += 1; }
        root.phase = DirectorySizePhase::Stale;
        root.reason = Some("实时监控不可用，结果可能已过期，可重新计算".into());
        self.emit(key);
    }
    pub(super) fn stale_readable(&self, lease: &Lease, root: &Root) -> bool {
        root.phase == DirectorySizePhase::Stale && root.watch.is_none() && root.result.is_some()
            && !root.identity_expired && root.guard.is_none() && lease.verified && !lease.detached && !lease.unavailable
            && lookup_path(&root.target, &lease.scope.path).is_ok()
    }
    fn forget_paths(&mut self, mut items: Vec<ForgetItem>) {
        if items.is_empty() { return; }
        let mut ancestors = std::collections::HashSet::new();
        for item in &items {
            let mut at = parent(item.path());
            while let Some(path) = at { ancestors.insert(path.to_owned()); at = parent(path); }
        }
        items.extend(ancestors.into_iter().map(ForgetItem::Exact));
        let cutoff = chrono::Utc::now().timestamp_micros();
        self.forgotten.insert(&items, cutoff);
        self.history.forget(&self.forgotten);
        if let Some(store) = &self.storage { for batch in items.chunks(256) { store.forget(batch.to_vec(), cutoff); } }
        self.cache_revision += 1;
        // Like `install_stored`: only listings that display a forgotten entry re-query.
        let parents: std::collections::HashSet<_> = items.iter().filter_map(|item| parent(item.path())).collect();
        for lease in self.leases.values().filter(|lease| lease.scope.profile.is_none() && parents.contains(lease.scope.path.as_str())) {
            self.cache_events.insert((lease.owner.label.clone(), lease.scope.path.clone()), DirectorySizeCacheUpdated {
                path: lease.scope.path.clone(), revision: self.cache_revision.to_string(), owner_epoch: lease.owner.epoch.to_string(),
            });
        }
    }
}

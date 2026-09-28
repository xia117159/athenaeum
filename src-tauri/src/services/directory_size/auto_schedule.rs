use super::*;

impl Core {
    pub(super) fn direct_auto(&self, key: &str) -> bool {
        self.leases.values().any(|lease| lease.mode == LeaseMode::Auto && lease.key == key && lease.scope.key == key && !lease.detached)
    }
    pub(super) fn scan_due(&self, key: &str, now: u64, quiet: u64, explicit: bool) -> u64 {
        let mut due = now.saturating_add(quiet).max(self.roots.get(key).and_then(|root| root.last_start).map_or(now, |last| last.saturating_add(2000)));
        if !explicit {
            for last in [self.auto_starts.get(key), self.auto_finished.get(key)].into_iter().flatten() { due = due.max(last.saturating_add(30_000)); }
        }
        due
    }
    pub(super) fn schedule_stale_auto(&mut self, key: &str, now: u64) {
        let Some(root) = self.roots.get(key) else { return; };
        if !matches!(root.phase, DirectorySizePhase::Complete | DirectorySizePhase::Partial) || root.identity_expired { return; }
        let leases: Vec<_> = self.leases.iter().filter(|(_, lease)| lease.key == key && lease.mode == LeaseMode::Auto
            && !lease.detached && root.stale.contains(&lease.scope.path)).map(|(id, lease)| (id.clone(), lease.scope.key.clone())).collect();
        for (id, scope) in leases {
            let due = self.scan_due(&scope, now, 500, false);
            let at = if scope == key { &mut self.roots.get_mut(key).unwrap().auto_rescan_at }
                else { &mut self.leases.get_mut(&id).unwrap().auto_reroot_at };
            *at = Some(at.map_or(due, |old| old.min(due)));
        }
    }
    pub(super) fn tick_auto(&mut self, now: u64) {
        self.auto_starts.retain(|key, last| now.saturating_sub(*last) <= 30_000 || self.roots.get(key).is_some_and(|root| root.running.is_some()));
        self.auto_finished.retain(|key, last| now.saturating_sub(*last) <= 30_000 || self.roots.get(key).is_some_and(|root| root.running.is_some()));
        let pending: Vec<_> = self.roots.iter().filter_map(|(key, root)| root.auto_rescan_at.map(|at| (key.clone(), at))).collect();
        for (key, at) in pending {
            if !self.direct_auto(&key) { self.roots.get_mut(&key).unwrap().auto_rescan_at = None; }
            else if now >= at { self.invalidate_with_intent(&key, now, true, false, 0, false, "目录已变化，自动重新计算"); }
        }
        let reroots: Vec<_> = self.leases.iter().filter(|(_, lease)| lease.auto_reroot_at.is_some_and(|at| now >= at))
            .map(|(id, _)| id.clone()).collect();
        for id in reroots {
            let key = self.leases[&id].key.clone();
            self.leases.get_mut(&id).unwrap().auto_reroot_at = None;
            if self.active_scan(&key) { continue; }
            self.reroot_auto(&id, 0, now);
        }
    }
    pub(super) fn reroot_invalidated_auto(&mut self, key: &str, now: u64) {
        let ids: Vec<_> = self.leases.iter().filter(|(_, lease)| lease.key == key && lease.scope.key != key
            && lease.mode == LeaseMode::Auto && !lease.detached).map(|(id, _)| id.clone()).collect();
        for id in ids { self.reroot_auto(&id, 500, now); }
    }
    /// `quiet`: 0 once a deferred reroot has already waited, 500 when an invalidated parent forces it.
    pub(super) fn reroot_auto(&mut self, id: &str, quiet: u64, now: u64) {
        let Some(lease) = self.leases.get(id) else { return; };
        let scope = lease.scope.clone(); let old_key = lease.key.clone();
        if let Err(error) = self.prepare_intent_root(&scope.key, &scope, DirectorySizeIntent::Auto, quiet, now) {
            self.leases.get_mut(id).unwrap().disk_error = Some(error); self.emit(&old_key); return;
        }
        let lease = self.leases.get_mut(id).unwrap();
        lease.key = scope.key.clone(); lease.verified = false; lease.disk_wait = None; lease.disk_error = None;
        lease.unavailable = false; lease.auto_reroot_at = None;
        self.apply_intent(&scope.key, DirectorySizeIntent::Auto, false, quiet, now);
        self.emit(&scope.key);
    }
}

use super::*;
use std::{cmp::Reverse, collections::HashSet, path::Path};
use super::super::scan::NODE_ACCOUNT_BYTES;

fn relative_depth(root: &str, path: &str) -> usize {
    path.strip_prefix(root.trim_end_matches(['/', '\\'])).unwrap_or(path)
        .bytes().filter(|byte| matches!(byte, b'/' | b'\\')).count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::super::scan::DirectorySize;
    fn result(paths: &[String]) -> ScanResult {
        ScanResult { directories: paths.iter().map(|path| (Arc::from(path.as_str()), DirectorySize {
            bytes: 60, complete: true, created_at: None, fingerprint: None, stats: ScanStats::default(),
        })).collect(), stats: ScanStats::default(), outcome: ScanOutcome::Complete,
            accounted_bytes: paths.iter().map(|path| NODE_ACCOUNT_BYTES + path.len()).sum(), message: None }
    }
    fn target(path: &str) -> ScanTarget { normalize_target(&DirectorySizeTarget::Local { path: path.into() }, None, 0).unwrap() }
    #[test]
    fn size_memory_recently_queried_deep_detail_survives_cold_shallow_admission() {
        let mut core = Core::default(); core.open_owner("main");
        core.subscribe(core.owner_token("main").unwrap(), SubscribeDirectorySizesRequest { consumer_id: "main-view".into(),
            target: DirectorySizeTarget::Local { path: "C:\\root".into() }, refresh: false, handoff: None }, None, 0).unwrap();
        let job = core.take_jobs(0).remove(0); let scope = job.target.clone();
        let hot = format!("{}\\deep\\view\\hot", scope.path);
        core.finished(&job, result(&[scope.path.clone(), format!("{}\\cold\\detail", scope.path), hot.clone()]), None, 1);
        core.lookup("main", LookupDirectorySizesRequest { consumer_id: "main-view".into(), generation: job.generation, paths: vec![hot.clone()] }, 2).unwrap();
        core.limits.cache_bytes = core.live_cache_bytes();
        let mut incoming = result(&[format!("{}\\cold\\incoming", scope.path)]);
        core.compact_live_details(&mut incoming, &scope);
        assert!(core.roots[&scope.key].result.as_ref().unwrap().directories.contains_key(hot.as_str()), "a recent deep lookup must outrank cold shallow details");
    }
    #[test]
    fn size_memory_rejected_admission_does_not_remove_existing_details() {
        let mut core = Core::default();
        let scope = target("C:\\root"); let cold = format!("{}\\cold\\deep", scope.path);
        let mut root = Root::new(scope.clone(), 1, 0); root.result = Some(result(&[scope.path.clone(), cold.clone()]));
        core.roots.insert(scope.key.clone(), root); core.limits.cache_bytes = core.live_cache_bytes();
        let mut incoming = result(&[format!("{}\\{}", scope.path, "x".repeat(2000))]);
        core.compact_live_details(&mut incoming, &scope);
        assert!(core.roots[&scope.key].result.as_ref().unwrap().directories.contains_key(cold.as_str()),
            "a rejected incoming detail must not evict old display data first");
        assert!(incoming.directories.is_empty() || core.live_cache_bytes() + incoming.accounted_bytes > core.limits.cache_bytes);
    }
    #[test]
    fn size_memory_preserves_a_first_page_for_each_open_view() {
        let mut core = Core::default(); core.open_owner("main");
        let scope = target("C:\\root"); let first = format!("{}\\first", scope.path); let second = format!("{}\\second", scope.path);
        core.views.update(&core.owner_token("main").unwrap(), UpdateDirectorySizeViewsRequest { revision: 1, owner_epoch: Some(core.owner_token("main").unwrap().epoch.to_string()), shutdown_nonce: None,
            scopes: vec![DirectorySizeViewScope { path: first.clone(), priority: 0 }, DirectorySizeViewScope { path: second.clone(), priority: 0 }] }).unwrap();
        let mut root = Root::new(scope.clone(), 1, 0);
        let mut paths = vec![scope.path.clone(), first.clone(), second.clone()];
        paths.extend((0..20).map(|index| format!("{first}\\{index:02}")));
        root.result = Some(result(&paths)); core.roots.insert(scope.key.clone(), root);
        core.limits.cache_bytes = core.live_cache_bytes();
        let mut incoming = result(&(0..16).map(|index| format!("{second}\\{index:02}")).collect::<Vec<_>>());
        core.compact_live_details(&mut incoming, &scope);
        let count = |view: &str| core.roots[&scope.key].result.as_ref().unwrap().directories.keys().chain(incoming.directories.keys())
            .filter(|path| Path::new(path.as_ref()).parent() == Some(Path::new(view))).count();
        assert!(count(&first) >= 9 && count(&second) >= 9, "one view must not consume the other's first page: {} / {}", count(&first), count(&second));
        assert!(core.live_cache_bytes() + incoming.accounted_bytes <= core.limits.cache_bytes);
    }
}

impl Core {
    pub(super) fn remember_paths(&mut self, paths: &[String]) {
        for path in paths {
            self.recent_paths.retain(|old| old.as_ref() != path); self.recent_paths.push_back(Arc::from(path.as_str()));
        }
        let mut bytes = self.recent_paths.iter().map(|path| path.len() + 64).sum::<usize>();
        while self.recent_paths.len() > 512 || bytes > 1 << 20 {
            if let Some(path) = self.recent_paths.pop_front() { bytes -= path.len() + 64; }
        }
    }
    #[cfg(test)]
    pub(crate) fn allocated_detail_slots(&self) -> usize {
        self.roots.values().filter_map(|root| root.result.as_ref()).map(|result| result.directories.capacity()).sum()
    }

    pub(super) fn detail_scopes(&self) -> HashMap<String, u8> {
        let mut scopes: HashMap<_, _> = self.views.scopes().iter().map(|scope| (scope.path.clone(), scope.priority)).collect();
        for lease in self.leases.values().filter(|lease| !lease.detached && lease.scope.profile.is_none()) {
            scopes.entry(lease.scope.path.clone()).and_modify(|priority| *priority = 0).or_insert(0);
        }
        for path in &self.recent_paths { scopes.entry(path.to_string()).or_insert(6); }
        scopes
    }

    /// Reclaim cold details before the direct children of open views. Priority
    /// is bounded admission, not a pin: when even visible details cannot fit,
    /// older pages yield to incoming pages while root aggregates stay intact.
    /// Reclaim only enough detail space across existing and new
    /// results. Protected roots/leases retain their aggregates; rename guards
    /// retain their entire candidate data. Arc candidates do not copy strings.
    pub(super) fn compact_live_details(&mut self, incoming: &mut ScanResult, target: &ScanTarget) {
        let mut excess = self.live_cache_bytes().saturating_add(incoming.accounted_bytes).saturating_sub(self.limits.cache_bytes);
        if excess == 0 { return; }
        let mut roots: Vec<_> = self.roots.iter().filter(|(_, root)| root.guard.is_none() && root.result.is_some())
            .map(|(key, root)| (root.last_used, key.clone())).collect();
        roots.sort(); // Equal-depth details from older results are evicted first.
        let scopes = self.detail_scopes();
        let mut candidates: Vec<(Reverse<u8>, Reverse<usize>, usize, Arc<str>)> = Vec::new();
        let mut collect = |index, key: &str, path: &str, result: &ScanResult| {
            let protected: HashSet<_> = std::iter::once(path).chain(self.leases.values()
                .filter(|lease| lease.key == key).map(|lease| lease.scope.path.as_str())).collect();
            for candidate in result.directories.keys().filter(|path| !protected.contains(path.as_ref())) {
                let exact = scopes.get(candidate.as_ref()).copied().unwrap_or(7);
                let direct = Path::new(candidate.as_ref()).parent().and_then(Path::to_str)
                    .and_then(|parent| scopes.get(parent)).filter(|priority| **priority < 3).map_or(7, |priority| 3 + *priority);
                let tier = exact.min(direct);
                let depth = if tier == 7 { relative_depth(path, candidate) } else { 0 };
                candidates.push((Reverse(tier), Reverse(depth), index, candidate.clone()));
            }
        };
        for (index, (_, key)) in roots.iter().enumerate() {
            let root = &self.roots[key];
            collect(index, key, &root.target.path, root.result.as_ref().unwrap());
        }
        collect(roots.len(), &target.key, &target.path, incoming);
        // Number children within each scope across existing and incoming data.
        // Evict later rows before any other view's first row at the same tier.
        let mut children: Vec<_> = candidates.iter().filter(|(tier, _, _, _)| (3..=5).contains(&tier.0))
            .map(|(_, _, _, path)| path.clone()).collect();
        children.sort_unstable(); children.dedup();
        let mut positions = HashMap::new(); let mut previous_parent = None; let mut position = 0;
        for path in &children {
            let parent = Path::new(path.as_ref()).parent();
            if parent != previous_parent { position = 0; previous_parent = parent; }
            positions.insert(path.as_ref(), position); position += 1;
        }
        for (tier, rank, _, path) in &mut candidates {
            if (3..=5).contains(&tier.0) { *rank = Reverse(positions[path.as_ref()]); }
        }
        candidates.sort_unstable();
        let mut count = 0; let mut incoming_removed = 0;
        for (_, _, index, path) in &candidates {
            if excess == 0 { break; }
            excess = excess.saturating_sub(NODE_ACCOUNT_BYTES + path.len()); count += 1;
            incoming_removed += usize::from(*index == roots.len());
        }
        // Plan first. If no incoming detail survives (or protected aggregates
        // still cannot fit), reject it without touching existing live rows.
        let admit = excess == 0 && incoming_removed < incoming.directories.len();
        let mut compacted = vec![false; roots.len() + 1];
        for (_, _, index, path) in candidates.into_iter().take(count) {
            if !admit && index != roots.len() { continue; }
            let result = if index == roots.len() { &mut *incoming }
                else { self.roots.get_mut(&roots[index].1).unwrap().result.as_mut().unwrap() };
            if result.directories.remove(&path).is_some() {
                compacted[index] = true;
                let cost = NODE_ACCOUNT_BYTES + path.len();
                result.accounted_bytes = result.accounted_bytes.saturating_sub(cost);
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

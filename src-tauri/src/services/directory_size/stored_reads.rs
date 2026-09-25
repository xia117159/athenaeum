use super::*;
use super::super::storage::StoredHit;

impl Core {
    pub(super) fn request_missing_scopes(&mut self, now: u64) {
        let Some(store) = &self.storage else { return; };
        let mut requests = std::collections::HashSet::new();
        let mut expired = std::collections::HashSet::new();
        for lease in self.leases.values_mut().filter(|lease| !lease.detached && lease.disk_error.is_none()) {
            let Some(root) = self.roots.get(&lease.key).filter(|root| root.watch.is_some() && root.guard.is_none()
                && matches!(root.phase, DirectorySizePhase::Complete | DirectorySizePhase::Partial)) else { continue; };
            let Some(scan) = &root.persisted_scan else { continue; };
            if root.result.as_ref().is_some_and(|result| result.directories.contains_key(lease.scope.path.as_str())) { continue; }
            let since = *lease.disk_wait.get_or_insert(now);
            if now.saturating_sub(since) >= 30_000 {
                lease.disk_error = Some("目录大小缓存暂时无法读取，请重试".into()); expired.insert(lease.key.clone()); continue;
            }
            if now >= lease.disk_retry {
                lease.disk_retry = now + 1000; requests.insert((scan.clone(), lease.scope.path.clone()));
            }
        }
        for (scan, path) in requests { let _ = store.lookup(vec![path], Some(scan)); }
        for key in expired { self.emit(&key); }
    }
    pub fn disk_scan_for_scope(&self, path: &str) -> Option<String> {
        let scope = normalize_target(&DirectorySizeTarget::Local { path: path.into() }, None, 0).ok()?;
        let root = &self.roots[&self.reusable_root(&scope)?];
        root.persisted_scan.clone()
    }
    pub fn disk_scan_for_lookup(&self, owner: &str, request: &LookupDirectorySizesRequest) -> Option<String> {
        let lease = self.leases.get(&request.consumer_id).filter(|lease| lease.owner.label == owner && !lease.detached)?;
        let root = self.roots.get(&lease.key).filter(|root| root.generation == request.generation && root.guard.is_none()
            && root.watch.is_some() && !root.identity_expired && root.result.is_some())?;
        root.persisted_scan.clone()
    }
    pub fn stored_read_finished(&mut self, paths: &[String], scan: Option<&str>, result: Result<&[StoredHit], &str>, now: u64) {
        if self.stopped { return; }
        let Ok(hits) = result else { return; };
        self.remember_paths(paths);
        self.install_stored(hits);
        let Some(scan) = scan else { return; };
        // Watch polling and scan identity fence run after I/O, before promoting any row.
        self.tick(now);
        let keys: Vec<_> = self.roots.iter().filter(|(_, root)| root.persisted_scan.as_deref() == Some(scan)
            && root.watch.is_some() && root.identity.is_some() && !root.identity_expired && root.guard.is_none()
            && matches!(root.phase, DirectorySizePhase::Complete | DirectorySizePhase::Partial))
            .map(|(key, _)| key.clone()).collect();
        for key in keys {
            let target = self.roots[&key].target.clone();
            let mut changed = false;
            for hit in hits.iter().filter(|hit| hit.scan_id == scan && hit.policy_version == 2 && hit.record.size.visited()) {
                if lookup_path(&target, &hit.record.path).is_err() || self.roots[&key].result.as_ref()
                    .is_none_or(|result| result.directories.contains_key(hit.record.path.as_str())) { continue; }
                let cost = super::super::scan::NODE_ACCOUNT_BYTES + hit.record.path.len();
                let mut incoming = ScanResult { directories: [(Arc::from(hit.record.path.as_str()), hit.record.size.clone())].into(),
                    stats: ScanStats::default(), outcome: ScanOutcome::Complete, accounted_bytes: cost, message: None };
                self.compact_live_details(&mut incoming, &target);
                if incoming.directories.is_empty() || self.live_cache_bytes().saturating_add(cost) > self.limits.cache_bytes { continue; }
                self.history.trim(self.limits.cache_bytes.saturating_sub(self.live_cache_bytes()).saturating_sub(cost));
                let saved = self.roots.get_mut(&key).unwrap().result.as_mut().unwrap();
                saved.directories.extend(incoming.directories); saved.accounted_bytes += cost; changed = true;
            }
            let mut misses = vec![];
            let root = &self.roots[&key];
            for (id, lease) in self.leases.iter_mut().filter(|(_, lease)| lease.key == key && lease.disk_wait.is_some()) {
                if !paths.iter().any(|path| lookup_path(&lease.scope, path).ok().as_deref() == Some(lease.scope.path.as_str())) { continue; }
                if root.result.as_ref().is_some_and(|result| result.directories.contains_key(lease.scope.path.as_str())) {
                    lease.disk_wait = None; lease.disk_error = None; changed = true;
                } else if hits.iter().any(|hit| hit.record.path == lease.scope.path) {
                    lease.disk_error = Some("目录大小缓存内存不足，已保留上次显示结果".into()); changed = true;
                } else { misses.push(id.clone()); }
            }
            if changed { self.emit(&key); }
            for id in misses { self.start_missed_scope(&id, now); }
        }
    }
    fn start_missed_scope(&mut self, consumer: &str, now: u64) {
        let Some(lease) = self.leases.get(consumer) else { return; };
        let scope = lease.scope.clone(); let old_key = lease.key.clone();
        if !self.roots.contains_key(&scope.key) {
            while self.roots.len() >= self.limits.roots {
                if !self.evict_unleased(None) {
                    self.leases.get_mut(consumer).unwrap().disk_error = Some("目录统计已达到 8 个根目录上限".into());
                    self.emit(&old_key); return;
                }
            }
            self.generation += 1;
            self.roots.insert(scope.key.clone(), Root::new(scope.clone(), self.generation, now));
        }
        let lease = self.leases.get_mut(consumer).unwrap();
        lease.key = scope.key.clone(); lease.disk_wait = None; lease.disk_error = None; lease.verified = false;
        self.emit(&scope.key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::super::{scan::{DirectorySize, NODE_ACCOUNT_BYTES}, storage::{Store, StoredDirectory, StoredHit}, watch::WatchPoll};
    struct Quiet;
    impl SizeWatch for Quiet { fn poll(&mut self) -> WatchPoll { WatchPoll::Quiet } }
    #[test]
    fn size_disk_deep_visible_child_displaces_cold_shallow_detail_when_memory_is_full() {
        let mut core = Core::default(); core.open_owner("main");
        core.storage = Some(Store::paused_for_test(8192, 2048)); core.session = "session".into();
        let owner = core.owner_token("main").unwrap();
        let request = |id: &str, path: &str| SubscribeDirectorySizesRequest { consumer_id: id.into(), target: DirectorySizeTarget::Local { path: path.into() }, refresh: false, handoff: None };
        core.subscribe(owner.clone(), request("parent", "C:\\root"), None, 0).unwrap();
        let job = core.take_jobs(0).remove(0); let identity = Some(RootIdentity([1,2,3,4]));
        core.prepared(&job, identity, Some(Box::new(Quiet)), 0);
        let size = DirectorySize { bytes: 60, complete: true, fingerprint: Some("stamp".into()), created_at: Some(chrono::DateTime::UNIX_EPOCH),
            stats: ScanStats { known_bytes: 60, directories: 1, ..Default::default() } };
        let normalize = |path| super::super::super::target::normalize_local_path(path).unwrap();
        let scope = normalize("C:\\root\\deep\\view"); let child = format!("{scope}\\child");
        let directories: HashMap<Arc<str>, _> = [job.target.path.clone(), scope.clone(), format!("{}\\cold", job.target.path)]
            .into_iter().map(|path| (Arc::from(path), size.clone())).collect();
        let accounted_bytes = directories.keys().map(|path| NODE_ACCOUNT_BYTES + path.len()).sum();
        core.finished(&job, ScanResult { directories, stats: size.stats.clone(), outcome: ScanOutcome::Complete, accounted_bytes, message: None }, identity, 1);
        core.subscribe(owner, request("view", &scope), None, 2).unwrap();
        let verification = core.take_identity_job(2).unwrap(); core.identity_finished(&verification, Ok(identity.unwrap()), 3);
        core.limits.cache_bytes = core.cache_bytes() + child.len() - format!("{}\\cold", job.target.path).len();
        let scan = job.storage.unwrap();
        core.stored_read_finished(&[child.clone()], Some(&scan.id), Ok(&[StoredHit { record: StoredDirectory { path: child.clone(), size, artifact_capture: None },
            scan_id: scan.id.clone(), source: 1, publication: 1, captured_at: chrono::Utc::now(), policy_version: 2 }]), 4);
        let lookup = core.lookup("main", LookupDirectorySizesRequest { consumer_id: "view".into(), generation: job.generation, paths: vec![child] }, 4).unwrap();
        assert_eq!(lookup.directories[0].bytes.as_deref(), Some("60"), "the current view must admit its disk hit instead of repeatedly discarding it");
        assert_eq!(lookup.directories[0].created_at, Some(chrono::DateTime::UNIX_EPOCH), "live IPC must carry object identity so late replies cannot certify a replacement directory");
        assert_eq!(core.jobs_started, 1); assert!(core.cache_bytes() <= core.limits.cache_bytes);
    }
    #[test]
    fn size_disk_timeout_emits_failure_to_the_waiting_view_without_starting_a_scan() {
        let mut core = Core::default(); core.open_owner("main");
        core.storage = Some(Store::paused_for_test(8192, 2048)); core.session = "session".into();
        let owner = core.owner_token("main").unwrap();
        for (id, path) in [("parent", "C:\\root"), ("child", "C:\\root\\child")] {
            core.subscribe(owner.clone(), SubscribeDirectorySizesRequest { consumer_id: id.into(),
                target: DirectorySizeTarget::Local { path: path.into() }, refresh: false, handoff: None }, None, 0).unwrap();
            if id == "parent" {
                let job = core.take_jobs(0).remove(0); let identity = Some(RootIdentity([1,2,3,4]));
                core.prepared(&job, identity, Some(Box::new(Quiet)), 0);
                let size = DirectorySize { bytes: 60, complete: true, fingerprint: None, created_at: None,
                    stats: ScanStats { directories: 1, ..Default::default() } };
                core.finished(&job, ScanResult { directories: [(Arc::from(job.target.path.as_str()), size)].into(),
                    stats: ScanStats::default(), outcome: ScanOutcome::Complete, accounted_bytes: 1024, message: None }, identity, 0);
            }
        }
        core.request_missing_scopes(1); core.drain_events();
        core.request_missing_scopes(30_002);
        assert!(core.drain_events().iter().any(|(_, event)| event.consumer_id == "child" && event.phase == DirectorySizePhase::Failed),
            "timeout must notify the UI instead of leaving its pending spinner indefinitely");
        assert_eq!(core.jobs_started, 1);
    }
    #[test]
    fn size_disk_evicted_child_reuses_the_accepted_scan_and_fences_late_callbacks() {
        let mut core = Core::default(); core.open_owner("main");
        core.storage = Some(Store::paused_for_test(8192, 2048)); core.session = "session".into();
        let request = |id: &str, path: &str| SubscribeDirectorySizesRequest {
            consumer_id: id.into(), target: DirectorySizeTarget::Local { path: path.into() }, refresh: false, handoff: None,
        };
        let owner = core.owner_token("main").unwrap();
        core.subscribe(owner.clone(), request("parent", "C:\\root"), None, 0).unwrap();
        let job = core.take_jobs(0).remove(0);
        let size = DirectorySize { bytes: 60, complete: true, fingerprint: Some("stamp".into()),
            stats: ScanStats { files: 1, directories: 1, known_bytes: 60, ..Default::default() }, created_at: Some(chrono::DateTime::UNIX_EPOCH) };
        let identity = Some(RootIdentity([1,2,3,4]));
        core.prepared(&job, identity, Some(Box::new(Quiet)), 0);
        core.finished(&job, ScanResult { directories: [(Arc::from(job.target.path.as_str()), size.clone())].into(),
            stats: size.stats.clone(), outcome: ScanOutcome::Complete, accounted_bytes: NODE_ACCOUNT_BYTES + job.target.path.len(), message: None }, identity, 1);
        let scan = job.storage.unwrap();
        core.subscribe(owner, request("child", "C:\\root\\child"), None, 2).unwrap();
        assert!(core.take_jobs(2).is_empty(), "evicted details must first query their accepted disk revision");
        let child = super::super::super::target::normalize_local_path("C:\\root\\child").unwrap();
        core.stored_read_finished(&[child.clone()], Some(&scan.id), Ok(&[StoredHit {
            record: StoredDirectory { path: child.clone(), size, artifact_capture: None }, scan_id: scan.id.clone(), source: 1,
            publication: 1, captured_at: chrono::Utc::now(), policy_version: 2,
        }]), 3);
        let verification = core.take_identity_job(3).unwrap(); core.identity_finished(&verification, identity.ok_or("missing".into()), 4);
        assert_eq!(core.snapshot("child").unwrap().total_bytes.as_deref(), Some("60"));
        assert_eq!(core.snapshot("child").unwrap().generation, job.generation);
        assert_eq!(core.jobs_started, 1);
        core.release("main", "child", 5).unwrap();
        core.stored_read_finished(&[child], Some(&scan.id), Ok(&[]), 6);
        assert_eq!(core.root_count(), 1, "a late miss cannot resurrect a released scope");
    }
}

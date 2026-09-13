use std::{collections::HashMap, sync::{Arc, atomic::{AtomicBool, Ordering}}};
use crate::domain::{directory_sizes::*, models::RemoteProfile};
use super::{scan::{ScanOutcome, ScanResult, ScanStats}, target::{ScanTarget, normalize_target, lookup_path}, watch::{RootIdentity, WatchPoll}};

pub(super) trait SizeWatch: Send { fn poll(&mut self) -> WatchPoll; }
impl SizeWatch for super::watch::RecursiveWatch { fn poll(&mut self) -> WatchPoll { self.poll() } }

#[derive(Clone)]
pub(super) struct ScanJob { pub target: ScanTarget, pub generation: u64, pub cancelled: Arc<AtomicBool> }
#[derive(Clone)]
pub(super) struct IdentityJob { pub key: String, pub path: String, pub generation: u64, pub ticket: u64 }
#[derive(Debug, Clone)]
pub(crate) struct OwnerToken { pub label: String, pub epoch: u64 }
#[derive(Clone, Copy)]
pub(super) struct ServiceLimits { pub roots: usize, pub leases: usize, pub workers: usize, pub remote_workers: usize, pub cache_bytes: usize }
impl Default for ServiceLimits {
    fn default() -> Self { Self { roots: 8, leases: 32, workers: 2, remote_workers: 1, cache_bytes: 64 * 1024 * 1024 } }
}

struct Lease { owner: OwnerToken, key: String, verified: bool, required_validation: u64 }
struct Running { generation: u64, cancelled: Arc<AtomicBool> }
struct Root {
    target: ScanTarget,
    generation: u64,
    sequence: u64,
    phase: DirectorySizePhase,
    stats: ScanStats,
    result: Option<ScanResult>,
    watch: Option<Box<dyn SizeWatch>>,
    identity: Option<RootIdentity>,
    last_identity_ok: Option<u64>,
    identity_expired: bool,
    needs_scan: bool,
    due: u64,
    last_start: Option<u64>,
    last_progress: u64,
    last_used: u64,
    running: Option<Running>,
    reason: Option<String>,
}
impl Root {
    fn new(target: ScanTarget, generation: u64, now: u64) -> Self {
        Self { target, generation, sequence: 0, phase: DirectorySizePhase::Queued, stats: ScanStats::default(), result: None,
            watch: None, identity: None, last_identity_ok: None, identity_expired: false, needs_scan: true, due: now,
            last_start: None, last_progress: now, last_used: now, running: None, reason: None }
    }
}

#[derive(Default)]
pub(super) struct Core {
    pub limits: ServiceLimits,
    roots: HashMap<String, Root>,
    leases: HashMap<String, Lease>,
    owners: HashMap<String, u64>,
    owner_epoch: u64,
    generation: u64,
    validation_ticket: u64,
    identity_running: Option<IdentityJob>,
    profile_revisions: HashMap<String, u64>,
    profile_updates: HashMap<String, usize>,
    events: HashMap<String, (String, DirectorySizeSnapshot)>,
    stopped: bool,
}
impl Core {
    pub fn open_owner(&mut self, label: &str) {
        if self.stopped { return; }
        self.close_owner(label, 0);
        self.owner_epoch += 1;
        self.owners.insert(label.into(), self.owner_epoch);
    }
    pub fn owner_token(&self, label: &str) -> Result<OwnerToken, String> {
        self.owners.get(label).filter(|_| !self.stopped).map(|epoch| OwnerToken { label: label.into(), epoch: *epoch })
            .ok_or_else(|| "统计窗口已关闭或尚未注册".into())
    }
    pub fn close_owner(&mut self, label: &str, now: u64) {
        self.owners.remove(label);
        let consumers: Vec<_> = self.leases.iter().filter(|(_, lease)| lease.owner.label == label).map(|(id, _)| id.clone()).collect();
        for consumer in consumers { let _ = self.release(label, &consumer, now); }
    }
    pub fn subscribe(&mut self, owner: OwnerToken, request: SubscribeDirectorySizesRequest, profile: Option<RemoteProfile>, now: u64) -> Result<DirectorySizeSnapshot, String> {
        if self.stopped || self.owners.get(&owner.label) != Some(&owner.epoch) { return Err("统计窗口生命周期已结束".into()); }
        if let DirectorySizeTarget::Remote { profile_id, .. } = &request.target {
            if self.profile_updates.contains_key(profile_id) { return Err("远程连接正在更新，请保存完成后重新计算大小".into()); }
        }
        if request.consumer_id.is_empty() || request.consumer_id.len() > 128 || !request.consumer_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')) {
            return Err("无效的目录统计订阅标识".into());
        }
        self.tick(now);
        let revision = profile.as_ref().and_then(|value| self.profile_revisions.get(&value.id)).copied().unwrap_or(0);
        let target = normalize_target(&request.target, profile, revision)?;
        let key = target.key.clone();
        let mut existing = false;
        if let Some(lease) = self.leases.get(&request.consumer_id) {
            if lease.owner.label != owner.label || lease.owner.epoch != owner.epoch { return Err("目录统计订阅不属于当前窗口".into()); }
            if lease.key == key { existing = true; }
            else { self.release(&owner.label, &request.consumer_id, now)?; }
        }
        if !existing && self.leases.len() >= self.limits.leases { return Err("目录统计订阅已达到 32 个上限".into()); }
        if !self.roots.contains_key(&key) {
            while self.roots.len() >= self.limits.roots {
                if !self.evict_unleased(None) { return Err("目录统计已达到 8 个根目录上限".into()); }
            }
            self.generation += 1;
            self.roots.insert(key.clone(), Root::new(target, self.generation, now));
        }
        let root = self.roots.get_mut(&key).expect("inserted root");
        root.last_used = now;
        let new_unmonitored_cache_lease = !existing && root.result.is_some() && root.target.profile.is_none() && root.watch.is_none();
        let refresh = request.refresh;
        if !existing {
            self.leases.insert(request.consumer_id.clone(), Lease { owner, key: key.clone(),
                verified: root.target.profile.is_some() && root.result.is_some(),
                required_validation: self.validation_ticket + 1 });
        }
        if new_unmonitored_cache_lease || refresh {
            self.invalidate(&key, now, true, false, 0, "已请求重新统计");
            self.roots.get_mut(&key).unwrap().phase = DirectorySizePhase::Queued;
            self.emit(&key);
        } else if self.roots[&key].phase == DirectorySizePhase::Cancelled {
            self.invalidate(&key, now, true, true, 0, "重新订阅目录统计");
        }
        self.snapshot(&request.consumer_id).ok_or_else(|| "目录统计订阅未建立".into())
    }
    pub fn release(&mut self, owner: &str, consumer: &str, now: u64) -> Result<(), String> {
        let Some(lease) = self.leases.get(consumer) else { return Ok(()); };
        if lease.owner.label != owner { return Err("目录统计订阅不属于当前窗口".into()); }
        let key = lease.key.clone();
        self.leases.remove(consumer);
        self.events.remove(consumer);
        if !self.has_leases(&key) {
            if let Some(root) = self.roots.get_mut(&key) {
                root.last_used = now;
                root.needs_scan = false;
                if let Some(running) = &root.running { running.cancelled.store(true, Ordering::Relaxed); }
                let reusable = root.result.is_some() && (root.target.profile.is_some() || root.watch.is_some());
                if !reusable {
                    root.phase = DirectorySizePhase::Cancelled;
                    root.watch = None;
                    root.result = None;
                    if root.running.is_none() { self.roots.remove(&key); }
                }
            }
        }
        Ok(())
    }
    pub fn snapshot(&self, consumer: &str) -> Option<DirectorySizeSnapshot> {
        let lease = self.leases.get(consumer)?;
        let root = self.roots.get(&lease.key)?;
        let pending_verification = root.result.is_some() && !lease.verified && matches!(root.phase, DirectorySizePhase::Complete | DirectorySizePhase::Partial | DirectorySizePhase::Failed);
        let phase = if pending_verification { DirectorySizePhase::Queued } else { root.phase };
        let total_bytes = (phase == DirectorySizePhase::Complete).then(|| root.result.as_ref()?.directories.get(root.target.path.as_str())
            .filter(|size| size.complete).map(|size| size.bytes.to_string())).flatten();
        Some(DirectorySizeSnapshot { consumer_id: consumer.into(), generation: root.generation, sequence: root.sequence, phase,
            known_bytes: root.stats.known_bytes.to_string(), total_bytes, files: root.stats.files, directories: root.stats.directories,
            skipped_links: root.stats.skipped_links, skipped_special: root.stats.skipped_special, errors: root.stats.errors,
            freshness: if root.watch.is_some() && root.identity.is_some() { DirectorySizeFreshness::Monitored } else { DirectorySizeFreshness::Snapshot },
            reason: if pending_verification { Some("正在验证缓存对应的目录对象".into()) } else { root.reason.clone() } })
    }
    pub fn take_jobs(&mut self, now: u64) -> Vec<ScanJob> {
        if self.stopped { return vec![]; }
        let mut active = self.roots.values().filter(|root| root.running.is_some()).count();
        let mut remote_active = self.roots.values().filter(|root| root.running.is_some() && root.target.profile.is_some()).count();
        let mut keys: Vec<_> = self.roots.iter().filter(|(key, root)| root.needs_scan && root.running.is_none() && root.due <= now && self.has_leases(key))
            .map(|(key, root)| (root.due, root.generation, key.clone())).collect();
        keys.sort();
        let mut jobs = vec![];
        for (_, _, key) in keys {
            if active >= self.limits.workers { break; }
            let root = self.roots.get_mut(&key).unwrap();
            if root.target.profile.is_some() && remote_active >= self.limits.remote_workers { continue; }
            let cancelled = Arc::new(AtomicBool::new(false));
            root.running = Some(Running { generation: root.generation, cancelled: cancelled.clone() });
            root.needs_scan = false;
            root.phase = DirectorySizePhase::Scanning;
            root.reason = None;
            root.last_start = Some(now);
            root.last_progress = now;
            root.watch = None;
            root.identity = None;
            root.last_identity_ok = None;
            root.identity_expired = false;
            jobs.push(ScanJob { target: root.target.clone(), generation: root.generation, cancelled });
            active += 1;
            remote_active += usize::from(root.target.profile.is_some());
            self.emit(&key);
        }
        jobs
    }
    pub fn prepared(&mut self, job: &ScanJob, identity: Option<RootIdentity>, watch: Option<Box<dyn SizeWatch>>, now: u64) {
        if !self.job_current(job) { return; }
        let root = self.roots.get_mut(&job.target.key).unwrap();
        root.identity = identity;
        root.last_identity_ok = identity.map(|_| now);
        root.watch = identity.and(watch);
        if root.watch.is_none() { root.reason = Some("实时监控不可用，本次结果仅为快照".into()); }
        self.tick(now);
    }
    pub fn finished(&mut self, job: &ScanJob, result: ScanResult, identity: Option<RootIdentity>, now: u64) {
        self.tick(now); // Poll pending subtree notifications before accepting any result.
        let current = self.job_current(job);
        if let Some(root) = self.roots.get_mut(&job.target.key) {
            if root.running.as_ref().is_some_and(|running| running.generation == job.generation) { root.running = None; }
        }
        if !self.has_leases(&job.target.key) {
            self.roots.remove(&job.target.key);
            return;
        }
        if !current { return; }
        let root = &self.roots[&job.target.key];
        if root.target.profile.is_none() && root.identity.is_some() && root.identity != identity {
            self.invalidate(&job.target.key, now, true, true, 500, "根目录对象发生变化或无法验证，旧统计已失效");
            return;
        }
        while self.cache_bytes().saturating_add(result.accounted_bytes) > self.limits.cache_bytes {
            if !self.evict_unleased(Some(&job.target.key)) { break; }
        }
        let fits = self.cache_bytes().saturating_add(result.accounted_bytes) <= self.limits.cache_bytes;
        let root = self.roots.get_mut(&job.target.key).unwrap();
        root.stats = result.stats.clone();
        root.phase = phase_for_outcome(result.outcome);
        root.reason = result.message.clone().map(|message| message.chars().take(256).collect()).or_else(|| root.reason.take());
        root.last_identity_ok = identity.map(|_| now);
        root.last_used = now;
        if fits && result.outcome != ScanOutcome::Cancelled { root.result = Some(result); }
        else if !fits { root.phase = DirectorySizePhase::Partial; root.reason = Some("统计缓存已达到 64 MiB 上限，无法保留目录明细".into()); }
        for lease in self.leases.values_mut().filter(|lease| lease.key == job.target.key) { lease.verified = true; }
        self.emit(&job.target.key);
    }
    pub fn progress(&mut self, job: &ScanJob, stats: ScanStats, now: u64) {
        if !self.job_current(job) { return; }
        let root = self.roots.get_mut(&job.target.key).unwrap();
        root.stats = stats;
        if now.saturating_sub(root.last_progress) >= 200 {
            root.last_progress = now;
            self.emit(&job.target.key);
        }
    }
    pub fn tick(&mut self, now: u64) {
        let mut changes = vec![];
        for (key, root) in &mut self.roots {
            if let Some(watch) = &mut root.watch {
                match watch.poll() {
                    WatchPoll::Changed => changes.push((key.clone(), false, "目录内容已变化，统计已失效")),
                    WatchPoll::Lost => changes.push((key.clone(), true, "目录实时监控已失效")),
                    WatchPoll::Quiet => {}
                }
            }
        }
        for (key, lost, reason) in changes {
            if !self.has_leases(&key) && self.roots[&key].running.is_none() { self.roots.remove(&key); }
            else { self.invalidate(&key, now, true, lost, 500, reason); }
        }
        let expired: Vec<_> = self.roots.iter().filter(|(key, root)| self.has_leases(key) && root.watch.is_some() && root.result.is_some()
            && !root.identity_expired && root.last_identity_ok.is_some_and(|last| now.saturating_sub(last) > 5000))
            .map(|(key, _)| key.clone()).collect();
        for key in expired {
            let root = self.roots.get_mut(&key).unwrap();
            root.identity_expired = true;
            root.phase = DirectorySizePhase::Stale;
            root.reason = Some("根目录身份校验超时，等待重新验证".into());
            self.emit(&key);
        }
    }
    pub fn take_identity_job(&mut self, now: u64) -> Option<IdentityJob> {
        if self.stopped || self.identity_running.is_some() { return None; }
        let key = self.roots.iter().filter(|(key, root)| root.target.profile.is_none() && root.watch.is_some() && root.result.is_some() && self.has_leases(key))
            .filter(|(key, root)| root.last_identity_ok.is_none_or(|last| now.saturating_sub(last) >= 2000)
                || self.leases.values().any(|lease| &lease.key == *key && !lease.verified))
            .min_by_key(|(_, root)| (root.last_identity_ok.unwrap_or(0), root.generation)).map(|(key, _)| key.clone())?;
        self.validation_ticket += 1;
        let root = &self.roots[&key];
        let job = IdentityJob { key, path: root.target.path.clone(), generation: root.generation, ticket: self.validation_ticket };
        self.identity_running = Some(job.clone());
        Some(job)
    }
    pub fn identity_finished(&mut self, job: &IdentityJob, identity: Result<RootIdentity, String>, now: u64) {
        if self.identity_running.as_ref().is_none_or(|running| running.ticket != job.ticket) { return; }
        self.identity_running = None;
        self.tick(now);
        let Some(root) = self.roots.get_mut(&job.key).filter(|root| root.generation == job.generation && root.watch.is_some() && root.result.is_some()) else { return; };
        if identity.ok() != root.identity {
            self.invalidate(&job.key, now, true, true, 500, "根目录对象发生变化或无法读取，统计已失效");
            return;
        }
        root.last_identity_ok = Some(now);
        if root.identity_expired {
            root.identity_expired = false;
            root.phase = phase_for_outcome(root.result.as_ref().unwrap().outcome);
            root.reason = root.result.as_ref().unwrap().message.clone();
        }
        for lease in self.leases.values_mut().filter(|lease| lease.key == job.key && lease.required_validation <= job.ticket) { lease.verified = true; }
        self.emit(&job.key);
    }
    pub fn lookup(&mut self, owner: &str, request: LookupDirectorySizesRequest, now: u64) -> Result<DirectorySizeLookup, String> {
        if request.paths.len() > 256 { return Err("一次最多查询 256 个目录".into()); }
        self.tick(now);
        let lease = self.leases.get(&request.consumer_id).ok_or_else(|| "目录统计订阅已结束".to_string())?;
        if lease.owner.label != owner { return Err("目录统计订阅不属于当前窗口".into()); }
        let root = self.roots.get(&lease.key).ok_or_else(|| "目录统计缓存已失效".to_string())?;
        let paths: Vec<_> = request.paths.iter().map(|path| lookup_path(&root.target, path)).collect::<Result<_, _>>()?;
        let stale = request.generation != root.generation || !lease.verified || root.result.is_none()
            || !matches!(root.phase, DirectorySizePhase::Complete | DirectorySizePhase::Partial | DirectorySizePhase::Failed);
        let directories = if stale { vec![] } else {
            paths.iter().zip(&request.paths).map(|(key, path)| {
                let size = root.result.as_ref().unwrap().directories.get(key.as_str());
                DirectorySizeRecord { path: path.clone(), state: match size { Some(size) if size.complete => DirectorySizeRecordState::Complete,
                    Some(_) => DirectorySizeRecordState::Partial, None => DirectorySizeRecordState::Unknown },
                    bytes: size.map(|size| size.bytes.to_string()), size_fingerprint: size.and_then(|size| size.fingerprint.clone()) }
            }).collect()
        };
        Ok(DirectorySizeLookup { consumer_id: request.consumer_id, generation: request.generation, sequence: root.sequence, stale, directories })
    }
    pub fn invalidate_profile(&mut self, id: &str, now: u64) {
        *self.profile_revisions.entry(id.into()).or_default() += 1;
        let keys: Vec<_> = self.roots.iter().filter(|(_, root)| root.target.profile.as_ref().is_some_and(|profile| profile.id == id)).map(|(key, _)| key.clone()).collect();
        for key in keys {
            self.invalidate(&key, now, false, true, 0, "远程连接或目录已变化，请手动重新统计");
            if !self.has_leases(&key) && self.roots[&key].running.is_none() { self.roots.remove(&key); }
        }
    }
    pub fn begin_profile_update(&mut self, id: &str, now: u64) {
        if self.stopped { return; }
        *self.profile_updates.entry(id.into()).or_default() += 1;
        self.invalidate_profile(id, now);
    }
    pub fn end_profile_update(&mut self, id: &str, now: u64) {
        let Some(active) = self.profile_updates.get_mut(id) else { return; };
        *active -= 1;
        if *active == 0 { self.profile_updates.remove(id); }
        self.invalidate_profile(id, now);
    }
    pub fn shutdown(&mut self) {
        self.stopped = true;
        for root in self.roots.values() { if let Some(running) = &root.running { running.cancelled.store(true, Ordering::Relaxed); } }
        self.roots.clear();
        self.leases.clear();
        self.events.clear();
        self.owners.clear();
        self.profile_updates.clear();
    }
    #[cfg(test)]
    pub fn root_count(&self) -> usize { self.roots.len() }
    pub fn cache_bytes(&self) -> usize { self.roots.values().filter_map(|root| root.result.as_ref()).map(|result| result.accounted_bytes).sum() }
    pub fn drain_events(&mut self) -> Vec<(String, DirectorySizeSnapshot)> { self.events.drain().map(|(_, event)| event).collect() }
    fn has_leases(&self, key: &str) -> bool { self.leases.values().any(|lease| lease.key == key) }
    fn job_current(&self, job: &ScanJob) -> bool {
        !self.stopped && !job.cancelled.load(Ordering::Relaxed) && self.has_leases(&job.target.key)
            && self.roots.get(&job.target.key).is_some_and(|root| root.generation == job.generation
                && root.running.as_ref().is_some_and(|running| running.generation == job.generation
                    && Arc::ptr_eq(&running.cancelled, &job.cancelled)))
    }
    fn emit(&mut self, key: &str) {
        let Some(root) = self.roots.get_mut(key) else { return; };
        root.sequence += 1;
        let consumers: Vec<_> = self.leases.iter().filter(|(_, lease)| lease.key == key).map(|(id, lease)| (id.clone(), lease.owner.label.clone())).collect();
        for (id, owner) in consumers { if let Some(snapshot) = self.snapshot(&id) { self.events.insert(id, (owner, snapshot)); } }
    }
    fn invalidate(&mut self, key: &str, now: u64, rescan: bool, drop_watch: bool, quiet: u64, reason: &str) {
        let leased = self.has_leases(key);
        let Some(root) = self.roots.get_mut(key) else { return; };
        self.generation += 1;
        root.generation = self.generation;
        root.sequence = 0;
        root.result = None;
        root.stats = ScanStats::default();
        root.phase = DirectorySizePhase::Stale;
        root.reason = Some(reason.into());
        root.identity_expired = false;
        root.needs_scan = rescan && leased;
        root.due = now.saturating_add(quiet).max(root.last_start.map(|start| start.saturating_add(2000)).unwrap_or(now));
        if let Some(running) = &root.running { running.cancelled.store(true, Ordering::Relaxed); }
        if drop_watch { root.watch = None; root.identity = None; root.last_identity_ok = None; }
        for lease in self.leases.values_mut().filter(|lease| lease.key == key) { lease.verified = false; lease.required_validation = self.validation_ticket + 1; }
        self.emit(key);
    }
    fn evict_unleased(&mut self, except: Option<&str>) -> bool {
        let key = self.roots.iter().filter(|(key, root)| Some(key.as_str()) != except && root.running.is_none() && !self.has_leases(key))
            .min_by_key(|(_, root)| root.last_used).map(|(key, _)| key.clone());
        if let Some(key) = key { self.roots.remove(&key); true } else { false }
    }
}

fn phase_for_outcome(outcome: ScanOutcome) -> DirectorySizePhase {
    match outcome { ScanOutcome::Complete => DirectorySizePhase::Complete, ScanOutcome::Partial => DirectorySizePhase::Partial,
        ScanOutcome::Failed => DirectorySizePhase::Failed, ScanOutcome::Cancelled => DirectorySizePhase::Cancelled }
}

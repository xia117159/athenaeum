use std::{collections::HashMap, path::Path, sync::{Arc, Mutex, Weak, atomic::{AtomicBool, Ordering}, mpsc::{self, SyncSender}}, thread, time::{Duration, Instant}};
use crate::domain::{directory_sizes::*, models::RemoteProfile};
use super::{core::{Core, OwnerToken, ScanJob, IdentityJob, SizeWatch}, scan::{MetadataSource, ScanOutcome, ScanResult, ScanStats, ScanLimits, scan_directory},
    local::LocalMetadataSource, metadata::MetadataEntry, target::normalize_local_path, watch::{RootIdentity, RecursiveWatch, read_root_identity}};

pub type EventSink = dyn Fn(&str, DirectorySizeSnapshot) + Send + Sync;
pub type CacheEventSink = dyn Fn(&str, DirectorySizeCacheUpdated) + Send + Sync;
pub struct DirectorySizeService {
    pub(super) core: Arc<Mutex<Core>>, clock: Instant, started: AtomicBool,
    stopped: Arc<AtomicBool>, wake: Mutex<Option<SyncSender<Message>>>,
    history_path: Mutex<Option<std::path::PathBuf>>,
    pub(super) storage: Mutex<Option<super::storage::Store>>,
    cache_sink: Mutex<Option<Weak<CacheEventSink>>>,
    artifacts: Mutex<Option<Arc<super::artifacts::Registry>>>,
}
pub struct ProfileUpdate<'a> { service: &'a DirectorySizeService, id: String }
impl Drop for ProfileUpdate<'_> {
    fn drop(&mut self) {
        self.service.core.lock().unwrap().end_profile_update(&self.id, self.service.now());
        self.service.wake();
    }
}
impl Default for DirectorySizeService {
    fn default() -> Self { Self { core: Arc::new(Mutex::new(Core::default())), clock: Instant::now(),
        started: AtomicBool::new(false), stopped: Arc::new(AtomicBool::new(false)), wake: Mutex::new(None), history_path: Mutex::new(None), storage: Mutex::new(None), cache_sink: Mutex::new(None), artifacts: Mutex::new(None) } }
}
impl DirectorySizeService {
    pub fn initialize_storage(&self, directory: std::path::PathBuf) {
        if self.started.load(Ordering::SeqCst) || self.stopped.load(Ordering::SeqCst) { return; }
        let mut slot = self.storage.lock().unwrap();
        if slot.is_some() { return; }
        let legacy = super::storage::legacy_path(&directory);
        let artifacts = match super::artifacts::Registry::register(&directory, legacy.as_deref()) {
            Ok(artifacts) => artifacts,
            Err(error) => { eprintln!("warning: size cache membership initialization failed: {error}"); return; }
        };
        let snapshot = artifacts.cached();
        *self.artifacts.lock().unwrap() = Some(artifacts.clone());
        let weak_core = Arc::downgrade(&self.core);
        let clock = self.clock;
        let store = super::storage::Store::start_with_legacy(directory.clone(), legacy, Arc::new(move |paths, scan, result| {
            if let Some(core) = weak_core.upgrade() { core.lock().unwrap().stored_read_finished(paths, scan, result, clock.elapsed().as_millis() as u64); }
        }));
        let mut core = self.core.lock().unwrap();
        core.artifacts = snapshot;
        core.artifact_registry = Some(artifacts);
        core.storage = Some(store.clone()); core.session = uuid::Uuid::new_v4().to_string(); core.history_enabled = true;
        core.protect_stored_scans();
        // Queue/page cache (16 MiB), manifests, summary encoding/decoding and bounded replies.
        core.limits.cache_bytes = core.limits.cache_bytes.saturating_sub(32 << 20);
        *slot = Some(store);
        drop(core); drop(slot);
        let weak_core = Arc::downgrade(&self.core); let (ready, loaded) = mpsc::sync_channel(1);
        thread::spawn(move || {
            match super::storage::startup::load(&directory) {
                Ok(hits) => if let Some(core) = weak_core.upgrade() { core.lock().unwrap().install_stored(&hits); },
                Err(error) => eprintln!("warning: directory size startup summary ignored: {error}"),
            }
            let _ = ready.send(());
        });
        // Slow or damaged storage must not hold the Ready event indefinitely.
        let _ = loaded.recv_timeout(Duration::from_millis(25));
    }
    #[cfg(test)]
    pub fn initialize_history(&self, path: std::path::PathBuf) {
        if self.started.load(Ordering::SeqCst) || self.stopped.load(Ordering::SeqCst) { return; }
        let budget = self.core.lock().unwrap().limits.cache_bytes;
        let history = super::history::History::load(&path, budget).unwrap_or_else(|error| {
            eprintln!("warning: directory size history ignored: {error:#}"); Default::default()
        });
        let mut core = self.core.lock().unwrap(); core.history = history; core.history_enabled = true;
        *self.history_path.lock().unwrap() = Some(path);
    }
    pub(super) fn now(&self) -> u64 { self.clock.elapsed().as_millis().min(u64::MAX as u128) as u64 }
    pub fn set_cache_sink(&self, sink: Weak<CacheEventSink>) { *self.cache_sink.lock().unwrap() = Some(sink); }
    pub fn start(&self, sink: Weak<EventSink>) {
        if self.stopped.load(Ordering::Relaxed) || self.started.swap(true, Ordering::SeqCst) { return; }
        let (sender, receiver) = mpsc::sync_channel(32);
        *self.wake.lock().unwrap() = Some(sender.clone());
        let core = self.core.clone(); let stopped = self.stopped.clone(); let clock = self.clock;
        let cache_sink = self.cache_sink.lock().unwrap().clone();
        let artifacts = self.artifacts.lock().unwrap().clone();
        // Native change-notification I/O is associated with the creating thread.
        // Keep traversal workers alive while their watches remain in the cache.
        let (scan_sender, scan_receiver) = mpsc::sync_channel::<ScanJob>(2);
        let scan_receiver = Arc::new(Mutex::new(scan_receiver));
        for _ in 0..2 {
            let receiver = scan_receiver.clone(); let sender = sender.clone();
            let storage = self.storage.lock().unwrap().clone();
            let artifacts = artifacts.clone();
            thread::spawn(move || loop {
                let job = receiver.lock().unwrap().recv();
                let Ok(job) = job else { break; };
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_scan(&job, &sender, storage.as_ref(), artifacts.clone())));
                if outcome.is_err() { let _ = sender.send(Message::Finished(job, failed_result("目录统计工作线程异常"), None)); }
            });
        }
        let (identity_sender, identity_receiver) = mpsc::sync_channel::<IdentityJob>(1);
        let identity_events = sender.clone();
        thread::spawn(move || {
            while let Ok(job) = identity_receiver.recv() {
                // Never replace this worker to mask a blocked UNC metadata call.
                let identity = std::panic::catch_unwind(|| read_root_identity(Path::new(&job.path)))
                    .unwrap_or_else(|_| Err("根目录身份校验异常".into()));
                let _ = identity_events.send(Message::Identity(job, identity));
            }
        });
        thread::spawn(move || {
            while !stopped.load(Ordering::Relaxed) {
                let message = receiver.recv_timeout(Duration::from_millis(100)).ok();
                let now = clock.elapsed().as_millis() as u64;
                let artifact_snapshot = artifacts.as_ref().map(|registry| registry.sample());
                let (jobs, identity, events, cache_events) = {
                    let mut core = core.lock().unwrap();
                    if let Some(snapshot) = artifact_snapshot { core.set_artifacts(snapshot, now); }
                    if let Some(message) = message { apply_message(&mut core, message, now); }
                    for message in receiver.try_iter().take(32) { apply_message(&mut core, message, now); }
                    core.tick(now);
                    core.protect_stored_scans();
                    (core.take_jobs(now), core.take_identity_job(now), core.drain_events(), core.drain_cache_events())
                };
                for job in jobs { let _ = scan_sender.send(job); }
                if let Some(job) = identity { let _ = identity_sender.send(job); }
                if let Some(sink) = sink.upgrade() { for (owner, event) in events { sink(&owner, event); } }
                if let Some(sink) = cache_sink.as_ref().and_then(Weak::upgrade) { for (owner, event) in cache_events { sink(&owner, event); } }
            }
        });
        self.wake();
    }
    pub(super) fn wake(&self) { if let Some(sender) = &*self.wake.lock().unwrap_or_else(|error| error.into_inner()) { let _ = sender.try_send(Message::Wake); } }
    pub fn open_owner(&self, label: &str) { self.core.lock().unwrap().open_owner(label); }
    pub fn owner_token(&self, label: &str) -> Result<OwnerToken, String> { self.core.lock().unwrap().owner_token(label) }
    pub fn close_owner(&self, label: &str) { self.core.lock().unwrap().close_owner(label, self.now()); self.wake(); }
    pub fn subscribe(&self, owner: OwnerToken, request: SubscribeDirectorySizesRequest, profile: Option<RemoteProfile>) -> Result<DirectorySizeSnapshot, String> {
        let result = self.core.lock().unwrap().subscribe(owner, request, profile, self.now());
        self.wake(); result
    }
    pub fn release(&self, owner: &str, consumer: &str) -> Result<(), String> {
        let result = self.core.lock().unwrap().release(owner, consumer, self.now()); self.wake(); result
    }
    pub fn release_slot(&self, owner: &str, consumer: &str, handoff: DirectorySizeHandoff) -> Result<(), String> {
        let mut core = self.core.lock().unwrap();
        let token = core.owner_token(owner)?;
        let result = core.release_slot(token, consumer, handoff, self.now());
        drop(core); self.wake(); result
    }
    pub fn lookup(&self, owner: &str, request: LookupDirectorySizesRequest) -> Result<DirectorySizeLookup, String> {
        let (lookup, scan) = {
            let mut core = self.core.lock().unwrap();
            (core.lookup(owner, request.clone(), self.now())?, core.disk_scan_for_lookup(owner, &request))
        };
        if lookup.stale || !lookup.directories.iter().any(|record| record.state == DirectorySizeRecordState::Unknown) { return Ok(lookup); }
        if let Some((store, scan)) = self.storage.lock().unwrap().clone().zip(scan) {
            if let Ok(pending) = store.lookup(request.paths.clone(), Some(scan)) { let _ = pending.recv_timeout(Duration::from_millis(50)); }
        }
        self.core.lock().unwrap().lookup(owner, request, self.now())
    }
    pub fn attach_listing_cache(&self, listing: &mut crate::domain::models::DirectoryListing) {
        use crate::domain::models::{EntryKind, LocationKind};
        if let Some(registry) = self.artifacts.lock().unwrap().clone() {
            let snapshot = registry.sample(); self.core.lock().unwrap().set_artifacts(snapshot, self.now());
        }
        listing.directory_size_cache = self.core.lock().unwrap().listing_display_cache(listing, self.now());
        if listing.location.kind != LocationKind::Local { return; }
        let Some(store) = self.storage.lock().unwrap().clone() else { return; };
        let deadline = Instant::now() + Duration::from_millis(50);
        let scan = self.core.lock().unwrap().disk_scan_for_scope(&listing.location.path);
        let known: std::collections::HashSet<_> = listing.directory_size_cache.as_ref().into_iter()
            .flat_map(|cache| &cache.directories).map(|record| record.path.as_str()).collect();
        let mut paths = std::iter::once(listing.location.path.clone()).filter(|path| scan.is_some() && !known.contains(path.as_str()))
            .chain(listing.entries.iter().filter(|entry| entry.kind == EntryKind::Directory && !entry.is_symlink
            && entry.created_at.is_some() && !known.contains(entry.path.as_str())).map(|entry| entry.path.clone()));
        loop {
            let batch: Vec<_> = paths.by_ref().take(256).collect();
            if batch.is_empty() { break; }
            let Ok(pending) = store.lookup(batch, scan.clone()) else { break; };
            // One total budget for the listing, never a separate timeout per child.
            if pending.recv_timeout(deadline.saturating_duration_since(Instant::now())).is_err() { break; }
            if Instant::now() >= deadline { break; }
        }
        listing.directory_size_cache = self.core.lock().unwrap().listing_display_cache(listing, self.now());
    }
    pub fn diagnostics(&self, owner: OwnerToken, path: &str) -> Result<DirectorySizeDiagnostics, String> {
        if path.len() > 65_536 { return Err("目录路径过长".into()); }
        let path = normalize_local_path(path)?;
        {
            let core = self.core.lock().unwrap();
            if core.owner_token(&owner.label)?.epoch != owner.epoch { return Err("统计窗口生命周期已结束".into()); }
        }
        let listing = crate::services::fs_service::list_directory(Path::new(&path), &[], |_| (vec![], None))
            .map_err(|error| error.to_string())?;
        // Use the actual bounded read queue, outside Core. Durable presence is
        // reported separately: a disk row does not certify live freshness.
        let store = self.storage.lock().unwrap().clone();
        let disk_read = match store.and_then(|store| store.lookup(vec![path], None).ok()) {
            Some(receiver) => match receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(Ok(hits)) if hits.is_empty() => DirectorySizeDiskRead::Miss,
                Ok(Ok(_)) => DirectorySizeDiskRead::Hit,
                Err(mpsc::RecvTimeoutError::Timeout) => DirectorySizeDiskRead::Pending,
                _ => DirectorySizeDiskRead::Unavailable,
            },
            None => DirectorySizeDiskRead::Unavailable,
        };
        let mut core = self.core.lock().unwrap();
        if core.owner_token(&owner.label)?.epoch != owner.epoch { return Err("统计窗口生命周期已结束".into()); }
        let mut report = core.diagnose_listing(&listing, self.now()); report.disk_read = disk_read;
        Ok(report)
    }
    pub fn invalidate_profile(&self, id: &str) { self.core.lock().unwrap().invalidate_profile(id, self.now()); self.wake(); }
    pub fn profile_update(&self, id: &str) -> ProfileUpdate<'_> {
        self.core.lock().unwrap().begin_profile_update(id, self.now()); self.wake();
        ProfileUpdate { service: self, id: id.into() }
    }
    pub fn shutdown(&self) {
        self.shutdown_with_timeout(Duration::from_secs(3));
    }
    pub fn shutdown_with_timeout(&self, timeout: Duration) {
        if self.stopped.swap(true, Ordering::SeqCst) { return; }
        let history = {
            let mut core = self.core.lock().unwrap_or_else(|error| error.into_inner());
            let scopes = core.views.freeze();
            if let Some(store) = &core.storage { store.update_views(scopes); }
            core.shutdown(); std::mem::take(&mut core.history)
        };
        self.wake();
        let storage = self.storage.lock().unwrap_or_else(|error| error.into_inner()).clone();
        if let Some(store) = storage {
            if let Err(error) = store.shutdown(timeout) { eprintln!("warning: directory size cache flush failed: {error}"); }
        }
        let history_path = self.history_path.lock().unwrap_or_else(|error| error.into_inner()).clone();
        if let Some(path) = history_path {
            if let Err(error) = history.save(&path) { eprintln!("warning: directory size history save failed: {error:#}"); }
        }
    }
}
impl Drop for DirectorySizeService { fn drop(&mut self) { self.shutdown(); } }

enum Message {
    Wake,
    Prepared(ScanJob, Option<RootIdentity>, Option<Box<dyn SizeWatch>>),
    Progress(ScanJob, ScanStats),
    Finished(ScanJob, ScanResult, Option<RootIdentity>),
    Identity(IdentityJob, Result<RootIdentity, String>),
}
fn apply_message(core: &mut Core, message: Message, now: u64) {
    match message {
        Message::Wake => {},
        Message::Prepared(job, identity, watch) => core.prepared(&job, identity, watch, now),
        Message::Progress(job, stats) => core.progress(&job, stats, now),
        Message::Finished(job, result, identity) => core.finished(&job, result, identity, now),
        Message::Identity(job, identity) => core.identity_finished(&job, identity, now),
    }
}
fn failed_result(reason: &str) -> ScanResult {
    ScanResult { directories: HashMap::new(), stats: ScanStats { errors: 1, ..Default::default() },
        outcome: ScanOutcome::Failed, accounted_bytes: 0, message: Some(reason.into()) }
}

struct NormalizedLocalSource { stream: Option<super::storage::ScanStream> }
impl MetadataSource for NormalizedLocalSource {
    fn directory_completed(&mut self, path: &str, size: &super::scan::DirectorySize) {
        if let Some(stream) = &mut self.stream { stream.completed(path, size); }
    }
    fn open_directory(&mut self, path: &str, cancelled: &AtomicBool) -> Option<Result<super::scan::DirectoryCursor, String>> {
        LocalMetadataSource.open_directory(path, cancelled).map(|result| result.map(|cursor| super::scan::DirectoryCursor {
            created_at: cursor.created_at, entries: Box::new(cursor.entries.map(|mut entry| {
                entry.directory_path = entry.directory_path.and_then(|path| normalize_local_path(&path).ok()); entry
            }))
        }))
    }
    fn read_directory(&mut self, path: &str, cancelled: &AtomicBool, visit: &mut dyn FnMut(MetadataEntry) -> bool) -> Result<(), String> {
        LocalMetadataSource.read_directory(path, cancelled, &mut |mut entry| {
            entry.directory_path = entry.directory_path.and_then(|path| normalize_local_path(&path).ok());
            visit(entry)
        })
    }
}
fn run_scan(job: &ScanJob, sender: &SyncSender<Message>, store: Option<&super::storage::Store>, artifacts: Option<Arc<super::artifacts::Registry>>) {
    if job.cancelled.load(Ordering::Relaxed) {
        let _ = sender.send(Message::Finished(job.clone(), failed_result("目录统计已取消"), None)); return;
    }
    let local = job.target.profile.is_none();
    let mut drain = None;
    if local {
        let before = read_root_identity(Path::new(&job.target.path)).ok();
        let watch = if before.is_some() { RecursiveWatch::open(&job.target.path) } else { None };
        let after = read_root_identity(Path::new(&job.target.path)).ok();
        let stable = before.is_some() && before == after;
        if stable { drain = watch.as_ref().map(RecursiveWatch::drain_handle); }
        let watch = if stable { watch.map(|watch| Box::new(watch) as Box<dyn SizeWatch>) } else { None };
        if sender.send(Message::Prepared(job.clone(), before.or(after), watch)).is_err() { return; }
        if before.is_some() && before != after {
            let _ = sender.send(Message::Finished(job.clone(), failed_result("根目录在开始统计时发生变化"), after)); return;
        }
    }
    let source: Result<Box<dyn MetadataSource>, String> = match &job.target.profile {
        Some(profile) => crate::services::remote_service::size_metadata::scan_source(profile, &job.target.path, &job.cancelled),
        None => Ok(Box::new(NormalizedLocalSource { stream: store.zip(job.storage.as_ref())
            .map(|(store, header)| super::storage::ScanStream::new(store.clone(), header.clone(), artifacts)) })),
    };
    let result = match source {
        Ok(mut source) => scan_directory(&job.target.path, source.as_mut(), &job.cancelled, ScanLimits::default(), |stats| {
            let _ = sender.try_send(Message::Progress(job.clone(), stats.clone()));
        }),
        Err(error) => failed_result(&error),
    };
    let identity = if local && !job.cancelled.load(Ordering::Relaxed) { read_root_identity(Path::new(&job.target.path)).ok() } else { None };
    // A quiet proxy mailbox is not evidence that the native lane has consumed
    // notifications caused before/during traversal. Fence completion first.
    if let Some(drain) = drain { drain.wait(); }
    let _ = sender.send(Message::Finished(job.clone(), result, identity));
}

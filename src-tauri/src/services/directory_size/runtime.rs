use std::{collections::HashMap, path::Path, sync::{Arc, Mutex, Weak, atomic::{AtomicBool, Ordering}, mpsc::{self, SyncSender}}, thread, time::{Duration, Instant}};
use crate::domain::{directory_sizes::*, models::RemoteProfile};
use super::{core::{Core, OwnerToken, ScanJob, IdentityJob, SizeWatch}, scan::{MetadataSource, ScanOutcome, ScanResult, ScanStats, ScanLimits, scan_directory},
    local::LocalMetadataSource, metadata::MetadataEntry, target::normalize_local_path, watch::{RootIdentity, RecursiveWatch, read_root_identity}};

pub type EventSink = dyn Fn(&str, DirectorySizeSnapshot) + Send + Sync;
pub struct DirectorySizeService {
    core: Arc<Mutex<Core>>, clock: Instant, started: AtomicBool,
    stopped: Arc<AtomicBool>, wake: Mutex<Option<SyncSender<Message>>>,
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
        started: AtomicBool::new(false), stopped: Arc::new(AtomicBool::new(false)), wake: Mutex::new(None) } }
}
impl DirectorySizeService {
    fn now(&self) -> u64 { self.clock.elapsed().as_millis().min(u64::MAX as u128) as u64 }
    pub fn start(&self, sink: Weak<EventSink>) {
        if self.stopped.load(Ordering::Relaxed) || self.started.swap(true, Ordering::SeqCst) { return; }
        let (sender, receiver) = mpsc::sync_channel(32);
        *self.wake.lock().unwrap() = Some(sender.clone());
        let core = self.core.clone(); let stopped = self.stopped.clone(); let clock = self.clock;
        // Native change-notification I/O is associated with the creating thread.
        // Keep traversal workers alive while their watches remain in the cache.
        let (scan_sender, scan_receiver) = mpsc::sync_channel::<ScanJob>(2);
        let scan_receiver = Arc::new(Mutex::new(scan_receiver));
        for _ in 0..2 {
            let receiver = scan_receiver.clone(); let sender = sender.clone();
            thread::spawn(move || loop {
                let job = receiver.lock().unwrap().recv();
                let Ok(job) = job else { break; };
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_scan(&job, &sender)));
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
                let (jobs, identity, events) = {
                    let mut core = core.lock().unwrap();
                    if let Some(message) = message { apply_message(&mut core, message, now); }
                    for message in receiver.try_iter().take(32) { apply_message(&mut core, message, now); }
                    core.tick(now);
                    (core.take_jobs(now), core.take_identity_job(now), core.drain_events())
                };
                for job in jobs { let _ = scan_sender.send(job); }
                if let Some(job) = identity { let _ = identity_sender.send(job); }
                if let Some(sink) = sink.upgrade() { for (owner, event) in events { sink(&owner, event); } }
            }
        });
        self.wake();
    }
    fn wake(&self) { if let Some(sender) = &*self.wake.lock().unwrap() { let _ = sender.try_send(Message::Wake); } }
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
    pub fn lookup(&self, owner: &str, request: LookupDirectorySizesRequest) -> Result<DirectorySizeLookup, String> { self.core.lock().unwrap().lookup(owner, request, self.now()) }
    pub fn invalidate_profile(&self, id: &str) { self.core.lock().unwrap().invalidate_profile(id, self.now()); self.wake(); }
    pub fn profile_update(&self, id: &str) -> ProfileUpdate<'_> {
        self.core.lock().unwrap().begin_profile_update(id, self.now()); self.wake();
        ProfileUpdate { service: self, id: id.into() }
    }
    pub fn shutdown(&self) { self.stopped.store(true, Ordering::SeqCst); self.core.lock().unwrap().shutdown(); self.wake(); }
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

struct NormalizedLocalSource;
impl MetadataSource for NormalizedLocalSource {
    fn read_directory(&mut self, path: &str, cancelled: &AtomicBool, visit: &mut dyn FnMut(MetadataEntry) -> bool) -> Result<(), String> {
        LocalMetadataSource.read_directory(path, cancelled, &mut |mut entry| {
            entry.directory_path = entry.directory_path.and_then(|path| normalize_local_path(&path).ok());
            visit(entry)
        })
    }
}
fn run_scan(job: &ScanJob, sender: &SyncSender<Message>) {
    if job.cancelled.load(Ordering::Relaxed) {
        let _ = sender.send(Message::Finished(job.clone(), failed_result("目录统计已取消"), None)); return;
    }
    let local = job.target.profile.is_none();
    if local {
        let before = read_root_identity(Path::new(&job.target.path)).ok();
        let watch = if before.is_some() { RecursiveWatch::open(&job.target.path) } else { None };
        let after = read_root_identity(Path::new(&job.target.path)).ok();
        let stable = before.is_some() && before == after;
        let watch = if stable { watch.map(|watch| Box::new(watch) as Box<dyn SizeWatch>) } else { None };
        if sender.send(Message::Prepared(job.clone(), before.or(after), watch)).is_err() { return; }
        if before.is_some() && before != after {
            let _ = sender.send(Message::Finished(job.clone(), failed_result("根目录在开始统计时发生变化"), after)); return;
        }
    }
    let source: Result<Box<dyn MetadataSource>, String> = match &job.target.profile {
        Some(profile) => crate::services::remote_service::size_metadata::scan_source(profile, &job.target.path, &job.cancelled),
        None => Ok(Box::new(NormalizedLocalSource)),
    };
    let result = match source {
        Ok(mut source) => scan_directory(&job.target.path, source.as_mut(), &job.cancelled, ScanLimits::default(), |stats| {
            let _ = sender.try_send(Message::Progress(job.clone(), stats.clone()));
        }),
        Err(error) => failed_result(&error),
    };
    let identity = if local && !job.cancelled.load(Ordering::Relaxed) { read_root_identity(Path::new(&job.target.path)).ok() } else { None };
    let _ = sender.send(Message::Finished(job.clone(), result, identity));
}

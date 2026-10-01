//! Single database owner. No database work runs while either service mutex is held.
use std::{collections::{HashMap, VecDeque}, path::PathBuf, sync::{Arc, Condvar, Mutex, mpsc}, thread, time::{Duration, Instant}};
use super::database::{Database, ScanHeader, StoredDirectory, StoredHit};
use super::operations::Operation;
use crate::domain::directory_sizes::{DirectorySizeViewScope, DirectorySizeStorageDiagnostics};
#[path = "queue_admission.rs"]
mod admission;

const QUEUE_BYTES: usize = 8 << 20;
const CONTROL_BYTES: usize = 256 << 10;
const RETRY_MS: [u64; 5] = [1000, 2000, 5000, 10_000, 30_000];
pub(super) type ReadReply = Result<Arc<ReadBatch>, String>;
pub(in crate::services::directory_size) struct ReadBatch { hits: Vec<StoredHit>, bytes: usize, shared: std::sync::Weak<Shared> }
impl std::ops::Deref for ReadBatch { type Target = Vec<StoredHit>; fn deref(&self) -> &Self::Target { &self.hits } }
impl Drop for ReadBatch {
    fn drop(&mut self) {
        if let Some(shared) = self.shared.upgrade() {
            shared.queue.lock().unwrap().reply_bytes -= self.bytes;
            shared.changed.notify_one();
        }
    }
}
type ReadSink = dyn Fn(&[String], Option<&str>, Result<&[StoredHit], &str>) + Send + Sync;

#[derive(Default)]
pub(super) struct Schedule { first: Option<u64>, last: u64 }
impl Schedule {
    pub fn dirty(&mut self, now: u64) { self.first.get_or_insert(now); self.last = now; }
    pub fn due(&self, now: u64, records: usize, bytes: usize) -> bool {
        self.first.is_some_and(|first| records >= 1024 || bytes >= 1 << 20
            || now.saturating_sub(self.last) >= 2000 || now.saturating_sub(first) >= 10_000)
    }
    fn deadline(&self) -> Option<u64> { self.first.map(|first| (first + 10_000).min(self.last + 2000)) }
}
enum Write {
    Append(ScanHeader, Vec<StoredDirectory>),
    Accept(ScanHeader, u64),
    Forget(Vec<super::super::forget::ForgetItem>, i64),
    Prepare(Operation, mpsc::SyncSender<Result<(), String>>),
    Authorize(Operation),
    Abort(String),
}
impl Write {
    fn apply(&self, db: &mut Database) -> anyhow::Result<()> {
        match self {
            Self::Append(header, records) => db.append(header, records),
            Self::Accept(header, ticket) => db.append(header, &[]).and_then(|_| db.publish(&header.id, *ticket)).map(|_| ()),
            Self::Forget(items, cutoff) => db.forget(items, *cutoff),
            Self::Prepare(operation, _) => db.prepare_operation(operation),
            Self::Authorize(operation) => db.authorize_operation(operation),
            Self::Abort(id) => db.abort_operation(id),
        }
    }
    fn records(&self) -> usize { match self { Self::Append(_, rows) => rows.len(), _ => 0 } }
    fn data(&self) -> bool { matches!(self, Self::Append(..)) }
    fn cost(&self) -> usize {
        let header = match self {
            Self::Forget(items, _) => return 256 + items.iter().map(|item| item.path().len() + 64).sum::<usize>(),
            Self::Append(header, _) | Self::Accept(header, _) => header,
            Self::Prepare(operation, _) | Self::Authorize(operation) => return 1024 + operation.paths.iter().map(|pair| pair.from.capacity() + pair.to.capacity() + 128).sum::<usize>()
                + operation.scans.iter().map(|scan| scan.capacity() + 64).sum::<usize>() + operation.patches.iter().map(|(path, fingerprint)| path.capacity() + fingerprint.as_ref().map_or(0, String::capacity) + 96).sum::<usize>(),
            Self::Abort(id) => return 256 + id.capacity(),
        };
        256 + header.id.capacity() + header.session.capacity() + header.root.capacity() + match self {
            Self::Append(_, rows) => rows.iter().map(admission::row_cost).sum::<usize>(),
            _ => 0,
        }
    }
}
struct Pending { work: Write, cost: usize, attempts: usize, retry_at: u64 }
#[cfg(test)]
#[derive(Default)]
struct TestHooks {
    iterations: u64, idle: bool, writes: Option<Arc<std::sync::atomic::AtomicU64>>,
    fail_maintenance: bool, maintenance_attempts: u64, hold_operations: bool,
}
#[derive(Clone, Hash, PartialEq, Eq)]
struct ReadKey { paths: Vec<String>, scan: Option<String> }
struct Readers { replies: Vec<mpsc::SyncSender<ReadReply>>, cost: usize }
struct Queue {
    writes: VecDeque<Pending>, reads: HashMap<ReadKey, Readers>, read_order: VecDeque<ReadKey>,
    bytes: usize, data_bytes: usize, reply_bytes: usize, records: usize, max_bytes: usize, reserved: usize,
    schedule: Schedule, draining: bool, stopping: bool, done: bool,
    flushes: Vec<mpsc::SyncSender<Result<(), String>>>,
    last_error: Option<String>, dropped_records: u64, last_commit: Option<chrono::DateTime<chrono::Utc>>,
    lost_write: Option<String>,
    views: Arc<Vec<DirectorySizeViewScope>>, views_version: u64,
    summary_schedule: Schedule, summary_pending: bool, summary_retry: u64, summary_attempts: usize,
    protection: super::maintenance::Protection,
    requests: super::maintenance::Requests, views_evict_at: Option<u64>,
    pending_fences: Vec<(String, String)>, reads_disabled: bool,
    ready: bool, read_only: bool, physical_bytes: u64, capacity_pressure: bool,
    #[cfg(test)] test: TestHooks,
}
impl Queue {
    fn new(max_bytes: usize, reserved: usize) -> Self {
        Self { writes: VecDeque::new(), reads: HashMap::new(), read_order: VecDeque::new(), bytes: 0,
            data_bytes: 0, reply_bytes: 0, records: 0, max_bytes, reserved, schedule: Schedule::default(),
            draining: false, stopping: false, done: false, flushes: vec![], last_error: None,
            dropped_records: 0, last_commit: None, lost_write: None, views: Arc::new(vec![]), views_version: 0,
            summary_schedule: Schedule::default(), summary_pending: false, summary_retry: 0, summary_attempts: 0,
            protection: super::maintenance::Protection::default(),
            requests: super::maintenance::Requests::default(), views_evict_at: None, pending_fences: vec![], reads_disabled: false,
            ready: false, read_only: false, physical_bytes: 0, capacity_pressure: false,
            #[cfg(test)] test: TestHooks::default(),
        }
    }
    fn finished_write(&mut self, pending: &Pending) {
        self.bytes -= pending.cost;
        if pending.work.data() { self.data_bytes -= pending.cost; }
        self.records -= pending.work.records();
        if self.writes.is_empty() { self.schedule = Schedule::default(); self.draining = false; }
    }
    fn read_blocked(&self, paths: &[String]) -> bool {
        self.reads_disabled || paths.iter().any(|path| self.pending_fences.iter().any(|(prefix, _)|
            super::super::rename_proof::contains(prefix, path)))
    }
    fn protection_snapshot(&self, active: Option<&Write>) -> super::maintenance::Protection {
        let mut protection = self.protection.clone();
        for work in active.into_iter().chain(self.writes.iter().map(|pending| &pending.work)) {
            if let Write::Append(header, _) | Write::Accept(header, _) = work {
                if !protection.scans.contains(&header.id) { protection.scans.push(header.id.clone()); }
            }
        }
        protection
    }
}
struct Shared { queue: Mutex<Queue>, changed: Condvar, clock: Instant }
#[derive(Clone)]
pub(in crate::services::directory_size) struct Store { shared: Arc<Shared> }
impl Store {
    #[cfg(test)]
    pub fn start_for_test(directory: PathBuf) -> Self { Self::start_with_sink(directory, Arc::new(|_, _, _| {})) }
    pub fn start_with_sink(directory: PathBuf, on_read: Arc<ReadSink>) -> Self {
        let store = Self::new(QUEUE_BYTES, CONTROL_BYTES);
        let shared = store.shared.clone();
        thread::Builder::new().name("directory-size-store".into()).spawn(move || run(shared, directory, on_read, RETRY_MS, None))
            .expect("start directory size storage worker");
        store
    }
    #[cfg(test)]
    pub fn start(directory: PathBuf) -> Self { Self::start_with_sink(directory, Arc::new(|_, _, _| {})) }
    fn new(max_bytes: usize, reserved: usize) -> Self {
        Self { shared: Arc::new(Shared { queue: Mutex::new(Queue::new(max_bytes, reserved)), changed: Condvar::new(), clock: Instant::now() }) }
    }
    #[cfg(test)]
    pub fn paused_for_test(max_bytes: usize, reserved: usize) -> Self { Self::new(max_bytes, reserved) }
    #[cfg(test)]
    pub fn resume_for_test(&self, directory: PathBuf) {
        self.resume_with_retry_for_test(directory, RETRY_MS);
    }
    #[cfg(test)]
    pub fn resume_with_retry_for_test(&self, directory: PathBuf, retry_ms: [u64; 5]) {
        let shared = self.shared.clone(); thread::spawn(move || run(shared, directory, Arc::new(|_, _, _| {}), retry_ms, None));
    }
    #[cfg(test)]
    pub fn resume_with_page_limit_for_test(&self, directory: PathBuf, pages: u32) {
        let shared = self.shared.clone(); thread::spawn(move || run(shared, directory, Arc::new(|_, _, _| {}), RETRY_MS, Some(pages)));
    }
    #[cfg(test)]
    pub fn queued_bytes(&self) -> usize { self.shared.queue.lock().unwrap().bytes }
    #[cfg(test)]
    pub fn iterations_for_test(&self) -> u64 { self.shared.queue.lock().unwrap().test.iterations }
    #[cfg(test)]
    pub fn idle_for_test(&self) -> bool { self.shared.queue.lock().unwrap().test.idle }
    /// `(draining, lost_write)`: Forget must never force a drain or mark a lost write.
    #[cfg(test)]
    pub fn write_flags_for_test(&self) -> (bool, bool) {
        let queue = self.shared.queue.lock().unwrap(); (queue.draining, queue.lost_write.is_some())
    }
    #[cfg(test)]
    pub fn vfs_writes_for_test(&self) -> u64 {
        self.shared.queue.lock().unwrap().test.writes.as_ref().map_or(0, |writes| writes.load(std::sync::atomic::Ordering::SeqCst))
    }
    #[cfg(test)]
    pub fn fail_maintenance_for_test(&self, fail: bool) { self.shared.queue.lock().unwrap().test.fail_maintenance = fail; }
    #[cfg(test)]
    pub fn maintenance_attempts_for_test(&self) -> u64 { self.shared.queue.lock().unwrap().test.maintenance_attempts }
    /// Holds authorized operations before their next copy step. Unlike release
    /// builds, a flush or shutdown while held is acknowledged before the copy ends.
    #[cfg(test)]
    pub fn hold_operations_for_test(&self, hold: bool) {
        self.shared.queue.lock().unwrap().test.hold_operations = hold; self.shared.changed.notify_all();
    }
    pub fn diagnostics(&self) -> DirectorySizeStorageDiagnostics {
        let queue = self.shared.queue.lock().unwrap();
        DirectorySizeStorageDiagnostics { ready: queue.ready, read_only: queue.read_only, reads_disabled: queue.reads_disabled,
            capacity_pressure: queue.capacity_pressure, queue_bytes: queue.bytes.to_string(), queue_limit_bytes: queue.max_bytes.to_string(),
            dropped_records: queue.dropped_records.to_string(), physical_bytes: queue.physical_bytes.to_string(),
            last_commit: queue.last_commit, last_error: queue.last_error.clone() }
    }
    fn enqueue(&self, mut work: Write) -> bool {
        let mut queue = self.shared.queue.lock().unwrap();
        let data = work.data();
        if queue.stopping || queue.done || queue.read_only {
            if matches!(work, Write::Forget(..)) { queue.last_error = Some("cache forget rejected: storage is read-only or stopping".into()); return false; }
            queue.rejected(work.records(), "cache write rejected: storage is read-only or stopping"); return false;
        }
        if !queue.admit(&mut work) {
            if matches!(work, Write::Forget(..)) { queue.last_error = Some("cache forget queue is full".into()); }
            else { queue.rejected(work.records(), "cache write queue is full"); }
            return false;
        }
        let cost = work.cost();
        queue.bytes += cost; if data { queue.data_bytes += cost; }
        if let Write::Accept(header, _) = &work {
            if !queue.protection.scans.contains(&header.id) { queue.protection.scans.push(header.id.clone()); }
        }
        if let Write::Append(header, _) | Write::Accept(header, _) = &work {
            if queue.protection.session.is_empty() { queue.protection.session = header.session.clone(); }
        } else if !matches!(work, Write::Forget(..)) { queue.draining = true; }
        queue.records += work.records(); queue.schedule.dirty(self.shared.clock.elapsed().as_millis() as u64);
        queue.writes.push_back(Pending { work, cost, attempts: 0, retry_at: 0 });
        self.shared.changed.notify_one(); true
    }
    pub fn append(&self, header: ScanHeader, mut records: Vec<StoredDirectory>) -> bool {
        records.shrink_to_fit();
        let work = Write::Append(header, records);
        if work.records() > 1024 || work.cost() > 1 << 20 {
            self.shared.queue.lock().unwrap().rejected(work.records(), "cache append batch exceeds the record or byte limit"); return false;
        }
        self.enqueue(work)
    }
    /// Called under Core's acceptance lock. Enqueue is bounded and never performs I/O.
    pub fn accept(&self, header: ScanHeader, ticket: u64) -> bool { self.enqueue(Write::Accept(header, ticket)) }
    pub fn forget(&self, items: Vec<super::super::forget::ForgetItem>, cutoff: i64) -> bool {
        if items.len() > 256 || items.iter().map(|item| item.path().len() + 64).sum::<usize>() > 1 << 20 {
            self.shared.queue.lock().unwrap().last_error = Some("cache forget batch exceeds its limit".into()); return false;
        }
        self.enqueue(Write::Forget(items, cutoff))
    }
    pub fn prepare_operation(&self, operation: Operation, timeout: Duration) -> Result<(), String> {
        let mut queue = self.shared.queue.lock().unwrap();
        let cost = operation.paths.iter().map(|pair| pair.from.len() + pair.to.len() + operation.id.len() * 2 + 128).sum::<usize>();
        let used = queue.pending_fences.iter().map(|(path, id)| path.len() + id.len() + 64).sum::<usize>();
        if queue.pending_fences.len() + operation.paths.len() * 2 > 1024 || used + cost > 1 << 20 {
            queue.reads_disabled = true; return Err("cache namespace fence capacity".into());
        }
        for path in operation.paths.iter().flat_map(|pair| [&pair.from, &pair.to]) { queue.pending_fences.push((path.clone(), operation.id.clone())); }
        drop(queue);
        let (reply, receiver) = mpsc::sync_channel(1);
        if !self.enqueue(Write::Prepare(operation, reply)) { return Err("cache operation queue is full".into()); }
        receiver.recv_timeout(timeout).map_err(|_| "cache operation fence timed out".to_string())?
    }
    pub fn authorize_operation(&self, operation: Operation) -> bool { self.enqueue(Write::Authorize(operation)) }
    pub fn abort_operation(&self, id: String) -> bool { self.enqueue(Write::Abort(id)) }
    pub fn update_views(&self, views: Arc<Vec<DirectorySizeViewScope>>) {
        let mut queue = self.shared.queue.lock().unwrap();
        if queue.stopping || queue.done || *queue.views == *views { return; }
        queue.protection.scopes = views.clone();
        let now = self.shared.clock.elapsed().as_millis() as u64;
        // Visible scopes change eviction tiers; restart an exhausted walk at most once a minute.
        if queue.capacity_pressure && queue.views_evict_at.is_none_or(|at| now.saturating_sub(at) >= 60_000) {
            queue.requests.evict = true; queue.views_evict_at = Some(now);
        }
        queue.views = views; queue.views_version += 1; queue.summary_pending = true; queue.summary_attempts = 0;
        queue.summary_schedule.dirty(self.shared.clock.elapsed().as_millis() as u64);
        self.shared.changed.notify_one();
    }
    /// Called every runtime tick; only an actual change of the pin set wakes the worker.
    pub fn protect(&self, session: &str, scans: Vec<String>) {
        let mut queue = self.shared.queue.lock().unwrap();
        let mut next: Vec<&String> = scans.iter().collect(); next.sort(); next.dedup();
        let mut old: Vec<&String> = queue.protection.scans.iter().collect(); old.sort(); old.dedup();
        if queue.protection.session == session && old == next { return; }
        let released: Vec<String> = old.into_iter().filter(|id| next.binary_search(id).is_err()).cloned().collect();
        for id in released { queue.requests.probe(id); }
        queue.requests.sweep = true; queue.requests.namespaces = true;
        if queue.capacity_pressure { queue.requests.evict = true; }
        queue.protection.session = session.into(); queue.protection.scans = scans;
        self.shared.changed.notify_one();
    }
    pub fn lookup(&self, paths: Vec<String>, scan: Option<String>) -> Result<mpsc::Receiver<ReadReply>, String> {
        if paths.len() > 256 || paths.iter().any(|path| path.len() > 65_536) { return Err("cache lookup path limit".into()); }
        let paths = paths.iter().map(|path| super::super::target::normalize_local_path(path)).collect::<Result<Vec<_>, _>>()?;
        let key = ReadKey { paths, scan };
        let cost = 512 + key.paths.iter().map(|path| path.capacity() * 2 + 64).sum::<usize>() + key.scan.as_ref().map_or(0, |scan| scan.capacity() * 2);
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut queue = self.shared.queue.lock().unwrap();
        if queue.stopping || queue.done { return Err("cache storage is stopping".into()); }
        if queue.read_blocked(&key.paths) {
            return Err("cache namespace change is awaiting persistence".into());
        }
        if let Some(readers) = queue.reads.get_mut(&key) {
            if readers.replies.len() >= 32 { return Err("cache read subscriber limit".into()); }
            readers.replies.push(sender); return Ok(receiver);
        }
        if queue.reads.len() >= 32 || queue.bytes.saturating_add(cost) > queue.max_bytes - queue.reserved {
            return Err("cache read queue is full".into());
        }
        queue.bytes += cost;
        queue.read_order.push_back(key.clone());
        queue.reads.insert(key, Readers { replies: vec![sender], cost });
        self.shared.changed.notify_one(); Ok(receiver)
    }
    #[cfg(test)]
    pub fn flush(&self, timeout: Duration) -> Result<(), String> { self.finish(false, timeout) }
    pub fn shutdown(&self, timeout: Duration) -> Result<(), String> { self.finish(true, timeout) }
    fn finish(&self, stop: bool, timeout: Duration) -> Result<(), String> {
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut queue = self.shared.queue.lock().unwrap();
        if queue.done { return queue.lost_write.clone().map_or(Ok(()), Err); }
        if queue.flushes.len() >= 16 { return Err("cache flush subscriber limit".into()); }
        queue.stopping |= stop; queue.flushes.push(sender);
        drop(queue); self.shared.changed.notify_one();
        receiver.recv_timeout(timeout).map_err(|_| "cache flush timed out".to_string())?
    }
}
impl Drop for Store {
    fn drop(&mut self) {
        if Arc::strong_count(&self.shared) == 2 {
            self.shared.queue.lock().unwrap().stopping = true; self.shared.changed.notify_one();
        }
    }
}

fn disk_full(error: &anyhow::Error) -> bool {
    error.downcast_ref::<rusqlite::Error>().is_some_and(|error| error.sqlite_error_code() == Some(rusqlite::ErrorCode::DiskFull))
}
fn run(shared: Arc<Shared>, directory: PathBuf, on_read: Arc<ReadSink>, retry_ms: [u64; 5], page_limit: Option<u32>) {
    use super::maintenance::{Kind, Maintenance};
    let mut database = None; let mut open_at = 0; let mut open_attempt = 0;
    let mut maintenance = Maintenance::default(); let mut maintain_at = 0;
    let mut operations_pending = false; let mut operation_retry = 0; let mut operation_attempts = 0;
    let mut sample_at = 0; let mut sample_due = true;
    loop {
        let now = shared.clock.elapsed().as_millis() as u64;
        #[cfg(test)] { shared.queue.lock().unwrap().test.iterations += 1; }
        if database.is_none() && now >= open_at {
            match Database::open(&directory) {
                Ok(db) => {
                    if let Some(pages) = page_limit.filter(|_| db.writable()) {
                        db.connection.pragma_update(None, "max_page_count", pages).expect("test page limit");
                    }
                    let pressure = db.writable() && Maintenance::pressure(&db).unwrap_or(false);
                    if db.writable() { maintenance.opened(pressure); }
                    let mut queue = shared.queue.lock().unwrap(); queue.ready = true; queue.read_only = !db.writable();
                    queue.capacity_pressure = pressure;
                    #[cfg(test)] { queue.test.writes = Some(db.vfs_writes()); }
                    queue.last_error = queue.read_only.then(|| "目录大小缓存由其他进程持有，当前仅可读取".into());
                    database = Some(db); sample_due = true;
                }
                Err(error) => {
                    shared.queue.lock().unwrap().last_error = Some(error.to_string());
                    open_at = now + retry_ms[open_attempt.min(4)]; open_attempt += 1;
                }
            }
        }
        if sample_due && now >= sample_at {
            let bytes = ["sizes.sqlite3", "sizes.sqlite3-wal", "sizes.sqlite3-shm", "sizes.sqlite3-journal", "startup.json", "startup.next", "writer.lock"]
                .iter().map(|name| std::fs::metadata(directory.join(name)).map_or(0, |meta| meta.len())).sum();
            shared.queue.lock().unwrap().physical_bytes = bytes; sample_at = now + 1000; sample_due = false;
        }
        let writable = database.as_ref().is_some_and(Database::writable);
        let mut queue = shared.queue.lock().unwrap();
        if let Some(key) = queue.read_order.pop_front() {
            let blocked = queue.read_blocked(&key.paths);
            drop(queue);
            let mut result = if blocked { Err("cache namespace change is awaiting persistence".into()) } else {
                database.as_ref().ok_or_else(|| "cache storage is not ready".to_string())
                    .and_then(|db| db.lookup(&key.paths, key.scan.as_deref()).map_err(|error| error.to_string()))
                    .and_then(|hits| {
                        let bytes = 512 + hits.iter().map(StoredHit::checked_bytes).sum::<anyhow::Result<usize>>().map_err(|error| error.to_string())?;
                        let mut queue = shared.queue.lock().unwrap();
                        if queue.reply_bytes.saturating_add(bytes) > 8 << 20 { return Err("cache read reply budget is full".into()); }
                        queue.reply_bytes += bytes;
                        Ok(Arc::new(ReadBatch { hits, bytes, shared: Arc::downgrade(&shared) }))
                    })
            };
            let blocked_after_read = shared.queue.lock().unwrap().read_blocked(&key.paths);
            if blocked_after_read { result = Err("cache namespace changed during read".into()); }
            on_read(&key.paths, key.scan.as_deref(), result.as_ref().map(|hits| hits.as_slice()).map_err(String::as_str));
            queue = shared.queue.lock().unwrap();
            let readers = queue.reads.remove(&key);
            if let Some(readers) = &readers {
                queue.bytes -= readers.cost;
            }
            if result.is_ok() {
                for path in &key.paths {
                    queue.protection.hot.retain(|old| old != path); queue.protection.hot.push(path.clone());
                }
                while queue.protection.hot.len() > 512 || queue.protection.hot.iter().map(|path| path.len() + 64).sum::<usize>() > 1 << 20 {
                    queue.protection.hot.remove(0);
                }
            }
            // Service one read between write batches; readers cannot starve dirty data.
            drop(queue);
            if let Some(readers) = readers { for reply in readers.replies { let _ = reply.try_send(result.clone()); } }
            drop(result); // A last reply releases its budget outside the queue lock.
            queue = shared.queue.lock().unwrap(); sample_due = true;
        }
        // Requests from other threads. Opening a writable database requests a
        // full convergence, so requests seen before that carry nothing.
        let requests = std::mem::take(&mut queue.requests);
        if writable { maintenance.absorb(requests); }
        let mut force = queue.stopping || !queue.flushes.is_empty();
        // Flush and shutdown drop an unfinished shrink even before its next step is due.
        if force { maintenance.abandon_shrink(); }
        let kind = (writable && now >= maintain_at).then(|| maintenance.next(force, !queue.writes.is_empty())).flatten();
        if let Some(kind) = kind {
            let protection = queue.protection_snapshot(None);
            #[cfg(test)] let fail = { queue.test.maintenance_attempts += 1; queue.test.fail_maintenance };
            drop(queue);
            let db = database.as_mut().unwrap();
            #[cfg(test)] let result = if fail { Err(anyhow::anyhow!("injected maintenance failure")) } else { maintenance.step(kind, db, &protection) };
            #[cfg(not(test))] let result = maintenance.step(kind, db, &protection);
            let pressure = result.as_ref().is_ok_and(|deleted| *deleted).then(|| Maintenance::pressure(db).ok()).flatten();
            queue = shared.queue.lock().unwrap();
            match result {
                Ok(_) => {
                    maintenance.succeeded();
                    if let Some(pressure) = pressure { maintenance.set_pressure(pressure); queue.capacity_pressure = pressure; }
                    maintain_at = now + if kind == Kind::Evict { 50 } else { 500 };
                }
                Err(error) => {
                    queue.last_error = Some(error.to_string());
                    match maintenance.failed(kind, &retry_ms) {
                        Some(delay) => maintain_at = now + delay,
                        None => queue.requests = Default::default(),
                    }
                }
            }
            sample_due = true;
            // The step ran unlocked; a flush or shutdown may have arrived meanwhile.
            force = queue.stopping || !queue.flushes.is_empty();
            if force { maintenance.abandon_shrink(); }
        }
        queue.draining |= force || queue.schedule.due(now, queue.records, queue.bytes);
        if queue.draining && database.is_some() && queue.writes.front().is_some_and(|pending| now >= pending.retry_at || force) {
            let mut pending = queue.writes.pop_front().unwrap();
            let priority = match &pending.work { Write::Append(header, records) => records.iter().map(|row| queue.priority(header, row)).min().unwrap_or(2), _ => 0 };
            let protection = queue.protection_snapshot(Some(&pending.work));
            drop(queue);
            let db = database.as_mut().unwrap();
            let mut result = pending.work.apply(db);
            let mut reclaimed = false;
            if db.writable() && result.as_ref().err().is_some_and(disk_full) {
                reclaimed = true;
                result = maintenance.reclaim_for(db, &protection, priority, pending.cost).and_then(|_| pending.work.apply(db));
            }
            // Pressure is sampled outside the queue lock after writes that grow the cache.
            let grows = reclaimed || result.is_ok() && matches!(pending.work, Write::Append(..) | Write::Accept(..));
            let pressure = (db.writable() && grows).then(|| Maintenance::pressure(db).ok()).flatten();
            let mut queue = shared.queue.lock().unwrap();
            if let Some(pressure) = pressure { maintenance.set_pressure(pressure); queue.capacity_pressure = pressure; }
            if reclaimed { maintenance.request_evict(true); }
            sample_due = true;
            match result {
                Ok(()) => {
                    match &pending.work {
                        Write::Prepare(operation, reply) => {
                            queue.pending_fences.retain(|(_, id)| id != &operation.id);
                            let _ = reply.try_send(Ok(()));
                        }
                        Write::Authorize(_) => { operations_pending = true; maintenance.request_sweep(); maintenance.request_namespaces(); }
                        Write::Abort(_) => { maintenance.request_sweep(); maintenance.request_namespaces(); }
                        Write::Append(..) => maintenance.request_evict(false),
                        Write::Forget(..) => {},
                        Write::Accept(header, _) => {
                            maintenance.request_probe(header.id.clone()); maintenance.request_sweep(); maintenance.request_evict(true);
                        }
                    }
                    // A write that lands after its scan lost its pin (cancelled) is garbage.
                    if let Write::Append(header, _) | Write::Accept(header, _) = &pending.work {
                        if !queue.protection.scans.contains(&header.id) { maintenance.request_sweep(); maintenance.request_namespaces(); }
                    }
                    queue.last_commit = Some(chrono::Utc::now());
                    if matches!(pending.work, Write::Accept(..) | Write::Forget(..)) && !queue.views.is_empty() {
                        queue.summary_pending = true; queue.summary_schedule.dirty(now);
                    }
                    queue.finished_write(&pending);
                }
                Err(error) => {
                    queue.last_error = Some(error.to_string());
                    if db.writable() && !force && pending.attempts < RETRY_MS.len() {
                        if disk_full(&error) { maintain_at = 0; }
                        pending.retry_at = now + retry_ms[pending.attempts]; pending.attempts += 1;
                        queue.writes.push_front(pending);
                    } else {
                        if let Write::Prepare(_, reply) = &pending.work { let _ = reply.try_send(Err(error.to_string())); }
                        if !matches!(pending.work, Write::Forget(..)) { queue.lost_write = Some(error.to_string()); }
                        queue.dropped_records += pending.work.records() as u64; queue.finished_write(&pending);
                    }
                }
            }
            continue;
        }
        #[cfg(test)] let held = queue.test.hold_operations;
        #[cfg(not(test))] let held = false;
        if operations_pending && !held && database.is_some() && (force || now >= operation_retry) {
            drop(queue);
            let db = database.as_mut().unwrap();
            let result = db.advance_operation();
            // Copies grow the cache like appends; a hard-full copy retries after eviction.
            let pressure = db.writable().then(|| Maintenance::pressure(db).ok()).flatten();
            let full = result.as_ref().err().is_some_and(disk_full);
            let mut queue = shared.queue.lock().unwrap(); sample_due = true;
            if let Some(pressure) = pressure { maintenance.set_pressure(pressure); queue.capacity_pressure = pressure; }
            maintenance.request_evict(full);
            if full { maintain_at = 0; }
            match result {
                Ok(pending) => {
                    operation_attempts = 0;
                    operations_pending = pending;
                    if !pending {
                        // Completion retires source scans and barriers.
                        maintenance.request_sweep(); maintenance.request_namespaces();
                        queue.summary_pending = true; queue.summary_schedule.dirty(now);
                    }
                }
                Err(error) => {
                    queue.last_error = Some(error.to_string());
                    if force || operation_attempts >= retry_ms.len() {
                        operations_pending = false; queue.lost_write = Some(error.to_string()); drop(queue);
                        // Keep persistent fences if even abort cannot be committed.
                        // Startup recovery will discard every invisible shadow.
                        let _ = database.as_mut().unwrap().recover_operations();
                        maintenance.request_sweep(); maintenance.request_namespaces();
                    } else { operation_retry = now + retry_ms[operation_attempts]; operation_attempts += 1; }
                }
            }
            continue;
        }
        if queue.summary_pending && database.is_some() && queue.writes.is_empty()
            && (force || now >= queue.summary_retry && queue.summary_schedule.due(now, 0, 0)) {
            let views = queue.views.clone(); let version = queue.views_version; drop(queue);
            let result = super::startup::save(database.as_mut().unwrap(), &directory, &views, super::startup::MAX_BYTES);
            let mut queue = shared.queue.lock().unwrap(); sample_due = true;
            match result {
                Ok(()) if version == queue.views_version => { queue.summary_pending = false; queue.summary_schedule = Schedule::default(); queue.summary_attempts = 0; }
                Ok(()) => {},
                Err(error) => {
                    queue.last_error = Some(error.to_string());
                    if force || queue.summary_attempts >= RETRY_MS.len() {
                        queue.summary_pending = false; queue.lost_write = Some(error.to_string());
                    } else {
                        queue.summary_retry = now + retry_ms[queue.summary_attempts]; queue.summary_attempts += 1;
                    }
                }
            }
            continue;
        }
        if force && (queue.writes.is_empty() || database.is_none()) {
            if database.is_none() {
                queue.lost_write = Some("cache storage is not ready".into());
                while let Some(pending) = queue.writes.pop_front() { queue.finished_write(&pending); }
            }
            let stopping = queue.stopping;
            drop(queue);
            let result = database.as_ref().map(|db| if db.writable() { db.checkpoint().map_err(|error| error.to_string()) } else { Ok(()) })
                .unwrap_or_else(|| Err("cache storage is not ready".into()));
            if stopping { drop(database.take()); }
            let mut queue = shared.queue.lock().unwrap(); sample_due = true;
            if let Err(error) = &result { queue.last_error = Some(error.clone()); }
            let result = queue.lost_write.clone().map_or(result, Err);
            queue.done = stopping;
            for reply in queue.flushes.drain(..) { let _ = reply.try_send(result.clone()); }
            if stopping { return; }
            continue;
        }
        // Idle invariant: the pending-work and deadline decision is made under
        // the same guard as the wait, so no notify between them can be lost.
        if force || !queue.read_order.is_empty() || !queue.requests.is_empty() { continue; }
        let mut deadline: Option<u64> = None;
        let mut due = |at: u64| deadline = Some(deadline.map_or(at, |old: u64| old.min(at)));
        if database.is_none() { due(open_at); }
        // Queued writes wait for the database; only its open retry can wake them.
        if let Some(front) = queue.writes.front().filter(|_| database.is_some()) {
            if queue.draining { due(front.retry_at); } else if let Some(at) = queue.schedule.deadline() { due(at); }
        }
        if writable && maintenance.pending() { due(maintain_at); }
        if operations_pending && !held { due(operation_retry); }
        if queue.summary_pending && database.is_some() && queue.writes.is_empty() {
            if let Some(at) = queue.summary_schedule.deadline() { due(at.max(queue.summary_retry)); }
        }
        if sample_due { due(sample_at); }
        let now = shared.clock.elapsed().as_millis() as u64;
        match deadline {
            None => {
                #[cfg(test)] { queue.test.idle = true; }
                #[cfg_attr(not(test), allow(unused_mut))]
                let mut _queue = shared.changed.wait(queue).unwrap();
                #[cfg(test)] { _queue.test.idle = false; }
            }
            Some(at) if at > now => { let _ = shared.changed.wait_timeout(queue, Duration::from_millis(at - now)).unwrap(); }
            Some(_) => {}
        }
    }
}

//! A bounded I/O lane owns every pending buffer until completion, including
//! after cancellation. Proxies can be retired while the Core mutex is held.
use super::{ChangeKind, WatchChanges, WatchEvent, RootIdentity};
use crate::services::watch_registry::{WatchClass, WatchRegistration};
use std::{sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, AtomicU64, Ordering}, mpsc::{self, SyncSender}},
    thread, time::{Duration, Instant}};
use windows::Win32::{Foundation::{CloseHandle, HANDLE, ERROR_IO_INCOMPLETE, WAIT_OBJECT_0, WAIT_TIMEOUT},
    Storage::FileSystem::*, System::{IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED}, Threading::WaitForSingleObject}};

const BUFFER_BYTES: usize = 64 * 1024;
const MAX_NATIVE_WATCHES: usize = 32;
static EPOCH: AtomicU64 = AtomicU64::new(1);
type Sender = SyncSender<OpenedWatch>;
// One process-wide owner includes retired I/O in the same capacity limit. A
// disappearing last proxy must not create a second lane while cancel is pending.
static LANE: OnceLock<Arc<Sender>> = OnceLock::new();

#[derive(Default, Debug)]
struct Mailbox { changes: WatchChanges, bytes: usize, ready: bool }
#[derive(Debug)]
struct Shared {
    epoch: u64, retired: Arc<AtomicBool>, drain: AtomicU64, mailbox: Mutex<Mailbox>,
}
impl Shared {
    fn lost(&self) {
        let mut state = self.mailbox.lock().unwrap();
        state.changes.lost = true;
        state.changes.events.clear(); state.bytes = 0;
    }
    fn publish(&self, events: Vec<WatchEvent>) {
        let cost = events.iter().map(|event| event.path.len() + 64).sum::<usize>();
        let mut state = self.mailbox.lock().unwrap();
        if state.changes.lost { return; }
        if cost > BUFFER_BYTES.saturating_sub(state.bytes) {
            state.changes.lost = true; state.changes.events.clear(); state.bytes = 0;
        } else {
            state.bytes += cost;
            state.changes.watermark += events.len() as u64;
            state.changes.events.extend(events);
        }
    }
}

#[derive(Debug)]
pub(crate) struct RecursiveWatch { shared: Arc<Shared>, _lane: Arc<Sender>, identity: RootIdentity }
pub(crate) struct WatchDrain { shared: Arc<Shared> }
impl WatchDrain {
    /// Runs on a scan/operation worker, never while holding Core.
    pub fn wait(&self) -> bool {
        let deadline = Instant::now() + Duration::from_secs(2);
        self.wait_until(deadline)
    }
    pub fn wait_until(&self, deadline: Instant) -> bool {
        let ticket = self.shared.drain.fetch_add(1, Ordering::AcqRel) + 1;
        loop {
            let state = self.shared.mailbox.lock().unwrap();
            if state.changes.lost || self.shared.retired.load(Ordering::Acquire) { return false; }
            if state.changes.drained_ticket >= ticket { return true; }
            drop(state);
            if Instant::now() >= deadline { self.shared.lost(); return false; }
            thread::sleep(Duration::from_millis(2));
        }
    }
}
impl RecursiveWatch {
    pub fn drain_handle(&self) -> WatchDrain { WatchDrain { shared: self.shared.clone() } }
    pub fn open(path: &str) -> Option<Self> {
        Self::open_before(path, None, Instant::now() + Duration::from_secs(2))
    }
    pub fn root_identity(&self) -> RootIdentity { self.identity }
    pub fn open_before(path: &str, permit: Option<u64>, deadline: Instant) -> Option<Self> {
        if Instant::now() >= deadline { return None; }
        // These potentially blocking opens run on the bounded scan worker,
        // never on the lane which services existing directory watches.
        let opened = OpenHandles::open_with_permit(path, permit)?;
        let identity = opened.identity;
        let shared = Arc::new(Shared { epoch: EPOCH.fetch_add(1, Ordering::Relaxed),
            retired: opened.registration.control().retire_flag(), drain: AtomicU64::new(0), mailbox: Mutex::new(Mailbox::default()) });
        let lane = lane();
        lane.try_send(OpenedWatch { opened, shared: shared.clone() }).ok()?;
        let proxy = Self { shared, _lane: lane, identity };
        loop {
            let (ready, lost) = { let state = proxy.shared.mailbox.lock().unwrap(); (state.ready, state.changes.lost) };
            if lost || Instant::now() >= deadline { return None; }
            if ready { return Some(proxy); }
            thread::sleep(Duration::from_millis(2));
        }
    }
    pub fn epoch(&self) -> u64 { self.shared.epoch }
    pub fn request_drain(&self) -> u64 { self.shared.drain.fetch_add(1, Ordering::AcqRel) + 1 }
    pub fn take_changes(&mut self) -> WatchChanges {
        let mut state = self.shared.mailbox.lock().unwrap();
        state.bytes = 0;
        WatchChanges { events: std::mem::take(&mut state.changes.events), lost: state.changes.lost || self.shared.retired.load(Ordering::Acquire),
            watermark: state.changes.watermark, drained_ticket: state.changes.drained_ticket }
    }
}
impl Drop for RecursiveWatch {
    fn drop(&mut self) { self.shared.retired.store(true, Ordering::Release); }
}

struct OpenHandles { directory: isize, security: isize, identity: RootIdentity, registration: WatchRegistration }
impl OpenHandles {
    #[cfg(test)]
    fn open(path: &str) -> Option<Self> {
        Self::open_with_permit(path, None)
    }
    fn open_with_permit(path: &str, permit: Option<u64>) -> Option<Self> {
        Self::open_with_hook(path, permit, || {})
    }
    fn open_with_hook(path: &str, permit: Option<u64>, after_directory_open: impl FnOnce()) -> Option<Self> {
        let registration = WatchRegistration::reserve(path, WatchClass::Size, permit)?;
        let path = windows_core::HSTRING::from(path);
        let directory = unsafe { CreateFileW(&path, FILE_LIST_DIRECTORY.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, None, OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_OVERLAPPED, None) }.ok()?;
        let mut opened = Self { directory: directory.0 as isize, security: 0, identity: RootIdentity([0; 4]), registration };
        after_directory_open();
        if opened.registration.retired() { return None; }
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        unsafe { GetFileInformationByHandle(directory, &mut info) }.ok()?;
        opened.identity = RootIdentity([u64::from(info.dwVolumeSerialNumber), (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
            (u64::from(info.ftCreationTime.dwHighDateTime) << 32) | u64::from(info.ftCreationTime.dwLowDateTime), 0]);
        let security = unsafe { FindFirstChangeNotificationW(&path, true, FILE_NOTIFY_CHANGE_SECURITY) }.ok()?;
        opened.security = security.0 as isize;
        if opened.registration.retired() { None } else { Some(opened) }
    }
    fn directory(&self) -> HANDLE { HANDLE(self.directory as *mut _) }
}
impl Drop for OpenHandles {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.directory()) };
        if self.security != 0 { let _ = unsafe { FindCloseChangeNotification(HANDLE(self.security as *mut _)) }; }
    }
}
struct OpenedWatch { opened: OpenHandles, shared: Arc<Shared> }

struct NativeWatch {
    opened: OpenHandles, shared: Arc<Shared>,
    // Boxes never move their storage when the lane's vector grows or shrinks.
    buffer: Box<[u32; BUFFER_BYTES / 4]>, overlapped: Box<OVERLAPPED>,
    pending: bool, cancelling: bool,
}
impl NativeWatch {
    fn new(prepared: OpenedWatch) -> Self {
        Self { opened: prepared.opened, shared: prepared.shared,
            buffer: Box::new([0; BUFFER_BYTES / 4]), overlapped: Box::new(OVERLAPPED::default()), pending: false, cancelling: false }
    }
    fn arm(&mut self) -> bool {
        let filter = FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME | FILE_NOTIFY_CHANGE_ATTRIBUTES |
            FILE_NOTIFY_CHANGE_SIZE | FILE_NOTIFY_CHANGE_LAST_WRITE | FILE_NOTIFY_CHANGE_CREATION;
        *self.overlapped = OVERLAPPED::default();
        self.pending = unsafe { ReadDirectoryChangesW(self.opened.directory(), self.buffer.as_mut_ptr().cast(),
            BUFFER_BYTES as u32, true, filter, None, Some(&mut *self.overlapped), None) }.is_ok();
        if !self.pending { self.shared.lost(); }
        else { self.opened.registration.mark_armed(); }
        self.pending
    }
    fn security_quiet(&self) -> bool {
        match unsafe { WaitForSingleObject(HANDLE(self.opened.security as *mut _), 0) } {
            WAIT_TIMEOUT => true,
            WAIT_OBJECT_0 => { self.shared.lost(); false }
            _ => { self.shared.lost(); false }
        }
    }
    /// Returns true only when all storage can safely be released.
    fn poll(&mut self, shutdown: bool) -> bool {
        let retired = shutdown || self.shared.retired.load(Ordering::Acquire) || self.shared.mailbox.lock().unwrap().changes.lost;
        if retired && self.pending && !self.cancelling {
            self.cancelling = true;
            // ERROR_NOT_FOUND is also a completion race, never permission to
            // free the OVERLAPPED. GetOverlappedResult remains the only fence.
            let _ = unsafe { CancelIoEx(self.opened.directory(), Some(&*self.overlapped)) };
        }
        if !self.pending { return true; }
        let ticket = self.shared.drain.load(Ordering::Acquire);
        for _ in 0..16 {
            let mut bytes = 0;
            match unsafe { GetOverlappedResult(self.opened.directory(), &*self.overlapped, &mut bytes, false) } {
                Err(error) if error.code() == ERROR_IO_INCOMPLETE.to_hresult() => {
                    if !retired && self.security_quiet() {
                        self.shared.mailbox.lock().unwrap().changes.drained_ticket = ticket;
                    }
                    return false;
                }
                Err(_) => { self.pending = false; self.shared.lost(); return true; }
                Ok(()) => {
                    self.pending = false;
                    if retired { self.shared.lost(); return true; }
                    if bytes == 0 || bytes as usize > BUFFER_BYTES { self.shared.lost(); return true; }
                    let raw = unsafe { std::slice::from_raw_parts(self.buffer.as_ptr().cast::<u8>(), bytes as usize) };
                    match decode_events(raw) { Some(events) => self.shared.publish(events), None => { self.shared.lost(); return true; } }
                    if !self.security_quiet() || !self.arm() { return true; }
                }
            }
        }
        false
    }
}

fn lane() -> Arc<Sender> {
    LANE.get_or_init(|| {
    let (sender, receiver) = mpsc::sync_channel::<OpenedWatch>(8);
    let sender = Arc::new(sender);
    thread::spawn(move || {
        let mut watches: Vec<NativeWatch> = vec![];
        let mut shutdown = false;
        loop {
            match receiver.recv_timeout(Duration::from_millis(5)) {
                Ok(prepared) => {
                    if watches.len() >= MAX_NATIVE_WATCHES || prepared.shared.retired.load(Ordering::Acquire) {
                        prepared.shared.lost(); // Not submitted: handles can close immediately.
                    } else {
                        let mut watch = NativeWatch::new(prepared);
                        if watch.arm() {
                            watch.shared.mailbox.lock().unwrap().ready = true;
                            watches.push(watch);
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => shutdown = true,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            watches.retain_mut(|watch| !watch.poll(shutdown));
            if shutdown && watches.is_empty() { break; }
            if shutdown { thread::sleep(Duration::from_millis(5)); }
        }
    });
    sender
    }).clone()
}

#[cfg(test)]
#[path = "watch_native_tests.rs"]
mod tests;

fn decode_events(raw: &[u8]) -> Option<Vec<WatchEvent>> {
    let mut events = vec![];
    let mut offset: usize = 0;
    loop {
        let header = raw.get(offset..offset.checked_add(12)?)?;
        let value = |index| u32::from_le_bytes(header[index..index + 4].try_into().unwrap()) as usize;
        let next = value(0); let action = value(4); let length = value(8);
        if length == 0 || length % 2 != 0 { return None; }
        let end = offset.checked_add(12)?.checked_add(length)?;
        let name = raw.get(offset + 12..end)?;
        let words: Vec<_> = name.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        let path = String::from_utf16(&words).ok()?;
        if path.starts_with(['\\', '/']) || path.chars().any(char::is_control) || path.contains(':') ||
            path.split(['\\', '/']).any(|part| part.is_empty() || matches!(part, "." | "..")) { return None; }
        let kind = match action { 1 => ChangeKind::Added, 2 => ChangeKind::Removed, 3 => ChangeKind::Modified,
            4 => ChangeKind::RenameOld, 5 => ChangeKind::RenameNew, _ => return None };
        events.push(WatchEvent { path, kind });
        if next == 0 { return Some(events); }
        if next % 4 != 0 || next < 12 + length { return None; }
        offset = offset.checked_add(next)?;
    }
}

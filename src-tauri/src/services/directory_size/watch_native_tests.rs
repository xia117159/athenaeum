use super::*;

#[test]
fn native_watch_open_handles_allow_watched_directory_rename() {
    let directory = Root::new();
    let old = directory.0.join("old"); let new = directory.0.join("new");
    fs::create_dir_all(old.join("deep")).unwrap();
    let mut watch = RecursiveWatch::open(old.to_str().unwrap()).unwrap();
    fs::rename(&old, &new).unwrap();
    assert!(watch.drain_handle().wait()); assert!(!watch.take_changes().lost);
    fs::write(new.join("deep/data"), b"change").unwrap();
    wait_until(|| !watch.take_changes().events.is_empty());
}

#[test]
fn native_watch_barrier_retires_live_handles_before_proxy_drop_and_tracks_late_handoff() {
    use crate::services::watch_registry::RenameBarrier;
    let root = Root::new(); let old = root.0.join("old"); let new = root.0.join("new");
    fs::create_dir_all(old.join("deep")).unwrap();
    let live = RecursiveWatch::open(old.join("deep").to_str().unwrap()).unwrap();
    let late = OpenHandles::open(old.join("deep").to_str().unwrap()).unwrap();
    let state = Arc::new(Shared { epoch: EPOCH.fetch_add(1, Ordering::Relaxed), retired: late.registration.control().retire_flag(),
        drain: AtomicU64::new(0), mailbox: Mutex::new(Mailbox::default()) });
    let barrier = RenameBarrier::new(&[(old.clone(), new.clone())]).unwrap();
    let closing = barrier.retire_descendants(); assert_eq!(closing.len(), 2);
    lane().send(OpenedWatch { opened: late, shared: state.clone() }).unwrap();
    wait_until(|| closing.iter().all(|watch| watch.closed()));
    assert!(!state.mailbox.lock().unwrap().ready);
    fs::rename(&old, &new).unwrap();
    assert!(RecursiveWatch::open(new.join("deep").to_str().unwrap()).is_none());
    drop(live); drop(barrier);
    assert!(RecursiveWatch::open(new.join("deep").to_str().unwrap()).is_some());
}

#[test]
fn native_watch_exact_opening_is_retired_before_rename_but_armed_exact_watch_survives() {
    use crate::services::watch_registry::{RenameBarrier, WatchClass, WatchRegistration};
    let root = Root::new(); let old = root.0.join("old"); let new = root.0.join("new"); fs::create_dir_all(&old).unwrap();
    let live = RecursiveWatch::open(old.to_str().unwrap()).unwrap();
    let (opened, opening) = std::sync::mpsc::channel(); let (resume, resumed) = std::sync::mpsc::channel();
    let path = old.to_str().unwrap().to_owned();
    let worker = thread::spawn(move || OpenHandles::open_with_hook(&path, None, || {
        opened.send(()).unwrap(); resumed.recv().unwrap();
    }));
    opening.recv().unwrap();
    let barrier = RenameBarrier::new(&[(old.clone(), new.clone())]).unwrap();
    let fresh_denied = WatchRegistration::reserve(old.to_str().unwrap(), WatchClass::Size, None).is_none();
    let closing = barrier.retire_descendants();
    resume.send(()).unwrap(); let late = worker.join().unwrap();
    assert!(fresh_denied, "new exact-path opens must not cross the gate");
    assert_eq!(closing.len(), 1, "the half-open exact reservation must retire, while the armed watch remains");
    assert!(late.is_none()); assert!(closing[0].closed());
    fs::rename(&old, &new).unwrap(); assert!(live.drain_handle().wait());
}

#[test]
fn native_watch_retirement_racing_successful_completion_is_observable_as_lost() {
    use crate::services::watch_registry::RenameBarrier;
    let root = Root::new(); let path = root.0.join("child");
    let opened = OpenHandles::open(path.to_str().unwrap()).unwrap(); let identity = opened.identity;
    let shared = Arc::new(Shared { epoch: EPOCH.fetch_add(1, Ordering::Relaxed), retired: opened.registration.control().retire_flag(),
        drain: AtomicU64::new(0), mailbox: Mutex::new(Mailbox::default()) });
    let mut native = NativeWatch::new(OpenedWatch { opened, shared: shared.clone() }); assert!(native.arm());
    let mut proxy = RecursiveWatch { shared, _lane: lane(), identity };
    fs::write(path.join("data"), b"changed").unwrap();
    wait_until(|| { let mut bytes = 0; unsafe { GetOverlappedResult(native.opened.directory(), &*native.overlapped, &mut bytes, false) }.is_ok() });
    let barrier = RenameBarrier::new(&[(root.0.clone(), root.0.with_extension("new"))]).unwrap();
    barrier.retire_descendants(); assert!(native.poll(false)); drop(native);
    assert!(proxy.take_changes().lost, "retired successful completion cannot masquerade as a quiet watch");
}

#[test]
fn native_watch_ready_wait_cannot_restart_an_expired_operation_deadline() {
    let root = Root::new();
    assert!(RecursiveWatch::open_before(root.0.to_str().unwrap(), None, Instant::now() - Duration::from_millis(1)).is_none());
}
use std::{fs, path::PathBuf};

struct Root(PathBuf);
impl Root { fn new() -> Self {
    let path = std::env::temp_dir().join(format!("athenaeum-watch-lifecycle-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(path.join("child")).unwrap(); Self(path)
} }
impl Drop for Root { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
fn wait_until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !condition() { assert!(Instant::now() < deadline, "native watch did not settle"); thread::sleep(Duration::from_millis(2)); }
}
fn shared() -> Arc<Shared> {
    Arc::new(Shared { epoch: EPOCH.fetch_add(1, Ordering::Relaxed), retired: Arc::new(AtomicBool::new(false)), drain: AtomicU64::new(0), mailbox: Mutex::new(Mailbox::default()) })
}

#[test]
fn native_watch_cancel_and_natural_completion_release_pending_storage() {
    for complete_first in [false, true] {
        let root = Root::new(); let shared = shared();
        let opened = OpenHandles::open(root.0.to_str().unwrap()).unwrap();
        let mut watch = NativeWatch::new(OpenedWatch { opened, shared: shared.clone() });
        assert!(watch.arm());
        if complete_first {
            fs::write(root.0.join("child/payload"), b"bytes").unwrap();
            wait_until(|| {
                let mut bytes = 0;
                unsafe { GetOverlappedResult(watch.opened.directory(), &*watch.overlapped, &mut bytes, false) }.is_ok()
            });
        }
        // Covers pending cancellation and CancelIoEx racing a completed read.
        wait_until(|| watch.poll(true));
        assert!(!watch.pending);
        drop(watch);
        assert_eq!(Arc::strong_count(&shared), 1);
    }
}

#[test]
fn native_watch_retired_handoff_and_repeated_proxy_drop_reclaim_all_objects() {
    let root = Root::new();
    let retired = shared(); retired.retired.store(true, Ordering::Release);
    lane().send(OpenedWatch { opened: OpenHandles::open(root.0.to_str().unwrap()).unwrap(), shared: retired.clone() }).unwrap();
    wait_until(|| Arc::strong_count(&retired) == 1);
    assert!(!retired.mailbox.lock().unwrap().ready);
    for _ in 0..12 {
        let watch = RecursiveWatch::open(root.0.to_str().unwrap()).unwrap();
        let state = watch.shared.clone();
        assert!(watch.drain_handle().wait());
        drop(watch);
        wait_until(|| Arc::strong_count(&state) == 1);
    }
}

#[test]
fn native_watch_drain_includes_name_events_and_security_changes_fail_closed() {
    use std::os::windows::process::CommandExt;
    let root = Root::new(); let mut watch = RecursiveWatch::open(root.0.to_str().unwrap()).unwrap();
    fs::rename(root.0.join("child"), root.0.join("renamed")).unwrap();
    assert!(watch.drain_handle().wait());
    let changes = watch.take_changes();
    assert!(changes.drained_ticket > 0 && changes.watermark >= 2);
    assert!(changes.events.iter().any(|event| event.kind == ChangeKind::RenameOld && event.path == "child"));
    assert!(changes.events.iter().any(|event| event.kind == ChangeKind::RenameNew && event.path == "renamed"));
    let status = std::process::Command::new("icacls.exe").arg(root.0.join("renamed")).arg("/inheritance:d")
        .creation_flags(0x08000000).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().unwrap();
    assert!(status.success(), "fixture DACL update failed");
    wait_until(|| watch.take_changes().lost);
    assert!(!watch.drain_handle().wait());
}

fn raw(action: u32, name: &[u16], next: u32) -> Vec<u8> {
    let mut bytes = vec![];
    for value in [next, action, (name.len() * 2) as u32] { bytes.extend(value.to_le_bytes()); }
    for word in name { bytes.extend(word.to_le_bytes()); }
    bytes
}
#[test]
fn native_watch_decoder_rejects_truncation_invalid_utf16_offsets_actions_and_paths() {
    let name: Vec<_> = "child".encode_utf16().collect();
    let valid = raw(4, &name, 0);
    assert_eq!(decode_events(&valid).unwrap()[0].kind, ChangeKind::RenameOld);
    for end in 0..valid.len() { assert!(decode_events(&valid[..end]).is_none()); }
    for bad in [raw(9, &name, 0), raw(3, &[0xd800], 0), raw(3, &[], 0), raw(3, &name, 12), raw(3, &name, 21)] {
        assert!(decode_events(&bad).is_none());
    }
    for name in ["..\\bad", "\\absolute", "a:stream", "x\\\\y"] {
        assert!(decode_events(&raw(3, &name.encode_utf16().collect::<Vec<_>>(), 0)).is_none());
    }
}

#[test]
fn native_watch_mailbox_overflow_is_sticky_and_never_unbounded() {
    let shared = shared();
    shared.publish(vec![WatchEvent { path: "x".repeat(BUFFER_BYTES), kind: ChangeKind::Modified }]);
    shared.publish(vec![WatchEvent { path: "small".into(), kind: ChangeKind::Modified }]);
    let mailbox = shared.mailbox.lock().unwrap();
    assert!(mailbox.changes.lost && mailbox.changes.events.is_empty());
    assert_eq!(mailbox.bytes, 0);
}

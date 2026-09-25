use super::desktop_shutdown::{Shutdown, complete_branches};
use std::{sync::{Arc, atomic::{AtomicBool, Ordering}, mpsc}, time::{Duration, Instant}};

#[test]
fn desktop_shutdown_cache_deadline_never_truncates_other_cleanup() {
    let gate = Arc::new(Shutdown::default()); assert!(gate.begin()); assert!(!gate.begin());
    let (release, guard) = mpsc::channel(); let (done, finished) = mpsc::channel();
    let other_done = Arc::new(AtomicBool::new(false)); let observed = other_done.clone();
    let thread_gate = gate.clone();
    let (cache_release, cache_guard) = mpsc::channel();
    std::thread::spawn(move || {
        complete_branches(Duration::from_millis(20), move |_| { cache_guard.recv().unwrap(); }, move || {
            guard.recv().unwrap(); observed.store(true, Ordering::SeqCst);
        });
        thread_gate.finish(); done.send(()).unwrap();
    });
    assert!(finished.recv_timeout(Duration::from_millis(50)).is_err());
    assert!(!other_done.load(Ordering::SeqCst)); assert!(!gate.finished());
    release.send(()).unwrap();
    assert!(finished.recv_timeout(Duration::from_secs(1)).is_ok()); assert!(gate.finished());
    cache_release.send(()).unwrap();
}

#[test]
fn desktop_shutdown_healthy_cache_and_other_cleanup_both_complete() {
    let cached = Arc::new(AtomicBool::new(false)); let observed = cached.clone();
    let now = Instant::now();
    complete_branches(Duration::from_secs(1), move |_| { observed.store(true, Ordering::SeqCst); }, || {});
    assert!(cached.load(Ordering::SeqCst)); assert!(now.elapsed() < Duration::from_secs(1));
}

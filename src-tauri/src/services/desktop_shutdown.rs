use std::{sync::{Arc, atomic::{AtomicU8, Ordering}, mpsc}, time::{Duration, Instant}};
use tauri::{Emitter, Manager};
use super::AppState;

/// One close task shared by CloseRequested, ExitRequested and Destroyed.
#[derive(Default)]
pub struct Shutdown { phase: AtomicU8 }
impl Shutdown {
    pub fn begin(&self) -> bool { self.phase.compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst).is_ok() }
    pub fn finish(&self) { self.phase.store(2, Ordering::SeqCst); }
    pub fn finished(&self) -> bool { self.phase.load(Ordering::SeqCst) == 2 }
}

pub(super) fn complete_branches(cache_budget: Duration, cache: impl FnOnce(Instant) + Send + 'static, other: impl FnOnce()) {
    let deadline = Instant::now() + cache_budget; let (done, finished) = mpsc::sync_channel(1);
    std::thread::spawn(move || { cache(deadline); let _ = done.send(()); });
    // RegisteredOpen guards can outlive the cache budget, including closed owners.
    other();
    if finished.recv_timeout(deadline.saturating_duration_since(Instant::now())).is_err() {
        eprintln!("warning: directory size exit flush exceeded its time budget");
    }
}

pub fn begin(app: &tauri::AppHandle, code: i32) {
    let state = app.state::<Arc<AppState>>().inner().clone();
    if !state.shutdown.begin() { return; }
    state.file_open_jobs.begin_shutdown();
    let notifications = state.directory_sizes.collect_views(uuid::Uuid::new_v4().to_string());
    for (owner, notification) in notifications { let _ = app.emit_to(&owner, "directory_size_views_flush_requested", notification); }
    let app = app.clone();
    std::thread::spawn(move || {
        let cache_state = state.clone();
        complete_branches(Duration::from_secs(3), move |deadline| {
            let collect_until = (Instant::now() + Duration::from_millis(750)).min(deadline);
            while !cache_state.directory_sizes.views_collected() && Instant::now() < collect_until {
                std::thread::sleep(Duration::from_millis(10));
            }
            cache_state.directory_sizes.freeze_views();
            cache_state.directory_sizes.shutdown_with_timeout(deadline.saturating_duration_since(Instant::now()));
        }, || state.file_open_jobs.shutdown());
        state.shutdown.finish();
        app.exit(code);
    });
}

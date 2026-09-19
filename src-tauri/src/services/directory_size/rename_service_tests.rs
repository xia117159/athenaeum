use super::*;
use std::{fs, path::PathBuf, sync::{Mutex, atomic::AtomicBool}, time::{Duration, Instant}};
use crate::{domain::models::*, services::{directory_size::{DirectorySizeService, rename_proof, watch::WatchChanges}, operation_service::{self, OperationStore}}};

struct TestDirectory(PathBuf);
impl TestDirectory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("athenaeum-rename-service-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(path.join("old")).unwrap(); Self(path)
    }
}
impl Drop for TestDirectory { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

struct ControlledDrain {
    state: Mutex<(u64, Instant)>, cancellation: Option<Arc<AtomicBool>>, delay_finish: bool,
}
impl SizeWatch for ControlledDrain {
    fn poll(&mut self) -> WatchPoll { WatchPoll::Quiet }
    fn epoch(&self) -> u64 { 17 }
    fn request_drain(&self) -> u64 {
        let mut state = self.state.lock().unwrap(); state.0 += 1; state.1 = Instant::now();
        if let Some(cancelled) = &self.cancellation { cancelled.store(true, Ordering::SeqCst); }
        state.0
    }
    fn changes(&mut self) -> WatchChanges {
        let state = self.state.lock().unwrap();
        let ready = !self.delay_finish || state.0 <= 1 || state.1.elapsed() >= Duration::from_millis(1300);
        WatchChanges { drained_ticket: if ready { state.0 } else { state.0.saturating_sub(1) }, ..Default::default() }
    }
}
fn service(path: &std::path::Path, cancellation: Option<Arc<AtomicBool>>, delay_finish: bool) -> DirectorySizeService {
    let service = DirectorySizeService::default(); service.open_owner("main");
    let mut core = service.core.lock().unwrap(); subscribe(&mut core, "old", path.to_str().unwrap(), 0);
    let job = core.take_jobs(0).remove(0);
    let identity = rename_proof::read_proof(path.to_str().unwrap()).unwrap().identity;
    core.prepared(&job, Some(identity), Some(Box::new(ControlledDrain {
        state: Mutex::new((0, Instant::now())), cancellation, delay_finish,
    })), 0);
    core.finished(&job, result(&job, 0), Some(identity), 0);
    drop(core); service
}

#[test]
fn rename_service_cancellation_during_preparation_prevents_the_single_task_syscall() {
    let directory = TestDirectory::new(); let old = directory.0.join("old"); let new = directory.0.join("new");
    let cancellation = Arc::new(AtomicBool::new(false));
    let service = service(&old, Some(cancellation.clone()), false);
    let intent = OperationIntent { request_id: "cancel-during-prepare".into(), source: OperationRequestSource::Shortcut,
        panel_id: None, tab_id: None, kind: OperationIntentKind::Rename, sources: None, destination: None,
        source_path: Some(OperationPathRef::Local { path: old.to_str().unwrap().into() }), new_name: Some("new".into()),
        parent: None, name: None, undo_record_id: None, conflict_policy: None };
    let mut store = OperationStore::load_from(directory.0.join("journal.json")).unwrap();
    let (queued, _) = store.queue_operation(intent.clone());
    let execution = operation_service::execute_operation_task_with_sizes(&queued.snapshot.task_id, &intent, None,
        cancellation.clone(), None, Some(&service));
    assert!(cancellation.load(Ordering::SeqCst), "cancellation occurs inside the cache preparation drain");
    let terminal = store.finish_operation(&queued.snapshot.task_id, &intent, execution).unwrap();
    assert_eq!(terminal.snapshot.status, OperationTaskStatus::Cancelled);
    assert!(old.is_dir()); assert!(!new.exists());
    assert_eq!(service.core.lock().unwrap().cache_bytes(), 0);
}

#[test]
fn rename_service_finish_drains_share_one_two_second_budget() {
    let directory = TestDirectory::new(); let old = directory.0.join("old"); let new = directory.0.join("new");
    let service = service(&old, None, true);
    let mut session = service.begin_rename(&[(old.clone(), new.clone())], true);
    session.step(&old, &new, || Ok(fs::rename(&old, &new)?)).unwrap();
    // Each drain individually fits two seconds; together they exceed the one finish budget.
    assert!(!session.finish(true), "two drains cannot each receive a fresh two-second deadline");
    assert!(new.is_dir()); assert_eq!(service.core.lock().unwrap().cache_bytes(), 0);
}

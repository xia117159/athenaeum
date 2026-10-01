use super::*;
use super::on_demand_tests::subscribe_intent;
use super::super::watch::{WatchChanges, WatchEvent, ChangeKind};
use std::sync::Mutex;

pub(super) struct Events(Arc<Mutex<WatchChanges>>);
impl SizeWatch for Events {
    fn poll(&mut self) -> WatchPoll { WatchPoll::Quiet }
    fn changes(&mut self) -> WatchChanges { std::mem::take(&mut *self.0.lock().unwrap()) }
}
pub(super) fn watch(core: &mut Core, job: &ScanJob) -> Arc<Mutex<WatchChanges>> {
    let events = Arc::new(Mutex::new(WatchChanges::default()));
    core.prepared(job, Some(RootIdentity([1,2,3,4])), Some(Box::new(Events(events.clone()))), 0); events
}
pub(super) fn changed(events: &Mutex<WatchChanges>, path: &str, kind: ChangeKind) { events.lock().unwrap().events.push(WatchEvent { path: path.into(), kind }); }
pub(super) fn tree(job: &ScanJob) -> ScanResult {
    let mut result = result(job, 100);
    let mut size = result.directories[&*job.target.path].clone(); size.created_at = Some(chrono::DateTime::UNIX_EPOCH);
    for suffix in ["", "\\a", "\\a\\deep", "\\b"] { result.directories.insert(Arc::from(format!("{}{suffix}", job.target.path)), size.clone()); }
    result
}
pub(super) fn records(core: &mut Core, id: &str, now: u64) -> Vec<DirectorySizeRecord> {
    let generation = core.snapshot(id).unwrap().generation;
    let lookup = core.lookup("main", LookupDirectorySizesRequest { consumer_id: id.into(), generation,
        paths: ["C:\\root", "C:\\root\\a", "C:\\root\\a\\deep", "C:\\root\\b"].map(String::from).into() }, now).unwrap();
    assert!(!lookup.stale); lookup.directories
}
pub(super) fn state(record: &DirectorySizeRecord) -> String { serde_json::to_value(record).unwrap()["state"].as_str().unwrap().into() }

#[test]
fn size_stale_modified_directory_marks_it_and_ancestors_without_rescanning_manual() {
    let mut core = core();
    subscribe_intent(&mut core, "a", "C:\\root", "calculate", false, 0);
    let job = core.take_jobs(0).remove(0); let events = watch(&mut core, &job);
    core.finished(&job, tree(&job), Some(RootIdentity([1,2,3,4])), 1);
    changed(&events, "a", ChangeKind::Modified); core.tick(2);
    let rows = records(&mut core, "a", 2);
    assert_eq!(rows.iter().map(state).collect::<Vec<_>>(), ["stale", "stale", "complete", "complete"]);
    assert_eq!(rows[1].bytes.as_deref(), Some("100"));
    assert!(core.snapshot("a").unwrap().total_bytes.is_none());
    assert_eq!(core.snapshot("a").unwrap().generation, job.generation);
    assert!(core.take_jobs(50000).is_empty());
}

#[test]
fn size_stale_unc_child_change_invalidates_and_forgets_the_canonical_share_root() {
    let mut core = core(); core.history_enabled = true;
    subscribe_intent(&mut core, "share", "\\\\server\\share", "calculate", false, 0);
    let job = core.take_jobs(0).remove(0); let events = watch(&mut core, &job);
    core.finished(&job, tree(&job), Some(RootIdentity([1,2,3,4])), 1);
    assert!(core.history.get(&job.target.path).is_some());
    changed(&events, "a\\file.txt", ChangeKind::Modified); core.tick(2);
    let lookup = core.lookup("main", LookupDirectorySizesRequest { consumer_id: "share".into(), generation: job.generation,
        paths: vec![job.target.path.clone(), format!("{}\\b", job.target.path)] }, 2).unwrap();
    assert_eq!(lookup.directories.iter().map(state).collect::<Vec<_>>(), ["stale", "complete"]);
    assert!(core.history.get(&job.target.path).is_none(), "canonical share-root history must not survive a child change");
    assert!(core.take_jobs(50000).is_empty());
}

#[test]
fn size_stale_tilde_in_root_or_ancestors_never_forgets_outside_the_watched_root() {
    for path in [r"C:\base\repo~1", r"C:\repo~1", r"C:\base~1\root", r"\\server~1\share\root"] {
        for during_scan in [false, true] {
            let mut core = core(); core.history_enabled = true;
            let sibling = normalize_local_path(&format!(r"{}\other", super::super::stale::parent(&normalize_local_path(path).unwrap()).unwrap())).unwrap();
            subscribe_intent(&mut core, "sibling", &sibling, "calculate", false, 0);
            let sibling_job = core.take_jobs(0).remove(0); watch(&mut core, &sibling_job);
            core.finished(&sibling_job, tree(&sibling_job), Some(RootIdentity([1,2,3,4])), 1);
            assert!(core.history.get(&sibling).is_some());
            subscribe_intent(&mut core, "root", path, "calculate", false, 2);
            let job = core.take_jobs(2).remove(0); let events = watch(&mut core, &job);
            if !during_scan { core.finished(&job, tree(&job), Some(RootIdentity([1,2,3,4])), 3); }
            changed(&events, r"a\file.txt", ChangeKind::Modified); core.tick(4);
            if during_scan {
                assert!(!job.cancelled.load(Ordering::Relaxed));
                core.finished(&job, tree(&job), Some(RootIdentity([1,2,3,4])), 5);
            }
            assert!(core.history.get(&sibling).is_some(), "{path}, during_scan={during_scan}: unrelated sibling history");
            let lookup = core.lookup("main", LookupDirectorySizesRequest { consumer_id: "root".into(), generation: job.generation,
                paths: ["", r"\a", r"\a\deep", r"\b"].map(|suffix| format!("{}{suffix}", job.target.path)).into() }, 6).unwrap();
            assert_eq!(lookup.directories.iter().map(state).collect::<Vec<_>>(), ["stale", "stale", "complete", "complete"]);
            assert!(core.history.get(&job.target.path).is_none());
            for (path, recursive, _) in core.forgotten_paths() {
                assert_eq!(normalize_local_path(path).as_deref(), Ok(path), "all persistent Forget inputs must be canonical");
                assert!(!recursive || super::super::rename_proof::contains(&job.target.path, path));
            }
        }
    }
}

#[test]
fn size_stale_short_event_components_still_forget_only_their_parent_subtree() {
    for during_scan in [false, true] {
        for event in [r"a\DEEP~1\file.txt", r"a\~1\file.txt", r"CHILD~1\file.txt"] {
            let mut core = core(); core.history_enabled = true;
            subscribe_intent(&mut core, "root", r"C:\repo~1", "calculate", false, 0);
            let job = core.take_jobs(0).remove(0); let events = watch(&mut core, &job);
            if !during_scan { core.finished(&job, tree(&job), Some(RootIdentity([1,2,3,4])), 1); }
            changed(&events, event, ChangeKind::Modified); core.tick(2);
            if during_scan { core.finished(&job, tree(&job), Some(RootIdentity([1,2,3,4])), 3); }
            let lookup = core.lookup("main", LookupDirectorySizesRequest { consumer_id: "root".into(), generation: job.generation,
                paths: ["", r"\a", r"\a\deep", r"\b"].map(|suffix| format!("{}{suffix}", job.target.path)).into() }, 4).unwrap();
            let sibling = if event.starts_with("a\\") { "complete" } else { "stale" };
            assert_eq!(lookup.directories.iter().map(state).collect::<Vec<_>>(), ["stale", "stale", "stale", sibling]);
            for (path, recursive, _) in core.forgotten_paths() {
                assert_eq!(normalize_local_path(path).as_deref(), Ok(path));
                assert!(!recursive || super::super::rename_proof::contains(&job.target.path, path));
            }
        }
    }
}

#[test]
fn size_stale_structural_directory_change_forgets_descendants_and_late_history() {
    let mut core = core(); core.history_enabled = true;
    subscribe_intent(&mut core, "a", "C:\\root", "calculate", false, 0);
    let job = core.take_jobs(0).remove(0); let events = watch(&mut core, &job); let result = tree(&job);
    core.finished(&job, tree(&job), Some(RootIdentity([1,2,3,4])), 1);
    let deep = normalize_local_path("C:\\root\\a\\deep").unwrap();
    assert!(core.history.get(&deep).is_some());
    changed(&events, "a", ChangeKind::Removed); core.tick(2);
    assert_eq!(records(&mut core, "a", 2).iter().map(state).collect::<Vec<_>>(), ["stale", "stale", "stale", "complete"]);
    assert!(core.history.get(&deep).is_none());
    let old = super::super::storage::StoredHit { record: super::super::storage::StoredDirectory { path: deep.clone(),
        size: result.directories[deep.as_str()].clone(), artifact_capture: None }, scan_id: "late".into(), source: 1, publication: 50,
        captured_at: chrono::DateTime::UNIX_EPOCH, policy_version: 2 };
    core.install_stored(&[old]); assert!(core.history.get(&deep).is_none());
    core.release("main", "a", 3).unwrap();
    changed(&events, "another", ChangeKind::Modified); core.tick(4);
    assert!(core.history.get(&deep).is_none(), "retiring a root cannot put forgotten rows back");
    assert!(core.history.get(&normalize_local_path("C:\\root\\b").unwrap()).is_some());
}

#[test]
fn size_stale_changes_during_scan_keep_token_and_fold_pending_into_result() {
    let mut core = core();
    subscribe_intent(&mut core, "a", "C:\\root", "calculate", false, 0);
    let job = core.take_jobs(0).remove(0); let events = watch(&mut core, &job);
    changed(&events, "a\\file.txt", ChangeKind::Modified); core.tick(2);
    assert!(!job.cancelled.load(Ordering::Relaxed));
    core.finished(&job, tree(&job), Some(RootIdentity([1,2,3,4])), 3);
    assert_eq!(records(&mut core, "a", 3).iter().map(state).collect::<Vec<_>>(), ["stale", "stale", "complete", "complete"]);
    assert!(core.take_jobs(50000).is_empty());
}

#[test]
fn size_stale_watch_loss_and_resume_without_watch_allow_only_advisory_reads() {
    let mut core = core();
    subscribe_intent(&mut core, "a", "C:\\root", "calculate", false, 0);
    let job = core.take_jobs(0).remove(0);
    core.finished(&job, tree(&job), None, 1);
    let snapshot = subscribe_intent(&mut core, "b", "C:\\root", "resume", false, 2);
    assert_eq!(snapshot.phase, DirectorySizePhase::Stale);
    assert_eq!(serde_json::to_value(snapshot).unwrap()["staleReadable"], true);
    assert!(records(&mut core, "b", 2).iter().all(|row| state(row) == "stale"));
    assert!(core.take_jobs(50000).is_empty());
}

#[test]
fn size_stale_auto_waits_thirty_seconds_after_long_scan_finishes() {
    let mut core = core();
    subscribe_intent(&mut core, "a", "C:\\root", "auto", true, 0);
    let job = core.take_jobs(0).remove(0); let events = watch(&mut core, &job);
    changed(&events, "a\\file", ChangeKind::Modified);
    core.finished(&job, tree(&job), Some(RootIdentity([1,2,3,4])), 40000);
    core.tick(40500); assert!(core.take_jobs(69999).is_empty());
    core.tick(70000); assert_eq!(core.take_jobs(70000).len(), 1);
}

#[test]
fn size_stale_derived_auto_reroots_to_browsed_scope_leaving_manual_parent() {
    let mut core = core();
    subscribe_intent(&mut core, "parent", "C:\\root", "calculate", false, 0);
    let job = core.take_jobs(0).remove(0); let events = watch(&mut core, &job);
    core.finished(&job, tree(&job), Some(RootIdentity([1,2,3,4])), 1);
    subscribe_intent(&mut core, "child", "C:\\root\\a", "auto", true, 2);
    changed(&events, "a\\file", ChangeKind::Modified); core.tick(3); core.tick(503);
    let next = core.take_jobs(503); assert_eq!(next.len(), 1);
    assert_eq!(next[0].target.path, normalize_local_path("C:\\root\\a").unwrap());
    assert_eq!(core.snapshot("parent").unwrap().generation, job.generation);
}

#[test]
fn size_stale_internal_operation_in_subtree_does_not_cancel_manual_scan() {
    let mut core = core();
    subscribe_intent(&mut core, "a", "C:\\root", "calculate", false, 0);
    let job = core.take_jobs(0).remove(0); watch(&mut core, &job);
    core.invalidate_local_paths(&[normalize_local_path("C:\\root\\a").unwrap()], 1);
    assert!(!job.cancelled.load(Ordering::Relaxed));
    core.finished(&job, tree(&job), Some(RootIdentity([1,2,3,4])), 2);
    assert_eq!(state(&records(&mut core, "a", 2)[2]), "stale");
}

fn with_dirs(job: &ScanJob, names: impl IntoIterator<Item = String>) -> ScanResult {
    let mut result = tree(job);
    let size = result.directories[&*job.target.path].clone();
    for name in names { result.directories.insert(Arc::from(format!("{}\\{name}", job.target.path)), size.clone()); }
    result
}
fn states(core: &mut Core, id: &str, now: u64) -> Vec<String> { records(core, id, now).iter().map(state).collect() }

#[test]
fn size_stale_idle_file_burst_marks_only_the_parent_chain() {
    let mut core = core();
    subscribe_intent(&mut core, "a", "C:\\root", "calculate", false, 0);
    let job = core.take_jobs(0).remove(0); let events = watch(&mut core, &job);
    core.finished(&job, tree(&job), Some(RootIdentity([1,2,3,4])), 1);
    let revision = core.snapshot("a").unwrap().invalidation_revision;
    for index in 0..300 { changed(&events, &format!("a\\file{index}.txt"), ChangeKind::Added); }
    core.tick(2);
    assert_eq!(states(&mut core, "a", 2), ["stale", "stale", "complete", "complete"], "files never mark their directory's subtree");
    assert_ne!(core.snapshot("a").unwrap().invalidation_revision, revision);
    assert!(core.snapshot("a").unwrap().invalidated);
}

#[test]
fn size_stale_idle_overflow_collapses_to_the_common_ancestor_without_rescanning() {
    let mut core = core();
    subscribe_intent(&mut core, "a", "C:\\root", "calculate", false, 0);
    let job = core.take_jobs(0).remove(0); let events = watch(&mut core, &job);
    core.finished(&job, with_dirs(&job, (0..4100).map(|index| format!("a\\d{index}"))), Some(RootIdentity([1,2,3,4])), 1);
    for index in 0..4100 { changed(&events, &format!("a\\d{index}"), ChangeKind::Modified); }
    core.tick(2);
    assert_eq!(states(&mut core, "a", 2), ["stale", "stale", "stale", "complete"]);
    assert_eq!(core.snapshot("a").unwrap().generation, job.generation);
    assert!(core.take_jobs(50000).is_empty());
}

#[test]
fn size_stale_recalculate_after_changes_starts_from_a_clean_set() {
    let mut core = core();
    subscribe_intent(&mut core, "a", "C:\\root", "calculate", false, 0);
    let job = core.take_jobs(0).remove(0); let events = watch(&mut core, &job);
    changed(&events, "a", ChangeKind::Modified); core.tick(2);
    core.finished(&job, tree(&job), Some(RootIdentity([1,2,3,4])), 3);
    assert_eq!(states(&mut core, "a", 3)[1], "stale");
    subscribe_intent(&mut core, "b", "C:\\root", "calculate", false, 4);
    let next = core.take_jobs(2000).remove(0); watch(&mut core, &next);
    core.finished(&next, tree(&next), Some(RootIdentity([1,2,3,4])), 2001);
    assert_eq!(states(&mut core, "a", 2001), ["complete"; 4]);
    assert!(!core.snapshot("a").unwrap().invalidated);
}

#[test]
fn size_stale_scan_bursts_reduce_pending_without_marking_everything() {
    let mut core = core();
    subscribe_intent(&mut core, "a", "C:\\root", "calculate", false, 0);
    let job = core.take_jobs(0).remove(0); let events = watch(&mut core, &job);
    for index in 0..5000 { changed(&events, &format!("a\\file{index}"), ChangeKind::Added); }
    core.tick(2);
    core.finished(&job, tree(&job), Some(RootIdentity([1,2,3,4])), 3);
    assert_eq!(states(&mut core, "a", 3), ["stale", "stale", "stale", "complete"]);

    let mut core = super::core();
    subscribe_intent(&mut core, "a", "C:\\root", "calculate", false, 0);
    let job = core.take_jobs(0).remove(0); let events = watch(&mut core, &job);
    for index in 0..4100 { changed(&events, &format!("a\\d{index}\\file"), ChangeKind::Added); }
    core.tick(2);
    core.finished(&job, with_dirs(&job, (0..4100).map(|index| format!("a\\d{index}"))), Some(RootIdentity([1,2,3,4])), 3);
    assert_eq!(states(&mut core, "a", 3), ["stale", "stale", "stale", "complete"], "overflow collapses to the common parent, not the root");
}

#[test]
fn size_stale_forget_notifies_only_listings_of_the_forgotten_parent() {
    let mut core = core();
    subscribe_intent(&mut core, "a", "C:\\root", "calculate", false, 0);
    let job = core.take_jobs(0).remove(0); let events = watch(&mut core, &job);
    core.finished(&job, tree(&job), Some(RootIdentity([1,2,3,4])), 1);
    subscribe_intent(&mut core, "other", "C:\\other", "calculate", false, 2);
    let other = core.take_jobs(2).remove(0); watch(&mut core, &other);
    core.finished(&other, tree(&other), Some(RootIdentity([1,2,3,4])), 3);
    core.drain_cache_events();
    changed(&events, "a\\deep", ChangeKind::Removed); core.tick(4);
    let paths: Vec<_> = core.drain_cache_events().into_iter().map(|(_, event)| event.path).collect();
    assert_eq!(paths, [normalize_local_path("C:\\root").unwrap()]);
}

#[test]
fn size_stale_scan_started_before_forget_cannot_restore_history_but_fresh_scan_can() {
    let mut core = core(); core.history_enabled = true;
    subscribe_intent(&mut core, "a", "C:\\root", "calculate", false, 0);
    let job = core.take_jobs(0).remove(0); let events = watch(&mut core, &job);
    core.finished(&job, tree(&job), Some(RootIdentity([1,2,3,4])), 1);
    subscribe_intent(&mut core, "inner", "C:\\root\\a", "calculate", false, 2);
    let inner = core.take_jobs(2).remove(0);
    std::thread::sleep(std::time::Duration::from_millis(2));
    changed(&events, "a\\deep", ChangeKind::Removed); core.tick(3);
    let deep = normalize_local_path("C:\\root\\a\\deep").unwrap();
    watch(&mut core, &inner);
    core.finished(&inner, with_dirs(&inner, ["deep".to_string()]), Some(RootIdentity([1,2,3,4])), 200_000);
    assert!(core.history.get(&deep).is_none(), "a scan that began before the forget is older than the fence");
    std::thread::sleep(std::time::Duration::from_millis(2));
    subscribe_intent(&mut core, "inner2", "C:\\root\\a", "calculate", false, 200_001);
    let fresh = core.take_jobs(202_001).remove(0); watch(&mut core, &fresh);
    core.finished(&fresh, with_dirs(&fresh, ["deep".to_string()]), Some(RootIdentity([1,2,3,4])), 202_002);
    assert!(core.history.get(&deep).is_some(), "a scan that began after the forget may publish again");
}

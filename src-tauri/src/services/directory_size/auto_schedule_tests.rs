use super::*;
use super::on_demand_tests::subscribe_intent;
use super::stale_core_tests::{changed, records, state, tree, watch};
use super::super::watch::ChangeKind;

fn identity_changes(core: &mut Core, now: u64) {
    let job = core.take_identity_job(now).expect("identity job");
    core.identity_finished(&job, Ok(RootIdentity([9, 9, 9, 9])), now);
}

#[test]
fn size_auto_identity_change_rescan_keeps_the_thirty_second_cooldown() {
    let mut core = core();
    subscribe_intent(&mut core, "a", "C:\\root", "auto", true, 0);
    let job = core.take_jobs(0).remove(0); monitored(&mut core, &job); finish(&mut core, &job, 1);
    identity_changes(&mut core, 2001);
    assert!(core.take_jobs(30_000).is_empty());
    assert_eq!(core.take_jobs(30_001).len(), 1);
}

#[test]
fn size_auto_unc_share_root_rescans_after_child_changes_and_cooldown() {
    for during_scan in [false, true] {
        let mut core = core();
        subscribe_intent(&mut core, "share", "\\\\server\\share", "auto", true, 0);
        let job = core.take_jobs(0).remove(0); let events = watch(&mut core, &job);
        if during_scan { changed(&events, "a\\file", ChangeKind::Modified); core.tick(1); }
        core.finished(&job, tree(&job), Some(RootIdentity([1,2,3,4])), 2);
        if !during_scan { changed(&events, "a\\file", ChangeKind::Modified); core.tick(3); }
        core.tick(30_001); assert!(core.take_jobs(30_001).is_empty());
        core.tick(30_002);
        let jobs = core.take_jobs(30_002);
        assert_eq!(jobs.len(), 1, "during_scan={during_scan}: shared root must schedule after its child changed");
        assert_eq!(jobs[0].target.path, job.target.path);
    }
}

#[test]
fn size_auto_calculate_joining_a_cooling_auto_scan_starts_without_the_cooldown() {
    let mut core = core();
    subscribe_intent(&mut core, "a", "C:\\root", "auto", true, 0);
    let job = core.take_jobs(0).remove(0); monitored(&mut core, &job); finish(&mut core, &job, 1);
    identity_changes(&mut core, 2001);
    let joined = subscribe_intent(&mut core, "b", "C:\\root", "calculate", false, 2002);
    assert_eq!(joined.generation, core.snapshot("a").unwrap().generation, "calculate shares the queued generation");
    assert_eq!(core.take_jobs(2002).len(), 1, "an explicit request is not held by the automatic cooldown");
}

#[test]
fn size_auto_new_root_inside_cooldown_explains_the_delay() {
    let mut core = core();
    subscribe_intent(&mut core, "a", "C:\\root", "auto", true, 0);
    let job = core.take_jobs(0).remove(0); finish(&mut core, &job, 1);
    core.release("main", "a", 2).unwrap();
    assert_eq!(core.root_count(), 0);
    let snapshot = subscribe_intent(&mut core, "b", "C:\\root", "auto", false, 100);
    assert_eq!(snapshot.phase, DirectorySizePhase::Queued);
    assert!(snapshot.reason.unwrap().contains("不足 30 秒"));
    assert!(core.take_jobs(30_000).is_empty());
    assert_eq!(core.take_jobs(30_001).len(), 1);
}

#[test]
fn size_auto_joining_a_placeholder_schedules_a_scan() {
    let mut core = core();
    subscribe_intent(&mut core, "a", "C:\\root", "resume", false, 0);
    let generation = core.snapshot("a").unwrap().generation;
    subscribe_intent(&mut core, "b", "C:\\root", "auto", true, 1);
    assert_eq!(core.snapshot("b").unwrap().generation, generation, "promoting a placeholder does not need a new generation");
    assert_eq!(core.take_jobs(1).len(), 1);
}

#[test]
fn size_auto_joining_a_stale_monitored_result_defers_invalidation() {
    let mut core = core();
    subscribe_intent(&mut core, "m", "C:\\root", "calculate", false, 0);
    let job = core.take_jobs(0).remove(0); let events = watch(&mut core, &job);
    core.finished(&job, tree(&job), Some(RootIdentity([1,2,3,4])), 1);
    changed(&events, "a", ChangeKind::Modified); core.tick(2);
    let snapshot = subscribe_intent(&mut core, "b", "C:\\root", "auto", false, 3);
    assert_eq!(snapshot.generation, job.generation, "the stale result stays visible");
    let verify = core.take_identity_job(3).unwrap();
    core.identity_finished(&verify, Ok(RootIdentity([1, 2, 3, 4])), 3);
    assert_eq!(state(&records(&mut core, "b", 3)[1]), "stale");
    assert!(core.take_jobs(1999).is_empty());
    core.tick(2000);
    assert_eq!(core.take_jobs(2000).len(), 1);
}

#[test]
fn size_auto_joining_an_identity_expired_root_waits_for_verification() {
    let mut core = core();
    subscribe_intent(&mut core, "a", "C:\\root", "auto", true, 0);
    let job = core.take_jobs(0).remove(0); monitored(&mut core, &job); finish(&mut core, &job, 1);
    core.tick(5002);
    assert_eq!(core.snapshot("a").unwrap().phase, DirectorySizePhase::Stale);
    let snapshot = subscribe_intent(&mut core, "b", "C:\\root", "auto", false, 5003);
    assert_eq!(snapshot.generation, job.generation);
    assert!(core.take_jobs(40_000).is_empty());
    let verify = core.take_identity_job(5003).unwrap();
    core.identity_finished(&verify, Ok(RootIdentity([1, 2, 3, 4])), 5004);
    assert_eq!(core.snapshot("b").unwrap().phase, DirectorySizePhase::Complete);
}

#[test]
fn size_auto_failed_root_marks_changes_without_rescheduling() {
    let mut core = core();
    subscribe_intent(&mut core, "a", "C:\\root", "auto", true, 0);
    let job = core.take_jobs(0).remove(0); let events = watch(&mut core, &job);
    let mut failed = tree(&job); failed.outcome = ScanOutcome::Failed;
    core.finished(&job, failed, Some(RootIdentity([1,2,3,4])), 1);
    changed(&events, "a", ChangeKind::Modified); core.tick(2);
    core.tick(40_000);
    assert!(core.take_jobs(40_000).is_empty());
}

#[test]
fn size_auto_derived_lease_waits_for_parent_calculate_instead_of_rerooting() {
    let mut core = core();
    subscribe_intent(&mut core, "parent", "C:\\root", "calculate", false, 0);
    let job = core.take_jobs(0).remove(0); let events = watch(&mut core, &job);
    core.finished(&job, tree(&job), Some(RootIdentity([1,2,3,4])), 1);
    subscribe_intent(&mut core, "child", "C:\\root\\a", "auto", true, 2);
    changed(&events, "a\\file", ChangeKind::Modified); core.tick(3);
    subscribe_intent(&mut core, "again", "C:\\root", "calculate", false, 4);
    core.tick(503);
    let jobs = core.take_jobs(2000);
    assert_eq!(jobs.iter().map(|job| job.target.path.clone()).collect::<Vec<_>>(), [job.target.path.clone()]);
}

#[test]
fn size_auto_derived_lease_without_parent_auto_only_scans_its_scope() {
    let mut core = core();
    subscribe_intent(&mut core, "parent", "C:\\root", "calculate", false, 0);
    let job = core.take_jobs(0).remove(0); let events = watch(&mut core, &job);
    core.finished(&job, tree(&job), Some(RootIdentity([1,2,3,4])), 1);
    subscribe_intent(&mut core, "child", "C:\\root\\a", "auto", true, 2);
    changed(&events, "a\\file", ChangeKind::Modified); core.tick(3); core.tick(503);
    assert_eq!(core.take_jobs(503).len(), 1);
    assert_eq!(core.jobs_started, 2, "the manual parent never rescans");
    core.tick(40_000);
    assert!(core.take_jobs(40_000).is_empty());
}

#[test]
fn size_auto_derived_lease_reroots_immediately_when_parent_is_invalidated() {
    for operation in [false, true] {
        let mut core = core();
        subscribe_intent(&mut core, "parent", "C:\\root", "calculate", false, 0);
        let job = core.take_jobs(0).remove(0); watch(&mut core, &job);
        core.finished(&job, tree(&job), Some(RootIdentity([1,2,3,4])), 1);
        subscribe_intent(&mut core, "child", "C:\\root\\a", "auto", true, 2);
        if operation { core.invalidate_local_paths(&[normalize_local_path("C:\\root").unwrap()], 2001); }
        else { identity_changes(&mut core, 2001); }
        let jobs = core.take_jobs(2501);
        assert_eq!(jobs.iter().map(|job| job.target.path.clone()).collect::<Vec<_>>(), [normalize_local_path("C:\\root\\a").unwrap()]);
        assert_eq!(core.snapshot("parent").unwrap().phase, DirectorySizePhase::Stale);
        assert!(core.take_jobs(50_000).is_empty(), "the manual parent is not rescanned");
    }
}

#[test]
fn size_auto_operation_on_root_rescans_only_direct_auto_roots() {
    for (mode, rescans) in [("calculate", false), ("auto", true)] {
        for target in ["C:\\root", "C:\\"] {
            let mut core = core();
            subscribe_intent(&mut core, "a", "C:\\root", mode, mode == "auto", 0);
            let job = core.take_jobs(0).remove(0); monitored(&mut core, &job); finish(&mut core, &job, 1);
            core.invalidate_local_paths(&[normalize_local_path(target).unwrap()], 2);
            assert_eq!(core.snapshot("a").unwrap().phase, DirectorySizePhase::Stale);
            assert!(core.take_jobs(30_000).is_empty());
            assert_eq!(core.take_jobs(30_001).len(), usize::from(rescans));
        }
    }
}

#[test]
fn size_auto_placeholder_promotion_respects_the_root_limit() {
    let mut core = core(); core.limits.roots = 1;
    subscribe_intent(&mut core, "a", "C:\\x", "calculate", false, 0);
    let job = core.take_jobs(0).remove(0); monitored(&mut core, &job); finish(&mut core, &job, 1);
    subscribe_intent(&mut core, "p", "C:\\y", "resume", false, 2);
    let full = core.subscribe(core.owner_token("main").unwrap(), super::on_demand_tests::intent("q", "C:\\y", "calculate", false), None, 3);
    assert!(full.unwrap_err().contains("上限"));
    assert_eq!(core.snapshot("p").unwrap().phase, DirectorySizePhase::Stale);
    assert!(core.take_jobs(50_000).is_empty());
    core.release("main", "a", 4).unwrap();
    subscribe_intent(&mut core, "q", "C:\\y", "calculate", false, 5);
    assert_eq!(core.take_jobs(5).len(), 1);
}

#[test]
fn size_auto_manual_detail_miss_recovers_after_parent_recalculation() {
    let mut core = core(); core.storage = Some(super::super::storage::Store::paused_for_test(8192, 2048));
    subscribe_intent(&mut core, "parent", "C:\\root", "calculate", false, 0);
    let job = core.take_jobs(0).remove(0); monitored(&mut core, &job); finish(&mut core, &job, 1);
    subscribe_intent(&mut core, "child", "C:\\root\\child", "resume", false, 2);
    let child = normalize_local_path("C:\\root\\child").unwrap();
    core.stored_read_finished(&[child.clone()], Some(&job.storage.clone().unwrap().id), Ok(&[]), 3);
    assert_eq!(core.snapshot("child").unwrap().phase, DirectorySizePhase::Stale);
    subscribe_intent(&mut core, "again", "C:\\root", "calculate", false, 4);
    let next = core.take_jobs(2000).remove(0); monitored(&mut core, &next);
    let mut scanned = result(&next, 100);
    let size = scanned.directories[&*next.target.path].clone();
    scanned.directories.insert(Arc::from(child.as_str()), size);
    core.finished(&next, scanned, Some(RootIdentity([1, 2, 3, 4])), 2001);
    assert_eq!(core.snapshot("child").unwrap().phase, DirectorySizePhase::Complete);
}

#[test]
fn size_auto_contract_rejects_unknown_intents_and_maps_legacy_refresh() {
    let unknown = serde_json::from_value::<SubscribeDirectorySizesRequest>(serde_json::json!({
        "consumerId":"a", "target":{"kind":"local", "path":"C:\\root"}, "intent":"bogus"
    }));
    assert!(unknown.is_err());
    let mut core = core();
    let legacy: SubscribeDirectorySizesRequest = serde_json::from_value(serde_json::json!({
        "consumerId":"legacy", "target":{"kind":"local", "path":"C:\\root"}, "refresh":true
    })).unwrap();
    core.subscribe(core.owner_token("main").unwrap(), legacy, None, 0).unwrap();
    assert_eq!(core.take_jobs(0).len(), 1);
}

#[test]
fn size_auto_remote_start_reuses_retained_results_and_scans_when_missing() {
    let mut core = core();
    subscribe_intent(&mut core, "a", "/root", "start", false, 0);
    let job = core.take_jobs(0).remove(0); finish(&mut core, &job, 1);
    core.release("main", "a", 2).unwrap();
    let reused = subscribe_intent(&mut core, "b", "/root", "start", false, 3);
    assert_eq!(reused.total_bytes.as_deref(), Some("100"));
    assert!(core.take_jobs(50_000).is_empty());
    subscribe_intent(&mut core, "c", "/other", "start", false, 50_001);
    assert_eq!(core.take_jobs(50_001).len(), 1);
}

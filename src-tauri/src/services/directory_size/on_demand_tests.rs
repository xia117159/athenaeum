use super::*;

pub(super) fn intent(id: &str, path: &str, intent: &str, retry: bool) -> SubscribeDirectorySizesRequest {
    let mut value = serde_json::to_value(request(id, path)).unwrap();
    value["intent"] = intent.into(); value["retryFailed"] = retry.into();
    serde_json::from_value(value).unwrap()
}
pub(super) fn subscribe_intent(core: &mut Core, id: &str, path: &str, mode: &str, retry: bool, now: u64) -> DirectorySizeSnapshot {
    core.subscribe(core.owner_token("main").unwrap(), intent(id, path, mode, retry), path.starts_with('/').then(profile), now).unwrap()
}

#[test]
fn size_demand_resume_never_scans_and_placeholders_do_not_evict_results() {
    let mut core = core(); core.limits.roots = 1;
    subscribe_intent(&mut core, "saved", "/saved", "start", false, 0);
    let saved = core.take_jobs(0).remove(0); finish(&mut core, &saved, 1);
    core.release("main", "saved", 2).unwrap();
    for i in 0..12 {
        let snapshot = subscribe_intent(&mut core, &format!("resume{i}"), &format!("C:\\root{i}"), "resume", false, 3);
        assert_eq!(snapshot.phase, DirectorySizePhase::Stale);
    }
    assert!(core.take_jobs(50000).is_empty());
    assert_eq!(subscribe_intent(&mut core, "saved-again", "/saved", "resume", false, 50001).total_bytes.as_deref(), Some("100"));
}

#[test]
fn size_demand_calculate_shares_queued_and_running_but_recalculates_completed() {
    for path in ["C:\\root", "/root"] {
        let mut core = core();
        let a = subscribe_intent(&mut core, "a", path, "calculate", false, 0);
        let b = subscribe_intent(&mut core, "b", path, "calculate", false, 1);
        assert_eq!(a.generation, b.generation);
        let job = core.take_jobs(1).remove(0);
        let c = subscribe_intent(&mut core, "c", path, "calculate", false, 2);
        assert_eq!(c.generation, a.generation);
        assert!(!job.cancelled.load(Ordering::Relaxed));
        finish(&mut core, &job, 3);
        let next = subscribe_intent(&mut core, "d", path, "calculate", false, 4);
        assert!(next.generation > a.generation);
    }
}

#[test]
fn size_demand_resume_after_cancel_rejects_late_job_without_starting_another() {
    let mut core = core();
    subscribe_intent(&mut core, "a", "C:\\root", "calculate", false, 0);
    let job = core.take_jobs(0).remove(0);
    core.release("main", "a", 1).unwrap();
    let resume = subscribe_intent(&mut core, "b", "C:\\root", "resume", false, 2);
    assert_eq!(resume.phase, DirectorySizePhase::Stale);
    finish(&mut core, &job, 3);
    assert!(core.take_jobs(50000).is_empty());
    assert!(core.snapshot("b").unwrap().total_bytes.is_none());
}

#[test]
fn size_demand_failed_auto_requires_explicit_retry_authorization() {
    let mut core = core();
    subscribe_intent(&mut core, "a", "C:\\root", "auto", true, 0);
    let job = core.take_jobs(0).remove(0);
    let mut failed = result(&job, 0); failed.outcome = ScanOutcome::Failed;
    core.finished(&job, failed, None, 1);
    let failed = subscribe_intent(&mut core, "b", "C:\\root", "auto", false, 2);
    assert_eq!(failed.phase, DirectorySizePhase::Failed);
    assert!(core.take_jobs(50000).is_empty());
    subscribe_intent(&mut core, "c", "C:\\root", "auto", true, 50001);
    assert!(core.take_jobs(50_500).is_empty(), "rescanning an existing result waits the 500ms quiet period");
    assert_eq!(core.take_jobs(50_501).len(), 1);
}

#[test]
fn size_demand_contract_rejects_incompatible_intents_and_preserves_legacy_cache_only_default() {
    let mut core = core();
    for (path, mode, retry) in [("C:\\root", "start", false), ("/root", "auto", false), ("C:\\root", "resume", true)] {
        let request = intent("a", path, mode, retry);
        assert!(core.subscribe(core.owner_token("main").unwrap(), request, path.starts_with('/').then(profile), 0).is_err());
    }
    let legacy: SubscribeDirectorySizesRequest = serde_json::from_value(serde_json::json!({
        "consumerId":"legacy", "target":{"kind":"local", "path":"C:\\root"}, "refresh":false
    })).unwrap();
    core.subscribe(core.owner_token("main").unwrap(), legacy, None, 1).unwrap();
    assert!(core.take_jobs(1).is_empty());
    let explicit: SubscribeDirectorySizesRequest = serde_json::from_value(serde_json::json!({
        "consumerId":"explicit", "target":{"kind":"local", "path":"C:\\root"}, "refresh":true, "intent":"resume"
    })).unwrap();
    core.subscribe(core.owner_token("main").unwrap(), explicit, None, 2).unwrap();
    assert!(core.take_jobs(2).is_empty());
}

#[test]
fn size_demand_manual_disk_miss_is_unavailable_and_never_starts_a_scan() {
    let mut core = core(); core.storage = Some(super::super::storage::Store::paused_for_test(8192, 2048));
    subscribe_intent(&mut core, "parent", "C:\\root", "calculate", false, 0);
    let job = core.take_jobs(0).remove(0); monitored(&mut core, &job); finish(&mut core, &job, 1);
    subscribe_intent(&mut core, "child", "C:\\root\\child", "resume", false, 2);
    let child = normalize_local_path("C:\\root\\child").unwrap();
    core.stored_read_finished(&[child], Some(&job.storage.unwrap().id), Ok(&[]), 3);
    let snapshot = core.snapshot("child").unwrap();
    assert_eq!(snapshot.phase, DirectorySizePhase::Stale);
    assert!(snapshot.reason.unwrap().contains("明细已不可用"));
    assert!(core.take_jobs(50000).is_empty());
}

#[test]
fn size_demand_auto_cancel_and_late_completion_keep_finish_to_start_cooldown() {
    let mut core = core();
    subscribe_intent(&mut core, "a", "C:\\root", "auto", true, 0);
    let job = core.take_jobs(0).remove(0);
    core.release("main", "a", 100).unwrap();
    subscribe_intent(&mut core, "b", "C:\\root", "auto", false, 110);
    finish(&mut core, &job, 200);
    assert!(core.take_jobs(30_199).is_empty());
    assert_eq!(core.take_jobs(30_200).len(), 1);
}

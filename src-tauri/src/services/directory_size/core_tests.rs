use super::{core::*, scan::{DirectorySize, ScanOutcome, ScanResult, ScanStats}, target::normalize_local_path, watch::{RootIdentity, WatchPoll}};
use crate::domain::{directory_sizes::*, models::{RemoteProfile, RemoteAuthKind, LocationKind}};
use std::{collections::HashMap, sync::{Arc, atomic::{AtomicU8, Ordering}}};

fn profile() -> RemoteProfile {
    RemoteProfile { id: "remote".into(), name: "Remote".into(), protocol: LocationKind::Sftp, host: "example.invalid".into(),
        port: 22, username: "user".into(), root_path: "/".into(), auth_kind: RemoteAuthKind::Password, private_key_path: None,
        passive_mode: true, ignore_host_key: false, connect_timeout_secs: 10, command_timeout_secs: 20,
        credential_target: None, password: Some("never-publish-secret".into()) }
}
fn request(id: &str, path: &str) -> SubscribeDirectorySizesRequest {
    SubscribeDirectorySizesRequest { consumer_id: id.into(), target: if path.starts_with('/') {
        DirectorySizeTarget::Remote { profile_id: "remote".into(), path: path.into() }
    } else { DirectorySizeTarget::Local { path: path.into() } }, refresh: false }
}
fn core() -> Core { let mut core = Core::default(); core.open_owner("main"); core.open_owner("settings"); core }
fn subscribe(core: &mut Core, id: &str, path: &str, now: u64) -> DirectorySizeSnapshot {
    core.subscribe(core.owner_token("main").unwrap(), request(id, path), path.starts_with('/').then(profile), now).unwrap()
}
fn result(job: &ScanJob, bytes: u64) -> ScanResult {
    ScanResult { directories: HashMap::from([(Arc::from(job.target.path.as_str()), DirectorySize { bytes, complete: true, fingerprint: Some("stamp".into()) })]),
        stats: ScanStats { known_bytes: bytes, files: 1, directories: 1, ..Default::default() },
        outcome: ScanOutcome::Complete, accounted_bytes: 1024, message: None }
}
struct FakeWatch(Arc<AtomicU8>);
impl SizeWatch for FakeWatch {
    fn poll(&mut self) -> WatchPoll { match self.0.swap(0, Ordering::Relaxed) { 1 => WatchPoll::Changed, 2 => WatchPoll::Lost, _ => WatchPoll::Quiet } }
}
fn monitored(core: &mut Core, job: &ScanJob) -> Arc<AtomicU8> {
    let flag = Arc::new(AtomicU8::new(0));
    core.prepared(job, Some(RootIdentity([1, 2, 3, 4])), Some(Box::new(FakeWatch(flag.clone()))), 0);
    flag
}
fn finish(core: &mut Core, job: &ScanJob, now: u64) { core.finished(job, result(job, 100), Some(RootIdentity([1, 2, 3, 4])), now); }

#[test]
fn size_service_single_flight_independent_leases_and_last_release_fence() {
    let mut core = core();
    let a = subscribe(&mut core, "a", "C:\\Root", 0);
    let b = subscribe(&mut core, "b", "c:/Root/", 0);
    assert_eq!(a.generation, b.generation);
    let jobs = core.take_jobs(0);
    assert_eq!(jobs.len(), 1);
    assert!(core.release("settings", "a", 1).is_err());
    core.release("main", "a", 1).unwrap();
    assert!(!jobs[0].cancelled.load(Ordering::Relaxed));
    core.release("main", "b", 2).unwrap();
    assert!(jobs[0].cancelled.load(Ordering::Relaxed));
    finish(&mut core, &jobs[0], 3);
    assert!(core.snapshot("b").is_none());
    assert_eq!(core.root_count(), 0);
}

#[test]
fn size_service_late_worker_messages_cannot_change_a_finished_result() {
    let mut core = core();
    subscribe(&mut core, "a", "C:\\root", 0);
    let job = core.take_jobs(0).remove(0);
    monitored(&mut core, &job);
    finish(&mut core, &job, 10);
    let completed = serde_json::to_value(core.snapshot("a")).unwrap();
    core.drain_events();
    core.progress(&job, ScanStats { known_bytes: 999, ..Default::default() }, 200);
    core.prepared(&job, None, None, 201);
    core.finished(&job, result(&job, 999), None, 202);
    assert_eq!(serde_json::to_value(core.snapshot("a")).unwrap(), completed);
    assert!(core.drain_events().is_empty());
}

#[test]
fn size_service_new_consumer_explicit_refresh_replaces_shared_running_generation() {
    let mut core = core();
    let first = subscribe(&mut core, "a", "/root", 0);
    let old_job = core.take_jobs(0).remove(0);
    let mut refresh = request("b", "/root");
    refresh.refresh = true;
    let next = core.subscribe(core.owner_token("main").unwrap(), refresh, Some(profile()), 100).unwrap();
    assert!(next.generation > first.generation);
    assert_eq!(core.snapshot("a").unwrap().generation, next.generation);
    assert!(old_job.cancelled.load(Ordering::Relaxed));
    assert!(core.take_jobs(2000).is_empty(), "the cancelled traversal still owns its worker slot");
    finish(&mut core, &old_job, 2001);
    assert!(core.snapshot("a").unwrap().total_bytes.is_none());
    let replacement = core.take_jobs(2001).remove(0);
    assert_eq!(replacement.generation, next.generation);
    finish(&mut core, &replacement, 2002);
    assert_eq!(core.snapshot("a").unwrap().total_bytes.as_deref(), Some("100"));
    assert_eq!(core.snapshot("b").unwrap().total_bytes.as_deref(), Some("100"));
}

#[test]
fn size_service_worker_bounds_leave_a_slot_for_local_and_never_replace_blocked_jobs() {
    let mut core = core();
    for (id, path) in [("r1", "/r1"), ("r2", "/r2"), ("l1", "C:\\one"), ("l2", "C:\\two")] { subscribe(&mut core, id, path, 0); }
    let jobs = core.take_jobs(0);
    assert_eq!(jobs.len(), 2);
    assert_eq!(jobs.iter().filter(|job| job.target.profile.is_some()).count(), 1);
    core.release("main", "r1", 1).unwrap();
    core.release("main", "l1", 1).unwrap();
    assert!(core.take_jobs(100_000).is_empty(), "cancelled OS calls still occupy workers");
    for job in &jobs { finish(&mut core, job, 100_001); }
    assert_eq!(core.take_jobs(100_002).len(), 2);
}

#[test]
fn size_service_limits_reject_excess_roots_and_consumers_explicitly() {
    let mut core = core();
    for index in 0..8 { subscribe(&mut core, &format!("r{index}"), &format!("C:\\root{index}"), 0); }
    assert!(core.subscribe(core.owner_token("main").unwrap(), request("excess", "C:\\ninth"), None, 0).is_err());
    for index in 8..32 { subscribe(&mut core, &format!("r{index}"), "C:\\root0", 0); }
    assert!(core.subscribe(core.owner_token("main").unwrap(), request("excess", "C:\\root0"), None, 0).is_err());
    assert_eq!(core.root_count(), 8);
}

#[test]
fn size_service_window_epochs_reject_late_subscribe_and_close_only_owner_leases() {
    let mut core = core();
    subscribe(&mut core, "main-job", "C:\\root", 0);
    let token = core.owner_token("settings").unwrap();
    core.subscribe(token.clone(), request("settings-job", "C:\\root"), None, 0).unwrap();
    let jobs = core.take_jobs(0);
    core.close_owner("settings", 1);
    assert!(!jobs[0].cancelled.load(Ordering::Relaxed));
    assert!(core.snapshot("settings-job").is_none());
    assert!(core.subscribe(token.clone(), request("late", "C:\\root"), None, 2).is_err());
    core.open_owner("settings");
    assert!(core.subscribe(token, request("late", "C:\\root"), None, 3).is_err());
}

#[test]
fn size_service_deep_change_during_scan_invalidates_and_coalesces_without_late_resurrection() {
    let mut core = core();
    let first = subscribe(&mut core, "a", "C:\\root", 0);
    let job = core.take_jobs(0).remove(0);
    let change = monitored(&mut core, &job);
    change.store(1, Ordering::Relaxed);
    core.tick(100);
    assert!(job.cancelled.load(Ordering::Relaxed));
    assert!(core.snapshot("a").unwrap().generation > first.generation);
    finish(&mut core, &job, 101);
    assert_eq!(core.snapshot("a").unwrap().phase, DirectorySizePhase::Stale);
    assert!(core.take_jobs(600).is_empty());
    assert_eq!(core.take_jobs(2000).len(), 1);
}

#[test]
fn size_service_cache_hit_needs_a_fresh_identity_check_and_expired_checks_remove_exactness() {
    let mut core = core();
    subscribe(&mut core, "a", "C:\\root", 0);
    let job = core.take_jobs(0).remove(0);
    monitored(&mut core, &job);
    finish(&mut core, &job, 10);
    assert_eq!(core.snapshot("a").unwrap().phase, DirectorySizePhase::Complete);
    let periodic = core.take_identity_job(2010).unwrap();
    let b = subscribe(&mut core, "b", "C:\\root", 2011);
    assert_eq!(b.phase, DirectorySizePhase::Queued);
    assert!(b.total_bytes.is_none());
    core.identity_finished(&periodic, Ok(RootIdentity([1, 2, 3, 4])), 2012);
    assert_eq!(core.snapshot("b").unwrap().phase, DirectorySizePhase::Queued, "a check started before the new lease is not fresh");
    let fresh = core.take_identity_job(2012).unwrap();
    core.identity_finished(&fresh, Ok(RootIdentity([1, 2, 3, 4])), 2013);
    assert_eq!(core.snapshot("b").unwrap().phase, DirectorySizePhase::Complete);
    let blocked = core.take_identity_job(4013).unwrap();
    assert!(core.take_identity_job(10_000).is_none(), "only one metadata-only validation worker");
    core.tick(7014);
    assert_eq!(core.snapshot("a").unwrap().phase, DirectorySizePhase::Stale);
    assert!(core.snapshot("a").unwrap().total_bytes.is_none());
    core.identity_finished(&blocked, Ok(RootIdentity([1, 2, 3, 4])), 7015);
    assert_eq!(core.snapshot("a").unwrap().phase, DirectorySizePhase::Complete);
}

#[test]
fn size_service_root_replacement_monitor_loss_and_late_identity_never_restore_old_sizes() {
    let mut core = core();
    subscribe(&mut core, "a", "C:\\root", 0);
    let job = core.take_jobs(0).remove(0);
    let flag = monitored(&mut core, &job);
    finish(&mut core, &job, 10);
    let identity = core.take_identity_job(2010).unwrap();
    flag.store(2, Ordering::Relaxed);
    core.tick(2011);
    core.identity_finished(&identity, Ok(RootIdentity([1, 2, 3, 4])), 2012);
    assert_eq!(core.snapshot("a").unwrap().phase, DirectorySizePhase::Stale);
    let replacement = core.take_jobs(2511).remove(0);
    monitored(&mut core, &replacement);
    core.finished(&replacement, result(&replacement, 999), Some(RootIdentity([9, 2, 3, 4])), 2520);
    assert_ne!(core.snapshot("a").unwrap().phase, DirectorySizePhase::Complete);
    assert!(core.snapshot("a").unwrap().total_bytes.is_none());
}

#[test]
fn size_service_lookup_is_owned_bounded_generation_fenced_and_decimal_exact() {
    let mut core = core();
    subscribe(&mut core, "a", "/root", 0);
    let job = core.take_jobs(0).remove(0);
    core.finished(&job, result(&job, u64::MAX), None, 10);
    let lookup = |paths| LookupDirectorySizesRequest { consumer_id: "a".into(), generation: job.generation, paths };
    let value = core.lookup("main", lookup(vec!["/root".into(), "/root/unknown".into()]), 11).unwrap();
    assert!(!value.stale);
    assert_eq!(value.directories[0].bytes.as_deref(), Some("18446744073709551615"));
    assert_eq!(value.directories[1].state, DirectorySizeRecordState::Unknown);
    assert!(core.lookup("settings", lookup(vec![]), 11).is_err());
    assert!(core.lookup("main", lookup(vec!["/outside".into()]), 11).is_err());
    assert!(core.lookup("main", lookup(vec!["/root".into(); 257]), 11).is_err());
    assert!(!serde_json::to_string(&core.snapshot("a")).unwrap().contains("never-publish-secret"));
    core.invalidate_profile("remote", 12);
    assert!(core.lookup("main", lookup(vec!["/root".into()]), 13).unwrap().stale);
    assert!(core.take_jobs(10_000).is_empty(), "remote invalidation is manual, never unsolicited recursion");
}

#[test]
fn size_service_unmonitored_snapshot_is_not_reused_after_final_release_and_cache_is_bounded() {
    let mut core = core();
    subscribe(&mut core, "a", "C:\\root", 0);
    let job = core.take_jobs(0).remove(0);
    core.prepared(&job, None, None, 0);
    core.finished(&job, result(&job, 100), None, 1);
    assert_eq!(core.snapshot("a").unwrap().freshness, DirectorySizeFreshness::Snapshot);
    core.release("main", "a", 2).unwrap();
    assert_eq!(core.root_count(), 0);
    core.limits.cache_bytes = 512;
    subscribe(&mut core, "b", "C:\\other", 3);
    let next = core.take_jobs(3).remove(0);
    monitored(&mut core, &next);
    finish(&mut core, &next, 4);
    assert!(core.cache_bytes() <= 512);
    assert_ne!(core.snapshot("b").unwrap().phase, DirectorySizePhase::Complete);
}

#[test]
fn size_service_progress_is_throttled_and_shutdown_cancels_without_replacement() {
    let mut core = core();
    subscribe(&mut core, "a", "C:\\root", 0);
    let job = core.take_jobs(0).remove(0);
    core.drain_events();
    core.progress(&job, ScanStats { known_bytes: 30, ..Default::default() }, 200);
    assert_eq!(core.drain_events().len(), 1);
    core.progress(&job, ScanStats { known_bytes: 40, ..Default::default() }, 250);
    assert!(core.drain_events().is_empty());
    core.shutdown();
    assert!(job.cancelled.load(Ordering::Relaxed));
    assert!(core.take_jobs(1000).is_empty());
    assert!(core.snapshot("a").is_none());
    assert!(core.subscribe(OwnerToken { label: "main".into(), epoch: 0 }, request("late", "C:\\root"), None, 1000).is_err());
}

#[test]
fn size_service_local_key_is_lexical_bounded_and_never_requires_filesystem_io() {
    assert_eq!(normalize_local_path("\\\\?\\C:\\Root\\").unwrap(), normalize_local_path("c:/Root").unwrap());
    for path in ["", "relative", "C:\\root\\..\\outside", "ftp://host/path", "C:\\root\0bad"] { assert!(normalize_local_path(path).is_err(), "{path:?}"); }
    assert_eq!(normalize_local_path("C:\\").unwrap(), "\\\\?\\c:\\");
    assert_eq!(normalize_local_path("\\\\Server\\Share\\Folder").unwrap(), "\\\\?\\UNC\\Server\\Share\\Folder");
}

#[test]
fn size_service_profile_save_window_blocks_new_acquisition_and_cancels_old_setup() {
    let mut core = core();
    subscribe(&mut core, "old", "/root", 0);
    let old = core.take_jobs(0).remove(0);
    // A fake credential write can happen here, before the new host is published.
    core.begin_profile_update("remote", 1);
    assert!(old.cancelled.load(Ordering::Acquire));
    let during = core.subscribe(core.owner_token("main").unwrap(), request("during-save", "/root"), Some(profile()), 2);
    assert!(during.is_err(), "a subscription must not capture the old host during a credential update");
    // Nested/concurrent saves keep acquisition fenced until every update ends.
    core.begin_profile_update("remote", 3);
    core.end_profile_update("remote", 4);
    assert!(core.subscribe(core.owner_token("main").unwrap(), request("still-saving", "/root"), Some(profile()), 5).is_err());
    let mut published = profile(); published.host = "new.example.invalid".into();
    core.end_profile_update("remote", 6);
    core.subscribe(core.owner_token("main").unwrap(), request("new", "/root"), Some(published), 7).unwrap();
    assert!(core.take_jobs(7).is_empty(), "the invalidated handshake still occupies the remote slot");
    finish(&mut core, &old, 8);
    let next = core.take_jobs(8).remove(0);
    assert_eq!(next.target.profile.unwrap().host, "new.example.invalid");
    assert!(core.snapshot("old").unwrap().total_bytes.is_none());
}

#[test]
fn size_service_distinct_component_spellings_never_merge_without_object_identity_evidence() {
    let mut core = core();
    let a = subscribe(&mut core, "upper", "C:\\data\\Foo", 0);
    let b = subscribe(&mut core, "lower", "C:\\data\\foo", 0);
    assert_ne!(a.generation, b.generation, "Windows supports per-directory case sensitivity");
    let dotted = subscribe(&mut core, "dotted", "C:\\data\\İ", 0);
    let decomposed = subscribe(&mut core, "decomposed", "C:\\data\\i\u{307}", 0);
    assert_ne!(dotted.generation, decomposed.generation);
}

#[test]
fn size_service_remote_lookup_keeps_legal_trailing_spaces_distinct() {
    let mut core = core(); subscribe(&mut core, "a", "/root", 0);
    let job = core.take_jobs(0).remove(0);
    let mut result = result(&job, 100);
    for (path, bytes) in [("/root/folder", 10), ("/root/folder ", 90)] {
        result.directories.insert(Arc::from(path), DirectorySize { bytes, complete: true, fingerprint: Some("child".into()) });
    }
    core.finished(&job, result, None, 1);
    let lookup = core.lookup("main", LookupDirectorySizesRequest { consumer_id: "a".into(), generation: job.generation,
        paths: vec!["/root/folder".into(), "/root/folder ".into()] }, 2).unwrap();
    assert_eq!(lookup.directories.iter().map(|record| record.bytes.as_deref()).collect::<Vec<_>>(), [Some("10"), Some("90")]);
}

#[test]
fn size_service_successful_rescan_clears_obsolete_reasons_but_preserves_current_snapshot_notice() {
    let mut core = core(); subscribe(&mut core, "a", "C:\\root", 0);
    let first = core.take_jobs(0).remove(0); let flag = monitored(&mut core, &first); finish(&mut core, &first, 10);
    flag.store(1, Ordering::Relaxed); core.tick(20);
    assert!(core.snapshot("a").unwrap().reason.unwrap().contains("失效"));
    let second = core.take_jobs(2000).remove(0); monitored(&mut core, &second); finish(&mut core, &second, 2001);
    assert_eq!(core.snapshot("a").unwrap().reason, None);

    let mut refresh = request("a", "C:\\root"); refresh.refresh = true;
    core.subscribe(core.owner_token("main").unwrap(), refresh, None, 4000).unwrap();
    let third = core.take_jobs(4000).remove(0); core.prepared(&third, None, None, 4000);
    core.finished(&third, result(&third, 100), None, 4001);
    assert!(core.snapshot("a").unwrap().reason.unwrap().contains("快照"));
}

#[test]
fn size_service_refresh_event_and_return_agree_when_cancelled_work_still_blocks_the_queue() {
    let mut core = core(); subscribe(&mut core, "a", "/root", 0);
    let old = core.take_jobs(0).remove(0); core.drain_events();
    let mut refresh = request("b", "/root"); refresh.refresh = true;
    let returned = core.subscribe(core.owner_token("main").unwrap(), refresh, Some(profile()), 1).unwrap();
    assert!(old.cancelled.load(Ordering::Relaxed)); assert!(core.take_jobs(2000).is_empty());
    let event = core.drain_events().into_iter().find(|(_, event)| event.consumer_id == "b").unwrap().1;
    assert_eq!(returned.phase, DirectorySizePhase::Queued);
    assert_eq!(serde_json::to_value(event).unwrap(), serde_json::to_value(returned).unwrap(), "same generation/sequence must identify the same state");
}

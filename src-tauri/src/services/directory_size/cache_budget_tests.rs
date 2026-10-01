use super::*;
use crate::services::directory_size::scan::NODE_ACCOUNT_BYTES;

pub(super) fn chain(job: &ScanJob, count: usize) -> ScanResult {
    let mut scan = result(job, 100);
    let size = scan.directories[&*job.target.path].clone();
    let mut path = job.target.path.clone();
    for _ in 0..count { if !path.ends_with('\\') { path.push('\\'); } path.push_str("child"); scan.directories.insert(Arc::from(path.as_str()), size.clone()); }
    scan.accounted_bytes = scan.directories.keys().map(|path| NODE_ACCOUNT_BYTES + path.len()).sum();
    scan
}

#[test]
fn global_budget_keeps_shallow_details_before_incoming_deep_details() {
    let mut core = core();
    subscribe(&mut core, "a", "C:\\first", 0);
    let a = core.take_jobs(0).remove(0); monitored(&mut core, &a);
    let scanned = chain(&a, 2); let before = scanned.accounted_bytes;
    core.finished(&a, scanned, Some(RootIdentity([1,2,3,4])), 1);
    subscribe(&mut core, "b", "C:\\second", 2);
    let b = core.take_jobs(2).remove(0); monitored(&mut core, &b);
    let scanned = chain(&b, 3);
    let deepest = format!("{}\\child\\child\\child", b.target.path);
    core.limits.cache_bytes = before + scanned.accounted_bytes - (NODE_ACCOUNT_BYTES + deepest.len());
    core.finished(&b, scanned, Some(RootIdentity([1,2,3,4])), 3);
    let lookup = |core: &mut Core, id: &str, job: &ScanJob, path: String| core.lookup("main", LookupDirectorySizesRequest {
        consumer_id: id.into(), generation: job.generation, paths: vec![path] }, 3).unwrap().directories.remove(0);
    assert_eq!(lookup(&mut core, "a", &a, format!("{}\\child", a.target.path)).state, DirectorySizeRecordState::Complete);
    assert_eq!(lookup(&mut core, "a", &a, format!("{}\\child\\child", a.target.path)).state, DirectorySizeRecordState::Complete);
    assert_eq!(lookup(&mut core, "b", &b, deepest).state, DirectorySizeRecordState::Unknown);
    assert_eq!(core.cache_bytes(), core.limits.cache_bytes, "stop after reclaiming exactly enough detail space");
    assert_eq!(core.snapshot("a").unwrap().total_bytes.as_deref(), Some("100"));
    assert_eq!(core.snapshot("b").unwrap().total_bytes.as_deref(), Some("100"));
}

#[test]
fn global_budget_protects_a_deep_active_lease_and_evicts_unprotected_details() {
    let mut core = core();
    subscribe(&mut core, "a", "C:\\first", 0);
    let a = core.take_jobs(0).remove(0); monitored(&mut core, &a);
    let scanned = chain(&a, 3); let before = scanned.accounted_bytes;
    core.finished(&a, scanned, Some(RootIdentity([1,2,3,4])), 1);
    let protected = format!("{}\\child\\child\\child", a.target.path);
    subscribe(&mut core, "deep", &protected, 2);
    let verify = core.take_identity_job(2).unwrap(); core.identity_finished(&verify, Ok(RootIdentity([1,2,3,4])), 3);
    subscribe(&mut core, "b", "C:\\second", 4);
    let b = core.take_jobs(4).remove(0); monitored(&mut core, &b);
    let scanned = chain(&b, 2);
    core.limits.cache_bytes = before + scanned.accounted_bytes - (NODE_ACCOUNT_BYTES + format!("{}\\child\\child", a.target.path).len());
    core.finished(&b, scanned, Some(RootIdentity([1,2,3,4])), 5);
    assert_eq!(core.snapshot("deep").unwrap().total_bytes.as_deref(), Some("100"));
    assert!(core.cache_bytes() <= core.limits.cache_bytes);
}

#[test]
fn global_budget_releases_hash_buckets_after_shedding_details() {
    let mut core = core();
    subscribe(&mut core, "a", "C:\\first", 0);
    let a = core.take_jobs(0).remove(0); monitored(&mut core, &a);
    core.finished(&a, chain(&a, 100), Some(RootIdentity([1,2,3,4])), 1);
    subscribe(&mut core, "b", "C:\\second", 2);
    let b = core.take_jobs(2).remove(0); monitored(&mut core, &b);
    core.limits.cache_bytes = 2 * NODE_ACCOUNT_BYTES + a.target.path.len() + b.target.path.len();
    core.finished(&b, chain(&b, 100), Some(RootIdentity([1,2,3,4])), 3);
    for id in ["a", "b"] { assert_eq!(core.snapshot(id).unwrap().total_bytes.as_deref(), Some("100")); }
    assert_eq!(core.cache_bytes(), core.limits.cache_bytes);
    assert!(core.allocated_detail_slots() <= 8,
        "two retained root records must not leave hundreds of allocated detail slots behind");
}

#[test]
fn global_budget_compares_depth_relative_to_drive_and_nested_roots() {
    let mut core = core();
    subscribe(&mut core, "drive", "C:\\", 0);
    let drive = core.take_jobs(0).remove(0); monitored(&mut core, &drive);
    let scanned = chain(&drive, 3); let before = scanned.accounted_bytes;
    core.finished(&drive, scanned, Some(RootIdentity([1,2,3,4])), 1);
    subscribe(&mut core, "nested", "D:\\nested\\root", 2);
    let nested = core.take_jobs(2).remove(0); monitored(&mut core, &nested);
    let scanned = chain(&nested, 2);
    let deepest = format!("{}child\\child\\child", drive.target.path);
    core.limits.cache_bytes = before + scanned.accounted_bytes - (NODE_ACCOUNT_BYTES + deepest.len());
    core.finished(&nested, scanned, Some(RootIdentity([1,2,3,4])), 3);
    for (id, job, path, expected) in [
        ("drive", &drive, "C:\\child\\child", DirectorySizeRecordState::Complete),
        ("drive", &drive, "C:\\child\\child\\child", DirectorySizeRecordState::Unknown),
        ("nested", &nested, "D:\\nested\\root\\child\\child", DirectorySizeRecordState::Complete),
    ] {
        let lookup = core.lookup("main", LookupDirectorySizesRequest { consumer_id: id.into(),
            generation: job.generation, paths: vec![path.into()] }, 3).unwrap();
        assert_eq!(lookup.directories[0].state, expected, "{path}");
    }
    assert_eq!(core.cache_bytes(), core.limits.cache_bytes);
}

use super::*;
use std::sync::{Mutex, atomic::{AtomicU64, AtomicBool}};
use crate::services::directory_size::{rename_proof::{ObjectProof, RenameItem}, watch::{WatchChanges, WatchEvent, ChangeKind}, metadata::{ListingFingerprint, MetadataKind}};

#[derive(Default)]
struct Notifications { changes: Mutex<WatchChanges>, ticket: AtomicU64, hold: AtomicBool }
struct Detailed(Arc<Notifications>);
impl SizeWatch for Detailed {
    fn poll(&mut self) -> WatchPoll { WatchPoll::Quiet }
    fn epoch(&self) -> u64 { 11 }
    fn request_drain(&self) -> u64 { self.0.ticket.fetch_add(1, Ordering::Relaxed) + 1 }
    fn changes(&mut self) -> WatchChanges {
        let mut changes = std::mem::take(&mut *self.0.changes.lock().unwrap());
        if !self.0.hold.load(Ordering::Relaxed) { changes.drained_ticket = self.0.ticket.load(Ordering::Relaxed); }
        changes
    }
}
fn proof(identity: RootIdentity) -> ObjectProof { ObjectProof { identity, directory: true, attributes: 16, modified: 10, bytes: 0 } }
fn fingerprint(name: &str) -> String { let mut stamp = ListingFingerprint::default(); stamp.add(name, MetadataKind::Directory); stamp.finish().unwrap() }
fn path(path: &str) -> String { normalize_local_path(path).unwrap() }
struct Fixture { core: Core, notify: Arc<Notifications>, key: String, item: RenameItem, roots: HashMap<String, ObjectProof> }
impl Fixture {
    fn new() -> Self {
        let mut core = core(); subscribe(&mut core, "parent", "C:\\root", 0);
        let job = core.take_jobs(0).remove(0);
        let notify = Arc::new(Notifications::default());
        let root_proof = proof(RootIdentity([1, 2, 3, 4]));
        core.prepared(&job, Some(root_proof.identity), Some(Box::new(Detailed(notify.clone()))), 0);
        let mut scanned = result(&job, 60); scanned.accounted_bytes = 4096;
        scanned.directories.get_mut(job.target.path.as_str()).unwrap().fingerprint = Some(fingerprint("old"));
        for name in ["C:\\root\\old", "C:\\root\\old\\deep"] {
            let mut size = scanned.directories[job.target.path.as_str()].clone(); size.fingerprint = Some(fingerprint("deep"));
            scanned.directories.insert(path(name).into(), size);
        }
        core.finished(&job, scanned, Some(root_proof.identity), 1);
        let item = RenameItem { from: path("C:\\root\\old"), current: path("C:\\root\\old"), to: path("C:\\root\\new"),
            proof: proof(RootIdentity([1, 8, 9, 0])), parent: root_proof.identity };
        Self { core, notify, key: job.target.key.clone(), item, roots: HashMap::from([(job.target.key, root_proof)]) }
    }
    fn begin(&mut self) -> u64 {
        let paths = vec![self.item.from.clone(), self.item.to.clone()];
        let prepared = self.core.prepare_rename(&paths, 2);
        assert!(self.core.preparation_drained(&prepared, 2));
        self.core.begin_rename(prepared, paths, Some(vec![self.item.clone()]), &self.roots, 2).unwrap()
    }
    fn events(&self, events: &[(&str, ChangeKind)]) {
        self.notify.changes.lock().unwrap().events.extend(events.iter().map(|(path, kind)| WatchEvent { path: (*path).into(), kind: *kind }));
    }
    fn register(&mut self, token: u64) {
        self.core.register_rename_step(token, &self.item.from, &self.item.to, Some(&self.item.proof), 3);
    }
    fn confirm(&mut self, token: u64) { self.core.confirm_rename_step(token, Some(&self.item.proof), 4); }
    fn finish(&mut self, token: u64) -> bool {
        self.core.request_rename_drain(token); self.core.tick(5);
        let revision = self.core.rename_proof_revision(token);
        self.core.finish_rename(token, true, &self.roots, revision, 5)
    }
}

#[test]
fn rename_cache_pairs_can_span_buffers_but_pending_old_and_drain_never_certify_results() {
    let mut t = Fixture::new(); let token = t.begin(); t.register(token);
    t.events(&[("old", ChangeKind::RenameOld)]); t.confirm(token);
    t.core.request_rename_drain(token);
    assert_eq!(t.core.rename_ready(token, 4), None);
    assert_eq!(t.core.snapshot("parent").unwrap().phase, DirectorySizePhase::Stale);
    t.events(&[("new", ChangeKind::RenameNew), ("new", ChangeKind::Modified)]);
    t.notify.hold.store(true, Ordering::Relaxed);
    assert_eq!(t.core.rename_ready(token, 4), None);
    t.notify.hold.store(false, Ordering::Relaxed);
    assert!(t.finish(token));
    assert_eq!(t.core.jobs_started, 1); assert_eq!(t.core.root_count(), 1);
    let snapshot = t.core.snapshot("parent").unwrap();
    let lookup = t.core.lookup("main", LookupDirectorySizesRequest { consumer_id: "parent".into(), generation: snapshot.generation,
        paths: vec!["C:\\root".into(), "C:\\root\\new\\deep".into()] }, 5).unwrap();
    assert_eq!(lookup.directories[0].size_fingerprint.as_deref(), Some(fingerprint("new").as_str()));
    assert_eq!(lookup.directories[1].bytes.as_deref(), Some("60"));
    assert!(!t.finish(token), "a consumed token cannot migrate twice");
}

#[test]
fn rename_cache_old_scope_is_stale_and_never_redirected_to_new_object() {
    let mut t = Fixture::new(); subscribe(&mut t.core, "old-scope", "C:\\root\\old", 1);
    let token = t.begin(); t.register(token);
    t.events(&[("old", ChangeKind::RenameOld), ("new", ChangeKind::RenameNew)]); t.confirm(token);
    assert!(t.finish(token));
    assert_eq!(t.core.snapshot("old-scope").unwrap().phase, DirectorySizePhase::Stale);
    assert_eq!(t.core.snapshot("parent").unwrap().total_bytes.as_deref(), Some("60"));
    let identity = t.core.take_identity_job(2005).unwrap();
    t.core.identity_finished(&identity, Ok(RootIdentity([1, 2, 3, 4])), 2006);
    assert_eq!(t.core.snapshot("old-scope").unwrap().phase, DirectorySizePhase::Stale);
    t.events(&[("old", ChangeKind::Added)]); t.core.tick(2007);
    let job = t.core.take_jobs(3000).remove(0);
    t.core.prepared(&job, Some(RootIdentity([1, 2, 3, 4])), Some(Box::new(Detailed(t.notify.clone()))), 3000);
    let mut replacement = result(&job, 999);
    replacement.directories.insert(t.item.from.clone().into(), replacement.directories[job.target.path.as_str()].clone());
    t.core.finished(&job, replacement, Some(RootIdentity([1, 2, 3, 4])), 3001);
    assert_eq!(t.core.snapshot("old-scope").unwrap().phase, DirectorySizePhase::Stale, "same path replacement is a different subscription identity");
}

#[test]
fn rename_cache_modified_after_final_proof_invalidates_that_proof() {
    let mut t = Fixture::new(); let token = t.begin(); t.register(token);
    t.events(&[("old", ChangeKind::RenameOld), ("new", ChangeKind::RenameNew)]); t.confirm(token);
    t.core.request_rename_drain(token); assert_eq!(t.core.rename_ready(token, 4), Some(true));
    let revision = t.core.rename_proof_revision(token);
    // A final metadata read can no longer prove an event arriving after it.
    t.events(&[("new", ChangeKind::Modified)]); t.core.request_rename_drain(token);
    assert!(!t.core.finish_rename(token, true, &t.roots, revision, 5));
}

#[test]
fn rename_cache_unexpected_events_loss_unconfirmed_steps_and_changed_metadata_never_revive() {
    for case in ["write", "added", "lost", "unexpected-rename", "unconfirmed", "metadata"] {
        let mut t = Fixture::new(); let token = t.begin(); t.register(token);
        t.events(&[("old", ChangeKind::RenameOld), ("new", ChangeKind::RenameNew)]);
        match case {
            "write" => t.events(&[("new\\deep\\payload", ChangeKind::Modified)]),
            "added" => t.events(&[("new\\surprise", ChangeKind::Added)]),
            "lost" => t.notify.changes.lock().unwrap().lost = true,
            "unexpected-rename" => t.events(&[("foreign", ChangeKind::RenameOld)]),
            "metadata" => { let mut changed = t.item.proof.clone(); changed.modified += 1; t.core.confirm_rename_step(token, Some(&changed), 4); },
            _ => {}
        }
        if case != "unconfirmed" { t.confirm(token); }
        assert!(!t.finish(token), "{case}");
        assert_ne!(t.core.snapshot("parent").unwrap().phase, DirectorySizePhase::Complete);
    }
}

#[test]
fn rename_cache_abandon_timeout_and_overlapping_guard_keep_scan_fences_until_worker_finishes() {
    for case in ["abandon", "timeout", "overlap"] {
        let mut t = Fixture::new(); let token = t.begin();
        let other = if case == "overlap" { Some(t.begin()) } else { None };
        if case == "abandon" { t.core.abandon_rename(token); }
        t.core.tick(40_000);
        subscribe(&mut t.core, "new-scope", "C:\\root\\new", 40_000);
        assert!(t.core.take_jobs(40_000).is_empty(), "{case}: new subscribers cannot bypass a live operation fence");
        assert!(!t.core.finish_rename(token, false, &HashMap::new(), None, 40_001));
        if let Some(other) = other {
            assert!(t.core.take_jobs(40_001).is_empty());
            t.core.finish_rename(other, false, &HashMap::new(), None, 40_001);
        }
        assert!(!t.core.take_jobs(50_000).is_empty());
    }
}

#[test]
fn rename_cache_rejects_late_prepare_identity_wrong_root_and_insufficient_memory_atomically() {
    for case in ["late-prepare", "root-proof", "budget"] {
        let mut t = Fixture::new();
        let token = if case == "late-prepare" {
            let paths = vec![t.item.from.clone(), t.item.to.clone()];
            let prepared = t.core.prepare_rename(&paths, 2);
            t.events(&[("other", ChangeKind::Added)]); t.core.tick(3);
            t.core.begin_rename(prepared, paths, Some(vec![t.item.clone()]), &t.roots, 3).unwrap()
        } else { t.begin() };
        t.register(token); t.events(&[("old", ChangeKind::RenameOld), ("new", ChangeKind::RenameNew)]); t.confirm(token);
        if case == "root-proof" { t.roots.get_mut(&t.key).unwrap().identity.0[1] += 1; }
        if case == "budget" { t.core.limits.cache_bytes = 1; }
        assert!(!t.finish(token), "{case}");
        assert_eq!(t.core.cache_bytes(), 0);
    }
}

#[test]
fn rename_cache_actual_temporary_paths_remain_scan_fenced_after_abandon_or_timeout() {
    for case in ["active", "abandoned", "timeout"] {
        let mut t = Fixture::new(); let token = t.begin();
        if case == "abandoned" { t.core.abandon_rename(token); }
        let now = if case == "timeout" { 40_000 } else { 3 };
        t.core.register_rename_step(token, &t.item.from, &path("C:\\root\\.athenaeum-temporary"), Some(&t.item.proof), now);
        t.core.confirm_rename_step(token, Some(&t.item.proof), now);
        subscribe(&mut t.core, "temporary", "C:\\root\\.athenaeum-temporary\\deep", now);
        assert!(t.core.take_jobs(now).is_empty(), "{case}: a temporary operation path cannot start a parallel scan");
        t.core.finish_rename(token, false, &HashMap::new(), None, now + 1);
        assert!(!t.core.take_jobs(now + 3000).is_empty());
    }
}

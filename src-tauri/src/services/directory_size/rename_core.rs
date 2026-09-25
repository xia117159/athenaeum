use super::*;
use std::collections::{HashSet, VecDeque};
use super::super::{rename_proof::{self as proof, RenameItem, ObjectProof}, watch::{WatchChanges, ChangeKind}};

pub(crate) struct RootProbe {
    pub key: String, pub path: String, pub generation: u64, pub epoch: u64, pub ticket: u64,
}
pub(crate) struct RenamePreparation { pub ticket: u64, pub roots: Vec<RootProbe> }
pub(super) struct GuardWatch {
    pub epoch: u64, pub generation: u64, pub path: String,
    pub expected: VecDeque<(String, ChangeKind)>, pub modified: HashSet<String>, pub ticket: u64,
}
pub(super) struct Maintenance {
    pub paths: Vec<String>, pub items: Vec<RenameItem>, pub roots: HashMap<String, GuardWatch>,
    pub started: u64, pub valid: bool, pub pending: Option<(usize, String)>, pub steps: usize,
    pub proof_revision: u64,
}
impl Maintenance {
    pub fn consume(&mut self, key: &str, changes: WatchChanges) {
        if !self.valid { return; }
        let Some(root) = self.roots.get_mut(key) else { self.valid = false; return; };
        if changes.lost { self.valid = false; return; }
        for event in changes.events {
            if event.kind == ChangeKind::Modified && root.modified.contains(&event.path) {
                self.proof_revision += 1;
                continue;
            }
            let expected = root.expected.pop_front();
            if expected != Some((event.path.clone(), event.kind)) {
                self.valid = false; break;
            }
        }
    }
}
impl Core {
    pub fn rename_fenced(&self, path: &str) -> bool {
        self.maintenance.values().any(|guard| guard.paths.iter().any(|scope| proof::overlaps(scope, path)))
    }
    pub fn prepare_rename(&mut self, paths: &[String], now: u64) -> RenamePreparation {
        self.tick(now); self.rename_ticket += 1;
        let roots = self.roots.iter().filter(|(_, root)| root.target.profile.is_none() && paths.iter().any(|path| proof::overlaps(&root.target.path, path)))
            .map(|(key, root)| RootProbe { key: key.clone(), path: root.target.path.clone(), generation: root.generation,
                epoch: root.watch.as_ref().map_or(0, |watch| watch.epoch()), ticket: root.watch.as_ref().map_or(0, |watch| watch.request_drain()) }).collect();
        RenamePreparation { ticket: self.rename_ticket, roots }
    }
    pub fn preparation_drained(&mut self, preparation: &RenamePreparation, now: u64) -> bool {
        self.tick(now);
        preparation.roots.iter().all(|probe| self.roots.get(&probe.key).is_none_or(|root|
            root.generation != probe.generation || root.watch.is_none() || root.drained_ticket >= probe.ticket))
    }
    pub fn begin_rename(&mut self, preparation: RenamePreparation, paths: Vec<String>, items: Option<Vec<RenameItem>>,
        roots_proof: &HashMap<String, ObjectProof>, now: u64) -> Option<u64> {
        self.tick(now);
        if self.stopped || paths.is_empty() { return None; }
        let overlapping: Vec<_> = self.maintenance.iter().filter(|(_, guard)| guard.paths.iter().any(|old| paths.iter().any(|new| proof::overlaps(old, new))))
            .map(|(id, _)| *id).collect();
        let mut valid = items.is_some() && overlapping.is_empty();
        for id in overlapping { self.abandon_rename(id); }
        let keys: Vec<_> = self.roots.iter().filter(|(_, root)| root.target.profile.is_none() && paths.iter().any(|path| proof::overlaps(&root.target.path, path)))
            .map(|(key, _)| key.clone()).collect();
        // The token is allocated before I/O and cannot be reused by a late prepare.
        let token = preparation.ticket;
        let mut roots = HashMap::new();
        for key in keys {
            let root = self.roots.get_mut(&key).unwrap();
            let probe = preparation.roots.iter().find(|probe| probe.key == key);
            let eligible = root.guard.is_none() && root.running.is_none() && root.result.is_some() && !root.identity_expired
                && matches!(root.phase, DirectorySizePhase::Complete | DirectorySizePhase::Partial)
                && probe.is_some_and(|probe| probe.generation == root.generation && probe.epoch != 0 && root.drained_ticket >= probe.ticket
                    && root.watch.as_ref().is_some_and(|watch| watch.epoch() == probe.epoch))
                && roots_proof.get(&key).is_some_and(|proof| proof.directory && Some(proof.identity) == root.identity);
            valid &= eligible;
            self.generation += 1; root.generation = self.generation; root.sequence = 0;
            root.phase = DirectorySizePhase::Stale; root.reason = Some("正在验证更名后的目录大小缓存".into());
            root.needs_scan = false;
            if let Some(running) = &root.running { running.cancelled.store(true, Ordering::Relaxed); }
            if root.guard.is_none() { root.guard = Some(token); }
            roots.insert(key.clone(), GuardWatch { epoch: root.watch.as_ref().map_or(0, |watch| watch.epoch()), generation: root.generation,
                path: root.target.path.clone(), expected: VecDeque::new(), modified: HashSet::new(), ticket: 0 });
            for lease in self.leases.values_mut().filter(|lease| lease.key == key) { lease.verified = false; }
            self.emit(&key);
        }
        self.maintenance.insert(token, Maintenance { paths, items: items.unwrap_or_default(), roots, started: now, valid, pending: None, steps: 0, proof_revision: 0 });
        if !valid { self.abandon_rename(token); }
        Some(token)
    }
    pub fn abandon_rename(&mut self, token: u64) {
        let Some(guard) = self.maintenance.get_mut(&token) else { return; };
        guard.valid = false;
        for root in self.roots.values_mut().filter(|root| root.guard == Some(token)) {
            root.result = None; root.stats = ScanStats::default(); root.phase = DirectorySizePhase::Stale;
            root.reason = Some("更名缓存验证未通过，等待操作结束后重新统计".into());
        }
    }
    pub fn register_rename_step(&mut self, token: u64, from: &str, to: &str, before: Option<&ObjectProof>, now: u64) -> bool {
        self.tick(now);
        let Some(guard) = self.maintenance.get_mut(&token) else { return false; };
        // Even a failed proof leaves a real worker using intermediate names.
        // Keep those paths fenced through cancellation, timeout and rollback.
        for path in [from, to] {
            if !guard.paths.iter().any(|known| known == path) {
                if guard.paths.len() >= 40_000 { self.abandon_rename(token); return false; }
                guard.paths.push(path.into());
            }
        }
        if !guard.valid { return true; }
        let index = guard.items.iter().position(|item| item.current == from && before == Some(&item.proof));
        if index.is_none() || guard.pending.is_some() || guard.steps >= 4096 || proof::parent(from) != proof::parent(to) {
            self.abandon_rename(token); return true;
        }
        let index = index.unwrap();
        for root in guard.roots.values_mut() {
            if root.path != from && proof::contains(&root.path, from) {
                let relative = |path: &str| path[root.path.trim_end_matches('\\').len() + 1..].to_owned();
                let old = relative(from); let new = relative(to);
                root.expected.push_back((old.clone(), ChangeKind::RenameOld));
                root.expected.push_back((new.clone(), ChangeKind::RenameNew));
                if guard.items[index].proof.directory { root.modified.insert(old); root.modified.insert(new); }
            }
        }
        guard.pending = Some((index, to.into())); guard.steps += 1;
        true
    }
    pub fn confirm_rename_step(&mut self, token: u64, after: Option<&ObjectProof>, now: u64) {
        self.tick(now);
        let Some(guard) = self.maintenance.get_mut(&token).filter(|guard| guard.valid) else { return; };
        let Some((index, to)) = guard.pending.take() else { self.abandon_rename(token); return; };
        if after != Some(&guard.items[index].proof) { self.abandon_rename(token); return; }
        let from = guard.items[index].current.clone();
        for root in guard.roots.values_mut() { root.path = proof::rewrite(&root.path, &from, &to); }
        guard.items[index].current = to;
    }
    pub fn request_rename_drain(&mut self, token: u64) {
        if let Some(guard) = self.maintenance.get_mut(&token) {
            for (key, watched) in &mut guard.roots {
                watched.ticket = self.roots.get(key).and_then(|root| root.watch.as_ref()).map_or(0, |watch| watch.request_drain());
            }
        }
    }
    pub fn rename_ready(&mut self, token: u64, now: u64) -> Option<bool> {
        self.tick(now);
        let guard = self.maintenance.get(&token)?;
        if !guard.valid { return Some(false); }
        if guard.pending.is_some() || guard.items.iter().any(|item| item.current != item.to) { return Some(false); }
        let ready = guard.roots.iter().all(|(key, watched)| watched.expected.is_empty() && watched.ticket > 0 && self.roots.get(key).is_some_and(|root|
            root.guard == Some(token) && root.generation == watched.generation && root.drained_ticket >= watched.ticket
            && root.watch.as_ref().is_some_and(|watch| watch.epoch() == watched.epoch)));
        ready.then_some(true)
    }
    pub fn rename_items(&self, token: u64) -> Option<Vec<RenameItem>> {
        self.maintenance.get(&token).filter(|guard| guard.valid).map(|guard| guard.items.clone())
    }
    pub fn rename_proof_revision(&self, token: u64) -> Option<u64> { self.maintenance.get(&token).map(|guard| guard.proof_revision) }
    pub fn rename_root_paths(&self, token: u64) -> Vec<(String, String)> {
        self.maintenance.get(&token).map(|guard| guard.roots.iter().map(|(key, root)| (key.clone(), root.path.clone())).collect()).unwrap_or_default()
    }
    pub fn rename_descendant_roots(&self, token: u64, sources: &[String]) -> Vec<(String, String, u64)> {
        self.maintenance.get(&token).map(|guard| guard.roots.iter().filter(|(_, root)| sources.iter()
            .any(|source| source != &root.path && proof::contains(source, &root.path)))
            .map(|(key, root)| (key.clone(), root.path.clone(), root.generation)).collect()).unwrap_or_default()
    }
    pub fn rename_drained(&mut self, token: u64, now: u64) -> bool {
        self.tick(now);
        self.maintenance.get(&token).is_some_and(|guard| guard.roots.iter().all(|(key, watched)|
            self.roots.get(key).is_none_or(|root| root.watch.is_none() || root.drained_ticket >= watched.ticket)))
    }
    pub fn detach_rename_watches(&mut self, token: u64, keys: &[String], now: u64) {
        self.tick(now);
        for key in keys {
            if let Some(root) = self.roots.get_mut(key).filter(|root| root.guard == Some(token)) {
                root.watch = None; root.drained_ticket = 0;
            }
        }
    }
    pub fn restore_rename_watch(&mut self, token: u64, key: &str, generation: u64, path: &str,
        identity: RootIdentity, watch: Box<dyn SizeWatch>, now: u64) -> bool {
        self.tick(now);
        let Some(guard) = self.maintenance.get_mut(&token).filter(|guard| guard.valid) else { return false; };
        let Some(watched) = guard.roots.get_mut(key).filter(|root| root.path == path && root.generation == generation) else { return false; };
        let Some(root) = self.roots.get_mut(key).filter(|root| root.guard == Some(token) && root.generation == generation
            && root.identity == Some(identity) && root.watch.is_none()) else { return false; };
        watched.epoch = watch.epoch(); watched.ticket = 0; root.drained_ticket = 0; root.watch = Some(watch); true
    }
}

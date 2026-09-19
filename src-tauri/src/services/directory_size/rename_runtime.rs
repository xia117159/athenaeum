use std::{collections::HashMap, path::{Path, PathBuf}, thread, time::{Duration, Instant}};
use super::{DirectorySizeService, rename_proof::{self as proof, ObjectProof}, rename_handoff::Handoff};

/// Internal capability held only by the actual operation worker. Cache failure
/// never changes the outcome of the underlying filesystem operation.
pub(crate) struct RenameSession<'a> { service: &'a DirectorySizeService, token: Option<u64>, handoff: Handoff }
impl DirectorySizeService {
    pub(crate) fn begin_rename(&self, paths: &[(PathBuf, PathBuf)], optimize: bool) -> RenameSession<'_> {
        let scopes: Vec<_> = paths.iter().flat_map(|(from, to)| [from, to]).filter_map(|path| proof::normalize(path)).collect();
        let preparation = self.core.lock().unwrap().prepare_rename(&scopes, self.now());
        let roots_proof = preparation.roots.iter().filter_map(|probe| proof::read_proof(&probe.path).map(|value| (probe.key.clone(), value))).collect();
        let mut items = optimize.then(|| proof::prepare_items(paths)).flatten();
        let deadline = Instant::now() + Duration::from_secs(2);
        while !self.core.lock().unwrap().preparation_drained(&preparation, self.now()) {
            if Instant::now() >= deadline { items = None; break; }
            thread::sleep(Duration::from_millis(2));
        }
        let token = self.core.lock().unwrap().begin_rename(preparation, scopes, items, &roots_proof, self.now());
        self.wake();
        let handoff = Handoff::prepare(self, token, paths);
        RenameSession { service: self, token, handoff }
    }
    pub(crate) fn rename_file(&self, from: &Path, to: &Path, optimize: bool) -> anyhow::Result<()> {
        self.rename_with(from, to, optimize, || Ok(std::fs::rename(from, to)?))
    }
    pub(crate) fn rename_with(&self, from: &Path, to: &Path, optimize: bool, action: impl FnOnce() -> anyhow::Result<()>) -> anyhow::Result<()> {
        let mut session = self.begin_rename(&[(from.to_path_buf(), to.to_path_buf())], optimize);
        let result = session.step(from, to, action);
        session.finish(result.is_ok());
        result
    }
    #[cfg(test)]
    pub(crate) fn debug_counts(&self) -> (usize, usize) {
        let core = self.core.lock().unwrap(); (core.root_count(), core.jobs_started)
    }
}
impl RenameSession<'_> {
    pub(crate) fn abandon(&mut self) { if let Some(token) = self.token { self.service.core.lock().unwrap().abandon_rename(token); } }
    pub(crate) fn step<T>(&mut self, from: &Path, to: &Path, action: impl FnOnce() -> anyhow::Result<T>) -> anyhow::Result<T> {
        let paths = proof::normalize(from).zip(proof::normalize(to));
        if let (Some(token), Some((from, to))) = (self.token, paths.as_ref()) {
            let before = proof::read_proof(from);
            anyhow::ensure!(self.service.core.lock().unwrap().register_rename_step(token, from, to, before.as_ref(), self.service.now()),
                "更名路径保护已结束或达到上限，请稍后重试");
        } else { self.abandon(); }
        let step_paths = self.handoff.before_step(from, to)?;
        let result = action();
        if result.is_ok() { self.handoff.renamed(&step_paths); }
        if !self.handoff.quiet() { self.abandon(); }
        if let (Some(token), Some((_, to))) = (self.token, paths) {
            let after = result.as_ref().ok().and_then(|_| proof::read_proof(&to));
            self.service.core.lock().unwrap().confirm_rename_step(token, after.as_ref(), self.service.now());
        }
        result
    }
    pub(crate) fn finish(&mut self, success: bool) -> bool {
        let Some(token) = self.token.take() else { return false; };
        let mut success = success;
        let deadline = Instant::now() + Duration::from_secs(2);
        if success { success = self.handoff.restore(self.service, token, deadline); }
        if success {
            self.service.core.lock().unwrap().request_rename_drain(token);
            loop {
                match self.service.core.lock().unwrap().rename_ready(token, self.service.now()) {
                    Some(true) => break,
                    Some(false) => { success = false; break; }
                    None if Instant::now() >= deadline => { success = false; break; }
                    None => {}
                }
                thread::sleep(Duration::from_millis(2));
            }
        }
        let revision = self.service.core.lock().unwrap().rename_proof_revision(token);
        let items = self.service.core.lock().unwrap().rename_items(token);
        success &= items.as_ref().is_some_and(|items| proof::final_proofs_match(items));
        let paths = self.service.core.lock().unwrap().rename_root_paths(token);
        let proofs: HashMap<String, ObjectProof> = paths.iter().filter_map(|(key, path)| proof::read_proof(path).map(|value| (key.clone(), value))).collect();
        // Account for notifications concurrent with the final proof reads too.
        self.service.core.lock().unwrap().request_rename_drain(token);
        while success {
            match self.service.core.lock().unwrap().rename_ready(token, self.service.now()) {
                Some(true) => break,
                Some(false) => { success = false; break; }
                None if Instant::now() >= deadline => { success = false; break; }
                None => thread::sleep(Duration::from_millis(2)),
            }
        }
        if success { success = self.handoff.drain(deadline); }
        let mut core = self.service.core.lock().unwrap();
        let result = core.finish_rename(token, success && self.handoff.quiet(), &proofs, revision, self.service.now());
        drop(core);
        self.service.wake(); result
    }
}
impl Drop for RenameSession<'_> {
    fn drop(&mut self) {
        if let Some(token) = self.token.take() {
            self.service.core.lock().unwrap().finish_rename(token, false, &HashMap::new(), None, self.service.now());
            self.service.wake();
        }
    }
}

use std::{path::{Path, PathBuf}, time::Instant};
use super::DirectorySizeService;

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{thread, time::Duration};
    use super::super::{rename_proof as proof, watch::RecursiveWatch};
    use crate::services::watch_registry::{RenameBarrier, WatchControl, physical_path};

    pub(crate) struct Handoff {
        coverage: Vec<RecursiveWatch>, barrier: Option<RenameBarrier>,
        roots: Vec<(String, String, u64)>, ready: bool, healthy: bool, deadline: Instant,
    }
    fn closed(controls: &[WatchControl], deadline: Instant) -> bool {
        while controls.iter().any(|watch| !watch.closed()) {
            if Instant::now() >= deadline { return false; }
            thread::sleep(Duration::from_millis(2));
        }
        true
    }
    impl Handoff {
        pub fn prepare(service: &DirectorySizeService, token: Option<u64>, paths: &[(PathBuf, PathBuf)]) -> Self {
            let deadline = Instant::now() + Duration::from_secs(2);
            let barrier = RenameBarrier::new(paths);
            let mut handoff = Self { coverage: vec![], barrier, roots: vec![], ready: false, healthy: true, deadline };
            let sources: Vec<_> = paths.iter().filter(|(from, to)| from != to).filter_map(|(from, _)| proof::normalize(from)).collect();
            if let Some(token) = token {
                handoff.roots = service.core.lock().unwrap().rename_descendant_roots(token, &sources);
                let mut covered = std::collections::HashSet::new();
                for source in sources.iter().filter(|source| handoff.roots.iter().any(|(_, path, _)| proof::contains(source, path))) {
                    if !covered.insert(source) { continue; }
                    let watch = RecursiveWatch::open_before(source, handoff.barrier.as_ref().map(RenameBarrier::permit), deadline);
                    match watch {
                        Some(watch) if proof::read_proof(source).is_some_and(|proof| proof.identity == watch.root_identity())
                            && watch.drain_handle().wait_until(deadline) => handoff.coverage.push(watch),
                        _ => handoff.healthy = false,
                    }
                }
                if !handoff.roots.is_empty() {
                    service.core.lock().unwrap().request_rename_drain(token);
                    while !service.core.lock().unwrap().rename_drained(token, service.now()) {
                        if Instant::now() >= deadline { handoff.healthy = false; break; }
                        thread::sleep(Duration::from_millis(2));
                    }
                }
                let keys: Vec<_> = handoff.roots.iter().map(|(key, _, _)| key.clone()).collect();
                service.core.lock().unwrap().detach_rename_watches(token, &keys, service.now());
            }
            if let Some(barrier) = &handoff.barrier { handoff.ready = closed(&barrier.retire_descendants(), deadline); }
            if !handoff.ready || !handoff.quiet() {
                if let Some(token) = token { service.core.lock().unwrap().abandon_rename(token); }
            }
            handoff
        }
        pub fn before_step(&mut self, from: &Path, to: &Path) -> anyhow::Result<(String, String)> {
            anyhow::ensure!(self.ready, "目录监视句柄尚未关闭，请稍后重试");
            let from = physical_path(from).ok_or_else(|| anyhow::anyhow!("无法确认更名源路径"))?;
            let to = physical_path(to).ok_or_else(|| anyhow::anyhow!("无法确认更名目标路径"))?;
            let closing = self.barrier.as_ref().and_then(|barrier| barrier.prepare_step(&to))
                .ok_or_else(|| anyhow::anyhow!("更名监视保护已达到上限，请稍后重试"))?;
            anyhow::ensure!(closed(&closing, self.deadline), "目录监视句柄尚未关闭，请稍后重试");
            Ok((from, to))
        }
        pub fn renamed(&mut self, paths: &(String, String)) {
            if let Some(barrier) = &self.barrier { barrier.renamed(&paths.0, &paths.1); }
        }
        pub fn restore(&mut self, service: &DirectorySizeService, token: u64, deadline: Instant) -> bool {
            if !self.quiet() { return false; }
            let Some(barrier) = &self.barrier else { return false; };
            let paths = service.core.lock().unwrap().rename_root_paths(token);
            for (key, _, generation) in &self.roots {
                let Some((_, path)) = paths.iter().find(|(current, _)| current == key) else { return false; };
                let Some(watch) = RecursiveWatch::open_before(path, Some(barrier.permit()), deadline) else { return false; };
                let identity = watch.root_identity();
                if !service.core.lock().unwrap().restore_rename_watch(token, key, *generation, path, identity, Box::new(watch), service.now()) { return false; }
            }
            self.quiet()
        }
        pub fn drain(&mut self, deadline: Instant) -> bool {
            for watch in &self.coverage {
                if !watch.drain_handle().wait_until(deadline) { self.healthy = false; }
            }
            self.quiet()
        }
        pub fn quiet(&mut self) -> bool {
            for watch in &mut self.coverage {
                let changes = watch.take_changes();
                if changes.lost || !changes.events.is_empty() { self.healthy = false; }
            }
            self.healthy
        }
    }
}
#[cfg(windows)]
pub(super) use windows::Handoff;

#[cfg(not(windows))]
pub(super) struct Handoff;
#[cfg(not(windows))]
impl Handoff {
    pub fn prepare(_: &DirectorySizeService, _: Option<u64>, _: &[(PathBuf, PathBuf)]) -> Self { Self }
    pub fn before_step(&mut self, _: &Path, _: &Path) -> anyhow::Result<(String, String)> { Ok((String::new(), String::new())) }
    pub fn renamed(&mut self, _: &(String, String)) {}
    pub fn restore(&mut self, _: &DirectorySizeService, _: u64, _: Instant) -> bool { true }
    pub fn drain(&mut self, _: Instant) -> bool { true }
    pub fn quiet(&mut self) -> bool { true }
}

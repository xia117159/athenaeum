use anyhow::{bail, Result};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
};

#[derive(Debug, Default)]
pub struct OpenJob {
    cancelled: AtomicBool,
    launching: Mutex<bool>,
}
impl OpenJob {
    pub fn cancelled(&self) -> &AtomicBool {
        &self.cancelled
    }
    pub fn cancel(&self) -> bool {
        let launching = self.launching.lock().expect("file launch lock poisoned");
        if *launching {
            return false;
        }
        self.cancelled.store(true, Ordering::Release);
        true
    }
    pub fn begin_launch(&self) -> bool {
        let mut launching = self.launching.lock().expect("file launch lock poisoned");
        if *launching || self.cancelled.load(Ordering::Acquire) {
            return false;
        }
        *launching = true;
        true
    }
}
type Owners = HashMap<String, HashMap<String, Arc<OpenJob>>>;
#[derive(Default)]
struct RegistryState {
    owners: Owners,
    pending: usize,
    closing: bool,
}
#[derive(Default)]
struct Registry {
    state: Mutex<RegistryState>,
    idle: Condvar,
}
#[derive(Clone, Default)]
pub struct FileOpenJobs {
    registry: Arc<Registry>,
}
pub struct RegisteredOpen {
    pub job: Arc<OpenJob>,
    registry: Arc<Registry>,
    owner: String,
    id: String,
}
impl Drop for RegisteredOpen {
    fn drop(&mut self) {
        let mut state = self.registry.state.lock().expect("file jobs lock poisoned");
        if let Some(jobs) = state.owners.get_mut(&self.owner) {
            if jobs
                .get(&self.id)
                .is_some_and(|job| Arc::ptr_eq(job, &self.job))
            {
                jobs.remove(&self.id);
            }
        }
        state.pending -= 1;
        if state.pending == 0 {
            self.registry.idle.notify_all();
        }
    }
}
impl FileOpenJobs {
    pub fn open_owner(&self, owner: &str) {
        let mut state = self.registry.state.lock().expect("file jobs lock poisoned");
        if state.closing {
            return;
        }
        if let Some(old) = state.owners.insert(owner.into(), HashMap::new()) {
            for job in old.values() {
                job.cancel();
            }
        }
    }
    pub fn close_owner(&self, owner: &str) {
        let mut state = self.registry.state.lock().expect("file jobs lock poisoned");
        if let Some(jobs) = state.owners.remove(owner) {
            for job in jobs.values() {
                job.cancel();
            }
        }
    }
    /// Stop admission and request cancellation without blocking the window thread.
    /// Return true only when every registration has already finished cleanup.
    pub fn begin_shutdown(&self) -> bool {
        let mut state = self.registry.state.lock().expect("file jobs lock poisoned");
        state.closing = true;
        for (_, jobs) in state.owners.drain() {
            for job in jobs.values() {
                job.cancel();
            }
        }
        state.pending == 0
    }
    /// Call from the exit coordinator before allowing the host process to exit.
    pub fn shutdown(&self) {
        self.begin_shutdown();
        let mut state = self.registry.state.lock().expect("file jobs lock poisoned");
        while state.pending != 0 {
            state = self
                .registry
                .idle
                .wait(state)
                .expect("file jobs lock poisoned");
        }
    }
    pub fn register(&self, owner: &str, id: &str) -> Result<RegisteredOpen> {
        if id.trim().is_empty() || id.len() > 128 {
            bail!("文件打开请求标识无效");
        }
        let mut state = self.registry.state.lock().expect("file jobs lock poisoned");
        if state.closing {
            bail!("应用正在退出，无法打开文件");
        }
        let jobs = state
            .owners
            .get_mut(owner)
            .ok_or_else(|| anyhow::anyhow!("文件窗口已关闭"))?;
        if jobs.contains_key(id) {
            bail!("文件打开请求重复");
        }
        let job = Arc::new(OpenJob::default());
        jobs.insert(id.into(), job.clone());
        state.pending += 1;
        Ok(RegisteredOpen {
            job,
            registry: self.registry.clone(),
            owner: owner.into(),
            id: id.into(),
        })
    }
    pub fn cancel(&self, owner: &str, id: &str) -> bool {
        let state = self.registry.state.lock().expect("file jobs lock poisoned");
        state
            .owners
            .get(owner)
            .and_then(|jobs| jobs.get(id))
            .is_some_and(|job| job.cancel())
    }
    #[cfg(test)]
    pub fn active_count(&self, owner: &str) -> usize {
        self.registry
            .state
            .lock()
            .unwrap()
            .owners
            .get(owner)
            .map_or(0, HashMap::len)
    }
}

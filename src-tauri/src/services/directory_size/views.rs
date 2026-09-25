use std::{collections::{HashMap, HashSet}, sync::Arc};
use crate::domain::directory_sizes::*;
use super::{core::OwnerToken, target::normalize_local_path};

const MAX_WINDOW_SCOPES: usize = 256;
const MAX_SCOPES: usize = 1024;
const MAX_BYTES: usize = 1 << 20;
struct Window { epoch: u64, revision: u32, used: u64, scopes: Vec<DirectorySizeViewScope>, truncated: bool, digest: [u8; 32] }
struct Collecting { nonce: String, expected: HashMap<String, u64>, replied: HashSet<String> }
#[derive(Default)]
pub(super) struct Views {
    windows: HashMap<String, Window>, clock: u64, collecting: Option<Collecting>, frozen: Option<Arc<Vec<DirectorySizeViewScope>>>,
}
impl Views {
    pub fn update(&mut self, owner: &OwnerToken, request: UpdateDirectorySizeViewsRequest) -> Result<DirectorySizeViewsAck, String> {
        if self.frozen.is_some() { return Err("目录大小退出清单已冻结".into()); }
        let handshake = request.owner_epoch.is_none() && request.revision == 0 && request.scopes.is_empty() && request.shutdown_nonce.is_none();
        if !handshake && request.owner_epoch.as_deref() != Some(owner.epoch.to_string().as_str()) { return Err("目录大小视图的窗口版本已过期".into()); }
        if request.scopes.len() > 4096 || request.scopes.iter().map(|scope| scope.path.len()).sum::<usize>() > MAX_BYTES { return Err("目录大小视图清单过大".into()); }
        let final_reply = if let Some(nonce) = &request.shutdown_nonce {
            let collecting = self.collecting.as_ref().ok_or("未请求目录大小退出清单")?;
            if nonce != &collecting.nonce || collecting.expected.get(&owner.label) != Some(&owner.epoch) { return Err("目录大小退出请求已过期".into()); }
            true
        } else { false };
        if self.collecting.is_some() && !self.windows.contains_key(&owner.label) { return Err("目录大小视图正在关闭".into()); }
        let mut seen = HashSet::new(); let mut scopes = vec![];
        let mut requested = request.scopes;
        requested.sort_by_key(|scope| scope.priority);
        for mut scope in requested {
            if scope.priority > 2 { return Err("无效的目录大小视图优先级".into()); }
            scope.path = normalize_local_path(&scope.path)?;
            if seen.insert(scope.path.clone()) { scopes.push(scope); }
        }
        use sha2::{Digest, Sha256};
        let mut hash = Sha256::new();
        for scope in &scopes { hash.update([scope.priority]); hash.update(scope.path.as_bytes()); hash.update([0]); }
        let digest: [u8; 32] = hash.finalize().into();
        let truncated = scopes.len() > MAX_WINDOW_SCOPES;
        scopes.truncate(MAX_WINDOW_SCOPES);
        if let Some(previous) = self.windows.get(&owner.label).filter(|window| window.epoch == owner.epoch) {
            if handshake || request.revision <= previous.revision {
                if final_reply && request.revision == previous.revision {
                    if digest != previous.digest { return Err("同一视图版本包含不同目录".into()); }
                    self.collecting.as_mut().unwrap().replied.insert(owner.label.clone());
                }
                return Ok(DirectorySizeViewsAck { accepted_revision: previous.revision, owner_epoch: owner.epoch.to_string(), truncated: previous.truncated });
            }
        } else if self.windows.len() >= 64 { return Err("目录大小工作区窗口超过容量".into()); }
        self.clock += 1;
        self.windows.insert(owner.label.clone(), Window { epoch: owner.epoch, revision: request.revision, used: self.clock, scopes, truncated, digest });
        self.enforce_limits();
        if final_reply { self.collecting.as_mut().unwrap().replied.insert(owner.label.clone()); }
        let window = &self.windows[&owner.label];
        Ok(DirectorySizeViewsAck { accepted_revision: window.revision, owner_epoch: owner.epoch.to_string(), truncated: window.truncated })
    }
    fn enforce_limits(&mut self) {
        let mut candidates = vec![];
        for (owner, window) in &self.windows {
            for (index, scope) in window.scopes.iter().enumerate() { candidates.push((scope.priority, std::cmp::Reverse(window.used), owner.clone(), index, scope.path.clone())); }
        }
        candidates.sort();
        let mut unique = HashSet::new(); let mut kept: HashSet<(String, usize)> = HashSet::new();
        let mut bytes = self.windows.keys().map(|owner| 192 + owner.len()).sum::<usize>();
        for (_, _, owner, index, path) in candidates {
            let cost = 128 + path.len();
            if bytes + cost > MAX_BYTES || unique.len() >= MAX_SCOPES && !unique.contains(&path) { continue; }
            unique.insert(path); bytes += cost; kept.insert((owner, index));
        }
        for (owner, window) in &mut self.windows {
            let mut index = 0;
            window.scopes.retain(|_| { let keep = kept.contains(&(owner.clone(), index)); index += 1; window.truncated |= !keep; keep });
        }
    }
    #[cfg(test)]
    pub fn accounted_bytes(&self) -> usize {
        self.windows.iter().map(|(owner, window)| 192 + owner.len() + window.scopes.iter().map(|scope| 128 + scope.path.len()).sum::<usize>()).sum()
    }
    pub fn scopes(&self) -> Arc<Vec<DirectorySizeViewScope>> {
        if let Some(frozen) = &self.frozen { return frozen.clone(); }
        let mut scopes = HashMap::<String, u8>::new();
        for scope in self.windows.values().flat_map(|window| &window.scopes) {
            scopes.entry(scope.path.clone()).and_modify(|priority| *priority = (*priority).min(scope.priority)).or_insert(scope.priority);
        }
        let mut scopes: Vec<_> = scopes.into_iter().map(|(path, priority)| DirectorySizeViewScope { path, priority }).collect();
        scopes.sort_by(|a, b| a.priority.cmp(&b.priority).then_with(|| a.path.cmp(&b.path))); Arc::new(scopes)
    }
    pub fn close(&mut self, owner: &str) { self.windows.remove(owner); }
    pub fn collect(&mut self, nonce: String) -> Vec<(String, DirectorySizeViewsFlushRequested)> {
        if self.frozen.is_some() { return vec![]; }
        let collecting = self.collecting.get_or_insert_with(|| Collecting { nonce,
            expected: self.windows.iter().map(|(owner, window)| (owner.clone(), window.epoch)).collect(), replied: HashSet::new() });
        collecting.expected.iter().map(|(owner, epoch)| (owner.clone(), DirectorySizeViewsFlushRequested {
            nonce: collecting.nonce.clone(), owner_epoch: epoch.to_string(),
        })).collect()
    }
    pub fn collected(&self) -> bool { self.collecting.as_ref().is_some_and(|state| state.expected.keys().all(|owner| state.replied.contains(owner))) }
    pub fn freeze(&mut self) -> Arc<Vec<DirectorySizeViewScope>> {
        if self.frozen.is_none() { self.frozen = Some(self.scopes()); }
        self.frozen.as_ref().unwrap().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn owner(label: &str, epoch: u64) -> OwnerToken { OwnerToken { label: label.into(), epoch } }
    fn update(epoch: u64, revision: u32, paths: &[&str]) -> UpdateDirectorySizeViewsRequest {
        UpdateDirectorySizeViewsRequest { revision, owner_epoch: Some(epoch.to_string()), shutdown_nonce: None,
            scopes: paths.iter().map(|path| DirectorySizeViewScope { path: (*path).into(), priority: 1 }).collect() }
    }
    #[test]
    fn size_views_track_all_tabs_and_freeze_before_owner_cleanup() {
        let main = owner("main", 1); let child = owner("workspace-2", 2);
        let mut views = Views::default();
        views.update(&main, update(1, 1, &["C:\\root", "D:\\inactive"])).unwrap();
        views.update(&child, update(2, 1, &["C:\\root", "E:\\other"])).unwrap();
        assert_eq!(views.scopes().len(), 3, "same paths across windows are stored only once");
        let notices = views.collect("nonce".into()); assert_eq!(notices.len(), 2);
        let mut final_main = update(1, 2, &["C:\\new-tab", "D:\\inactive"]); final_main.shutdown_nonce = Some("nonce".into());
        views.update(&main, final_main).unwrap();
        assert!(!views.collected());
        let mut final_child = update(2, 2, &["E:\\other"]); final_child.shutdown_nonce = Some("nonce".into());
        views.update(&child, final_child).unwrap(); assert!(views.collected());
        let frozen = views.freeze(); assert_eq!(frozen.len(), 3);
        views.close("main"); views.close("workspace-2");
        assert_eq!(views.freeze(), frozen, "destroying windows must not overwrite the frozen exit manifest");
        assert!(views.update(&main, update(1, 3, &["C:\\late"])).is_err());
    }
    #[test]
    fn size_views_reject_old_epochs_revisions_and_wrong_exit_nonces() {
        let main = owner("main", 2); let mut views = Views::default();
        assert!(views.update(&main, update(1, 1, &["C:\\old-window"])).is_err());
        views.update(&main, update(2, 3, &["C:\\current"])).unwrap();
        assert_eq!(views.update(&main, update(2, 2, &["C:\\late"])).unwrap().accepted_revision, 3);
        views.collect("nonce".into());
        let mut wrong = update(2, 4, &["C:\\bad"]); wrong.shutdown_nonce = Some("old-nonce".into());
        assert!(views.update(&main, wrong).is_err()); assert!(!views.collected());
        assert!(views.freeze()[0].path.ends_with("current"));
    }
    #[test]
    fn size_views_prioritize_visible_scopes_and_bound_global_paths_and_bytes() {
        let mut views = Views::default();
        for index in 0..6 {
            let owner = owner(&format!("window-{index}"), index);
            let mut request = update(index, 1, &[]);
            request.scopes = (0..300).map(|item| DirectorySizeViewScope { path: format!("C:\\scope-{index}-{item}"), priority: 1 }).collect();
            request.scopes.last_mut().unwrap().priority = 0;
            assert!(views.update(&owner, request).unwrap().truncated);
        }
        let scopes = views.scopes(); assert!(scopes.len() <= 1024);
        for index in 0..6 { assert!(scopes.iter().any(|scope| scope.path.ends_with(&format!("scope-{index}-299")))); }
        assert!(views.accounted_bytes() <= 1 << 20);
    }
    #[test]
    fn size_views_final_same_revision_remains_valid_after_global_truncation() {
        let mut views = Views::default(); let mut first = None;
        for index in 0..5 {
            let request = UpdateDirectorySizeViewsRequest { revision: 1, owner_epoch: Some(index.to_string()), shutdown_nonce: None,
                scopes: (0..256).map(|item| DirectorySizeViewScope { path: format!("C:\\{index}-{item}"), priority: 1 }).collect() };
            if index == 0 { first = Some(request.clone()); }
            views.update(&owner(&format!("window-{index}"), index), request).unwrap();
        }
        views.collect("exit".into());
        let mut request = first.unwrap(); request.shutdown_nonce = Some("exit".into());
        assert!(views.update(&owner("window-0", 0), request).is_ok(), "capacity truncation must not look like a conflicting revision");
    }
}

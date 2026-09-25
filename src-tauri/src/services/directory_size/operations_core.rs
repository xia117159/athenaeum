use super::*;
use super::super::{rename_proof as proof, storage::{Operation, RenamePath}};

impl Core {
    pub fn invalidate_local_paths(&mut self, paths: &[String], now: u64) {
        let keys: Vec<_> = self.roots.iter().filter(|(_, root)| root.target.profile.is_none()
            && paths.iter().any(|path| proof::overlaps(path, &root.target.path))).map(|(key, _)| key.clone()).collect();
        for key in keys { self.invalidate(&key, now, true, true, 500, "文件操作已改变目录内容，等待刷新统计"); }
    }
    pub fn storage_operation(&mut self, paths: Vec<RenamePath>) -> Option<Operation> {
        if self.storage.is_none() || self.quiescing || paths.is_empty() { return None; }
        self.generation += 1;
        let scans = self.roots.values().filter(|root| root.target.profile.is_none()
            && paths.iter().any(|pair| proof::overlaps(&root.target.path, &pair.from) || proof::overlaps(&root.target.path, &pair.to)))
            .filter_map(|root| root.persisted_scan.clone()).collect();
        Some(Operation { id: uuid::Uuid::new_v4().to_string(), session: self.session.clone(), generation: self.generation, paths, scans, patches: vec![] })
    }
    pub fn accept_storage_operation(&mut self, mut operation: Operation) -> bool {
        let parents: std::collections::HashSet<_> = operation.paths.iter().flat_map(|pair| [&pair.from, &pair.to])
            .filter_map(|path| proof::parent(path)).collect();
        for root in self.roots.values().filter(|root| root.persisted_scan.as_ref().is_some_and(|scan| operation.scans.contains(scan))) {
            if let Some(result) = &root.result {
                for path in &parents {
                    if let Some(size) = result.directories.get(*path) { operation.patches.push(((*path).into(), size.fingerprint.clone())); }
                }
            }
        }
        let accepted = self.storage.as_ref().is_some_and(|store| store.authorize_operation(operation.clone()));
        for root in self.roots.values_mut() {
            if let Some(old) = root.persisted_scan.as_ref().filter(|scan| operation.scans.contains(scan)) {
                root.persisted_scan = accepted.then(|| operation.shadow(old));
            }
        }
        self.protect_stored_scans(); accepted
    }
}

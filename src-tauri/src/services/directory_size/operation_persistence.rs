use std::{path::{Path, PathBuf}, time::Duration};
use super::{DirectorySizeService, storage::{Store, Operation, RenamePath}, rename_proof as proof};

pub(super) struct Persistence { store: Store, operation: Option<Operation>, prepared: bool, temporary: Vec<String> }
impl Persistence {
    pub fn begin(service: &DirectorySizeService, paths: &[(PathBuf, PathBuf)]) -> Option<Self> {
        let pairs = paths.iter().map(|(from, to)| Some(RenamePath { from: proof::normalize(from)?, to: proof::normalize(to)? })).collect::<Option<Vec<_>>>()?;
        let operation = service.core.lock().unwrap().storage_operation(pairs)?;
        let store = service.storage.lock().unwrap().clone()?;
        let prepared = store.prepare_operation(operation.clone(), Duration::from_millis(50)).is_ok();
        Some(Self { store, operation: Some(operation), prepared, temporary: vec![] })
    }
    pub fn step(&mut self, from: &Path, to: &Path) {
        let Some(operation) = &self.operation else { return; };
        let Some((from, to)) = proof::normalize(from).zip(proof::normalize(to)) else { self.prepared = false; return; };
        if operation.paths.iter().any(|pair| pair.from == from && pair.to == to) { return; }
        let temporary = Operation { id: uuid::Uuid::new_v4().to_string(), session: operation.session.clone(), generation: operation.generation,
            paths: vec![RenamePath { from, to }], scans: vec![], patches: vec![] };
        self.prepared &= self.store.prepare_operation(temporary.clone(), Duration::from_millis(50)).is_ok();
        self.temporary.push(temporary.id);
    }
    pub fn finish(&mut self, service: &DirectorySizeService, accepted: bool) {
        for id in self.temporary.drain(..) { self.store.abort_operation(id); }
        if let Some(operation) = self.operation.take() {
            let storage_accepted = self.prepared && service.core.lock().unwrap().accept_storage_operation(operation.clone());
            if !accepted || !storage_accepted {
                self.store.abort_operation(operation.id);
            }
        }
    }
}
impl Drop for Persistence {
    fn drop(&mut self) {
        for id in self.temporary.drain(..) { self.store.abort_operation(id); }
        if let Some(operation) = self.operation.take() { self.store.abort_operation(operation.id); }
    }
}

pub(crate) struct NamespaceChange<'a> { service: &'a DirectorySizeService, paths: Vec<String>, persistence: Option<Persistence> }
impl DirectorySizeService {
    pub(crate) fn namespace_change(&self, paths: &[PathBuf]) -> NamespaceChange<'_> {
        let pairs = paths.iter().map(|path| (path.clone(), path.clone())).collect::<Vec<_>>();
        NamespaceChange { service: self, paths: paths.iter().filter_map(|path| proof::normalize(path)).collect(), persistence: Persistence::begin(self, &pairs) }
    }
}
impl Drop for NamespaceChange<'_> {
    fn drop(&mut self) {
        self.service.core.lock().unwrap().invalidate_local_paths(&self.paths, self.service.now());
        if let Some(persistence) = &mut self.persistence { persistence.finish(self.service, false); }
        self.service.wake();
    }
}

use super::{ScanHeader, Store, StoredDirectory};
use super::super::scan::DirectorySize;

pub(in crate::services::directory_size) struct ScanStream {
    store: Store, header: ScanHeader, pending: Vec<StoredDirectory>, bytes: usize,
    artifacts: Option<std::sync::Arc<super::super::artifacts::Registry>>,
}
impl ScanStream {
    pub fn new(store: Store, header: ScanHeader, artifacts: Option<std::sync::Arc<super::super::artifacts::Registry>>) -> Self {
        Self { store, header, pending: vec![], bytes: 0, artifacts }
    }
    pub fn completed(&mut self, path: &str, size: &DirectorySize) {
        if !size.visited() || size.created_at.is_none() { return; }
        let cost = 640 + path.len() + size.fingerprint.as_ref().map_or(0, String::len);
        if self.bytes + cost > 64 << 10 { self.flush(); }
        if cost > 128 << 10 { return; }
        self.bytes += cost; self.pending.push(StoredDirectory { path: path.into(), size: size.clone(),
            artifact_capture: self.artifacts.as_ref().and_then(|registry| registry.cached().capture(path)) });
        if self.pending.len() >= 128 { self.flush(); }
    }
    fn flush(&mut self) {
        if !self.pending.is_empty() { self.store.append(self.header.clone(), std::mem::take(&mut self.pending)); self.bytes = 0; }
    }
}
impl Drop for ScanStream { fn drop(&mut self) { self.flush(); } }

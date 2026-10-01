//! Admission and retirement of this process's Windows notification handles.
//! Reservations precede native opens; owners release them only after closing.
use std::{collections::HashMap, path::Path, sync::{Arc, Mutex, OnceLock, Weak, atomic::{AtomicBool, Ordering}}};
use super::batch_rename::native::same_name;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WatchClass { Size, Listing }
#[derive(Debug, Default)]
struct Life { retired: Arc<AtomicBool>, closed: AtomicBool, armed: AtomicBool }
#[derive(Clone, Debug)]
pub(crate) struct WatchControl(Arc<Life>);
impl WatchControl {
    pub fn retired(&self) -> bool { self.0.retired.load(Ordering::Acquire) }
    pub fn closed(&self) -> bool { self.0.closed.load(Ordering::Acquire) }
    pub fn retire_flag(&self) -> Arc<AtomicBool> { self.0.retired.clone() }
}
struct Entry { path: String, class: WatchClass, life: Weak<Life> }
#[derive(Default)]
struct Registry { next: u64, entries: HashMap<u64, Entry>, gates: HashMap<u64, Vec<String>> }
fn registry() -> &'static Mutex<Registry> { static VALUE: OnceLock<Mutex<Registry>> = OnceLock::new(); VALUE.get_or_init(Default::default) }
fn descendant(root: &str, path: &str) -> bool {
    let root = root.trim_end_matches('\\');
    path.get(..root.len()).is_some_and(|prefix| same_name(root, prefix)) && path.get(root.len()..).is_some_and(|rest| rest.starts_with('\\'))
}
fn rewrite(path: &str, from: &str, to: &str) -> Option<String> {
    if same_name(path, from) || descendant(from, path) { Some(format!("{to}{}", &path[from.len()..])) } else { None }
}
pub(crate) fn physical_path(path: &Path) -> Option<String> {
    let resolved = std::fs::canonicalize(path).ok().or_else(|| {
        std::fs::canonicalize(path.parent()?).ok().map(|parent| parent.join(path.file_name().unwrap_or_default()))
    })?;
    Some(resolved.to_str()?.trim_end_matches('\\').into())
}
impl Registry {
    fn next(&mut self) -> u64 { self.next += 1; self.next }
    fn clean(&mut self) { self.entries.retain(|_, entry| entry.life.upgrade().is_some_and(|life| !life.closed.load(Ordering::Acquire))); }
    fn reserve(&mut self, path: String, class: WatchClass, permit: Option<u64>) -> Option<(u64, WatchControl)> {
        self.clean();
        if self.gates.iter().any(|(id, paths)| Some(*id) != permit && paths.iter().any(|root| same_name(root, &path) || descendant(root, &path))) { return None; }
        let limit = if class == WatchClass::Size { 32 } else { 768 };
        if self.entries.values().filter(|entry| entry.class == class).count() >= limit { return None; }
        let id = self.next(); let life = Arc::new(Life::default());
        self.entries.insert(id, Entry { path, class, life: Arc::downgrade(&life) });
        Some((id, WatchControl(life)))
    }
    fn gate(&mut self, paths: Vec<String>) -> Option<u64> {
        if self.gates.len() >= 32 || paths.len() > 20_000 { return None; }
        let id = self.next(); self.gates.insert(id, paths); Some(id)
    }
    fn retire(&mut self, paths: &[String]) -> Vec<WatchControl> {
        self.clean();
        self.entries.values().filter_map(|entry| {
            let life = entry.life.upgrade()?;
            paths.iter().any(|path| descendant(path, &entry.path) || same_name(path, &entry.path) && !life.armed.load(Ordering::Acquire)).then_some(life)
        }).map(|life| {
                life.retired.store(true, Ordering::Release); WatchControl(life)
            }).collect()
    }
    fn renamed(&mut self, from: &str, to: &str) {
        for entry in self.entries.values_mut() {
            if let Some(path) = rewrite(&entry.path, from, to) {
                entry.path = path;
                // Listing subscriptions identify paths, not the moved object.
                if entry.class == WatchClass::Listing { if let Some(life) = entry.life.upgrade() { life.retired.store(true, Ordering::Release); } }
            }
        }
        for paths in self.gates.values_mut() {
            let rewritten: Vec<_> = paths.iter().filter_map(|path| rewrite(path, from, to)).collect();
            for path in rewritten { if !paths.contains(&path) { paths.push(path); } }
        }
    }
}

#[derive(Debug)]
pub(crate) struct WatchRegistration { id: u64, control: WatchControl }
impl WatchRegistration {
    pub fn reserve(path: &str, class: WatchClass, permit: Option<u64>) -> Option<Self> {
        let path = physical_path(Path::new(path))?; // No handle yet; no registry lock during filesystem I/O.
        let (id, control) = registry().lock().unwrap().reserve(path, class, permit)?;
        Some(Self { id, control })
    }
    pub fn control(&self) -> WatchControl { self.control.clone() }
    pub fn retired(&self) -> bool { self.control.retired() }
    pub fn mark_armed(&self) { self.control.0.armed.store(true, Ordering::Release); }
}
impl Drop for WatchRegistration {
    fn drop(&mut self) {
        self.control.0.closed.store(true, Ordering::Release);
        registry().lock().unwrap().entries.remove(&self.id);
    }
}

pub(crate) struct RenameBarrier { id: u64 }
impl RenameBarrier {
    pub fn new(paths: &[(std::path::PathBuf, std::path::PathBuf)]) -> Option<Self> {
        if paths.len() > 10_000 { return None; }
        let paths = paths.iter().filter(|(from, to)| from != to).flat_map(|(from, to)| [from, to])
            .map(|path| physical_path(path)).collect::<Option<Vec<_>>>()?;
        Some(Self { id: registry().lock().unwrap().gate(paths)? })
    }
    pub fn permit(&self) -> u64 { self.id }
    pub fn retire_descendants(&self) -> Vec<WatchControl> {
        let mut registry = registry().lock().unwrap();
        let paths = registry.gates.get(&self.id).cloned().unwrap_or_default(); registry.retire(&paths)
    }
    pub fn prepare_step(&self, destination: &str) -> Option<Vec<WatchControl>> {
        let mut registry = registry().lock().unwrap(); let paths = registry.gates.get_mut(&self.id)?;
        if !paths.iter().any(|path| same_name(path, destination)) {
            if paths.len() >= 40_000 { return None; }
            paths.push(destination.into());
        }
        Some(registry.retire(&[destination.into()]))
    }
    pub fn renamed(&self, from: &str, to: &str) { registry().lock().unwrap().renamed(from, to); }
}
impl Drop for RenameBarrier { fn drop(&mut self) { registry().lock().unwrap().gates.remove(&self.id); } }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn watch_admission_fences_opening_and_retiring_until_actual_close() {
        let mut registry = Registry::default();
        let (_, opening) = registry.reserve("C:\\old\\deep".into(), WatchClass::Size, None).unwrap();
        let gate = registry.gate(vec!["C:\\old".into(), "C:\\new".into()]).unwrap();
        assert!(registry.reserve("c:\\OLD\\another".into(), WatchClass::Size, None).is_none());
        let retiring = registry.retire(&["C:\\old".into()]);
        assert!(opening.retired()); assert!(!retiring[0].closed());
        assert_eq!(registry.entries.len(), 1, "retirement is not a close acknowledgement");
        opening.0.closed.store(true, Ordering::Release); registry.clean(); assert!(registry.entries.is_empty());
        registry.gates.remove(&gate);
        assert!(registry.reserve("C:\\old\\another".into(), WatchClass::Size, None).is_some());
    }
    #[test]
    fn watch_admission_permit_is_scoped_and_renamed_handles_remain_findable() {
        let mut registry = Registry::default();
        let (_, bridge) = registry.reserve("C:\\old".into(), WatchClass::Size, None).unwrap();
        let gate = registry.gate(vec!["C:\\old".into(), "C:\\temp".into(), "C:\\new".into()]).unwrap();
        registry.renamed("C:\\old", "C:\\temp"); registry.renamed("C:\\temp", "C:\\new");
        let child = registry.reserve("C:\\new\\deep".into(), WatchClass::Size, Some(gate)).unwrap();
        assert!(registry.reserve("C:\\temp\\late".into(), WatchClass::Listing, None).is_none());
        let other = registry.gate(vec!["C:\\new".into()]).unwrap();
        assert!(registry.reserve("C:\\new\\late".into(), WatchClass::Size, Some(gate)).is_none());
        assert_eq!(registry.retire(&["C:".into()]).len(), 2);
        assert!(bridge.retired() && child.1.retired()); registry.gates.remove(&other);
    }
    #[test]
    fn watch_admission_quotas_include_retiring_and_keep_listing_separate() {
        let mut registry = Registry::default();
        let owners: Vec<_> = (0..32).map(|index| registry.reserve(format!("C:\\old\\{index}"), WatchClass::Size, None).unwrap()).collect();
        registry.retire(&["C:\\old".into()]);
        assert!(registry.reserve("C:\\new".into(), WatchClass::Size, None).is_none());
        assert!(registry.reserve("C:\\new".into(), WatchClass::Listing, None).is_some());
        owners[0].1.0.closed.store(true, Ordering::Release);
        assert!(registry.reserve("C:\\new".into(), WatchClass::Size, None).is_some());
    }
}

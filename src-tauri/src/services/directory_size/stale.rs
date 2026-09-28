use std::{collections::{HashMap, HashSet}, sync::Arc};
use super::{forget::ForgetItem, rename_proof::{contains, rewrite}, scan::ScanResult, target::normalize_local_path, watch::{ChangeKind, WatchChanges, WatchEvent}};

/// Path::parent includes the UNC share root's trailing separator; size keys do not.
pub(super) fn parent(path: &str) -> Option<&str> {
    let path = super::rename_proof::parent(path)?;
    Some(if path.starts_with("\\\\") && !path.ends_with(":\\") { path.trim_end_matches('\\') } else { path })
}

#[derive(Clone, Default, PartialEq, Eq)]
pub(super) struct StaleSet { pub all: bool, pub exact: HashSet<Arc<str>>, pub subtrees: Vec<Arc<str>> }
impl StaleSet {
    pub fn contains(&self, path: &str) -> bool { self.all || self.exact.contains(path) || self.subtrees.iter().any(|root| contains(root, path)) }
    fn covered(&self, path: &str) -> bool { self.all || self.subtrees.iter().any(|root| contains(root, path)) }
    fn exact(&mut self, path: &str) { if !self.covered(path) { self.exact.insert(Arc::from(path)); } }
    fn subtree(&mut self, path: &str) {
        if self.covered(path) { return; }
        self.exact.retain(|old| !contains(path, old)); self.subtrees.retain(|old| !contains(path, old));
        self.subtrees.push(Arc::from(path));
    }
    fn ancestors(&mut self, path: &str, root: &str) {
        let mut at = parent(path);
        while let Some(path) = at.filter(|path| contains(root, path)) { self.exact(path); at = parent(path); }
    }
    fn bounded(&mut self, root: &str) {
        if self.exact.len() <= 4096 && self.subtrees.len() <= 256 { return; }
        // Ancestors were marked to invalidate totals, not because their whole subtree changed.
        // Find the terminal sources by walking parent chains instead of comparing every pair.
        let mut ancestors = HashSet::new();
        for path in self.exact.iter().chain(&self.subtrees) {
            let mut at = parent(path);
            while let Some(path) = at.filter(|path| contains(root, path)) {
                if !ancestors.insert(path) { break; }
                ancestors.insert(path.trim_end_matches('\\'));
                at = parent(path);
            }
        }
        let sources: Vec<_> = self.exact.iter().chain(&self.subtrees)
            .filter(|path| !ancestors.contains(path.as_ref())).map(|path| path.as_ref()).collect();
        let common = common_parent(&sources, root).to_owned();
        self.exact.clear(); self.subtrees.clear();
        if common == root { self.all = true; } else { self.subtree(&common); self.ancestors(&common, root); }
    }
    fn mark(&mut self, path: &str, kind: PendingKind, root: &str, result: &ScanResult) {
        match kind {
            PendingKind::Subtree => self.subtree(path),
            PendingKind::Structural if result.directories.contains_key(path) => self.subtree(path),
            PendingKind::Modified if result.directories.contains_key(path) => self.exact(path),
            _ => (),
        }
        self.ancestors(path, root);
    }
    pub fn apply(&mut self, pending: &PendingStale, root: &str, result: &ScanResult) {
        for (path, kind) in &pending.entries { self.mark(path, *kind, root, result); }
        self.bounded(root);
        if pending.all { self.all = true; self.exact.clear(); self.subtrees.clear(); }
    }
    /// Idle roots convert events directly: a file only marks its parent chain, so a
    /// burst inside one directory never widens into that directory's subtree.
    pub fn apply_events(&mut self, changes: &WatchChanges, root: &str, result: &ScanResult) {
        for event in &changes.events {
            if let Some((path, kind)) = classify(root, event) { self.mark(&path, kind, root, result); self.bounded(root); }
        }
    }
    pub fn additions(&self, previous: &Self, root: &str) -> Vec<ForgetItem> {
        if previous.all { return vec![]; }
        if self.all { return vec![ForgetItem::Prefix(root.into())]; }
        self.exact.iter().filter(|path| !previous.contains(path)).map(|path| ForgetItem::Exact(path.to_string()))
            .chain(self.subtrees.iter().filter(|path| !previous.covered(path)).map(|path| ForgetItem::Prefix(path.to_string()))).collect()
    }
    pub fn rewrite(&mut self, from: &str, to: &str) -> bool {
        let old = self.clone();
        self.exact = self.exact.iter().map(|path| Arc::from(rewrite(path, from, to))).collect();
        self.subtrees = self.subtrees.iter().map(|path| Arc::from(rewrite(path, from, to))).collect();
        *self != old
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum PendingKind { Modified, Structural, Subtree }
#[derive(Default)]
pub(super) struct PendingStale {
    pub all: bool, pub entries: HashMap<Arc<str>, PendingKind>,
    parent_counts: HashMap<Arc<str>, usize>,
}
impl PendingStale {
    pub fn add_changes(&mut self, root: &str, changes: &WatchChanges) {
        for event in &changes.events {
            if let Some((path, kind)) = classify(root, event) { self.insert(&path, kind, root); }
        }
        if changes.lost { self.all = true; }
    }
    fn insert(&mut self, path: &str, kind: PendingKind, root: &str) {
        let mut at = Some(path);
        while let Some(path) = at {
            if self.entries.get(path) == Some(&PendingKind::Subtree) ||
                self.entries.get(path.trim_end_matches('\\')) == Some(&PendingKind::Subtree) { return; }
            at = parent(path);
        }
        if kind == PendingKind::Subtree { self.remove_subtree(path); }
        self.insert_entry(path, kind);
        if let Some(parent) = parent(path).filter(|parent| contains(root, parent)) {
            if self.parent_counts.get(parent).copied().unwrap_or(0) > 64 {
                self.remove_subtree(parent);
                self.insert_entry(parent, PendingKind::Subtree);
            }
        }
        if self.entries.len() > 4096 {
            let paths: Vec<_> = self.entries.keys().map(|path| path.as_ref()).collect();
            let common = common_parent(&paths, root).to_owned();
            self.entries.clear(); self.parent_counts.clear(); self.insert_entry(&common, PendingKind::Subtree);
        }
    }
    fn insert_entry(&mut self, path: &str, kind: PendingKind) {
        if let Some(old) = self.entries.get_mut(path) { *old = (*old).max(kind); return; }
        self.entries.insert(Arc::from(path), kind);
        if let Some(parent) = parent(path) { *self.parent_counts.entry(Arc::from(parent)).or_default() += 1; }
    }
    fn remove_subtree(&mut self, root: &str) {
        self.entries.retain(|path, _| {
            if !contains(root, path) { return true; }
            if let Some(parent) = parent(path) {
                if let Some(count) = self.parent_counts.get_mut(parent) {
                    *count -= 1;
                    if *count == 0 { self.parent_counts.remove(parent); }
                }
            }
            false
        });
    }
    pub fn rewrite(&mut self, from: &str, to: &str) -> bool {
        let old = std::mem::take(&mut self.entries); let mut changed = false;
        self.parent_counts.clear();
        for (path, kind) in old {
            let next = rewrite(&path, from, to); changed |= next != path.as_ref();
            self.insert_entry(&next, kind);
        }
        changed
    }
}
/// Event path (relative to `root`, or absolute for in-app operations) → normalized
/// in-root path and kind; an 8.3 short-name component degrades to its parent's subtree.
fn classify(root: &str, event: &WatchEvent) -> Option<(String, PendingKind)> {
    let path = if event.path.is_empty() { root.into() } else if normalize_local_path(&event.path).is_ok() {
        event.path.clone()
    } else { format!("{}\\{}", root.trim_end_matches('\\'), event.path) };
    let path = normalize_local_path(&path).ok().filter(|path| contains(root, path))?;
    // The watched root is already canonical. Only event components below it may
    // be short aliases; a literal ~1 in the root must not widen the forget prefix.
    let short = path[root.len()..].char_indices().find_map(|(offset, ch)| {
        let i = root.len() + offset;
        if ch != '~' || !path.as_bytes().get(i + 1).is_some_and(u8::is_ascii_digit) { return None; }
        let end = path[i..].find('\\').map_or(path.len(), |at| i + at);
        Some(parent(&path[..end]).filter(|parent| contains(root, parent)).unwrap_or(root).to_owned())
    });
    Some(match short {
        Some(parent) => (parent, PendingKind::Subtree),
        None => (path, if event.kind == ChangeKind::Modified { PendingKind::Modified } else { PendingKind::Structural }),
    })
}
fn common_parent<'a>(paths: &[&'a str], root: &'a str) -> &'a str {
    let mut common = paths.first().copied().unwrap_or(root);
    for path in paths {
        while !contains(common, path) { common = parent(common).filter(|path| contains(root, path)).unwrap_or(root); }
    }
    common
}

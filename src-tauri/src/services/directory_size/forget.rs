//! Bounded invalidation fences shared by live history and persistent cache readers.
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum ForgetItem { Exact(String), Prefix(String) }
impl ForgetItem {
    pub fn path(&self) -> &str { match self { Self::Exact(path) | Self::Prefix(path) => path } }
    pub fn recursive(&self) -> bool { matches!(self, Self::Prefix(_)) }
}

pub(super) fn rewritten(item: &ForgetItem, from: &str, to: &str) -> Option<ForgetItem> {
    use super::rename_proof::{contains, rewrite};
    if contains(from, item.path()) {
        let path = rewrite(item.path(), from, to);
        Some(if item.recursive() { ForgetItem::Prefix(path) } else { ForgetItem::Exact(path) })
    } else if item.recursive() && contains(item.path(), from) { Some(ForgetItem::Prefix(to.into())) }
    else { None }
}

/// Exact and prefix cutoffs live in separate maps so a lookup borrows the probed path instead of allocating a key (SAF-02).
#[derive(Clone, Default)]
pub(super) struct ForgetFence {
    exact: HashMap<String, i64>,
    prefix: HashMap<String, i64>,
    pub floor: Option<i64>,
    bytes: usize,
}
impl ForgetFence {
    fn map(&self, recursive: bool) -> &HashMap<String, i64> { if recursive { &self.prefix } else { &self.exact } }
    pub fn len(&self) -> usize { self.exact.len() + self.prefix.len() }
    pub fn get(&self, path: &str, recursive: bool) -> Option<i64> { self.map(recursive).get(path).copied() }
    pub fn entries(&self) -> impl Iterator<Item = (&str, bool, i64)> {
        self.exact.iter().map(|(path, cutoff)| (path.as_str(), false, *cutoff))
            .chain(self.prefix.iter().map(|(path, cutoff)| (path.as_str(), true, *cutoff)))
    }
    pub fn insert(&mut self, items: &[ForgetItem], cutoff: i64) {
        if self.floor.is_some_and(|floor| cutoff <= floor) { return; }
        for item in items {
            let map = if item.recursive() { &mut self.prefix } else { &mut self.exact };
            if let Some(old) = map.get_mut(item.path()) { *old = (*old).max(cutoff); }
            else { self.bytes += item.path().len(); map.insert(item.path().to_owned(), cutoff); }
        }
        if self.len() > 4096 || self.bytes > 1 << 20 {
            self.floor = self.exact.values().chain(self.prefix.values()).copied().chain(self.floor).max();
            self.exact.clear(); self.prefix.clear(); self.bytes = 0;
        }
    }
    pub fn cutoff(&self, path: &str) -> Option<i64> {
        if self.exact.is_empty() && self.prefix.is_empty() { return self.floor; }
        let mut at = self.floor;
        let mut include = |key: &str, recursive| {
            if let Some(value) = self.get(key, recursive) { at = Some(at.map_or(value, |old| old.max(value))); }
        };
        include(path, false); include(path, true);
        for (index, _) in path.char_indices().filter(|(_, ch)| matches!(ch, '\\' | '/')) {
            include(&path[..index], true);
            include(&path[..index + 1], true);
        }
        at
    }
    pub fn blocks(&self, path: &str, captured: i64) -> bool { self.cutoff(path).is_some_and(|at| captured <= at) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn size_forget_fence_preserves_path_boundaries_and_new_scans() {
        let mut fence = ForgetFence::default();
        fence.insert(&[&"C:\\root\\a", &"C:\\other"].map(|p| ForgetItem::Prefix(p.to_string())), 10);
        assert!(fence.blocks("C:\\root\\a", 10));
        assert!(fence.blocks("C:\\root\\a\\deep", 5));
        assert!(!fence.blocks("C:\\root\\a2", 5));
        assert!(!fence.blocks("C:\\root\\a\\deep", 11));
        fence.insert(&[ForgetItem::Exact("C:\\exact".into())], 20);
        assert!(fence.blocks("C:\\exact", 19));
        assert!(!fence.blocks("C:\\exact\\child", 19));
    }
    #[test]
    fn size_forget_fence_full_capacity_covers_the_newest_omitted_item() {
        let mut fence = ForgetFence::default();
        for index in 0..4097 { fence.insert(&[ForgetItem::Exact(format!("C:\\{index}"))], index + 1); }
        assert!(fence.len() <= 4096);
        assert!(fence.blocks("C:\\4096", 2000), "floor must cover the newest omitted cutoff, not the oldest");
        assert!(!fence.blocks("C:\\4096", 5000));
    }
}

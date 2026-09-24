use super::*;
use crate::domain::models::{DirectoryListing, EntryKind, LocationKind};

impl Core {
    pub fn listing_display_cache(&mut self, listing: &DirectoryListing, now: u64) -> Option<DirectorySizeCache> {
        let live = self.listing_cache(listing, now);
        let Some(mut history) = self.historical_listing(listing) else { return live; };
        let Some(live) = live else { return Some(history); };
        let live_paths: std::collections::HashSet<_> = live.directories.iter().map(|record| record.path.as_str()).collect();
        if history.directories.iter().all(|record| live_paths.contains(record.path.as_str())) { return Some(live); }
        // A bounded scan can retain the root while dropping child details. Merge
        // those holes as advisory display; live lookup still owns all freshness.
        let mut records: HashMap<_, _> = history.directories.into_iter().map(|record| (record.path.clone(), record)).collect();
        for record in live.directories {
            if record.cached_at.is_none() || record.created_at.is_none() { continue; }
            if records.get(&record.path).is_some_and(|old| old.cached_at > record.cached_at) { continue; }
            records.insert(record.path.clone(), record);
        }
        history.directories = records.into_values().collect();
        Some(history)
    }

    /// Memory-only projection, called after the ordinary listing has been read.
    /// No lease acquisition, identity I/O, or recursive metadata reads here.
    pub fn listing_cache(&mut self, listing: &DirectoryListing, now: u64) -> Option<DirectorySizeCache> {
        if self.stopped || listing.location.kind != LocationKind::Local { return None; }
        self.tick(now);
        let scope = normalize_target(&DirectorySizeTarget::Local { path: listing.location.path.clone() }, None, 0).ok()?;
        let key = self.reusable_root(&scope)?;
        let root = &self.roots[&key];
        let result = root.result.as_ref()?;
        let fingerprint = listing.size_fingerprint.as_ref()?;
        if result.directories.get(scope.path.as_str())?.fingerprint.as_ref() != Some(fingerprint) { return None; }
        let paths = std::iter::once(listing.location.path.as_str()).chain(listing.entries.iter()
            .filter(|entry| entry.kind == EntryKind::Directory && !entry.is_symlink).map(|entry| entry.path.as_str()));
        let directories = paths.filter_map(|path| {
            let normalized = lookup_path(&scope, path).ok()?;
            if normalized != scope.path && std::path::Path::new(&normalized).parent() != Some(std::path::Path::new(&scope.path)) { return None; }
            let size = result.directories.get(normalized.as_str()).filter(|size| size.visited())?;
            Some(DirectorySizeRecord { path: path.into(), state: if size.complete { DirectorySizeRecordState::Complete } else { DirectorySizeRecordState::Partial },
                bytes: Some(size.bytes.to_string()), size_fingerprint: size.fingerprint.clone(), cached_at: root.captured_at, created_at: size.created_at })
        }).collect();
        Some(DirectorySizeCache { generation: root.generation, sequence: root.sequence, directories, historical: false })
    }

    pub fn historical_listing(&self, listing: &DirectoryListing) -> Option<DirectorySizeCache> {
        if self.stopped || listing.location.kind != LocationKind::Local { return None; }
        let directories: Vec<_> = listing.entries.iter().filter(|entry| entry.kind == EntryKind::Directory && !entry.is_symlink)
            .filter_map(|entry| {
                let key = super::super::target::normalize_local_path(&entry.path).ok()?;
                let saved = self.history.get(&key)?;
                if entry.created_at != Some(saved.created_at) { return None; }
                Some(DirectorySizeRecord { path: entry.path.clone(), bytes: Some(saved.bytes.to_string()),
                    state: if saved.complete { DirectorySizeRecordState::Complete } else { DirectorySizeRecordState::Partial },
                    size_fingerprint: None, cached_at: Some(saved.cached_at), created_at: Some(saved.created_at) })
            }).collect();
        (!directories.is_empty()).then_some(DirectorySizeCache { generation: 0, sequence: 0, directories, historical: true })
    }
}

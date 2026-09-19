use super::*;
use crate::domain::models::{DirectoryListing, EntryKind, LocationKind};

impl Core {
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
                bytes: Some(size.bytes.to_string()), size_fingerprint: size.fingerprint.clone() })
        }).collect();
        Some(DirectorySizeCache { generation: root.generation, sequence: root.sequence, directories })
    }
}

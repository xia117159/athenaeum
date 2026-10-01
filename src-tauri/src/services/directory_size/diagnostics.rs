use super::*;
use crate::domain::models::{DirectoryListing, LocationKind};

impl Core {
    // Shared by listing projection and diagnostics: there is only one live-cache decision.
    pub(super) fn listing_live_root(&self, listing: &DirectoryListing) -> Result<(String, ScanTarget), DirectorySizeCacheReason> {
        use DirectorySizeCacheReason::*;
        if self.stopped || listing.location.kind != LocationKind::Local { return Err(Unsupported); }
        let scope = normalize_target(&DirectorySizeTarget::Local { path: listing.location.path.clone() }, None, 0)
            .map_err(|_| Unsupported)?;
        let key = self.reusable_root(&scope).or_else(|| self.roots.iter()
            .filter(|(_, root)| root.target.profile.is_none() && lookup_path(&root.target, &scope.path).is_ok())
            .max_by_key(|(_, root)| root.target.path.len()).map(|(key, _)| key.clone())).ok_or(NoAcceptedResult)?;
        let root = &self.roots[&key];
        if root.watch.is_none() { return Err(WatchLost); }
        if root.identity.is_none() || root.identity_expired { return Err(IdentityPending); }
        let result = root.result.as_ref().filter(|_| matches!(root.phase, DirectorySizePhase::Complete | DirectorySizePhase::Partial))
            .ok_or(NoAcceptedResult)?;
        let record = result.directories.get(scope.path.as_str()).filter(|size| size.visited()).ok_or(ScopeEvicted)?;
        if listing.size_fingerprint.is_none() || record.fingerprint != listing.size_fingerprint { return Err(FingerprintMismatch); }
        Ok((key, scope))
    }

    pub fn diagnose_listing(&mut self, listing: &DirectoryListing, now: u64) -> DirectorySizeDiagnostics {
        let cache = self.listing_display_cache(listing, now);
        // Projection polls once; diagnostics observes that same state without another poll.
        let decision = self.listing_live_root(listing);
        let path = super::super::target::normalize_local_path(&listing.location.path).unwrap_or_else(|_| listing.location.path.clone());
        let candidates = self.roots.values().filter(|root| root.target.profile.is_none() && lookup_path(&root.target, &path).is_ok())
            .map(|root| DirectorySizeCandidate { path: root.target.path.clone(), phase: root.phase,
                generation: root.generation.to_string(), sequence: root.sequence.to_string(), monitored: root.watch.is_some(),
                identity_known: root.identity.is_some(), identity_expired: root.identity_expired,
                result_present: root.result.is_some(), scope_present: root.result.as_ref()
                    .is_some_and(|result| result.directories.get(path.as_str()).is_some_and(|size| size.visited())), reason: root.reason.clone() }).collect();
        DirectorySizeDiagnostics { path: path.clone(), reason: match &cache {
            Some(cache) if cache.historical => DirectorySizeCacheReason::HistoryHit,
            Some(_) => DirectorySizeCacheReason::LiveHit,
            None => decision.as_ref().err().copied().unwrap_or(DirectorySizeCacheReason::NoAcceptedResult),
        }, disk_read: DirectorySizeDiskRead::Unavailable,
            live_rejection: decision.err(), listing_fingerprint: listing.size_fingerprint.clone(),
            display_records: cache.map_or(0, |cache| cache.directories.len()), history_enabled: self.history_enabled,
            cache_bytes: self.cache_bytes().to_string(), scan_jobs_started: self.jobs_started.to_string(), candidates,
            storage: self.storage.as_ref().map_or_else(Default::default, |store| store.diagnostics()),
            transitions: self.transitions.iter().filter(|event| std::path::Path::new(&path).starts_with(&event.path))
                .cloned().collect() }
    }

    pub(super) fn record_transition(&mut self, key: &str) {
        let Some(root) = self.roots.get(key).filter(|root| root.target.profile.is_none()) else { return; };
        let event = DirectorySizeTransition { path: root.target.path.clone(), generation: root.generation.to_string(),
            phase: root.phase, reason: root.reason.clone() };
        if self.transitions.iter().rev().find(|old| old.path == event.path) == Some(&event) { return; }
        if self.transitions.len() == 128 { self.transitions.pop_front(); }
        self.transitions.push_back(event);
    }
}

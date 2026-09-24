use super::*;
use super::super::{rename_proof::{self as proof, ObjectProof}, metadata::{ListingFingerprint, MetadataKind}};

impl Core {
    pub fn finish_rename(&mut self, token: u64, success: bool, proofs: &HashMap<String, ObjectProof>, revision: Option<u64>, now: u64) -> bool {
        let ready = success && self.rename_ready(token, now) == Some(true);
        let committed = ready && self.rename_proof_revision(token) == revision && self.install_renamed(token, proofs, now).is_some();
        self.maintenance.remove(&token);
        let keys: Vec<_> = self.roots.iter().filter(|(_, root)| root.guard == Some(token)).map(|(key, _)| key.clone()).collect();
        for key in keys {
            self.roots.get_mut(&key).unwrap().guard = None;
            if !committed { self.invalidate(&key, now, true, true, 500, "更名缓存未通过验证，需要重新统计"); }
            else { self.emit(&key); }
        }
        committed
    }

    fn install_renamed(&mut self, token: u64, proofs: &HashMap<String, ObjectProof>, now: u64) -> Option<()> {
        let guard = self.maintenance.get(&token)?;
        let mut candidates = Vec::new();
        let mut keys = std::collections::HashSet::new();
        let mut total = self.roots.iter().filter(|(key, _)| !guard.roots.contains_key(*key))
            .filter_map(|(_, root)| root.result.as_ref()).map(|result| result.accounted_bytes).sum::<usize>();
        for (key, watched) in &guard.roots {
            let root = self.roots.get(key)?;
            let result = root.result.as_ref()?;
            let verified = proofs.get(key)?;
            if !verified.directory || Some(verified.identity) != root.identity || root.generation != watched.generation { return None; }
            let target = normalize_target(&DirectorySizeTarget::Local { path: watched.path.clone() }, None, 0).ok()?;
            if !keys.insert(target.key.clone()) || self.roots.contains_key(&target.key) && !guard.roots.contains_key(&target.key) { return None; }
            let mut directories = HashMap::new();
            let mut accounted_bytes = result.accounted_bytes;
            for (path, size) in &result.directories {
                let mut next = path.to_string();
                let mut size = size.clone();
                for item in &guard.items {
                    if item.proof.directory { next = proof::rewrite(&next, &item.from, &item.to); }
                    if proof::parent(&item.from) == Some(path.as_ref()) {
                        let kind = if item.proof.directory { MetadataKind::Directory } else { MetadataKind::File(item.proof.bytes) };
                        size.fingerprint = size.fingerprint.as_ref().and_then(|value| ListingFingerprint::renamed(value,
                            std::path::Path::new(&item.from).file_name()?.to_str()?, std::path::Path::new(&item.to).file_name()?.to_str()?, kind));
                    }
                }
                if next.len() > 32768 { return None; }
                accounted_bytes = accounted_bytes.checked_sub(path.len())?.checked_add(next.len())?;
                if directories.insert(Arc::<str>::from(next), size).is_some() { return None; }
            }
            total = total.checked_add(accounted_bytes)?;
            if total > self.limits.cache_bytes { return None; }
            candidates.push((key.clone(), target, ScanResult { directories, accounted_bytes, stats: result.stats.clone(),
                outcome: result.outcome, message: result.message.clone() }));
        }
        // All names, root collisions, proofs and final accounting have passed.
        // Install the complete candidate set within the same Core critical section.
        self.history.trim(self.limits.cache_bytes.saturating_sub(total));
        let mut installed = Vec::new();
        for (key, target, result) in candidates {
            let mut root = self.roots.remove(&key)?;
            for lease in self.leases.values_mut().filter(|lease| lease.key == key) {
                lease.key = target.key.clone();
                lease.detached |= guard.items.iter().any(|item| item.proof.directory && proof::contains(&item.from, &lease.scope.path));
                lease.verified = !lease.detached && result.directories.get(lease.scope.path.as_str()).is_some_and(|size| size.visited());
            }
            root.phase = phase_for_outcome(result.outcome); root.reason = result.message.clone(); root.result = Some(result);
            root.target = target; root.last_identity_ok = Some(now); root.identity_expired = false; root.last_used = now; root.needs_scan = false;
            installed.push(root);
        }
        for root in installed { self.roots.insert(root.target.key.clone(), root); }
        Some(())
    }
}

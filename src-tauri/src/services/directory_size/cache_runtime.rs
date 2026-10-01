use std::{path::Path, time::Duration};
use super::{runtime::DirectorySizeService, core::OwnerToken, target::normalize_local_path};
use crate::domain::directory_sizes::*;

impl DirectorySizeService {
    pub fn lookup_cache(&self, owner: OwnerToken, request: LookupDirectorySizeCacheRequest) -> Result<DirectorySizeCacheLookup, String> {
        if request.entries.len() > 256 || request.entries.iter().map(|entry| entry.path.len()).sum::<usize>() > 1 << 20 {
            return Err("目录大小缓存查询超过批次上限".into());
        }
        let scope = normalize_local_path(&request.path)?;
        {
            let core = self.core.lock().unwrap();
            if core.owner_token(&owner.label)?.epoch != owner.epoch { return Err("统计窗口生命周期已结束".into()); }
        }
        let mut identities = Vec::with_capacity(request.entries.len());
        for entry in &request.entries {
            let path = normalize_local_path(&entry.path)?;
            if Path::new(&path).parent() != Some(Path::new(&scope)) { return Err("缓存查询超出当前列表范围".into()); }
            let matches = std::fs::symlink_metadata(&path).ok().is_some_and(|metadata| {
                super::local::local_metadata_kind(&metadata) == super::metadata::MetadataKind::Directory
                    && metadata.created().ok().map(chrono::DateTime::<chrono::Utc>::from) == Some(entry.created_at)
            });
            identities.push((path, matches));
        }
        let missing = {
            let core = self.core.lock().unwrap();
            identities.iter().zip(&request.entries).filter(|((path, valid), entry)| *valid
                && core.history.get(path).is_none_or(|size| size.created_at != entry.created_at))
                .map(|((path, _), _)| path.clone()).collect::<Vec<_>>()
        };
        let mut pending = false;
        if !missing.is_empty() {
            if let Some(store) = self.storage.lock().unwrap().clone() {
                pending = match store.lookup(missing, None) {
                    Ok(receiver) => !matches!(receiver.recv_timeout(Duration::from_millis(50)), Ok(Ok(_))),
                    Err(_) => true,
                };
            }
        }
        let core = self.core.lock().unwrap();
        if core.owner_token(&owner.label)?.epoch != owner.epoch { return Err("统计窗口生命周期已结束".into()); }
        let entries = request.entries.into_iter().zip(identities).map(|(entry, (path, valid))| {
            let saved = valid.then(|| core.history.get(&path)).flatten().filter(|size| size.created_at == entry.created_at);
            let record = saved.map(|size| DirectorySizeRecord { path: entry.path.clone(),
                bytes: Some(size.display_bytes(&path, &core.artifacts).to_string()), state: if size.complete { DirectorySizeRecordState::Complete } else { DirectorySizeRecordState::Partial },
                cached_at: Some(size.cached_at), created_at: Some(size.created_at), size_fingerprint: None });
            DirectorySizeCacheEntry { path: entry.path, status: if record.is_some() { DirectorySizeCacheStatus::Hit }
                else if valid && pending { DirectorySizeCacheStatus::Pending } else { DirectorySizeCacheStatus::Miss }, record }
        }).collect();
        Ok(DirectorySizeCacheLookup { path: request.path, request_version: request.request_version,
            revision: core.cache_revision.to_string(), entries })
    }
}

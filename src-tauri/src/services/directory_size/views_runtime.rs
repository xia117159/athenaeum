use std::sync::Arc;
use super::{DirectorySizeService, core::OwnerToken};
use crate::domain::directory_sizes::*;

impl DirectorySizeService {
    pub(crate) fn update_views(&self, owner: OwnerToken, request: UpdateDirectorySizeViewsRequest) -> Result<DirectorySizeViewsAck, String> {
        let mut core = self.core.lock().unwrap();
        if core.owner_token(&owner.label)?.epoch != owner.epoch { return Err("目录大小视图窗口已关闭".into()); }
        let ack = core.views.update(&owner, request)?;
        if let Some(store) = &core.storage { store.update_views(core.views.scopes()); }
        Ok(ack)
    }
    pub(crate) fn collect_views(&self, nonce: String) -> Vec<(String, DirectorySizeViewsFlushRequested)> {
        let mut core = self.core.lock().unwrap(); core.quiescing = true; core.views.collect(nonce)
    }
    pub(crate) fn views_collected(&self) -> bool { self.core.lock().unwrap().views.collected() }
    pub(crate) fn freeze_views(&self) -> Arc<Vec<DirectorySizeViewScope>> {
        let mut core = self.core.lock().unwrap(); let scopes = core.views.freeze();
        if let Some(store) = &core.storage { store.update_views(scopes.clone()); }
        scopes
    }
}

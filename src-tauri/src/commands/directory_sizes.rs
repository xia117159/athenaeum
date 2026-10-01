use std::sync::Arc;
use tauri::{State, Window};
use crate::{domain::directory_sizes::*, services::AppState};

#[tauri::command]
pub fn update_directory_size_views(request: UpdateDirectorySizeViewsRequest, window: Window,
    state: State<'_, Arc<AppState>>) -> Result<DirectorySizeViewsAck, String> {
    state.directory_sizes.update_views(state.directory_sizes.owner_token(window.label())?, request)
}

#[tauri::command]
pub async fn lookup_directory_size_cache(request: LookupDirectorySizeCacheRequest, window: Window,
    state: State<'_, Arc<AppState>>) -> Result<DirectorySizeCacheLookup, String> {
    let owner = state.directory_sizes.owner_token(window.label())?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.directory_sizes.lookup_cache(owner, request)).await
        .map_err(|error| format!("目录大小缓存查询失败：{error}"))?
}

#[tauri::command]
pub async fn get_directory_size_diagnostics(path: String, window: Window,
    state: State<'_, Arc<AppState>>) -> Result<DirectorySizeDiagnostics, String> {
    let owner = state.directory_sizes.owner_token(window.label())?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.directory_sizes.diagnostics(owner, &path)).await
        .map_err(|error| format!("目录大小诊断失败：{error}"))?
}

#[tauri::command]
pub fn subscribe_directory_sizes(request: SubscribeDirectorySizesRequest, window: Window,
    state: State<'_, Arc<AppState>>) -> Result<DirectorySizeSnapshot, String> {
    let owner = state.directory_sizes.owner_token(window.label())?;
    // Profile acquisition/registration uses metadata -> size-store lock order.
    // The profile-update guard additionally blocks acquisition across credential
    // writes; worker cancellation fences authentication after blocking calls.
    // No filesystem/credential/network I/O here.
    let metadata = state.metadata.read().map_err(|_| "远程连接配置不可用".to_string())?;
    let profile = match &request.target {
        DirectorySizeTarget::Remote { profile_id, .. } => Some(metadata.remote_profiles.iter()
            .find(|profile| &profile.id == profile_id).cloned().ok_or_else(|| "远程连接已不存在".to_string())?),
        DirectorySizeTarget::Local { .. } => None,
    };
    state.directory_sizes.subscribe(owner, request, profile)
}

#[tauri::command]
pub fn release_directory_sizes(consumer_id: String, slot_id: Option<String>, slot_revision: Option<u32>, handoff_from: Option<String>,
    window: Window, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    match (slot_id, slot_revision) {
        (Some(slot_id), Some(slot_revision)) => state.directory_sizes.release_slot(window.label(), &consumer_id,
            DirectorySizeHandoff { slot_id, slot_revision, handoff_from }),
        (None, None) => state.directory_sizes.release(window.label(), &consumer_id),
        _ => Err("目录统计关闭版本不完整".into()),
    }
}

#[tauri::command]
pub async fn lookup_directory_sizes(request: LookupDirectorySizesRequest, window: Window,
    state: State<'_, Arc<AppState>>) -> Result<DirectorySizeLookup, String> {
    let state = state.inner().clone(); let owner = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || state.directory_sizes.lookup(&owner, request)).await
        .map_err(|error| format!("目录大小查询失败：{error}"))?
}

use std::sync::Arc;
use tauri::{State, Window};
use crate::{domain::directory_sizes::*, services::AppState};

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
pub fn release_directory_sizes(consumer_id: String, window: Window, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.directory_sizes.release(window.label(), &consumer_id)
}

#[tauri::command]
pub fn lookup_directory_sizes(request: LookupDirectorySizesRequest, window: Window,
    state: State<'_, Arc<AppState>>) -> Result<DirectorySizeLookup, String> {
    state.directory_sizes.lookup(window.label(), request)
}

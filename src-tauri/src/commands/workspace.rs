use std::{path::Path, sync::Arc};

use tauri::{State, Window};

use crate::{
  domain::models::{NavigationTargetInfo, SystemIconBitmap, SystemIconRequest, WorkspaceBootstrap},
  services::{fs_service, icon_service, windows_shell, AppState}
};

#[tauri::command]
pub fn initialize_workspace(state: State<'_, Arc<AppState>>) -> Result<WorkspaceBootstrap, String> {
  let drives = fs_service::list_drives();
  let initial_path = drives
    .first()
    .map(|drive| drive.path.clone())
    .unwrap_or_else(|| ".".to_string());

  let metadata = state.metadata.read().expect("metadata lock poisoned").clone();
  let settings = state.settings.read().expect("settings lock poisoned").clone();
  let initial_listing = fs_service::list_directory(Path::new(&initial_path), &metadata.color_rules, |path| {
    metadata.tags_for_path(path)
  })
  .map_err(|error| error.to_string())?;

  Ok(WorkspaceBootstrap {
    drives,
    initial_path,
    initial_listing,
    settings: metadata.to_settings_snapshot(settings.layout, settings.details_row_height, settings.theme)
  })
}

#[tauri::command]
pub fn list_directory(path: String, state: State<'_, Arc<AppState>>) -> Result<crate::domain::models::DirectoryListing, String> {
  let metadata = state.metadata.read().expect("metadata lock poisoned").clone();
  fs_service::list_directory(Path::new(&path), &metadata.color_rules, |entry_path| metadata.tags_for_path(entry_path))
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_tree_children(path: String) -> Result<Vec<crate::domain::models::TreeNode>, String> {
  fs_service::get_tree_children(Path::new(&path)).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn resolve_system_icon(
  request: SystemIconRequest,
  state: State<'_, Arc<AppState>>
) -> Result<SystemIconBitmap, String> {
  let cache_key = icon_service::cache_key_for_request(&request);

  if let Some(bitmap) = state
    .system_icon_cache
    .lock()
    .expect("system icon cache lock poisoned")
    .get(&cache_key)
    .cloned()
  {
    return Ok(bitmap);
  }

  let bitmap = icon_service::resolve_system_icon(&request).map_err(|error| error.to_string())?;
  state
    .system_icon_cache
    .lock()
    .expect("system icon cache lock poisoned")
    .insert(cache_key, bitmap.clone());

  Ok(bitmap)
}

#[tauri::command]
pub async fn show_native_context_menu(paths: Vec<String>, x: i32, y: i32, window: Window) -> Result<bool, String> {
  windows_shell::show_native_context_menu(paths, x, y, &window)
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn resolve_navigation_targets(paths: Vec<String>) -> Result<Vec<NavigationTargetInfo>, String> {
  paths
    .iter()
    .map(|path| windows_shell::resolve_navigation_target(path).map_err(|error| error.to_string()))
    .collect()
}

#[tauri::command]
pub fn open_path_with_system_default(path: String) -> Result<(), String> {
  windows_shell::open_path_with_system_default(path).map_err(|error| error.to_string())
}

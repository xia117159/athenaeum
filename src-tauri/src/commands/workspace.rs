use std::{path::Path, sync::Arc};

use tauri::{AppHandle, State, Window};

use crate::{
    domain::models::{
        ItemProperties, ItemPropertiesRequest, ItemPropertiesTarget,
        NativeBackgroundContextMenuOptions, NativeBackgroundContextMenuResult,
        NavigationTargetInfo, SystemFileClipboard, SystemFileClipboardMode,
        SystemFileOperationRequest, SystemIconBitmap, SystemIconRequest, WindowsDragDropEnvironment,
        WorkspaceBootstrap, WorkspaceWatchRootsRequest,
    },
    services::{fs_service, icon_service, remote_service, windows_shell, AppState},
};

#[tauri::command]
pub fn initialize_workspace(state: State<'_, Arc<AppState>>) -> Result<WorkspaceBootstrap, String> {
    let drives = fs_service::list_drives();
    let initial_path = drives
        .first()
        .map(|drive| drive.path.clone())
        .unwrap_or_else(|| ".".to_string());

    let metadata = {
        let mut metadata = state.metadata.write().expect("metadata lock poisoned");
        metadata.cleanup_expired_entry_metadata(chrono::Utc::now);
        metadata.clone()
    };
    let settings = state
        .settings
        .read()
        .expect("settings lock poisoned")
        .clone();
    let initial_listing =
        fs_service::list_directory(Path::new(&initial_path), &metadata.color_rules, |path| {
            (metadata.tags_for_path(path), metadata.comment_for_path(path))
        })
        .map_err(|error| error.to_string())?;

    let mut bootstrap = WorkspaceBootstrap {
        drives,
        initial_path,
        initial_listing,
        settings: metadata.to_settings_snapshot(
            settings.layout,
            settings.detail_columns,
            settings.details_row_height,
            settings.tooltip_hover_delay_ms,
            settings.metadata_retention_hours,
            settings.context_menu,
            settings.theme,
        ),
    };

    // Hydrate remote profile passwords from credential store
    bootstrap.settings.remote_profiles = super::remote::hydrate_remote_profiles(bootstrap.settings.remote_profiles);

    Ok(bootstrap)
}

#[tauri::command]
pub fn list_directory(
    path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<crate::domain::models::DirectoryListing, String> {
    let metadata = {
        let mut metadata = state.metadata.write().expect("metadata lock poisoned");
        metadata.cleanup_expired_entry_metadata(chrono::Utc::now);
        metadata.clone()
    };
    fs_service::list_directory(Path::new(&path), &metadata.color_rules, |entry_path| {
        (
            metadata.tags_for_path(entry_path),
            metadata.comment_for_path(entry_path),
        )
    })
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_workspace_watch_roots(
    request: WorkspaceWatchRootsRequest,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<(), String> {
    state.file_watcher.update_roots(app, request);
    Ok(())
}

#[tauri::command]
pub fn get_tree_children(path: String) -> Result<Vec<crate::domain::models::TreeNode>, String> {
    fs_service::get_tree_children(Path::new(&path)).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_item_properties(
    request: ItemPropertiesRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<ItemProperties, String> {
    match request.target.clone() {
        ItemPropertiesTarget::Local { path } => {
            let request_for_service = request.clone();
            tauri::async_runtime::spawn_blocking(move || {
                fs_service::get_item_properties(&request_for_service, Path::new(&path))
                    .map_err(|error| error.to_string())
            })
            .await
            .map_err(|error| format!("item properties task failed: {error}"))?
        }
        ItemPropertiesTarget::Remote {
            protocol,
            profile_id,
            remote_path,
            display_path,
        } => {
            let profile = state
                .metadata
                .read()
                .expect("metadata lock poisoned")
                .remote_profiles
                .iter()
                .find(|profile| profile.id == profile_id)
                .cloned()
                .ok_or_else(|| format!("remote profile not found: {profile_id}"))?;
            if profile.protocol != protocol {
                return Err(format!(
                    "remote profile protocol does not match: {profile_id}"
                ));
            }
            let request_for_service = request.clone();
            tauri::async_runtime::spawn_blocking(move || {
                remote_service::get_item_properties(
                    &request_for_service,
                    &profile,
                    None,
                    &remote_path,
                    &display_path,
                )
                .map_err(|error| error.to_string())
            })
            .await
            .map_err(|error| format!("remote item properties task failed: {error}"))?
        }
    }
}

#[tauri::command]
pub fn resolve_system_icon(
    request: SystemIconRequest,
    state: State<'_, Arc<AppState>>,
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
pub async fn show_native_context_menu(
    paths: Vec<String>,
    x: i32,
    y: i32,
    window: Window,
) -> Result<bool, String> {
    windows_shell::show_native_context_menu(paths, x, y, &window)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn show_native_background_context_menu(
    directory_path: String,
    x: i32,
    y: i32,
    options: NativeBackgroundContextMenuOptions,
    window: Window,
) -> Result<NativeBackgroundContextMenuResult, String> {
    windows_shell::show_native_background_context_menu(directory_path, x, y, options, &window)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn resolve_navigation_targets(paths: Vec<String>) -> Result<Vec<NavigationTargetInfo>, String> {
    paths
        .iter()
        .map(|path| {
            windows_shell::resolve_navigation_target(path).map_err(|error| error.to_string())
        })
        .collect()
}

#[tauri::command]
pub fn open_path_with_system_default(path: String) -> Result<(), String> {
    windows_shell::open_path_with_system_default(path).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_system_file_clipboard(
    paths: Vec<String>,
    mode: SystemFileClipboardMode,
) -> Result<(), String> {
    windows_shell::set_system_file_clipboard(paths, mode).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn read_system_file_clipboard() -> Result<Option<SystemFileClipboard>, String> {
    windows_shell::read_system_file_clipboard().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_windows_drag_drop_environment() -> Result<WindowsDragDropEnvironment, String> {
    windows_shell::get_windows_drag_drop_environment().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn start_system_file_drag(
    paths: Vec<String>,
    window: Window,
) -> Result<SystemFileClipboardMode, String> {
    windows_shell::start_system_file_drag(paths, &window)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn perform_system_file_operation(
    request: SystemFileOperationRequest,
    window: Window,
) -> Result<(), String> {
    windows_shell::perform_system_file_operation(request, &window)
        .await
        .map_err(|error| error.to_string())
}

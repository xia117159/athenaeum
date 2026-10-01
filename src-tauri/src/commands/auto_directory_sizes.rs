use std::sync::Arc;
use tauri::{AppHandle, Emitter, State, WebviewWindow};
use crate::services::{auto_directory_size_paths, AppState};

fn update(path: String, add: bool, state: State<'_, Arc<AppState>>, app: AppHandle) -> Result<Vec<String>, String> {
    let paths = {
        let mut settings = state.settings.write().expect("settings lock poisoned");
        auto_directory_size_paths::update(&mut settings, &path, add).map_err(|error| error.to_string())?
    };
    let snapshot = super::settings::get_settings_snapshot(state)?;
    let _ = app.emit("settings_changed", &snapshot);
    Ok(paths)
}
#[tauri::command]
pub fn add_auto_directory_size_path(path: String, state: State<'_, Arc<AppState>>, app: AppHandle) -> Result<Vec<String>, String> {
    update(path, true, state, app)
}
#[tauri::command]
pub fn remove_auto_directory_size_path(path: String, state: State<'_, Arc<AppState>>, app: AppHandle) -> Result<Vec<String>, String> {
    update(path, false, state, app)
}
#[tauri::command]
pub async fn choose_directory_size_folder(window: WebviewWindow) -> Result<Option<String>, String> {
    #[cfg(windows)]
    let owner = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
    #[cfg(not(windows))]
    let owner = { let _ = window; 0 };
    tauri::async_runtime::spawn_blocking(move || crate::services::templates::picker::choose(owner, "选择要自动计算大小的文件夹")
        .map_err(|error| error.to_string())).await.map_err(|error| error.to_string())?
}

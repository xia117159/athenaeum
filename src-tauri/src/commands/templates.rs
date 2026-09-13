use crate::{
    domain::models::{CreateTemplateItemsRequest, CreationTemplateListing, OperationTaskSnapshot},
    services::{templates, AppState},
};
use std::sync::Arc;
use tauri::{State, WebviewWindow};

#[tauri::command]
pub async fn list_creation_templates(
    state: State<'_, Arc<AppState>>,
    root_path: String,
    relative_path: String,
) -> Result<CreationTemplateListing, String> {
    let configured = state
        .settings
        .read()
        .expect("settings poisoned")
        .template_root
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        templates::list(&configured, &root_path, &relative_path)
            .map_err(|error| format!("{error:#}"))
    })
    .await
    .map_err(|error| format!("读取模板失败：{error}"))?
}

#[tauri::command]
pub async fn choose_template_root(window: WebviewWindow) -> Result<Option<String>, String> {
    #[cfg(windows)]
    let owner = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
    #[cfg(not(windows))]
    let owner = {
        let _ = window;
        0
    };
    tauri::async_runtime::spawn_blocking(move || {
        templates::picker::choose(owner).map_err(|error| format!("{error:#}"))
    })
    .await
    .map_err(|error| format!("文件夹选择框异常：{error}"))?
}

#[tauri::command]
pub fn create_template_items(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    request: CreateTemplateItemsRequest,
) -> Result<OperationTaskSnapshot, String> {
    #[cfg(windows)]
    {
        let state = state.inner().clone();
        let root = state
            .settings
            .read()
            .expect("settings poisoned")
            .template_root
            .clone();
        let (result, execute) = state
            .operations
            .lock()
            .expect("operations poisoned")
            .queue_template_creation(&request)
            .map_err(|error| format!("{error:#}"))?;
        super::operations::emit_operation_result(&app, &result);
        if execute {
            let id = result.snapshot.task_id.clone();
            std::thread::spawn(move || {
                if let Err(error) = crate::services::operation_service::templates::execute_creation(
                    &state,
                    &id,
                    request,
                    &root,
                    &|result| super::operations::emit_operation_result(&app, result),
                ) {
                    eprintln!("template creation worker failed: {error:#}");
                }
            });
        }
        Ok(result.snapshot)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, state, request);
        Err("新建项目目前仅支持 Windows".into())
    }
}

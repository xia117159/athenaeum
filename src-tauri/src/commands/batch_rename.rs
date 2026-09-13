use super::operations::emit_operation_result;
use crate::{
    domain::{
        batch_rename::*,
        models::{OperationIntent, OperationIntentKind, OperationTaskSnapshot},
        rename_expression::FunctionInfo,
    },
    services::{operation_service::batch::execute_batch, AppState},
};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn create_batch_rename_session(
    window: tauri::Window,
    state: State<'_, Arc<AppState>>,
    request: CreateBatchRenameRequest,
) -> Result<BatchRenameSessionSnapshot, String> {
    let state = state.inner().clone();
    let owner = window.label().to_owned();
    let epoch = state.batch_rename.owner_epoch(&owner);
    tauri::async_runtime::spawn_blocking(move || {
        state
            .batch_rename
            .create_at_epoch(&owner, request.paths, epoch)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn preview_batch_rename(
    window: tauri::Window,
    state: State<'_, Arc<AppState>>,
    request: PreviewBatchRenameRequest,
) -> Result<BatchRenamePreview, String> {
    state
        .batch_rename
        .preview(window.label(), request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn invalidate_batch_rename_preview(
    window: tauri::Window,
    state: State<'_, Arc<AppState>>,
    request: InvalidateBatchRenameRequest,
) -> Result<(), String> {
    state
        .batch_rename
        .invalidate(window.label(), request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn apply_batch_rename(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, Arc<AppState>>,
    request: ApplyBatchRenameRequest,
) -> Result<OperationTaskSnapshot, String> {
    let plan = state
        .batch_rename
        .claim(
            window.label(),
            &request.session_id,
            &request.preview_id,
            &request.request_id,
        )
        .map_err(|error| error.to_string())?;
    let intent = OperationIntent {
        request_id: request.request_id,
        source: request.source,
        panel_id: Some(request.panel_id),
        tab_id: Some(request.tab_id),
        kind: OperationIntentKind::Rename,
        sources: None,
        destination: None,
        source_path: None,
        new_name: None,
        parent: None,
        name: None,
        undo_record_id: None,
        conflict_policy: None,
    };
    let (result, payload) = state
        .operations
        .lock()
        .expect("operation store poisoned")
        .queue_batch(intent, &plan)
        .map_err(|error| error.to_string())?;
    emit_operation_result(&app, &result);
    if let Some(payload) = payload {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = execute_batch(&state, payload, &|result| {
                emit_operation_result(&app, result)
            }) {
                eprintln!("batch rename worker failed: {error:#}");
            }
        });
    }
    Ok(result.snapshot)
}

#[tauri::command]
pub fn close_batch_rename_session(
    window: tauri::Window,
    state: State<'_, Arc<AppState>>,
    session_id: String,
) {
    state.batch_rename.close(window.label(), &session_id);
}

#[tauri::command]
pub fn get_batch_rename_functions(state: State<'_, Arc<AppState>>) -> Vec<FunctionInfo> {
    state.batch_rename.catalog()
}

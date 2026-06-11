use std::{path::Path, sync::Arc};

use tauri::{Emitter, State};

use crate::{
  domain::models::{
    CreateDirectoryRequest, CreateFileRequest, FileOperationRequest, OperationConflictResolution,
    OperationHistoryListSnapshot, OperationIntent, OperationResult, OperationTaskListSnapshot, OperationTaskSnapshot,
    RenameRequest
  },
  services::{
    fs_service,
    operation_service::{execute_conflict_resolution, execute_operation_task, execute_undo_task},
    AppState
  }
};

fn app_data_dir(state: &AppState) -> Option<std::path::PathBuf> {
  state
    .app_data_dir
    .read()
    .expect("app data dir lock poisoned")
    .clone()
}

fn emit_operation_result(app: &tauri::AppHandle, result: &crate::services::operation_service::OperationServiceResult) {
  for event in &result.task_events {
    let _ = app.emit("operation_task_snapshot", event);
  }
  for event in &result.history_events {
    let _ = app.emit("operation_history_changed", event);
  }
  if let Some(conflict) = &result.conflict {
    let _ = app.emit("operation_conflict_requested", conflict);
  }
}

#[tauri::command]
pub fn copy_entries(request: FileOperationRequest) -> Result<OperationResult, String> {
  let destination_root = request
    .destination
    .ok_or_else(|| "destination is required for copy".to_string())?;

  let mut affected_paths = Vec::new();
  for source in request.sources {
    let source_path = Path::new(&source);
    let file_name = source_path
      .file_name()
      .and_then(|value| value.to_str())
      .ok_or_else(|| format!("invalid source path: {source}"))?;
    let destination = Path::new(&destination_root).join(file_name);
    let copied = fs_service::copy_recursively(source_path, &destination).map_err(|error| error.to_string())?;
    affected_paths.push(copied.to_string_lossy().into_owned());
  }

  Ok(OperationResult { affected_paths })
}

#[tauri::command]
pub fn move_entries(request: FileOperationRequest) -> Result<OperationResult, String> {
  let destination_root = request
    .destination
    .ok_or_else(|| "destination is required for move".to_string())?;

  let mut affected_paths = Vec::new();
  for source in request.sources {
    let source_path = Path::new(&source);
    let file_name = source_path
      .file_name()
      .and_then(|value| value.to_str())
      .ok_or_else(|| format!("invalid source path: {source}"))?;
    let destination = Path::new(&destination_root).join(file_name);
    let moved = fs_service::move_entry(source_path, &destination).map_err(|error| error.to_string())?;
    affected_paths.push(moved.to_string_lossy().into_owned());
  }

  Ok(OperationResult { affected_paths })
}

#[tauri::command]
pub fn delete_entries(request: FileOperationRequest) -> Result<OperationResult, String> {
  for source in &request.sources {
    fs_service::delete_entry(Path::new(source)).map_err(|error| error.to_string())?;
  }

  Ok(OperationResult {
    affected_paths: request.sources
  })
}

#[tauri::command]
pub fn rename_entry(request: RenameRequest) -> Result<OperationResult, String> {
  let renamed = fs_service::rename_entry(Path::new(&request.source), &request.new_name)
    .map_err(|error| error.to_string())?;
  Ok(OperationResult {
    affected_paths: vec![renamed.to_string_lossy().into_owned()]
  })
}

#[tauri::command]
pub fn create_directory(request: CreateDirectoryRequest, _state: State<'_, Arc<AppState>>) -> Result<OperationResult, String> {
  let created = fs_service::create_directory(Path::new(&request.parent), &request.name)
    .map_err(|error| error.to_string())?;
  Ok(OperationResult {
    affected_paths: vec![created.to_string_lossy().into_owned()]
  })
}

#[tauri::command]
pub fn create_file(request: CreateFileRequest, _state: State<'_, Arc<AppState>>) -> Result<OperationResult, String> {
  let created = fs_service::create_file(Path::new(&request.parent), &request.name)
    .map_err(|error| error.to_string())?;
  Ok(OperationResult {
    affected_paths: vec![created.to_string_lossy().into_owned()]
  })
}

#[tauri::command]
pub fn start_file_operation(
  app: tauri::AppHandle,
  state: State<'_, Arc<AppState>>,
  intent: OperationIntent
) -> Result<OperationTaskSnapshot, String> {
  let app_state = state.inner().clone();
  let app_data_dir = app_data_dir(&app_state);
  let (result, should_execute) = {
    let mut operations = app_state
      .operations
      .lock()
      .expect("operation store lock poisoned");
    operations.queue_operation(intent.clone())
  };
  emit_operation_result(&app, &result);
  if should_execute {
    let task_id = result.snapshot.task_id.clone();
    let app_for_thread = app.clone();
    std::thread::spawn(move || {
      let running = {
        let mut operations = app_state
          .operations
          .lock()
          .expect("operation store lock poisoned");
        operations.mark_operation_running(&task_id)
      };
      if let Some(running) = running {
        emit_operation_result(&app_for_thread, &running);
        if matches!(
          running.snapshot.status,
          crate::domain::models::OperationTaskStatus::Cancelled
            | crate::domain::models::OperationTaskStatus::Cancelling
        ) {
          return;
        }
      }

      let cancellation = {
        let operations = app_state
          .operations
          .lock()
          .expect("operation store lock poisoned");
        operations.operation_cancellation(&task_id)
      };
      let Some(cancellation) = cancellation else {
        return;
      };
      let execution = execute_operation_task(&task_id, &intent, app_data_dir, cancellation, None);
      let finished = {
        let mut operations = app_state
          .operations
          .lock()
          .expect("operation store lock poisoned");
        operations.finish_operation(&task_id, &intent, execution)
      };
      if let Some(finished) = finished {
        emit_operation_result(&app_for_thread, &finished);
      }
    });
  }
  Ok(result.snapshot)
}

#[tauri::command]
pub fn list_file_operation_tasks(state: State<'_, Arc<AppState>>) -> Result<OperationTaskListSnapshot, String> {
  let operations = state
    .operations
    .lock()
    .expect("operation store lock poisoned");
  Ok(operations.list_tasks())
}

#[tauri::command]
pub fn cancel_file_operation(
  app: tauri::AppHandle,
  state: State<'_, Arc<AppState>>,
  task_id: String
) -> Result<OperationTaskSnapshot, String> {
  let mut operations = state
    .operations
    .lock()
    .expect("operation store lock poisoned");
  let result = operations
    .cancel_task(&task_id)
    .ok_or_else(|| format!("operation task was not found: {task_id}"))?;
  emit_operation_result(&app, &result);
  Ok(result.snapshot)
}

#[tauri::command]
pub fn resolve_file_operation_conflict(
  app: tauri::AppHandle,
  state: State<'_, Arc<AppState>>,
  resolution: OperationConflictResolution
) -> Result<OperationTaskSnapshot, String> {
  let app_state = state.inner().clone();
  let app_data_dir = app_data_dir(&app_state);
  let (result, execution) = {
    let mut operations = app_state
      .operations
      .lock()
      .expect("operation store lock poisoned");
    operations
      .prepare_conflict_resolution(resolution)
      .map_err(|error| error.to_string())?
  };
  emit_operation_result(&app, &result);
  let app_for_thread = app.clone();
  std::thread::spawn(move || {
    let task_id = execution.task_id.clone();
    let intent = execution.intent.clone();
    let operation = execute_conflict_resolution(execution, app_data_dir);
    let finished = {
      let mut operations = app_state
        .operations
        .lock()
        .expect("operation store lock poisoned");
      operations.finish_operation(&task_id, &intent, operation)
    };
    if let Some(finished) = finished {
      emit_operation_result(&app_for_thread, &finished);
    }
  });
  Ok(result.snapshot)
}

#[tauri::command]
pub fn list_operation_history(state: State<'_, Arc<AppState>>) -> Result<OperationHistoryListSnapshot, String> {
  let operations = state
    .operations
    .lock()
    .expect("operation store lock poisoned");
  Ok(operations.list_history())
}

#[tauri::command]
pub fn undo_latest_operation(
  app: tauri::AppHandle,
  state: State<'_, Arc<AppState>>,
  request_id: String
) -> Result<OperationTaskSnapshot, String> {
  let app_state = state.inner().clone();
  let (result, execution) = {
    let mut operations = app_state
      .operations
      .lock()
      .expect("operation store lock poisoned");
    operations
      .prepare_undo_latest(request_id)
      .map_err(|error| error.to_string())?
  };
  emit_operation_result(&app, &result);
  let app_for_thread = app.clone();
  std::thread::spawn(move || {
    let undo_result = execute_undo_task(execution);
    let finished = {
      let mut operations = app_state
        .operations
        .lock()
        .expect("operation store lock poisoned");
      operations.finish_undo_operation(undo_result)
    };
    if let Ok(finished) = finished {
      emit_operation_result(&app_for_thread, &finished);
    }
  });
  Ok(result.snapshot)
}

#[tauri::command]
pub fn undo_operation(
  app: tauri::AppHandle,
  state: State<'_, Arc<AppState>>,
  record_id: String,
  request_id: String
) -> Result<OperationTaskSnapshot, String> {
  let app_state = state.inner().clone();
  let (result, execution) = {
    let mut operations = app_state
      .operations
      .lock()
      .expect("operation store lock poisoned");
    operations
      .prepare_undo_record(record_id, request_id)
      .map_err(|error| error.to_string())?
  };
  emit_operation_result(&app, &result);
  let app_for_thread = app.clone();
  std::thread::spawn(move || {
    let undo_result = execute_undo_task(execution);
    let finished = {
      let mut operations = app_state
        .operations
        .lock()
        .expect("operation store lock poisoned");
      operations.finish_undo_operation(undo_result)
    };
    if let Ok(finished) = finished {
      emit_operation_result(&app_for_thread, &finished);
    }
  });
  Ok(result.snapshot)
}

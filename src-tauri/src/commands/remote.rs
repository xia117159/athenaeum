use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::{
  domain::models::{
    EntryViewModel, OperationResult, RemoteCreateDirectoryRequest, RemoteDirectoryRequest, RemoteFileOperationRequest,
    RemoteHostKeyInfo, RemoteProfile, RemoteProfileUpsertRequest, RemoteRenameRequest, RemoteTestResult,
    RemoteTransferOperation, RemoteTransferRequest, RemoteTrustHostKeyRequest
  },
  services::{remote_service, AppState}
};

fn emit_settings_changed(app: &AppHandle, state: &Arc<AppState>) {
  let metadata = state.metadata.read().expect("metadata lock poisoned").clone();
  let settings = state.settings.read().expect("settings lock poisoned").clone();
  let snapshot = metadata.to_settings_snapshot(settings.layout, settings.details_row_height, settings.theme);
  let _ = app.emit("settings_changed", snapshot);
}

async fn run_remote_blocking<T, F>(operation: F) -> Result<T, String>
where
  T: Send + 'static,
  F: FnOnce() -> Result<T, String> + Send + 'static
{
  tauri::async_runtime::spawn_blocking(operation)
    .await
    .map_err(|error| format!("remote operation task failed: {error}"))?
}

#[tauri::command]
pub fn list_remote_profiles(state: State<'_, Arc<AppState>>) -> Result<Vec<RemoteProfile>, String> {
  Ok(redact_remote_profiles(
    state
      .metadata
      .read()
      .expect("metadata lock poisoned")
      .remote_profiles
      .clone()
  ))
}

#[tauri::command]
pub fn save_remote_profile(
  request: RemoteProfileUpsertRequest,
  state: State<'_, Arc<AppState>>,
  app: AppHandle
) -> Result<Vec<RemoteProfile>, String> {
  let existing_credential_target = {
    state
      .metadata
      .read()
      .expect("metadata lock poisoned")
      .remote_profiles
      .iter()
      .find(|profile| profile.id == request.profile.id)
      .and_then(|profile| profile.credential_target.clone())
  };
  let profile = remote_service::prepare_profile_for_save(
    request,
    existing_credential_target.as_deref()
  )
  .map_err(|error| error.to_string())?;
  {
    state
      .metadata
      .write()
      .expect("metadata lock poisoned")
      .upsert_remote_profile(profile);
  }
  state
    .metadata
    .read()
    .expect("metadata lock poisoned")
    .persist()
    .map_err(|error| error.to_string())?;
  emit_settings_changed(&app, state.inner());
  list_remote_profiles(state)
}

#[tauri::command]
pub fn delete_remote_profile(
  id: String,
  state: State<'_, Arc<AppState>>,
  app: AppHandle
) -> Result<Vec<RemoteProfile>, String> {
  let removed_profile = {
    state
      .metadata
      .write()
      .expect("metadata lock poisoned")
      .delete_remote_profile(&id)
  };
  state
    .metadata
    .read()
    .expect("metadata lock poisoned")
    .persist()
    .map_err(|error| error.to_string())?;

  if let Some(profile) = removed_profile.as_ref() {
    remote_service::cleanup_profile_after_delete(profile);
  }

  emit_settings_changed(&app, state.inner());
  list_remote_profiles(state)
}

#[tauri::command]
pub async fn test_remote_profile(
  request: RemoteProfileUpsertRequest,
  state: State<'_, Arc<AppState>>
) -> Result<RemoteTestResult, String> {
  let profile_id = request.profile.id.clone();
  let existing_credential_target = {
    state
      .metadata
      .read()
      .expect("metadata lock poisoned")
      .remote_profiles
      .iter()
      .find(|profile| profile.id == profile_id)
      .and_then(|profile| profile.credential_target.clone())
  };
  let mut profile = request.profile;
  profile.credential_target = existing_credential_target;
  let password = request.password;
  run_remote_blocking(move || {
    remote_service::test_profile(&profile, password.as_deref()).map_err(|error| error.to_string())
  })
  .await
}

#[tauri::command]
pub async fn get_remote_host_key(
  profile_id: String,
  state: State<'_, Arc<AppState>>
) -> Result<RemoteHostKeyInfo, String> {
  let profile = remote_profile_by_id(&state, &profile_id)?;
  run_remote_blocking(move || remote_service::fetch_host_key_info(&profile).map_err(|error| error.to_string())).await
}

#[tauri::command]
pub async fn trust_remote_host_key(
  request: RemoteTrustHostKeyRequest,
  state: State<'_, Arc<AppState>>
) -> Result<RemoteHostKeyInfo, String> {
  let profile = remote_profile_by_id(&state, &request.profile_id)?;
  run_remote_blocking(move || remote_service::trust_host_key(&profile, &request).map_err(|error| error.to_string())).await
}

#[tauri::command]
pub async fn list_remote_directory(
  request: RemoteDirectoryRequest,
  state: State<'_, Arc<AppState>>
) -> Result<Vec<EntryViewModel>, String> {
  let profile = remote_profile_by_id(&state, &request.profile_id)?;
  let password = request.password;
  let path = request.path;
  run_remote_blocking(move || {
    remote_service::list_directory(&profile, password.as_deref(), path.as_deref()).map_err(|error| error.to_string())
  })
  .await
}

#[tauri::command]
pub async fn create_remote_directory(
  request: RemoteCreateDirectoryRequest,
  state: State<'_, Arc<AppState>>
) -> Result<OperationResult, String> {
  let profile = remote_profile_by_id(&state, &request.profile_id)?;
  let password = request.password;
  let parent = request.parent;
  let name = request.name;
  run_remote_blocking(move || {
    let created = remote_service::create_directory(&profile, password.as_deref(), &parent, &name)
      .map_err(|error| error.to_string())?;
    Ok(OperationResult {
      affected_paths: vec![created]
    })
  })
  .await
}

#[tauri::command]
pub async fn delete_remote_entries(
  request: RemoteFileOperationRequest,
  state: State<'_, Arc<AppState>>
) -> Result<OperationResult, String> {
  let profile = remote_profile_by_id(&state, &request.profile_id)?;
  let password = request.password;
  let sources = request.sources;
  run_remote_blocking(move || {
    let deleted = remote_service::delete_entries(&profile, password.as_deref(), &sources)
      .map_err(|error| error.to_string())?;
    Ok(OperationResult {
      affected_paths: deleted
    })
  })
  .await
}

#[tauri::command]
pub async fn rename_remote_entry(
  request: RemoteRenameRequest,
  state: State<'_, Arc<AppState>>
) -> Result<OperationResult, String> {
  let profile = remote_profile_by_id(&state, &request.profile_id)?;
  let password = request.password;
  let source = request.source;
  let new_name = request.new_name;
  run_remote_blocking(move || {
    let renamed = remote_service::rename_entry(&profile, password.as_deref(), &source, &new_name)
      .map_err(|error| error.to_string())?;
    Ok(OperationResult {
      affected_paths: vec![renamed]
    })
  })
  .await
}

#[tauri::command]
pub async fn upload_remote_files(
  request: RemoteFileOperationRequest,
  state: State<'_, Arc<AppState>>
) -> Result<OperationResult, String> {
  let profile = remote_profile_by_id(&state, &request.profile_id)?;
  let password = request.password;
  let sources = request.sources;
  let destination = request
    .destination
    .ok_or_else(|| "destination is required for remote upload".to_string())?;
  run_remote_blocking(move || {
    let uploaded = remote_service::upload_files(&profile, password.as_deref(), &sources, &destination)
      .map_err(|error| error.to_string())?;
    Ok(OperationResult {
      affected_paths: uploaded
    })
  })
  .await
}

#[tauri::command]
pub async fn download_remote_entries(
  request: RemoteFileOperationRequest,
  state: State<'_, Arc<AppState>>
) -> Result<OperationResult, String> {
  let profile = remote_profile_by_id(&state, &request.profile_id)?;
  let password = request.password;
  let sources = request.sources;
  let destination = request
    .destination
    .ok_or_else(|| "destination is required for remote download".to_string())?;
  run_remote_blocking(move || {
    let downloaded = remote_service::download_entries(&profile, password.as_deref(), &sources, &destination)
      .map_err(|error| error.to_string())?;
    Ok(OperationResult {
      affected_paths: downloaded
    })
  })
  .await
}

#[tauri::command]
pub async fn copy_remote_entries(
  request: RemoteFileOperationRequest,
  state: State<'_, Arc<AppState>>
) -> Result<OperationResult, String> {
  let profile = remote_profile_by_id(&state, &request.profile_id)?;
  let password = request.password;
  let sources = request.sources;
  let destination = request
    .destination
    .ok_or_else(|| "destination is required for remote copy".to_string())?;
  run_remote_blocking(move || {
    let copied = remote_service::copy_entries(&profile, password.as_deref(), &sources, &destination)
      .map_err(|error| error.to_string())?;
    Ok(OperationResult {
      affected_paths: copied
    })
  })
  .await
}

#[tauri::command]
pub async fn move_remote_entries(
  request: RemoteFileOperationRequest,
  state: State<'_, Arc<AppState>>
) -> Result<OperationResult, String> {
  let profile = remote_profile_by_id(&state, &request.profile_id)?;
  let password = request.password;
  let sources = request.sources;
  let destination = request
    .destination
    .ok_or_else(|| "destination is required for remote move".to_string())?;
  run_remote_blocking(move || {
    let moved = remote_service::move_entries(&profile, password.as_deref(), &sources, &destination)
      .map_err(|error| error.to_string())?;
    Ok(OperationResult {
      affected_paths: moved
    })
  })
  .await
}

#[tauri::command]
pub async fn transfer_remote_entries(
  request: RemoteTransferRequest,
  state: State<'_, Arc<AppState>>
) -> Result<OperationResult, String> {
  let source_profile = remote_profile_by_id(&state, &request.source_profile_id)?;
  let destination_profile = remote_profile_by_id(&state, &request.destination_profile_id)?;
  run_remote_blocking(move || {
    let transferred = match request.operation {
      RemoteTransferOperation::Copy => remote_service::transfer_entries(
        &source_profile,
        request.source_password.as_deref(),
        &destination_profile,
        request.destination_password.as_deref(),
        &request.sources,
        &request.destination,
        false
      ),
      RemoteTransferOperation::Move => remote_service::transfer_entries(
        &source_profile,
        request.source_password.as_deref(),
        &destination_profile,
        request.destination_password.as_deref(),
        &request.sources,
        &request.destination,
        true
      )
    }
    .map_err(|error| error.to_string())?;

    Ok(OperationResult {
      affected_paths: transferred
    })
  })
  .await
}

fn remote_profile_by_id(state: &State<'_, Arc<AppState>>, id: &str) -> Result<RemoteProfile, String> {
  state
    .metadata
    .read()
    .expect("metadata lock poisoned")
    .remote_profiles
    .iter()
    .find(|profile| profile.id == id)
    .cloned()
    .ok_or_else(|| format!("remote profile not found: {id}"))
}

fn redact_remote_profiles(profiles: Vec<RemoteProfile>) -> Vec<RemoteProfile> {
  profiles
    .into_iter()
    .map(|mut profile| {
      profile.credential_target = None;
      profile
    })
    .collect()
}

#[cfg(test)]
mod tests {
  use super::run_remote_blocking;

  #[test]
  fn remote_blocking_runner_executes_work_on_background_thread() {
    let caller_thread = std::thread::current().id();
    let worker_thread = tauri::async_runtime::block_on(run_remote_blocking(move || {
      Ok::<_, String>(std::thread::current().id())
    }))
    .expect("blocking work should finish");

    assert_ne!(worker_thread, caller_thread);
  }
}

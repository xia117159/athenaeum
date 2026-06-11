use std::{
  sync::{
    atomic::AtomicBool,
    Arc
  }
};

use tauri::{Emitter, State};

use crate::{
  domain::models::{SearchQuery, SearchTaskStarted},
  services::{search_service, AppState}
};

#[tauri::command]
pub async fn start_search(
  app: tauri::AppHandle,
  state: State<'_, Arc<AppState>>,
  mut query: SearchQuery
) -> Result<SearchTaskStarted, String> {
  let search_id = query
    .search_id
    .clone()
    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
  query.search_id = Some(search_id.clone());

  let cancellation = Arc::new(AtomicBool::new(false));
  state
    .search_cancellations
    .lock()
    .expect("search lock poisoned")
    .insert(search_id.clone(), cancellation.clone());

  let app_handle = app.clone();
  let state_handle = state.inner().clone();
  let finished_search_id = search_id.clone();
  tauri::async_runtime::spawn_blocking(move || {
    let result = search_service::run_search(
      query,
      cancellation.clone(),
      |result| app_handle.emit("search_result", &result).map_err(Into::into),
      |progress| app_handle.emit("search_progress", &progress).map_err(Into::into)
    );

    if let Ok(finished) = result {
      let _ = app_handle.emit("search_finished", &finished);
    } else if let Err(error) = result {
      let _ = app_handle.emit("search_failed", error.to_string());
    }

    state_handle
      .search_cancellations
      .lock()
      .expect("search lock poisoned")
      .remove(&finished_search_id);
  });

  Ok(SearchTaskStarted { search_id })
}

#[tauri::command]
pub fn cancel_search(search_id: String, state: State<'_, Arc<AppState>>) -> Result<(), String> {
  state.set_search_flag(&search_id, true);
  Ok(())
}

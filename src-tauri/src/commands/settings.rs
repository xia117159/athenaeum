use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::{
  domain::models::{
    Bookmark, ColorRule, HotlistEntry, NavigationItemUpsertRequest, SettingsSnapshot, ShortcutBinding,
    SettingsModelUpdate, TagDefinition, UiLayout, UiTheme
  },
  services::{settings_store::validate_shortcuts, AppState}
};

fn persist_state(state: &Arc<AppState>) -> Result<(), String> {
  {
    let metadata = state.metadata.read().expect("metadata lock poisoned");
    metadata.persist().map_err(|error| error.to_string())?;
  }
  {
    let settings = state.settings.read().expect("settings lock poisoned");
    settings.persist().map_err(|error| error.to_string())?;
  }
  Ok(())
}

fn emit_settings_changed(app: &AppHandle, snapshot: &SettingsSnapshot) {
  let _ = app.emit("settings_changed", snapshot);
}

fn emit_current_settings_changed(app: &AppHandle, state: State<'_, Arc<AppState>>) -> Result<SettingsSnapshot, String> {
  let snapshot = get_settings_snapshot(state)?;
  emit_settings_changed(app, &snapshot);
  Ok(snapshot)
}

#[tauri::command]
pub fn get_settings_snapshot(state: State<'_, Arc<AppState>>) -> Result<SettingsSnapshot, String> {
  let metadata = state.metadata.read().expect("metadata lock poisoned").clone();
  let settings = state.settings.read().expect("settings lock poisoned").clone();
  Ok(metadata.to_settings_snapshot(settings.layout, settings.details_row_height, settings.theme))
}

#[tauri::command]
pub fn save_bookmark(
  bookmark: Bookmark,
  state: State<'_, Arc<AppState>>,
  app: AppHandle
) -> Result<SettingsSnapshot, String> {
  state.metadata.write().expect("metadata lock poisoned").upsert_bookmark(bookmark);
  persist_state(state.inner())?;
  emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn delete_bookmark(id: String, state: State<'_, Arc<AppState>>, app: AppHandle) -> Result<SettingsSnapshot, String> {
  state.metadata.write().expect("metadata lock poisoned").delete_bookmark(&id);
  persist_state(state.inner())?;
  emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn save_hotlist_entry(
  entry: HotlistEntry,
  state: State<'_, Arc<AppState>>,
  app: AppHandle
) -> Result<SettingsSnapshot, String> {
  state.metadata.write().expect("metadata lock poisoned").upsert_hotlist(entry);
  persist_state(state.inner())?;
  emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn delete_hotlist_entry(
  id: String,
  state: State<'_, Arc<AppState>>,
  app: AppHandle
) -> Result<SettingsSnapshot, String> {
  state.metadata.write().expect("metadata lock poisoned").delete_hotlist(&id);
  persist_state(state.inner())?;
  emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn save_navigation_item(
  request: NavigationItemUpsertRequest,
  state: State<'_, Arc<AppState>>,
  app: AppHandle
) -> Result<SettingsSnapshot, String> {
  state
    .metadata
    .write()
    .expect("metadata lock poisoned")
    .upsert_navigation_item(request, chrono::Utc::now, || uuid::Uuid::new_v4().to_string())
    .map_err(|error| error.to_string())?;
  persist_state(state.inner())?;
  emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn delete_navigation_item(
  id: String,
  state: State<'_, Arc<AppState>>,
  app: AppHandle
) -> Result<SettingsSnapshot, String> {
  state
    .metadata
    .write()
    .expect("metadata lock poisoned")
    .delete_navigation_item(&id);
  persist_state(state.inner())?;
  emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn reorder_navigation_items(
  ids: Vec<String>,
  state: State<'_, Arc<AppState>>,
  app: AppHandle
) -> Result<SettingsSnapshot, String> {
  state
    .metadata
    .write()
    .expect("metadata lock poisoned")
    .reorder_navigation_items(ids);
  persist_state(state.inner())?;
  emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn mark_navigation_item_opened(
  id: String,
  state: State<'_, Arc<AppState>>,
  app: AppHandle
) -> Result<SettingsSnapshot, String> {
  let marked = state
    .metadata
    .write()
    .expect("metadata lock poisoned")
    .mark_navigation_item_opened(&id, chrono::Utc::now);
  if marked.is_none() {
    return Err("navigation item id was not found".into());
  }
  persist_state(state.inner())?;
  emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn save_color_rule(
  rule: ColorRule,
  state: State<'_, Arc<AppState>>,
  app: AppHandle
) -> Result<SettingsSnapshot, String> {
  state.metadata.write().expect("metadata lock poisoned").upsert_color_rule(rule);
  persist_state(state.inner())?;
  emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn delete_color_rule(id: String, state: State<'_, Arc<AppState>>, app: AppHandle) -> Result<SettingsSnapshot, String> {
  state.metadata.write().expect("metadata lock poisoned").delete_color_rule(&id);
  persist_state(state.inner())?;
  emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn save_tag_definition(
  definition: TagDefinition,
  state: State<'_, Arc<AppState>>,
  app: AppHandle
) -> Result<SettingsSnapshot, String> {
  state.metadata.write().expect("metadata lock poisoned").upsert_tag_definition(definition);
  persist_state(state.inner())?;
  emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn delete_tag_definition(
  id: String,
  state: State<'_, Arc<AppState>>,
  app: AppHandle
) -> Result<SettingsSnapshot, String> {
  state.metadata.write().expect("metadata lock poisoned").delete_tag_definition(&id);
  persist_state(state.inner())?;
  emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn save_shortcuts(
  shortcuts: Vec<ShortcutBinding>,
  state: State<'_, Arc<AppState>>,
  app: AppHandle
) -> Result<SettingsSnapshot, String> {
  validate_shortcuts(&shortcuts).map_err(|error| error.to_string())?;
  state.metadata.write().expect("metadata lock poisoned").set_shortcuts(shortcuts);
  persist_state(state.inner())?;
  emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn save_details_row_height(
  details_row_height: u16,
  state: State<'_, Arc<AppState>>,
  app: AppHandle
) -> Result<SettingsSnapshot, String> {
  state
    .settings
    .write()
    .expect("settings lock poisoned")
    .set_details_row_height(details_row_height);
  persist_state(state.inner())?;
  emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn save_ui_layout(layout: UiLayout, state: State<'_, Arc<AppState>>, app: AppHandle) -> Result<SettingsSnapshot, String> {
  state.settings.write().expect("settings lock poisoned").set_layout(layout);
  persist_state(state.inner())?;
  emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn save_ui_theme(theme: UiTheme, state: State<'_, Arc<AppState>>, app: AppHandle) -> Result<SettingsSnapshot, String> {
  state.settings.write().expect("settings lock poisoned").set_theme(theme);
  persist_state(state.inner())?;
  emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn save_settings_model(
  model: SettingsModelUpdate,
  state: State<'_, Arc<AppState>>,
  app: AppHandle
) -> Result<SettingsSnapshot, String> {
  validate_shortcuts(&model.shortcuts).map_err(|error| error.to_string())?;
  {
    let mut metadata = state.metadata.write().expect("metadata lock poisoned");
    metadata.set_shortcuts(model.shortcuts);
    metadata.set_color_rules(model.color_rules);
  }
  {
    let mut settings = state.settings.write().expect("settings lock poisoned");
    settings.set_details_row_height(model.details_row_height);
    settings.set_theme(model.theme);
  }
  persist_state(state.inner())?;
  emit_current_settings_changed(&app, state)
}

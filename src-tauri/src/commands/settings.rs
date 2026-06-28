use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::{
    domain::models::{
        Bookmark, ColorRule, HotlistEntry, NavigationItemUpsertRequest, SettingsModelUpdate,
        SettingsSnapshot, ShortcutBinding, TagDefinition, UiLayout, UiTheme,
    },
    services::{settings_store::validate_shortcuts, AppState},
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

fn emit_current_settings_changed(
    app: &AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<SettingsSnapshot, String> {
    let snapshot = get_settings_snapshot(state)?;
    emit_settings_changed(app, &snapshot);
    Ok(snapshot)
}

fn normalize_entry_comment_input(comment: &str) -> Option<String> {
    let normalized = comment.trim_end_matches(['\r', '\n']).to_string();
    if normalized.trim().is_empty() {
        None
    } else {
        Some(normalized)
    }
}

#[tauri::command]
pub fn get_settings_snapshot(state: State<'_, Arc<AppState>>) -> Result<SettingsSnapshot, String> {
    let metadata = state
        .metadata
        .read()
        .expect("metadata lock poisoned")
        .clone();
    let settings = state
        .settings
        .read()
        .expect("settings lock poisoned")
        .clone();
    Ok(metadata.to_settings_snapshot(
        settings.layout,
        settings.detail_columns,
        settings.details_row_height,
        settings.tooltip_hover_delay_ms,
        settings.metadata_retention_hours,
        settings.context_menu,
        settings.theme,
    ))
}

#[tauri::command]
pub fn save_bookmark(
    bookmark: Bookmark,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<SettingsSnapshot, String> {
    state
        .metadata
        .write()
        .expect("metadata lock poisoned")
        .upsert_bookmark(bookmark);
    persist_state(state.inner())?;
    emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn delete_bookmark(
    id: String,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<SettingsSnapshot, String> {
    state
        .metadata
        .write()
        .expect("metadata lock poisoned")
        .delete_bookmark(&id);
    persist_state(state.inner())?;
    emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn save_hotlist_entry(
    entry: HotlistEntry,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<SettingsSnapshot, String> {
    state
        .metadata
        .write()
        .expect("metadata lock poisoned")
        .upsert_hotlist(entry);
    persist_state(state.inner())?;
    emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn delete_hotlist_entry(
    id: String,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<SettingsSnapshot, String> {
    state
        .metadata
        .write()
        .expect("metadata lock poisoned")
        .delete_hotlist(&id);
    persist_state(state.inner())?;
    emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn save_navigation_item(
    request: NavigationItemUpsertRequest,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<SettingsSnapshot, String> {
    state
        .metadata
        .write()
        .expect("metadata lock poisoned")
        .upsert_navigation_item(request, chrono::Utc::now, || {
            uuid::Uuid::new_v4().to_string()
        })
        .map_err(|error| error.to_string())?;
    persist_state(state.inner())?;
    emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn delete_navigation_item(
    id: String,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
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
    app: AppHandle,
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
    app: AppHandle,
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
    app: AppHandle,
) -> Result<SettingsSnapshot, String> {
    state
        .metadata
        .write()
        .expect("metadata lock poisoned")
        .upsert_color_rule(rule);
    persist_state(state.inner())?;
    emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn delete_color_rule(
    id: String,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<SettingsSnapshot, String> {
    state
        .metadata
        .write()
        .expect("metadata lock poisoned")
        .delete_color_rule(&id);
    persist_state(state.inner())?;
    emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn save_tag_definition(
    definition: TagDefinition,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<SettingsSnapshot, String> {
    state
        .metadata
        .write()
        .expect("metadata lock poisoned")
        .upsert_tag_definition(definition);
    persist_state(state.inner())?;
    emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn delete_tag_definition(
    id: String,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<SettingsSnapshot, String> {
    state
        .metadata
        .write()
        .expect("metadata lock poisoned")
        .delete_tag_definition(&id);
    persist_state(state.inner())?;
    emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn save_shortcuts(
    shortcuts: Vec<ShortcutBinding>,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<SettingsSnapshot, String> {
    validate_shortcuts(&shortcuts).map_err(|error| error.to_string())?;
    state
        .metadata
        .write()
        .expect("metadata lock poisoned")
        .set_shortcuts(shortcuts);
    persist_state(state.inner())?;
    emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn save_details_row_height(
    details_row_height: u16,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
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
pub fn save_ui_layout(
    layout: UiLayout,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<SettingsSnapshot, String> {
    state
        .settings
        .write()
        .expect("settings lock poisoned")
        .set_layout(layout);
    persist_state(state.inner())?;
    emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn save_ui_theme(
    theme: UiTheme,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<SettingsSnapshot, String> {
    state
        .settings
        .write()
        .expect("settings lock poisoned")
        .set_theme(theme);
    persist_state(state.inner())?;
    emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn save_settings_model(
    model: SettingsModelUpdate,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<SettingsSnapshot, String> {
    validate_shortcuts(&model.shortcuts).map_err(|error| error.to_string())?;
    {
        let mut metadata = state.metadata.write().expect("metadata lock poisoned");
        metadata.set_shortcuts(model.shortcuts);
        metadata.set_color_rules(model.color_rules);
    }
    {
        let mut settings = state.settings.write().expect("settings lock poisoned");
        settings.set_detail_columns(model.columns);
        settings.set_details_row_height(model.details_row_height);
        settings.set_tooltip_hover_delay_ms(model.tooltip_hover_delay_ms);
        settings.set_metadata_retention_hours(model.metadata_retention_hours);
        settings.set_context_menu(model.context_menu);
        settings.set_theme(model.theme);
    }
    persist_state(state.inner())?;
    emit_current_settings_changed(&app, state)
}

#[tauri::command]
pub fn get_entry_comment(
    path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Option<String>, String> {
    let metadata = state.metadata.read().expect("metadata lock poisoned");
    Ok(metadata.comment_for_path(&path))
}

#[tauri::command]
pub fn save_entry_comment(
    path: String,
    comment: String,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<Option<String>, String> {
    let normalized_comment = normalize_entry_comment_input(&comment);
    {
        let mut metadata = state.metadata.write().expect("metadata lock poisoned");
        if let Some(comment) = &normalized_comment {
            metadata.upsert_entry_comment(&path, comment, chrono::Utc::now);
        } else {
            metadata.remove_entry_comment(&path);
        }
    }
    persist_state(state.inner())?;
    let _ = app.emit("entry_metadata_changed", vec![path.clone()]);
    Ok(normalized_comment)
}

#[tauri::command]
pub fn remove_entry_comment(
    path: String,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<(), String> {
    {
        let mut metadata = state.metadata.write().expect("metadata lock poisoned");
        metadata.remove_entry_comment(&path);
    }
    persist_state(state.inner())?;
    let _ = app.emit("entry_metadata_changed", vec![path]);
    Ok(())
}

#[tauri::command]
pub fn mark_entry_metadata_deleted(
    paths: Vec<String>,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<(), String> {
    let retention_hours = state
        .settings
        .read()
        .expect("settings lock poisoned")
        .metadata_retention_hours;
    {
        let mut metadata = state.metadata.write().expect("metadata lock poisoned");
        metadata.mark_entry_metadata_deleted(&paths, retention_hours, chrono::Utc::now);
    }
    persist_state(state.inner())?;
    let _ = app.emit("entry_metadata_changed", paths);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::normalize_entry_comment_input;

    #[test]
    fn whitespace_entry_comment_input_is_treated_as_removal() {
        assert_eq!(normalize_entry_comment_input(""), None);
        assert_eq!(normalize_entry_comment_input("   "), None);
        assert_eq!(normalize_entry_comment_input("\r\n"), None);
        assert_eq!(normalize_entry_comment_input("  \r\n"), None);
    }

    #[test]
    fn entry_comment_input_preserves_meaningful_text_and_trims_terminal_newlines() {
        assert_eq!(
            normalize_entry_comment_input("  keep leading space\nsecond line\r\n"),
            Some("  keep leading space\nsecond line".to_string())
        );
        assert_eq!(
            normalize_entry_comment_input("keep trailing spaces  "),
            Some("keep trailing spaces  ".to_string())
        );
    }
}

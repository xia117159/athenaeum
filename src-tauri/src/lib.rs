mod commands;
mod domain;
mod services;

use std::sync::Arc;

use commands::{
  operations::{
    cancel_file_operation, copy_entries, create_directory, create_file, delete_entries, list_file_operation_tasks,
    list_operation_history, move_entries, rename_entry, resolve_file_operation_conflict, start_file_operation,
    undo_latest_operation, undo_operation
  },
  remote::{
    copy_remote_entries, create_remote_directory, delete_remote_entries, delete_remote_profile, download_remote_entries,
    get_remote_host_key, list_remote_directory, list_remote_profiles, move_remote_entries, rename_remote_entry,
    save_remote_profile, test_remote_profile, transfer_remote_entries, trust_remote_host_key, upload_remote_files
  },
  search::{cancel_search, start_search},
  settings::{
    delete_bookmark, delete_color_rule, delete_hotlist_entry, delete_navigation_item, delete_tag_definition,
    get_settings_snapshot, mark_navigation_item_opened, reorder_navigation_items, save_bookmark, save_color_rule,
    save_details_row_height, save_hotlist_entry, save_navigation_item, save_shortcuts, save_tag_definition,
    save_settings_model, save_ui_layout, save_ui_theme
  },
  workspace::{
    get_item_properties, get_tree_children, initialize_workspace, list_directory, open_path_with_system_default,
    resolve_navigation_targets, resolve_system_icon, show_native_context_menu
  }
};
use services::{metadata_store::MetadataStore, settings_store::SettingsStore, AppState};
use tauri::Manager;

pub fn run() {
  tauri::Builder::default()
    .manage(Arc::new(AppState::new(
      MetadataStore::load_default(),
      SettingsStore::load_default()
    )))
    .setup(|app| {
      let app_handle = app.handle().clone();
      let state = app.state::<Arc<AppState>>().inner().clone();
      state.initialize_paths(&app_handle)?;
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      initialize_workspace,
      list_directory,
      get_item_properties,
      get_tree_children,
      resolve_system_icon,
      copy_entries,
      move_entries,
      delete_entries,
      rename_entry,
      create_directory,
      create_file,
      start_file_operation,
      list_file_operation_tasks,
      cancel_file_operation,
      resolve_file_operation_conflict,
      list_operation_history,
      undo_latest_operation,
      undo_operation,
      start_search,
      cancel_search,
      get_settings_snapshot,
      save_bookmark,
      delete_bookmark,
      save_hotlist_entry,
      delete_hotlist_entry,
      save_navigation_item,
      delete_navigation_item,
      reorder_navigation_items,
      mark_navigation_item_opened,
      save_color_rule,
      delete_color_rule,
      save_tag_definition,
      delete_tag_definition,
      save_shortcuts,
      save_details_row_height,
      save_settings_model,
      save_ui_layout,
      save_ui_theme,
      list_remote_profiles,
      save_remote_profile,
      delete_remote_profile,
      test_remote_profile,
      get_remote_host_key,
      trust_remote_host_key,
      list_remote_directory,
      create_remote_directory,
      delete_remote_entries,
      rename_remote_entry,
      upload_remote_files,
      download_remote_entries,
      copy_remote_entries,
      move_remote_entries,
      transfer_remote_entries,
      resolve_navigation_targets,
      open_path_with_system_default,
      show_native_context_menu
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

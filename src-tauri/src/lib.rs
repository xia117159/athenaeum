mod commands;
mod domain;
mod services;

use std::sync::Arc;

use commands::{
    operations::{
        cancel_file_operation, copy_entries, create_directory, create_file, delete_entries,
        list_file_operation_tasks, list_operation_history, move_entries, rename_entry,
        resolve_file_operation_conflict, start_file_operation, undo_latest_operation,
        undo_operation,
    },
    remote::{
        copy_remote_entries, create_remote_directory, create_remote_file, delete_remote_entries,
        delete_remote_profile, download_remote_entries, get_remote_host_key, list_remote_directory,
        list_remote_profiles, move_remote_entries, rename_remote_entry, save_remote_profile,
        test_remote_profile, transfer_remote_entries, trust_remote_host_key, upload_remote_files,
    },
    search::{cancel_search, start_search},
    settings::{
        delete_bookmark, delete_color_rule, delete_hotlist_entry, delete_navigation_item,
        delete_tag_definition, get_settings_snapshot, mark_navigation_item_opened,
        reorder_navigation_items, save_bookmark, save_color_rule, save_details_row_height,
        save_hotlist_entry, save_navigation_item, save_settings_model, save_shortcuts,
        save_tag_definition, save_ui_layout, save_ui_theme,
    },
    workspace::{
        get_item_properties, get_tree_children, get_windows_drag_drop_environment,
        initialize_workspace, list_directory, open_path_with_system_default,
        perform_system_file_operation, read_system_file_clipboard, resolve_navigation_targets,
        resolve_system_icon, set_system_file_clipboard, show_native_background_context_menu,
        set_workspace_watch_roots, show_native_context_menu, start_system_file_drag,
    },
};
use services::{metadata_store::MetadataStore, settings_store::SettingsStore, AppState};
use tauri::{Manager, WindowEvent};

pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(AppState::new(
            MetadataStore::load_default(),
            SettingsStore::load_default(),
        )))
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { .. } = event {
                    for webview in window.app_handle().webview_windows().values() {
                        if webview.label() != "main" {
                            let _ = webview.close();
                        }
                    }
                }
            }
        })
        .setup(|app| {
            let app_handle = app.handle().clone();
            let state = app.state::<Arc<AppState>>().inner().clone();
            state.initialize_paths(&app_handle)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            initialize_workspace,
            list_directory,
            set_workspace_watch_roots,
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
            create_remote_file,
            delete_remote_entries,
            rename_remote_entry,
            upload_remote_files,
            download_remote_entries,
            copy_remote_entries,
            move_remote_entries,
            transfer_remote_entries,
            resolve_navigation_targets,
            open_path_with_system_default,
            set_system_file_clipboard,
            read_system_file_clipboard,
            get_windows_drag_drop_environment,
            start_system_file_drag,
            perform_system_file_operation,
            show_native_background_context_menu,
            show_native_context_menu
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

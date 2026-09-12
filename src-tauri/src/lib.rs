mod commands;
mod domain;
mod services;

use std::sync::Arc;

use commands::{
    color_filter::{replace_color_rules, set_color_filter_enabled, validate_color_filter_rule},
    directory_sizes::{subscribe_directory_sizes, release_directory_sizes, lookup_directory_sizes},
    file_opening::{open_file, cancel_file_open, inspect_association_programs, choose_association_program},
    operations::{
        cancel_file_operation, clear_operation_records, copy_entries, create_directory,
        create_file, delete_entries, list_file_operation_tasks, list_operation_history,
        move_entries, rename_entry, resolve_file_operation_conflict, start_file_operation,
        undo_latest_operation, undo_operation,
    },
    remote::{
        copy_remote_entries, create_remote_directory, create_remote_file, delete_remote_entries,
        delete_remote_profile, download_remote_entries, get_remote_host_key, list_remote_directory,
        list_remote_profiles, move_remote_entries, rename_remote_entry, save_remote_profile,
        test_remote_profile, transfer_remote_entries, trust_remote_host_key, upload_remote_files,
    },
    search::{cancel_search, start_search},
    settings::{
        delete_bookmark, delete_hotlist_entry, delete_navigation_item, delete_tag_definition,
        get_entry_comment, get_settings_snapshot, mark_entry_metadata_deleted,
        mark_navigation_item_opened, remove_entry_comment, reorder_navigation_items, save_bookmark,
        save_details_row_height, save_entry_comment, save_hotlist_entry, save_navigation_item,
        save_settings_model, save_shortcuts, save_tag_definition, save_ui_layout, save_ui_theme,
    },
    workspace::{
        get_git_status, get_item_properties, get_tree_children, get_windows_drag_drop_environment,
        initialize_workspace, list_directory, list_drive_roots, open_path_with_system_default,
        perform_system_file_operation, read_system_file_clipboard, resolve_navigation_targets,
        resolve_system_icon, set_system_file_clipboard, set_workspace_watch_roots,
        show_native_background_context_menu, show_native_context_menu, start_system_file_drag,
    },
};
use services::{metadata_store::MetadataStore, settings_store::SettingsStore, AppState};
use tauri::{Emitter, Manager, WindowEvent};

pub fn run() {
    let app = tauri::Builder::default()
        .manage(Arc::new(AppState::new(
            MetadataStore::load_default(),
            SettingsStore::load_default(),
        )))
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                let state = window.state::<Arc<AppState>>();
                state.directory_sizes.close_owner(window.label());
                state.file_open_jobs.close_owner(window.label());
                if window.label() == "main" {
                    state.directory_sizes.shutdown();
                    state.file_open_jobs.begin_shutdown();
                }
            }
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
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                webview.state::<Arc<AppState>>().directory_sizes.open_owner(webview.label());
                webview.state::<Arc<AppState>>().file_open_jobs.open_owner(webview.label());
            }
        })
        .setup(|app| {
            let app_handle = app.handle().clone();
            let state = app.state::<Arc<AppState>>().inner().clone();
            state.initialize_paths(&app_handle)?;
            state.directory_sizes.open_owner("main");
            state.file_open_jobs.open_owner("main");

            #[cfg(windows)]
            {
                let main_label = services::webview_recovery::MAIN_WEBVIEW_LABEL;
                if services::webview_recovery::should_install_for_label(main_label) {
                    if let Some(main_webview) = app.get_webview_window(main_label) {
                        services::webview_recovery::install(&main_webview)?;
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            initialize_workspace,
            list_directory,
            subscribe_directory_sizes,
            release_directory_sizes,
            lookup_directory_sizes,
            list_drive_roots,
            set_workspace_watch_roots,
            get_item_properties,
            get_tree_children,
            get_git_status,
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
            clear_operation_records,
            undo_latest_operation,
            undo_operation,
            start_search,
            cancel_search,
            get_settings_snapshot,
            set_color_filter_enabled,
            replace_color_rules,
            validate_color_filter_rule,
            save_bookmark,
            delete_bookmark,
            save_hotlist_entry,
            delete_hotlist_entry,
            save_navigation_item,
            delete_navigation_item,
            reorder_navigation_items,
            mark_navigation_item_opened,
            save_tag_definition,
            delete_tag_definition,
            save_shortcuts,
            save_details_row_height,
            save_settings_model,
            get_entry_comment,
            save_entry_comment,
            remove_entry_comment,
            mark_entry_metadata_deleted,
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
            open_file,
            cancel_file_open,
            inspect_association_programs,
            choose_association_program,
            set_system_file_clipboard,
            read_system_file_clipboard,
            get_windows_drag_drop_environment,
            start_system_file_drag,
            perform_system_file_operation,
            show_native_background_context_menu,
            show_native_context_menu
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");
    // The outer run scope owns the emitter. Managed state and worker threads
    // keep only a Weak reference, so no AppHandle/AppState ownership cycle forms.
    let event_app = app.handle().clone();
    let sink: Arc<services::directory_size::EventSink> = Arc::new(move |owner, snapshot| {
        let _ = event_app.emit_to(owner, "directory_sizes_changed", snapshot);
    });
    app.state::<Arc<AppState>>().directory_sizes.start(Arc::downgrade(&sink));
    let mut waiting_for_file_open_cleanup = false;
    app.run(move |app, event| {
        if let tauri::RunEvent::ExitRequested { api, code, .. } = &event {
            let jobs = app.state::<Arc<AppState>>().file_open_jobs.clone();
            if !jobs.begin_shutdown() && *code != Some(tauri::RESTART_EXIT_CODE) {
                api.prevent_exit();
                if !waiting_for_file_open_cleanup {
                    waiting_for_file_open_cleanup = true;
                    let app = app.clone();
                    let exit_code = code.unwrap_or(0);
                    std::thread::spawn(move || {
                        jobs.shutdown();
                        app.exit(exit_code);
                    });
                }
            }
        }
        if matches!(event, tauri::RunEvent::Exit) {
            let state = app.state::<Arc<AppState>>();
            state.directory_sizes.shutdown();
            state.file_open_jobs.shutdown();
        }
    });
    drop(sink);
}

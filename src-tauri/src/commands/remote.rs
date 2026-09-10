use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::{
    domain::models::{
        EntryViewModel, OperationResult, RemoteCreateDirectoryRequest, RemoteDirectoryRequest,
        RemoteFileOperationRequest, RemoteHostKeyInfo, RemoteProfile, RemoteProfileUpsertRequest,
        RemoteRenameRequest, RemoteTestResult, RemoteTransferOperation, RemoteTransferRequest,
        RemoteTrustHostKeyRequest,
    },
    services::{
        color_filter::{compile_rules, AttributeFacts, CompiledColorRules, EntryFacts},
        remote_service, AppState,
    },
};

fn apply_remote_color_rules(entries: &mut [EntryViewModel], compiled: &CompiledColorRules) {
    for entry in entries {
        let availability = &entry.attribute_availability;
        let style = compiled.style_for(&EntryFacts {
            name: entry.name.clone(),
            path: entry.path.clone(),
            extension: match entry.kind {
                crate::domain::models::EntryKind::Directory => None,
                crate::domain::models::EntryKind::File => Some(
                    entry
                        .extension
                        .as_ref()
                        .map_or_else(String::new, |extension| {
                            if extension.starts_with('.') {
                                extension.clone()
                            } else {
                                format!(".{extension}")
                            }
                        }),
                ),
            },
            kind: entry.kind.clone(),
            size: entry.size,
            created_at: entry.created_at,
            modified_at: entry.modified_at,
            accessed_at: entry.accessed_at,
            attributes: AttributeFacts {
                hidden: availability.hidden.then_some(entry.is_hidden),
                system: availability.system.then_some(entry.is_system),
                protected_system: availability
                    .protected_system
                    .then_some(entry.is_protected_operating_system),
                read_only: availability.read_only.then_some(entry.is_read_only),
                symlink: availability.symlink.then_some(entry.is_symlink),
                archive: availability.archive.then_some(false),
            },
        });
        if let Some(style) = style {
            entry.decoration.foreground_color_hex = style.foreground_color_hex;
            entry.decoration.background_color_hex = style.background_color_hex;
        }
    }
}

fn emit_settings_changed(app: &AppHandle, state: &Arc<AppState>) {
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
    let snapshot = metadata.to_settings_snapshot(
        settings.layout,
        settings.detail_columns,
        settings.navigation_columns,
        settings.details_row_height,
        settings.folder_expansion_enabled,
        settings.tooltip_hover_delay_ms,
        settings.metadata_retention_hours,
        settings.file_visibility,
        settings.context_menu,
        settings.theme,
    );
    let _ = app.emit("settings_changed", snapshot);
}

async fn run_remote_blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("remote operation task failed: {error}"))?
}

#[tauri::command]
pub fn list_remote_profiles(state: State<'_, Arc<AppState>>) -> Result<Vec<RemoteProfile>, String> {
    let profiles = hydrate_remote_profiles(
        state
            .metadata
            .read()
            .expect("metadata lock poisoned")
            .remote_profiles
            .clone(),
    );
    Ok(profiles)
}

#[tauri::command]
pub fn save_remote_profile(
    request: RemoteProfileUpsertRequest,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
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
    let profile =
        remote_service::prepare_profile_for_save(request, existing_credential_target.as_deref())
            .map_err(|error| error.to_string())?;
    {
        let mut metadata = state.metadata.write().expect("metadata lock poisoned");
        metadata.upsert_remote_profile(profile);
        metadata.persist().map_err(|error| error.to_string())?;
    }
    emit_settings_changed(&app, state.inner());
    list_remote_profiles(state)
}

#[tauri::command]
pub fn delete_remote_profile(
    id: String,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<Vec<RemoteProfile>, String> {
    let removed_profile = {
        let mut metadata = state.metadata.write().expect("metadata lock poisoned");
        let removed = metadata.delete_remote_profile(&id);
        metadata.persist().map_err(|error| error.to_string())?;
        removed
    };

    if let Some(profile) = removed_profile.as_ref() {
        remote_service::cleanup_profile_after_delete(profile);
    }

    emit_settings_changed(&app, state.inner());
    list_remote_profiles(state)
}

#[tauri::command]
pub async fn test_remote_profile(
    request: RemoteProfileUpsertRequest,
    state: State<'_, Arc<AppState>>,
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
        remote_service::test_profile(&profile, password.as_deref())
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn get_remote_host_key(
    profile_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<RemoteHostKeyInfo, String> {
    let profile = remote_profile_by_id(&state, &profile_id)?;
    run_remote_blocking(move || {
        remote_service::fetch_host_key_info(&profile).map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn trust_remote_host_key(
    request: RemoteTrustHostKeyRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<RemoteHostKeyInfo, String> {
    let profile = remote_profile_by_id(&state, &request.profile_id)?;
    run_remote_blocking(move || {
        remote_service::trust_host_key(&profile, &request).map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn list_remote_directory(
    request: RemoteDirectoryRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<EntryViewModel>, String> {
    let profile = remote_profile_by_id(&state, &request.profile_id)?;
    let metadata = {
        let mut metadata = state.metadata.write().expect("metadata lock poisoned");
        metadata.cleanup_expired_entry_metadata(chrono::Utc::now);
        metadata.clone()
    };
    let compiled_color_rules = compile_rules(&metadata.color_rules, chrono::Utc::now());
    let password = request.password;
    let path = request.path;
    let profile_for_listing = profile.clone();
    let mut entries = run_remote_blocking(move || {
        remote_service::list_directory(&profile_for_listing, password.as_deref(), path.as_deref())
            .map_err(|error| error.to_string())
    })
    .await?;
    apply_remote_color_rules(&mut entries, &compiled_color_rules);
    for entry in &mut entries {
        let key = remote_entry_uri(&profile, &entry.path);
        entry.comment = metadata.comment_for_path(&key);
    }
    Ok(entries)
}

#[tauri::command]
pub async fn create_remote_directory(
    request: RemoteCreateDirectoryRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<OperationResult, String> {
    let profile = remote_profile_by_id(&state, &request.profile_id)?;
    let password = request.password;
    let parent = request.parent;
    let name = request.name;
    run_remote_blocking(move || {
        let created =
            remote_service::create_directory(&profile, password.as_deref(), &parent, &name)
                .map_err(|error| error.to_string())?;
        Ok(OperationResult {
            affected_paths: vec![created],
        })
    })
    .await
}

#[tauri::command]
pub async fn create_remote_file(
    request: RemoteCreateDirectoryRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<OperationResult, String> {
    let profile = remote_profile_by_id(&state, &request.profile_id)?;
    let password = request.password;
    let parent = request.parent;
    let name = request.name;
    run_remote_blocking(move || {
        let created = remote_service::create_file(&profile, password.as_deref(), &parent, &name)
            .map_err(|error| error.to_string())?;
        Ok(OperationResult {
            affected_paths: vec![created],
        })
    })
    .await
}

#[tauri::command]
pub async fn delete_remote_entries(
    request: RemoteFileOperationRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<OperationResult, String> {
    let profile = remote_profile_by_id(&state, &request.profile_id)?;
    let password = request.password;
    let sources = request.sources;
    run_remote_blocking(move || {
        let deleted = remote_service::delete_entries(&profile, password.as_deref(), &sources)
            .map_err(|error| error.to_string())?;
        Ok(OperationResult {
            affected_paths: deleted,
        })
    })
    .await
}

#[tauri::command]
pub async fn rename_remote_entry(
    request: RemoteRenameRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<OperationResult, String> {
    let profile = remote_profile_by_id(&state, &request.profile_id)?;
    let password = request.password;
    let source = request.source;
    let new_name = request.new_name;
    run_remote_blocking(move || {
        let renamed =
            remote_service::rename_entry(&profile, password.as_deref(), &source, &new_name)
                .map_err(|error| error.to_string())?;
        Ok(OperationResult {
            affected_paths: vec![renamed],
        })
    })
    .await
}

#[tauri::command]
pub async fn upload_remote_files(
    request: RemoteFileOperationRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<OperationResult, String> {
    let profile = remote_profile_by_id(&state, &request.profile_id)?;
    let password = request.password;
    let sources = request.sources;
    let destination = request
        .destination
        .ok_or_else(|| "destination is required for remote upload".to_string())?;
    run_remote_blocking(move || {
        let uploaded =
            remote_service::upload_files(&profile, password.as_deref(), &sources, &destination)
                .map_err(|error| error.to_string())?;
        Ok(OperationResult {
            affected_paths: uploaded,
        })
    })
    .await
}

#[tauri::command]
pub async fn download_remote_entries(
    request: RemoteFileOperationRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<OperationResult, String> {
    let profile = remote_profile_by_id(&state, &request.profile_id)?;
    let password = request.password;
    let sources = request.sources;
    let destination = request
        .destination
        .ok_or_else(|| "destination is required for remote download".to_string())?;
    run_remote_blocking(move || {
        let downloaded =
            remote_service::download_entries(&profile, password.as_deref(), &sources, &destination)
                .map_err(|error| error.to_string())?;
        Ok(OperationResult {
            affected_paths: downloaded,
        })
    })
    .await
}

#[tauri::command]
pub async fn copy_remote_entries(
    request: RemoteFileOperationRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<OperationResult, String> {
    let profile = remote_profile_by_id(&state, &request.profile_id)?;
    let password = request.password;
    let sources = request.sources;
    let destination = request
        .destination
        .ok_or_else(|| "destination is required for remote copy".to_string())?;
    run_remote_blocking(move || {
        let copied =
            remote_service::copy_entries(&profile, password.as_deref(), &sources, &destination)
                .map_err(|error| error.to_string())?;
        Ok(OperationResult {
            affected_paths: copied,
        })
    })
    .await
}

#[tauri::command]
pub async fn move_remote_entries(
    request: RemoteFileOperationRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<OperationResult, String> {
    let profile = remote_profile_by_id(&state, &request.profile_id)?;
    let password = request.password;
    let sources = request.sources;
    let destination = request
        .destination
        .ok_or_else(|| "destination is required for remote move".to_string())?;
    run_remote_blocking(move || {
        let moved =
            remote_service::move_entries(&profile, password.as_deref(), &sources, &destination)
                .map_err(|error| error.to_string())?;
        Ok(OperationResult {
            affected_paths: moved,
        })
    })
    .await
}

#[tauri::command]
pub async fn transfer_remote_entries(
    request: RemoteTransferRequest,
    state: State<'_, Arc<AppState>>,
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
                false,
            ),
            RemoteTransferOperation::Move => remote_service::transfer_entries(
                &source_profile,
                request.source_password.as_deref(),
                &destination_profile,
                request.destination_password.as_deref(),
                &request.sources,
                &request.destination,
                true,
            ),
        }
        .map_err(|error| error.to_string())?;

        Ok(OperationResult {
            affected_paths: transferred,
        })
    })
    .await
}

fn remote_profile_by_id(
    state: &State<'_, Arc<AppState>>,
    id: &str,
) -> Result<RemoteProfile, String> {
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

fn default_remote_port(protocol: &crate::domain::models::LocationKind) -> Option<u16> {
    match protocol {
        crate::domain::models::LocationKind::Ftp => Some(21),
        crate::domain::models::LocationKind::Sftp => Some(22),
        _ => None,
    }
}

fn normalize_remote_uri_path(path: &str) -> String {
    let normalized = path
        .trim()
        .replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    if normalized.is_empty() {
        "/".into()
    } else {
        format!("/{normalized}")
    }
}

fn remote_entry_uri(profile: &RemoteProfile, remote_path: &str) -> String {
    let port = if Some(profile.port) == default_remote_port(&profile.protocol) {
        String::new()
    } else {
        format!(":{}", profile.port)
    };
    format!(
        "{}://{}@{}{}{}",
        match profile.protocol {
            crate::domain::models::LocationKind::Ftp => "ftp",
            crate::domain::models::LocationKind::Sftp => "sftp",
            _ => "remote",
        },
        profile.username,
        profile.host.to_lowercase(),
        port,
        normalize_remote_uri_path(remote_path)
    )
}

pub fn hydrate_remote_profiles(profiles: Vec<RemoteProfile>) -> Vec<RemoteProfile> {
    profiles
        .into_iter()
        .map(|profile| {
            let mut hydrated = profile.clone();
            if let Some(credential_target) = &profile.credential_target {
                if let Some(password) =
                    remote_service::read_password_from_credential(credential_target)
                {
                    hydrated.password = Some(password);
                }
            }
            hydrated
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{apply_remote_color_rules, remote_entry_uri, run_remote_blocking};
    use crate::domain::{
        color_filter::{ColorRule, ColorRuleTarget},
        models::{
            EntryAttributeAvailability, EntryDecoration, EntryKind, EntryViewModel,
            LocationDescriptor, LocationKind, RemoteAuthKind, RemoteProfile,
        },
    };
    use chrono::{TimeZone, Utc};

    #[test]
    fn remote_blocking_runner_executes_work_on_background_thread() {
        let caller_thread = std::thread::current().id();
        let worker_thread = tauri::async_runtime::block_on(run_remote_blocking(move || {
            Ok::<_, String>(std::thread::current().id())
        }))
        .expect("blocking work should finish");

        assert_ne!(worker_thread, caller_thread);
    }

    #[test]
    fn remote_entry_uri_normalizes_host_but_preserves_username_and_path_case() {
        let profile = RemoteProfile {
            id: "remote-1".into(),
            name: "Edge".into(),
            protocol: LocationKind::Sftp,
            host: "Edge-01.Internal".into(),
            port: 22,
            username: "DeployUser".into(),
            root_path: "/".into(),
            auth_kind: RemoteAuthKind::Password,
            private_key_path: None,
            passive_mode: true,
            ignore_host_key: false,
            connect_timeout_secs: 10,
            command_timeout_secs: 20,
            credential_target: None,
            password: None,
        };

        assert_eq!(
            remote_entry_uri(&profile, "/Releases/Report.TXT"),
            "sftp://DeployUser@edge-01.internal/Releases/Report.TXT"
        );
    }

    #[test]
    fn remote_coloring_preserves_unknown_sftp_permission_facts() {
        let mut entries = vec![EntryViewModel {
            path: "/report.txt".into(),
            name: "report.txt".into(),
            extension: Some("txt".into()),
            kind: EntryKind::File,
            size: Some(32),
            created_at: None,
            modified_at: None,
            accessed_at: None,
            is_hidden: false,
            is_system: false,
            is_protected_operating_system: false,
            is_read_only: false,
            is_symlink: false,
            location: LocationDescriptor {
                kind: LocationKind::Sftp,
                path: "/report.txt".into(),
                connection_id: Some("remote-1".into()),
            },
            decoration: EntryDecoration::default(),
            comment: None,
            attribute_availability: EntryAttributeAvailability {
                hidden: true,
                ..Default::default()
            },
        }];
        let rules = vec![ColorRule {
            schema_version: 2,
            id: "unknown-readonly".into(),
            name: "Unknown readonly".into(),
            enabled: true,
            target: ColorRuleTarget::Any,
            expression: "Attributes NOT HAS ReadOnly".into(),
            case_sensitive: false,
            foreground_color_hex: Some("#ffffff".into()),
            background_color_hex: Some("#a4262c".into()),
            priority: 1,
            migration_diagnostic: None,
            migration_source: None,
        }];

        let compiled = crate::services::color_filter::compile_rules(
            &rules,
            Utc.with_ymd_and_hms(2026, 9, 7, 8, 0, 0).unwrap(),
        );
        apply_remote_color_rules(&mut entries, &compiled);

        assert_eq!(entries[0].decoration.foreground_color_hex, None);
        assert_eq!(entries[0].decoration.background_color_hex, None);
    }

    #[test]
    fn remote_coloring_uses_the_compiled_request_clock() {
        let now = Utc.with_ymd_and_hms(2026, 9, 7, 8, 0, 0).unwrap();
        let mut entries = vec![EntryViewModel {
            path: "/report.txt".into(),
            name: "report.txt".into(),
            extension: Some("txt".into()),
            kind: EntryKind::File,
            size: Some(32),
            created_at: None,
            modified_at: Some(now - chrono::Duration::hours(23)),
            accessed_at: None,
            is_hidden: false,
            is_system: false,
            is_protected_operating_system: false,
            is_read_only: false,
            is_symlink: false,
            location: LocationDescriptor {
                kind: LocationKind::Sftp,
                path: "/report.txt".into(),
                connection_id: Some("remote-1".into()),
            },
            decoration: EntryDecoration::default(),
            comment: None,
            attribute_availability: EntryAttributeAvailability {
                hidden: true,
                ..Default::default()
            },
        }];
        let rules = vec![ColorRule {
            schema_version: 2,
            id: "age".into(),
            name: "Age".into(),
            enabled: true,
            target: ColorRuleTarget::Any,
            expression: "Age >= 1d".into(),
            case_sensitive: false,
            foreground_color_hex: Some("#ffffff".into()),
            background_color_hex: None,
            priority: 1,
            migration_diagnostic: None,
            migration_source: None,
        }];
        let compiled = crate::services::color_filter::compile_rules(&rules, now);

        apply_remote_color_rules(&mut entries, &compiled);

        assert_eq!(entries[0].decoration.foreground_color_hex, None);
    }

    #[test]
    fn remote_extensionless_files_match_the_known_empty_extension() {
        for name in ["README", ".gitignore", "name."] {
            let mut entries = vec![EntryViewModel {
                path: format!("/{name}"),
                name: name.into(),
                extension: None,
                kind: EntryKind::File,
                size: Some(1),
                created_at: None,
                modified_at: None,
                accessed_at: None,
                is_hidden: name.starts_with('.'),
                is_system: false,
                is_protected_operating_system: false,
                is_read_only: false,
                is_symlink: false,
                location: LocationDescriptor {
                    kind: LocationKind::Sftp,
                    path: format!("/{name}"),
                    connection_id: Some("remote-1".into()),
                },
                decoration: EntryDecoration::default(),
                comment: None,
                attribute_availability: EntryAttributeAvailability {
                    hidden: true,
                    ..Default::default()
                },
            }];
            let rules = vec![ColorRule {
                schema_version: 2,
                id: "no-extension".into(),
                name: "No extension".into(),
                enabled: true,
                target: ColorRuleTarget::File,
                expression: "Extension == \"\"".into(),
                case_sensitive: false,
                foreground_color_hex: Some("#123456".into()),
                background_color_hex: None,
                priority: 1,
                migration_diagnostic: None,
                migration_source: None,
            }];
            let compiled = crate::services::color_filter::compile_rules(&rules, Utc::now());

            apply_remote_color_rules(&mut entries, &compiled);

            assert_eq!(
                entries[0].decoration.foreground_color_hex.as_deref(),
                Some("#123456"),
                "{name} should expose a known empty extension"
            );
        }
    }
}

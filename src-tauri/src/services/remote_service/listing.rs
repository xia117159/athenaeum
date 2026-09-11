use std::path::PathBuf;

use chrono::{TimeZone, Utc};

use crate::domain::models::{
    EntryAttributeAvailability, EntryDecoration, EntryKind, EntryViewModel, LocationDescriptor,
    RemoteProfile,
};

use super::{join_remote_path, normalize_remote_path, remote_file_name};

fn remote_extension(name: &str, is_directory: bool) -> Option<String> {
    if is_directory {
        return None;
    }
    let (stem, extension) = name.rsplit_once('.')?;
    (!stem.is_empty() && !extension.is_empty()).then(|| extension.to_string())
}

pub(super) fn parse_listing_entries(
    profile: &RemoteProfile,
    path: Option<&str>,
    stdout: &[u8],
) -> Vec<EntryViewModel> {
    let base_path = normalize_remote_path(path.unwrap_or(&profile.root_path));
    String::from_utf8_lossy(stdout)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let trimmed = line.trim();
            let is_directory = trimmed.ends_with('/');
            let name = trimmed.trim_end_matches('/').to_string();
            let remote_path = join_remote_path(&base_path, &name);
            let extension = remote_extension(&name, is_directory);
            EntryViewModel {
                path: remote_path.clone(),
                name,
                extension,
                kind: if is_directory {
                    EntryKind::Directory
                } else {
                    EntryKind::File
                },
                size: None,
                created_at: None,
                modified_at: None,
                accessed_at: None,
                is_hidden: false,
                is_system: false,
                is_protected_operating_system: false,
                is_read_only: false,
                is_symlink: false,
                location: LocationDescriptor {
                    kind: profile.protocol.clone(),
                    path: remote_path,
                    connection_id: Some(profile.id.clone()),
                },
                decoration: EntryDecoration::default(),
                comment: None,
                attribute_availability: EntryAttributeAvailability {
                    hidden: false,
                    ..Default::default()
                },
            }
        })
        .collect()
}

pub(super) fn parse_sftp_entries(
    profile: &RemoteProfile,
    base_path: &str,
    entries: Vec<(PathBuf, ssh2::FileStat)>,
) -> Vec<EntryViewModel> {
    let mut mapped = entries
        .into_iter()
        .filter_map(|(path, stat)| {
            let name = path
                .file_name()
                .and_then(|value| value.to_str())?
                .to_string();
            if name == "." || name == ".." {
                return None;
            }
            let remote_path = join_remote_path(base_path, &name);
            let is_directory = stat.is_dir();
            let permissions_available = stat.perm.is_some();
            let extension = remote_extension(&name, is_directory);
            Some(EntryViewModel {
                path: remote_path.clone(),
                name,
                extension,
                kind: if is_directory {
                    EntryKind::Directory
                } else {
                    EntryKind::File
                },
                size: if let crate::services::directory_size::metadata::MetadataKind::File(bytes) = super::size_metadata::sftp_metadata_kind(&stat) { Some(bytes) } else { None },
                created_at: None,
                modified_at: stat
                    .mtime
                    .and_then(|seconds| Utc.timestamp_opt(seconds as i64, 0).single()),
                accessed_at: stat
                    .atime
                    .and_then(|seconds| Utc.timestamp_opt(seconds as i64, 0).single()),
                is_hidden: remote_file_name(&remote_path)
                    .map(|value| value.starts_with('.'))
                    .unwrap_or(false),
                is_system: false,
                is_protected_operating_system: false,
                is_read_only: stat.perm.map(|perm| perm & 0o200 == 0).unwrap_or(false),
                is_symlink: stat.file_type().is_symlink(),
                location: LocationDescriptor {
                    kind: profile.protocol.clone(),
                    path: remote_path,
                    connection_id: Some(profile.id.clone()),
                },
                decoration: EntryDecoration::default(),
                comment: None,
                attribute_availability: EntryAttributeAvailability {
                    hidden: true,
                    read_only: permissions_available,
                    symlink: permissions_available,
                    ..Default::default()
                },
            })
        })
        .collect::<Vec<_>>();

    mapped.sort_by(|left, right| match (&left.kind, &right.kind) {
        (EntryKind::Directory, EntryKind::File) => std::cmp::Ordering::Less,
        (EntryKind::File, EntryKind::Directory) => std::cmp::Ordering::Greater,
        _ => left.name.to_lowercase().cmp(&right.name.to_lowercase()),
    });
    mapped
}

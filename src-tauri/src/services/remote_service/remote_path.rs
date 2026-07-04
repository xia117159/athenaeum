use std::{
    env, fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Context, Result};
use ssh2::Sftp;

use crate::domain::models::{LocationKind, RemoteProfile};

pub(super) fn build_url(profile: &RemoteProfile, path: Option<&str>) -> String {
    let scheme = match profile.protocol {
        LocationKind::Ftp => "ftp",
        LocationKind::Sftp => "sftp",
        LocationKind::Local => "file",
    };
    let remote_path = normalize_remote_path(path.unwrap_or(&profile.root_path));
    let suffix = encode_remote_url_path(&remote_path);
    if suffix.is_empty() {
        format!("{scheme}://{}:{}/", profile.host, profile.port)
    } else {
        format!("{scheme}://{}:{}/{}", profile.host, profile.port, suffix)
    }
}

pub(super) fn encode_remote_url_path(path: &str) -> String {
    normalize_remote_path(path)
        .trim_start_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(percent_encode_path_segment)
        .collect::<Vec<_>>()
        .join("/")
}

fn percent_encode_path_segment(segment: &str) -> String {
    let mut encoded = String::new();
    for byte in segment.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(*byte as char)
            }
            value => encoded.push_str(&format!("%{value:02X}")),
        }
    }
    encoded
}

pub(super) fn normalize_remote_path(path: &str) -> String {
    let normalized = path
        .trim()
        .replace('\\', "/")
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    if normalized.is_empty() {
        "/".to_string()
    } else {
        format!("/{normalized}")
    }
}

pub(super) fn validate_remote_entry_name(name: &str) -> Result<()> {
    let candidate = name.trim();
    if candidate.is_empty() {
        bail!("remote entry name cannot be empty");
    }
    if candidate == "." || candidate == ".." {
        bail!("remote entry name must not be a dot segment");
    }
    if candidate.contains('/') || candidate.contains('\\') {
        bail!("remote entry name must not include path separators");
    }
    if candidate.chars().any(|character| character.is_control()) {
        bail!("remote entry name must not include control characters");
    }
    Ok(())
}

pub(super) fn validate_remote_path(path: &str) -> Result<()> {
    if path.chars().any(|character| character.is_control()) {
        bail!("remote path must not include control characters");
    }

    for segment in path
        .replace('\\', "/")
        .split('/')
        .filter(|segment| !segment.is_empty())
    {
        if segment == "." || segment == ".." {
            bail!("remote path must not include dot segments");
        }
    }

    Ok(())
}

pub(super) fn remote_path_is_within_root(profile: &RemoteProfile, path: &str) -> bool {
    let root = normalize_remote_path(&profile.root_path);
    let path = normalize_remote_path(path);
    root == "/" || path == root || path.starts_with(&format!("{}/", root.trim_end_matches('/')))
}

pub(super) fn validate_remote_path_within_root(profile: &RemoteProfile, path: &str) -> Result<()> {
    validate_remote_path(path)?;
    if !remote_path_is_within_root(profile, path) {
        bail!("remote path must be within the profile root");
    }
    Ok(())
}

pub(super) fn validate_remote_operation_source(profile: &RemoteProfile, path: &str) -> Result<()> {
    validate_remote_path_within_root(profile, path)?;
    let normalized = normalize_remote_path(path);
    if normalized == normalize_remote_path(&profile.root_path) {
        bail!("remote profile root cannot be used as a file operation source");
    }
    Ok(())
}

pub(super) fn remote_parent_path(path: &str) -> Option<String> {
    let normalized = normalize_remote_path(path);
    if normalized == "/" {
        return None;
    }
    let trimmed = normalized.trim_end_matches('/');
    let index = trimmed.rfind('/')?;
    if index == 0 {
        Some("/".to_string())
    } else {
        Some(trimmed[..index].to_string())
    }
}

pub(super) fn remote_file_name(path: &str) -> Option<String> {
    normalize_remote_path(path)
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .map(ToOwned::to_owned)
        .filter(|value| !value.is_empty())
}

pub(super) fn available_remote_conflict_path<F>(destination: &str, exists: F) -> String
where
    F: Fn(&str) -> bool,
{
    let destination = normalize_remote_path(destination);
    if !exists(&destination) {
        return destination;
    }

    let parent = remote_parent_path(&destination).unwrap_or_else(|| "/".to_string());
    let file_name = remote_file_name(&destination).unwrap_or_else(|| "item".to_string());
    let (stem, extension) = split_remote_file_name(&file_name);
    for index in 1.. {
        let candidate_name = match extension {
            Some(extension) if !extension.is_empty() => format!("{stem} ({index}).{extension}"),
            _ => format!("{stem} ({index})"),
        };
        let candidate = join_remote_path(&parent, &candidate_name);
        if !exists(&candidate) {
            return candidate;
        }
    }

    unreachable!("conflict index iteration is unbounded")
}

pub(super) fn split_remote_file_name(file_name: &str) -> (&str, Option<&str>) {
    match file_name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, Some(extension)),
        _ => (file_name, None),
    }
}

pub(super) fn available_sftp_conflict_path(sftp: &Sftp, destination: &str) -> String {
    available_remote_conflict_path(destination, |candidate| {
        sftp.lstat(Path::new(candidate)).is_ok()
    })
}

pub(super) fn available_local_conflict_path(destination: &Path) -> PathBuf {
    if !destination.exists() {
        return destination.to_path_buf();
    }

    let parent = destination.parent().unwrap_or_else(|| Path::new(""));
    let stem = destination
        .file_stem()
        .and_then(|value| value.to_str())
        .or_else(|| destination.file_name().and_then(|value| value.to_str()))
        .unwrap_or("item");
    let extension = destination.extension().and_then(|value| value.to_str());
    for index in 1.. {
        let file_name = match extension {
            Some(extension) if !extension.is_empty() => format!("{stem} ({index}).{extension}"),
            _ => format!("{stem} ({index})"),
        };
        let candidate = parent.join(file_name);
        if !candidate.exists() {
            return candidate;
        }
    }

    unreachable!("conflict index iteration is unbounded")
}

pub(super) fn create_remote_transfer_temp_dir() -> Result<PathBuf> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path = env::temp_dir().join(format!(
        "sfm-remote-transfer-{}-{nanos}",
        std::process::id()
    ));
    fs::create_dir_all(&path).with_context(|| {
        format!(
            "failed to create remote transfer temp directory {}",
            path.display()
        )
    })?;
    Ok(path)
}

pub(super) fn ensure_remote_not_inside_source(source: &str, destination: &str) -> Result<()> {
    let source = normalize_remote_path(source);
    let destination = normalize_remote_path(destination);
    if destination == source
        || destination.starts_with(&format!("{}/", source.trim_end_matches('/')))
    {
        bail!("remote destination must not be inside the source path");
    }
    Ok(())
}

pub(super) fn join_remote_path(base_path: &str, name: &str) -> String {
    if base_path == "/" {
        format!("/{}", name.trim_start_matches('/'))
    } else {
        format!(
            "{}/{}",
            base_path.trim_end_matches('/'),
            name.trim_start_matches('/')
        )
    }
}

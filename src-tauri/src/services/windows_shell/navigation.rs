use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationOpenValidationError {
    InvalidPath,
    UnsupportedRemote,
    Missing,
    PermissionDenied,
    Unknown,
}

pub(super) fn is_remote_path(path: &str) -> bool {
    let lowered = path.to_ascii_lowercase();
    lowered.starts_with("ftp://") || lowered.starts_with("sftp://")
}

pub(super) fn has_unsupported_url_scheme(path: &str) -> bool {
    let Some(index) = path.find(':') else {
        return false;
    };
    if index == 1 && path.as_bytes()[0].is_ascii_alphabetic() {
        return false;
    }
    path[..index]
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.'))
}

pub(super) fn normalize_local_path(path: &Path) -> String {
    let mut rendered = path.to_string_lossy().replace('/', "\\");
    while rendered.len() > 3 && rendered.ends_with('\\') {
        rendered.pop();
    }
    rendered
}

pub(super) fn path_display_name(path: &Path, fallback: &str) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| fallback.trim().to_string())
}

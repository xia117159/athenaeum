use std::process::Command;

use crate::domain::models::{LocationKind, RemoteProfile};

use super::{CurlRemoteAdapter, RemoteAdapter, SftpRemoteAdapter, UnsupportedRemoteAdapter};

pub(super) fn select_adapter(profile: &RemoteProfile) -> Box<dyn RemoteAdapter + Send + Sync> {
    match profile.protocol {
        LocationKind::Sftp => Box::new(SftpRemoteAdapter),
        LocationKind::Ftp if preferred_curl_executable().is_some() => Box::new(CurlRemoteAdapter),
        _ => Box::new(UnsupportedRemoteAdapter),
    }
}

pub(super) fn preferred_curl_executable() -> Option<&'static str> {
    if cfg!(target_os = "windows") && Command::new("curl.exe").arg("--version").output().is_ok() {
        Some("curl.exe")
    } else if Command::new("curl").arg("--version").output().is_ok() {
        Some("curl")
    } else {
        None
    }
}

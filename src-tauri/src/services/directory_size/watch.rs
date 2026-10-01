use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RootIdentity(pub [u64; 4]);

#[cfg(windows)]
pub(crate) fn read_root_identity(path: &Path) -> Result<RootIdentity, String> {
    use windows::Win32::{Foundation::CloseHandle, Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    }};
    let path = windows_core::HSTRING::from(path.as_os_str());
    let handle = unsafe { CreateFileW(&path, FILE_READ_ATTRIBUTES.0,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, None, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, None) }
        .map_err(|_| "无法校验目录身份".to_owned())?;
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    let result = unsafe { GetFileInformationByHandle(handle, &mut information) };
    let _ = unsafe { CloseHandle(handle) };
    result.map_err(|_| "无法读取目录身份".to_owned())?;
    if information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 == 0 ||
        information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        return Err("大小统计不跟随链接，目标必须是普通目录".into());
    }
    Ok(RootIdentity([
        u64::from(information.dwVolumeSerialNumber),
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
        (u64::from(information.ftCreationTime.dwHighDateTime) << 32) | u64::from(information.ftCreationTime.dwLowDateTime),
        0,
    ]))
}

#[cfg(unix)]
pub(crate) fn read_root_identity(path: &Path) -> Result<RootIdentity, String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "无法校验目录身份".to_owned())?;
    if super::local::local_metadata_kind(&metadata) != super::metadata::MetadataKind::Directory {
        return Err("大小统计不跟随链接，目标必须是普通目录".into());
    }
    let created = metadata.created().ok().and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok()).unwrap_or_default();
    Ok(RootIdentity([metadata.dev(), metadata.ino(), created.as_secs(), u64::from(created.subsec_nanos())]))
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn read_root_identity(_path: &Path) -> Result<RootIdentity, String> { Err("此平台无法校验目录身份".into()) }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WatchPoll { Quiet, Changed, Lost }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ChangeKind { Added, Removed, Modified, RenameOld, RenameNew }
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WatchEvent { pub path: String, pub kind: ChangeKind }
#[derive(Debug, Default)]
pub(crate) struct WatchChanges {
    pub events: Vec<WatchEvent>, pub lost: bool, pub watermark: u64, pub drained_ticket: u64,
}

#[cfg(windows)]
#[path = "watch_native.rs"]
mod native;
#[cfg(windows)]
pub(crate) use native::RecursiveWatch;

#[cfg(not(windows))]
#[derive(Debug)]
pub(crate) struct RecursiveWatch;
#[cfg(not(windows))]
impl RecursiveWatch {
    pub fn open(_path: &str) -> Option<Self> { None }
    pub fn take_changes(&mut self) -> WatchChanges { WatchChanges { lost: true, ..Default::default() } }
    pub fn epoch(&self) -> u64 { 0 }
    pub fn request_drain(&self) -> u64 { 0 }
    pub fn drain_handle(&self) -> Self { Self }
    pub fn wait(&self) -> bool { false }
}
impl RecursiveWatch {
    pub fn poll(&mut self) -> WatchPoll {
        let changes = self.take_changes();
        if changes.lost { WatchPoll::Lost } else if changes.events.is_empty() { WatchPoll::Quiet } else { WatchPoll::Changed }
    }
}

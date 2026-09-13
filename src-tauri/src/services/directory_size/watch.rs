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

#[derive(Debug)]
pub(crate) struct RecursiveWatch {
    // Native change handles may move between threads; only the owning service
    // coordinator polls them. Store the value, not a borrowed pointer.
    #[cfg(windows)]
    handle: isize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WatchPoll { Quiet, Changed, Lost }

impl RecursiveWatch {
    #[cfg(windows)]
    pub fn open(path: &str) -> Option<Self> {
        use windows::Win32::Storage::FileSystem::{FindFirstChangeNotificationW,
            FILE_NOTIFY_CHANGE_ATTRIBUTES, FILE_NOTIFY_CHANGE_CREATION, FILE_NOTIFY_CHANGE_DIR_NAME,
            FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SECURITY, FILE_NOTIFY_CHANGE_SIZE};
        let filter = FILE_NOTIFY_CHANGE_ATTRIBUTES | FILE_NOTIFY_CHANGE_CREATION | FILE_NOTIFY_CHANGE_DIR_NAME |
            FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_LAST_WRITE | FILE_NOTIFY_CHANGE_SECURITY | FILE_NOTIFY_CHANGE_SIZE;
        let handle = unsafe { FindFirstChangeNotificationW(&windows_core::HSTRING::from(path), true, filter) }.ok()?;
        Some(Self { handle: handle.0 as isize })
    }

    #[cfg(windows)]
    pub fn poll(&mut self) -> WatchPoll {
        use windows::Win32::{Foundation::{HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
            Storage::FileSystem::FindNextChangeNotification, System::Threading::WaitForSingleObject};
        let handle = HANDLE(self.handle as *mut _);
        match unsafe { WaitForSingleObject(handle, 0) } {
            WAIT_TIMEOUT => WatchPoll::Quiet,
            WAIT_OBJECT_0 => if unsafe { FindNextChangeNotification(handle) }.is_ok() { WatchPoll::Changed } else { WatchPoll::Lost },
            _ => WatchPoll::Lost,
        }
    }

    #[cfg(not(windows))]
    pub fn open(_path: &str) -> Option<Self> { None }
    #[cfg(not(windows))]
    pub fn poll(&mut self) -> WatchPoll { WatchPoll::Lost }
}

#[cfg(windows)]
impl Drop for RecursiveWatch {
    fn drop(&mut self) {
        let _ = unsafe { windows::Win32::Storage::FileSystem::FindCloseChangeNotification(
            windows::Win32::Foundation::HANDLE(self.handle as *mut _)) };
    }
}

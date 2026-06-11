#[cfg(windows)]
mod imp {
  use std::{
    ffi::OsStr,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    ptr::null_mut
  };

  use anyhow::{anyhow, bail, Context, Result};
  use crate::domain::models::{NavigationTargetInfo, NavigationTargetKind, NavigationTargetStatus};
  use tauri::{Runtime, Window};
  use windows::{
    core::{PCSTR, PCWSTR},
    Win32::{
      Foundation::{GetLastError, SetLastError, ERROR_SUCCESS, HWND, LPARAM, POINT, WIN32_ERROR, WPARAM},
      System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE},
      UI::{
        Shell::{
          Common::ITEMIDLIST, CMINVOKECOMMANDINFO, CMF_NORMAL, IContextMenu, ILFree, IShellFolder,
          SHBindToParent, SHParseDisplayName, ShellExecuteW
        },
        WindowsAndMessaging::{
          CreatePopupMenu, DestroyMenu, GetCursorPos, PostMessageW, SetForegroundWindow, TrackPopupMenuEx,
          HMENU, TPM_RETURNCMD, TPM_RIGHTBUTTON, SW_SHOWNORMAL, WM_NULL
        }
      }
    }
  };

  const CMD_FIRST: u32 = 1;
  const CMD_LAST: u32 = 0x7FFF;

  #[derive(Debug, Clone, Copy, PartialEq, Eq)]
  pub enum NavigationOpenValidationError {
    InvalidPath,
    UnsupportedRemote,
    Missing,
    PermissionDenied,
    Unknown
  }

  fn is_remote_path(path: &str) -> bool {
    let lowered = path.to_ascii_lowercase();
    lowered.starts_with("ftp://") || lowered.starts_with("sftp://")
  }

  fn has_unsupported_url_scheme(path: &str) -> bool {
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

  fn normalize_local_path(path: &Path) -> String {
    let mut rendered = path.to_string_lossy().replace('/', "\\");
    while rendered.len() > 3 && rendered.ends_with('\\') {
      rendered.pop();
    }
    rendered
  }

  fn path_display_name(path: &Path, fallback: &str) -> String {
    path
      .file_name()
      .and_then(|name| name.to_str())
      .filter(|name| !name.trim().is_empty())
      .map(ToOwned::to_owned)
      .unwrap_or_else(|| fallback.trim().to_string())
  }

  fn invalid_target_info(raw: &str, message: impl Into<String>) -> NavigationTargetInfo {
    NavigationTargetInfo {
      path: raw.trim().to_string(),
      normalized_path: None,
      canonical_path: None,
      display_name: raw.trim().to_string(),
      target_kind: NavigationTargetKind::Unknown,
      target_status: NavigationTargetStatus::InvalidPath,
      message: Some(message.into()),
      exists: false,
      is_local: false,
      parent_path: None
    }
  }

  fn remote_unsupported_target_info(raw: &str) -> NavigationTargetInfo {
    NavigationTargetInfo {
      path: raw.trim().to_string(),
      normalized_path: None,
      canonical_path: None,
      display_name: raw.trim().to_string(),
      target_kind: NavigationTargetKind::RemoteUnsupported,
      target_status: NavigationTargetStatus::UnsupportedRemote,
      message: Some("remote navigation targets are not supported by Windows shell operations yet".into()),
      exists: false,
      is_local: false,
      parent_path: None
    }
  }

  pub fn resolve_navigation_target(raw: &str) -> Result<NavigationTargetInfo> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
      return Ok(invalid_target_info(raw, "path is empty"));
    }
    if is_remote_path(trimmed) {
      return Ok(remote_unsupported_target_info(raw));
    }
    if has_unsupported_url_scheme(trimmed) {
      return Ok(invalid_target_info(raw, "URL schemes are not supported as navigation targets"));
    }

    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
      return Ok(invalid_target_info(raw, "navigation target must be an absolute local path"));
    }

    let normalized_path = normalize_local_path(&path);
    let parent_path = path.parent().map(normalize_local_path);
    let display_name = path_display_name(&path, &normalized_path);

    match std::fs::symlink_metadata(&path) {
      Ok(metadata) => {
        let canonical_path = std::fs::canonicalize(&path).ok().map(|item| normalize_local_path(&item));
        Ok(NavigationTargetInfo {
          path: trimmed.to_string(),
          normalized_path: Some(normalized_path),
          canonical_path,
          display_name,
          target_kind: if metadata.is_dir() {
            NavigationTargetKind::Folder
          } else if metadata.is_file() {
            NavigationTargetKind::File
          } else {
            NavigationTargetKind::Unknown
          },
          target_status: NavigationTargetStatus::Ok,
          message: None,
          exists: true,
          is_local: true,
          parent_path
        })
      }
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(NavigationTargetInfo {
        path: trimmed.to_string(),
        normalized_path: Some(normalized_path),
        canonical_path: None,
        display_name,
        target_kind: NavigationTargetKind::Missing,
        target_status: NavigationTargetStatus::Missing,
        message: Some("path is missing or currently inaccessible".into()),
        exists: false,
        is_local: true,
        parent_path
      }),
      Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => Ok(NavigationTargetInfo {
        path: trimmed.to_string(),
        normalized_path: Some(normalized_path),
        canonical_path: None,
        display_name,
        target_kind: NavigationTargetKind::Unknown,
        target_status: NavigationTargetStatus::PermissionDenied,
        message: Some(error.to_string()),
        exists: false,
        is_local: true,
        parent_path
      }),
      Err(error) => Ok(NavigationTargetInfo {
        path: trimmed.to_string(),
        normalized_path: Some(normalized_path),
        canonical_path: None,
        display_name,
        target_kind: NavigationTargetKind::Unknown,
        target_status: NavigationTargetStatus::UnknownError,
        message: Some(error.to_string()),
        exists: false,
        is_local: true,
        parent_path
      })
    }
  }

  pub fn validate_system_default_open_path(path: &str) -> std::result::Result<PathBuf, NavigationOpenValidationError> {
    let info = resolve_navigation_target(path).map_err(|_| NavigationOpenValidationError::Unknown)?;
    match info.target_status {
      NavigationTargetStatus::Ok => info
        .normalized_path
        .map(PathBuf::from)
        .ok_or(NavigationOpenValidationError::InvalidPath),
      NavigationTargetStatus::UnsupportedRemote => Err(NavigationOpenValidationError::UnsupportedRemote),
      NavigationTargetStatus::Missing => Err(NavigationOpenValidationError::Missing),
      NavigationTargetStatus::PermissionDenied => Err(NavigationOpenValidationError::PermissionDenied),
      NavigationTargetStatus::InvalidPath => Err(NavigationOpenValidationError::InvalidPath),
      NavigationTargetStatus::UnknownError => Err(NavigationOpenValidationError::Unknown)
    }
  }

  fn wide_null(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
  }

  fn shell_execute_error_message(code: isize) -> String {
    match code {
      0 => "system default open failed: out of memory or resources".into(),
      2 => "file was not found".into(),
      3 => "path was not found".into(),
      5 => "access was denied".into(),
      31 => "no application is associated with this file type".into(),
      _ => format!("system default open failed with ShellExecuteW code {code}")
    }
  }

  fn validate_shell_execute_result(code: isize) -> Result<()> {
    if code <= 32 {
      bail!(shell_execute_error_message(code));
    }
    Ok(())
  }

  pub fn open_path_with_system_default(path: String) -> Result<()> {
    let target = validate_system_default_open_path(&path).map_err(|error| match error {
      NavigationOpenValidationError::InvalidPath => anyhow!("path must be an absolute local file system path"),
      NavigationOpenValidationError::UnsupportedRemote => anyhow!("remote targets are not supported by system default open"),
      NavigationOpenValidationError::Missing => anyhow!("path does not exist"),
      NavigationOpenValidationError::PermissionDenied => anyhow!("access was denied"),
      NavigationOpenValidationError::Unknown => anyhow!("path could not be opened")
    })?;
    let operation = wide_null(OsStr::new("open"));
    let file = wide_null(target.as_os_str());
    let directory = target
      .parent()
      .map(|parent| wide_null(parent.as_os_str()))
      .unwrap_or_else(|| wide_null(OsStr::new("")));

    let result = unsafe {
      ShellExecuteW(
        None,
        PCWSTR(operation.as_ptr()),
        PCWSTR(file.as_ptr()),
        PCWSTR::null(),
        PCWSTR(directory.as_ptr()),
        SW_SHOWNORMAL
      )
    };
    let code = result.0 as isize;
    validate_shell_execute_result(code)
  }

  struct ComGuard;

  impl ComGuard {
    fn init() -> Result<Self> {
      unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE)
          .ok()
          .context("failed to initialize COM apartment")?;
      }
      Ok(Self)
    }
  }

  impl Drop for ComGuard {
    fn drop(&mut self) {
      unsafe {
        CoUninitialize();
      }
    }
  }

  struct PopupMenu(HMENU);

  impl PopupMenu {
    fn create() -> Result<Self> {
      Ok(Self(unsafe { CreatePopupMenu().context("failed to create popup menu")? }))
    }

    fn handle(&self) -> HMENU {
      self.0
    }
  }

  impl Drop for PopupMenu {
    fn drop(&mut self) {
      unsafe {
        if !self.0.is_invalid() {
          let _ = DestroyMenu(self.0);
        }
      }
    }
  }

  struct OwnedPidl(*mut ITEMIDLIST);

  impl OwnedPidl {
    fn parse(path: &Path) -> Result<Self> {
      let mut wide = path.as_os_str().encode_wide().collect::<Vec<u16>>();
      wide.push(0);

      let mut pidl = null_mut();
      unsafe {
        SHParseDisplayName(windows::core::PCWSTR(wide.as_ptr()), None, &mut pidl, 0, None)
          .with_context(|| format!("failed to resolve shell path {}", path.display()))?;
      }

      Ok(Self(pidl))
    }
  }

  impl Drop for OwnedPidl {
    fn drop(&mut self) {
      unsafe {
        if !self.0.is_null() {
          ILFree(Some(self.0.cast_const()));
        }
      }
    }
  }

  struct ShellSelection {
    parent_folder: IShellFolder,
    child_pidls: Vec<*const ITEMIDLIST>,
    _absolute_pidls: Vec<OwnedPidl>
  }

  fn navigation_parent_key(parent: &str) -> String {
    normalize_local_path(&PathBuf::from(parent)).to_lowercase()
  }

  fn validate_paths(paths: Vec<String>) -> Result<Vec<PathBuf>> {
    let mut resolved = Vec::new();
    let mut parent: Option<String> = None;

    for raw in paths {
      let info = resolve_navigation_target(&raw)?;
      if info.target_status != NavigationTargetStatus::Ok || !info.is_local || !info.exists {
        bail!(
          "{}",
          info
            .message
            .unwrap_or_else(|| "native context menu only supports existing local file system paths".into())
        );
      }
      let path = info
        .normalized_path
        .as_deref()
        .or(info.canonical_path.as_deref())
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("native context menu requires absolute local paths"))?;
      let normalized_parent = info
        .parent_path
        .as_deref()
        .map(|parent| navigation_parent_key(parent))
        .ok_or_else(|| anyhow!("native context menu requires items with a parent directory"))?;
      if let Some(expected_parent) = &parent {
        if expected_parent != &normalized_parent {
          bail!("native context menu requires items from the same parent directory");
        }
      } else {
        parent = Some(normalized_parent);
      }

      resolved.push(path);
    }

    if resolved.is_empty() {
      bail!("no local paths available for native context menu");
    }

    Ok(resolved)
  }

  fn bind_shell_selection(paths: &[PathBuf]) -> Result<ShellSelection> {
    let mut parent_folder = None;
    let mut child_pidls = Vec::with_capacity(paths.len());
    let mut absolute_pidls = Vec::with_capacity(paths.len());

    for path in paths {
      let absolute_pidl = OwnedPidl::parse(path)?;
      let mut child_pidl = null_mut();
      let folder: IShellFolder = unsafe {
        SHBindToParent(absolute_pidl.0.cast_const(), Some(&mut child_pidl))
          .with_context(|| format!("failed to bind shell parent for {}", path.display()))?
      };

      if child_pidl.is_null() {
        bail!("failed to resolve shell child item {}", path.display());
      }

      if parent_folder.is_none() {
        parent_folder = Some(folder);
      }

      child_pidls.push(child_pidl.cast_const());
      absolute_pidls.push(absolute_pidl);
    }

    Ok(ShellSelection {
      parent_folder: parent_folder.ok_or_else(|| anyhow!("no local paths available for native context menu"))?,
      child_pidls,
      _absolute_pidls: absolute_pidls
    })
  }

  fn invoke_command(context_menu: &IContextMenu, hwnd: HWND, command_id: u32) -> Result<()> {
    let command_offset = command_id
      .checked_sub(CMD_FIRST)
      .ok_or_else(|| anyhow!("invalid shell command id"))?;

    let invoke = CMINVOKECOMMANDINFO {
      cbSize: std::mem::size_of::<CMINVOKECOMMANDINFO>() as u32,
      fMask: 0,
      hwnd,
      lpVerb: PCSTR(command_offset as usize as *const u8),
      lpParameters: PCSTR::null(),
      lpDirectory: PCSTR::null(),
      nShow: SW_SHOWNORMAL.0,
      dwHotKey: 0,
      hIcon: Default::default()
    };

    unsafe {
      context_menu
        .InvokeCommand(&invoke)
        .context("failed to invoke shell context menu command")?;
    }

    Ok(())
  }

  fn did_native_menu_open(command_id: u32, last_error: WIN32_ERROR) -> bool {
    command_id >= CMD_FIRST || last_error == ERROR_SUCCESS
  }

  fn resolve_menu_position(fallback_x: i32, fallback_y: i32) -> (i32, i32) {
    let mut cursor = POINT::default();
    if unsafe { GetCursorPos(&mut cursor) }.is_ok() {
      return (cursor.x, cursor.y);
    }

    (fallback_x, fallback_y)
  }

  fn show_native_context_menu_inner(paths: Vec<String>, x: i32, y: i32, hwnd_raw: isize) -> Result<bool> {
    let _com = ComGuard::init()?;
    let hwnd = HWND(hwnd_raw as *mut std::ffi::c_void);
    let validated_paths = validate_paths(paths)?;
    let selection = bind_shell_selection(&validated_paths)?;
    let context_menu: IContextMenu = unsafe {
      selection
        .parent_folder
        .GetUIObjectOf(hwnd, &selection.child_pidls, None)
        .context("failed to bind shell selection to context menu")?
    };

    let popup = PopupMenu::create()?;
    unsafe {
      context_menu
        .QueryContextMenu(popup.handle(), 0, CMD_FIRST, CMD_LAST, CMF_NORMAL)
        .ok()
        .context("failed to populate shell context menu")?;
    }

    if hwnd.0.is_null() {
      bail!("failed to resolve window handle");
    }
    unsafe {
      let _ = SetForegroundWindow(hwnd);
    }

    let (menu_x, menu_y) = resolve_menu_position(x, y);
    unsafe {
      SetLastError(ERROR_SUCCESS);
    }
    let command_id = unsafe {
      TrackPopupMenuEx(
        popup.handle(),
        TPM_RIGHTBUTTON.0 | TPM_RETURNCMD.0,
        menu_x,
        menu_y,
        hwnd,
        None
      )
    }
    .0 as u32;
    let menu_last_error = unsafe { GetLastError() };
    unsafe {
      let _ = PostMessageW(Some(hwnd), WM_NULL, WPARAM(0), LPARAM(0));
    }

    if command_id == 0 {
      return Ok(did_native_menu_open(command_id, menu_last_error));
    }

    let _ = invoke_command(&context_menu, hwnd, command_id);
    Ok(true)
  }

  pub async fn show_native_context_menu<R: Runtime>(
    paths: Vec<String>,
    x: i32,
    y: i32,
    window: &Window<R>
  ) -> Result<bool> {
    let hwnd = window.hwnd().context("failed to resolve Tauri window handle")?;
    let hwnd_raw = hwnd.0 as isize;
    let (sender, receiver) = tokio::sync::oneshot::channel();

    window
      .run_on_main_thread(move || {
        let _ = sender.send(show_native_context_menu_inner(paths, x, y, hwnd_raw));
      })
      .context("failed to schedule native context menu on the Tauri main thread")?;

    receiver
      .await
      .map_err(|_| anyhow!("native context menu main-thread task was canceled"))?
  }

  #[cfg(test)]
  mod tests {
    use anyhow::Result;

    use windows::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_SUCCESS};

    use super::{
      did_native_menu_open, resolve_navigation_target, validate_paths, validate_shell_execute_result,
      validate_system_default_open_path, NavigationOpenValidationError
    };

    #[test]
    fn track_popup_zero_with_success_reports_native_menu_handled() {
      assert!(did_native_menu_open(0, ERROR_SUCCESS));
    }

    #[test]
    fn track_popup_zero_with_win32_error_keeps_app_fallback_available() {
      assert!(!did_native_menu_open(0, ERROR_ACCESS_DENIED));
    }

    #[test]
    fn track_popup_command_reports_native_menu_handled() {
      assert!(did_native_menu_open(1, ERROR_ACCESS_DENIED));
      assert!(did_native_menu_open(42, ERROR_SUCCESS));
    }

    #[test]
    fn validate_paths_rejects_empty_inputs() {
      assert!(validate_paths(vec![]).is_err());
    }

    #[test]
    fn validate_paths_rejects_remote_inputs() {
      assert!(validate_paths(vec!["sftp://deploy@example/root".into()]).is_err());
    }

    #[test]
    fn resolve_navigation_target_reports_remote_unsupported_without_touching_shell() {
      let info = resolve_navigation_target("sftp://deploy@example/root").expect("target should resolve as unsupported");

      assert_eq!(info.target_kind, crate::domain::models::NavigationTargetKind::RemoteUnsupported);
      assert_eq!(info.target_status, crate::domain::models::NavigationTargetStatus::UnsupportedRemote);
      assert!(!info.exists);
      assert!(!info.is_local);
    }

    #[test]
    fn resolve_navigation_target_rejects_empty_relative_and_url_inputs() {
      for path in ["", "relative\\file.txt", "https://example.com/file.txt", "mailto:test@example.com"] {
        let info = resolve_navigation_target(path).expect("invalid targets should be classified");
        assert_eq!(info.target_status, crate::domain::models::NavigationTargetStatus::InvalidPath);
        assert_eq!(info.exists, false);
      }
    }

    #[test]
    fn resolve_navigation_target_reports_existing_files_and_folders() -> Result<()> {
      let temp = std::env::temp_dir().join(format!("simplefilemanager-navigation-target-{}", uuid::Uuid::new_v4()));
      let folder = temp.join("docs");
      let file = folder.join("readme.txt");
      std::fs::create_dir_all(&folder)?;
      std::fs::write(&file, "readme")?;

      let folder_info = resolve_navigation_target(&folder.to_string_lossy())?;
      let file_info = resolve_navigation_target(&file.to_string_lossy())?;

      let _ = std::fs::remove_dir_all(&temp);
      assert_eq!(folder_info.target_kind, crate::domain::models::NavigationTargetKind::Folder);
      assert_eq!(folder_info.target_status, crate::domain::models::NavigationTargetStatus::Ok);
      assert_eq!(file_info.target_kind, crate::domain::models::NavigationTargetKind::File);
      assert_eq!(file_info.parent_path.as_deref(), Some(folder.to_string_lossy().as_ref()));
      Ok(())
    }

    #[test]
    fn default_open_validation_rejects_non_user_openable_targets() {
      assert_eq!(
        validate_system_default_open_path("").unwrap_err(),
        NavigationOpenValidationError::InvalidPath
      );
      assert_eq!(
        validate_system_default_open_path("ftp://example/root").unwrap_err(),
        NavigationOpenValidationError::UnsupportedRemote
      );
      assert_eq!(
        validate_system_default_open_path("relative\\file.txt").unwrap_err(),
        NavigationOpenValidationError::InvalidPath
      );
    }

    #[test]
    fn shell_execute_result_maps_failure_codes() {
      assert!(validate_shell_execute_result(33).is_ok());
      assert_eq!(
        validate_shell_execute_result(31).unwrap_err().to_string(),
        "no application is associated with this file type"
      );
      assert_eq!(
        validate_shell_execute_result(5).unwrap_err().to_string(),
        "access was denied"
      );
    }

    #[test]
    fn validate_paths_rejects_mixed_remote_and_local_inputs() -> Result<()> {
      let temp = std::env::temp_dir().join(format!("simplefilemanager-native-menu-{}", uuid::Uuid::new_v4()));
      std::fs::create_dir_all(&temp)?;
      let local_file = temp.join("a.txt");
      std::fs::write(&local_file, "a")?;

      let result = validate_paths(vec![
        local_file.to_string_lossy().into_owned(),
        "ftp://deploy@example/root/b.txt".into()
      ]);

      let _ = std::fs::remove_dir_all(&temp);
      assert!(result.is_err());
      Ok(())
    }

    #[test]
    fn validate_paths_rejects_mixed_parent_directories() -> Result<()> {
      let temp = std::env::temp_dir().join(format!("simplefilemanager-native-menu-{}", uuid::Uuid::new_v4()));
      let left = temp.join("left");
      let right = temp.join("right");
      std::fs::create_dir_all(&left)?;
      std::fs::create_dir_all(&right)?;
      let left_file = left.join("a.txt");
      let right_file = right.join("b.txt");
      std::fs::write(&left_file, "a")?;
      std::fs::write(&right_file, "b")?;

      let result = validate_paths(vec![
        left_file.to_string_lossy().into_owned(),
        right_file.to_string_lossy().into_owned()
      ]);

      let _ = std::fs::remove_dir_all(&temp);
      assert!(result.is_err());
      Ok(())
    }

    #[test]
    fn validate_paths_accepts_multiple_items_from_same_parent() -> Result<()> {
      let temp = std::env::temp_dir().join(format!("simplefilemanager-native-menu-{}", uuid::Uuid::new_v4()));
      std::fs::create_dir_all(&temp)?;
      let first_file = temp.join("a.txt");
      let second_file = temp.join("b.txt");
      std::fs::write(&first_file, "a")?;
      std::fs::write(&second_file, "b")?;

      let result = validate_paths(vec![
        first_file.to_string_lossy().into_owned(),
        second_file.to_string_lossy().into_owned()
      ])?;

      let _ = std::fs::remove_dir_all(&temp);
      assert_eq!(result.len(), 2);
      Ok(())
    }

    #[test]
    fn validate_paths_keeps_shell_friendly_non_verbatim_paths() -> Result<()> {
      let temp = std::env::temp_dir().join(format!("simplefilemanager-native-menu-{}", uuid::Uuid::new_v4()));
      std::fs::create_dir_all(&temp)?;
      let file = temp.join("a.txt");
      std::fs::write(&file, "a")?;

      let result = validate_paths(vec![file.to_string_lossy().into_owned()])?;
      let rendered = result[0].to_string_lossy().replace('/', "\\");

      let _ = std::fs::remove_dir_all(&temp);
      assert!(
        !rendered.starts_with(r"\\?\"),
        "Windows shell context menu paths must not use verbatim canonical form: {rendered}"
      );
      assert_eq!(rendered, file.to_string_lossy().replace('/', "\\"));
      Ok(())
    }
  }
}

#[cfg(windows)]
pub use imp::{
  open_path_with_system_default, resolve_navigation_target, show_native_context_menu
};

#[cfg(not(windows))]
pub async fn show_native_context_menu<R: tauri::Runtime>(
  _paths: Vec<String>,
  _x: i32,
  _y: i32,
  _window: &tauri::Window<R>
) -> anyhow::Result<bool> {
  anyhow::bail!("native context menu is only supported on Windows")
}

#[cfg(not(windows))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationOpenValidationError {
  InvalidPath,
  UnsupportedRemote,
  Missing,
  PermissionDenied,
  Unknown
}

#[cfg(not(windows))]
pub fn resolve_navigation_target(raw: &str) -> anyhow::Result<crate::domain::models::NavigationTargetInfo> {
  use crate::domain::models::{NavigationTargetInfo, NavigationTargetKind, NavigationTargetStatus};

  let trimmed = raw.trim();
  let lowered = trimmed.to_ascii_lowercase();
  if lowered.starts_with("ftp://") || lowered.starts_with("sftp://") {
    return Ok(NavigationTargetInfo {
      path: trimmed.into(),
      normalized_path: None,
      canonical_path: None,
      display_name: trimmed.into(),
      target_kind: NavigationTargetKind::RemoteUnsupported,
      target_status: NavigationTargetStatus::UnsupportedRemote,
      message: Some("remote navigation targets are not supported by system shell operations yet".into()),
      exists: false,
      is_local: false,
      parent_path: None
    });
  }

  Ok(NavigationTargetInfo {
    path: trimmed.into(),
    normalized_path: None,
    canonical_path: None,
    display_name: trimmed.into(),
    target_kind: NavigationTargetKind::Unknown,
    target_status: NavigationTargetStatus::InvalidPath,
    message: Some("navigation shell target resolution is only supported on Windows".into()),
    exists: false,
    is_local: false,
    parent_path: None
  })
}

#[cfg(not(windows))]
pub fn validate_system_default_open_path(_path: &str) -> std::result::Result<std::path::PathBuf, NavigationOpenValidationError> {
  Err(NavigationOpenValidationError::InvalidPath)
}

#[cfg(not(windows))]
pub fn open_path_with_system_default(_path: String) -> anyhow::Result<()> {
  anyhow::bail!("system default open is only supported on Windows")
}

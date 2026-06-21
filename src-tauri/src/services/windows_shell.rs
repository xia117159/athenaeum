mod navigation;

#[cfg(not(windows))]
use navigation::NavigationOpenValidationError;

#[cfg(windows)]
mod imp {
    use std::{
        ffi::OsStr,
        os::windows::ffi::OsStrExt,
        path::{Path, PathBuf},
        ptr::{copy_nonoverlapping, null_mut},
    };

    use crate::domain::models::{
        NativeBackgroundContextMenuAction, NativeBackgroundContextMenuOptions,
        NativeBackgroundContextMenuResult, NativeBackgroundContextMenuSortColumn,
        NativeBackgroundContextMenuSortDirection, NativeBackgroundContextMenuViewMode,
        NavigationTargetInfo, NavigationTargetKind, NavigationTargetStatus, SystemFileClipboard,
        SystemFileClipboardMode, SystemFileOperationKind, SystemFileOperationRequest,
        WindowsDragDropEnvironment,
    };
    use anyhow::{anyhow, bail, Context, Result};
    use tauri::{Emitter, Runtime, Window};
    use windows::{
        core::{implement, PCSTR, PCWSTR},
        Win32::{
            Foundation::{
                CloseHandle, GetLastError, SetLastError, DRAGDROP_S_CANCEL, DRAGDROP_S_DROP,
                DRAGDROP_S_USEDEFAULTCURSORS, ERROR_SUCCESS, HANDLE, HGLOBAL, HWND, LPARAM, POINT,
                S_OK, WIN32_ERROR, WPARAM,
            },
            Graphics::Gdi::ScreenToClient,
            Security::{
                GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenElevation,
                TokenIntegrityLevel, TOKEN_ELEVATION, TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
            },
            System::{
                Com::{
                    CoCreateInstance, CoInitializeEx, CoUninitialize, IBindCtx, IDataObject,
                    CLSCTX_ALL, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
                },
                DataExchange::{
                    CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard,
                    RegisterClipboardFormatW, SetClipboardData,
                },
                Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT},
                Ole::{
                    IDropSource, CF_HDROP, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_MOVE,
                    DROPEFFECT_NONE,
                },
                SystemServices::{
                    MK_LBUTTON, MODIFIERKEYS_FLAGS, SECURITY_MANDATORY_HIGH_RID,
                    SECURITY_MANDATORY_LOW_RID, SECURITY_MANDATORY_MEDIUM_RID,
                    SECURITY_MANDATORY_SYSTEM_RID,
                },
                Threading::{GetCurrentProcess, OpenProcessToken},
            },
            UI::{
                Shell::{
                    Common::ITEMIDLIST, DragQueryFileW, FileOperation, IContextMenu,
                    IFileOperation, IFileOperationProgressSink, ILFree, IShellFolder, IShellItem,
                    SHBindToParent, SHCreateItemFromParsingName, SHDoDragDrop, SHParseDisplayName,
                    ShellExecuteW, CFSTR_PREFERREDDROPEFFECT, CMF_NORMAL, CMINVOKECOMMANDINFO,
                    DROPFILES, FOFX_ADDUNDORECORD, FOFX_SHOWELEVATIONPROMPT, FOF_ALLOWUNDO, HDROP,
                },
                WindowsAndMessaging::{
                    AppendMenuW, CreatePopupMenu, DestroyMenu, GetCursorPos, PostMessageW,
                    SetForegroundWindow, TrackPopupMenuEx, HMENU, MENU_ITEM_FLAGS, MF_CHECKED,
                    MF_GRAYED, MF_POPUP, MF_SEPARATOR, MF_STRING, SW_SHOWNORMAL, TPM_RETURNCMD,
                    TPM_RIGHTBUTTON, WM_NULL,
                },
            },
        },
    };

    use super::navigation::{
        has_unsupported_url_scheme, is_remote_path, normalize_local_path, path_display_name,
        NavigationOpenValidationError,
    };

    const CMD_FIRST: u32 = 1;
    const CMD_LAST: u32 = 0x7FFF;
    const BACKGROUND_SHELL_CMD_FIRST: u32 = 1000;
    const BACKGROUND_CMD_CREATE_FILE: u32 = 1;
    const BACKGROUND_CMD_CREATE_FOLDER: u32 = 2;
    const BACKGROUND_CMD_VIEW_EXTRA_LARGE: u32 = 10;
    const BACKGROUND_CMD_VIEW_LARGE: u32 = 11;
    const BACKGROUND_CMD_VIEW_MEDIUM: u32 = 12;
    const BACKGROUND_CMD_VIEW_SMALL: u32 = 13;
    const BACKGROUND_CMD_VIEW_LIST: u32 = 14;
    const BACKGROUND_CMD_VIEW_DETAILS: u32 = 15;
    const BACKGROUND_CMD_VIEW_TILES: u32 = 16;
    const BACKGROUND_CMD_VIEW_CONTENT: u32 = 17;
    const BACKGROUND_CMD_SORT_NAME: u32 = 30;
    const BACKGROUND_CMD_SORT_MODIFIED: u32 = 31;
    const BACKGROUND_CMD_SORT_TYPE: u32 = 32;
    const BACKGROUND_CMD_SORT_SIZE: u32 = 33;
    const BACKGROUND_CMD_SORT_ASC: u32 = 40;
    const BACKGROUND_CMD_SORT_DESC: u32 = 41;
    const BACKGROUND_CMD_PASTE: u32 = 50;
    const BACKGROUND_CUSTOM_TOP_ITEM_COUNT: u32 = 6;
    const ELEVATED_DRAG_DROP_MESSAGE: &str =
        "Explorer file drops are blocked while this process is running elevated.";

    struct HandleGuard(HANDLE);

    impl Drop for HandleGuard {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }
    }

    fn integrity_level_name(integrity_rid: u32) -> &'static str {
        if integrity_rid < SECURITY_MANDATORY_LOW_RID as u32 {
            "untrusted"
        } else if integrity_rid < SECURITY_MANDATORY_MEDIUM_RID as u32 {
            "low"
        } else if integrity_rid < SECURITY_MANDATORY_HIGH_RID as u32 {
            "medium"
        } else if integrity_rid < SECURITY_MANDATORY_SYSTEM_RID as u32 {
            "high"
        } else {
            "system"
        }
    }

    fn explorer_to_app_drag_blocked(is_elevated: bool, integrity_rid: u32) -> bool {
        is_elevated || integrity_rid >= SECURITY_MANDATORY_HIGH_RID as u32
    }

    fn open_current_process_token() -> Result<HandleGuard> {
        let mut token = HANDLE::default();
        unsafe {
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
                .context("failed to open current process token")?;
        }
        Ok(HandleGuard(token))
    }

    fn current_process_is_elevated(token: HANDLE) -> Result<bool> {
        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned_length = 0_u32;
        unsafe {
            GetTokenInformation(
                token,
                TokenElevation,
                Some((&mut elevation as *mut TOKEN_ELEVATION).cast()),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut returned_length,
            )
            .context("failed to read current process elevation")?;
        }
        Ok(elevation.TokenIsElevated != 0)
    }

    fn current_process_integrity_rid(token: HANDLE) -> Result<u32> {
        let mut required_length = 0_u32;
        let _ = unsafe {
            GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut required_length)
        };
        if required_length == 0 {
            bail!("failed to query current process integrity token length");
        }

        let mut buffer = vec![0_u8; required_length as usize];
        unsafe {
            GetTokenInformation(
                token,
                TokenIntegrityLevel,
                Some(buffer.as_mut_ptr().cast()),
                required_length,
                &mut required_length,
            )
            .context("failed to read current process integrity level")?;

            let label = &*(buffer.as_ptr().cast::<TOKEN_MANDATORY_LABEL>());
            let authority_count = GetSidSubAuthorityCount(label.Label.Sid);
            if authority_count.is_null() || *authority_count == 0 {
                bail!("current process integrity SID is invalid");
            }

            let rid = GetSidSubAuthority(label.Label.Sid, *authority_count as u32 - 1);
            if rid.is_null() {
                bail!("current process integrity SID RID is invalid");
            }
            Ok(*rid)
        }
    }

    pub fn get_windows_drag_drop_environment() -> Result<WindowsDragDropEnvironment> {
        let token = open_current_process_token()?;
        let is_elevated = current_process_is_elevated(token.0)?;
        let integrity_rid = current_process_integrity_rid(token.0)?;
        let blocked = explorer_to_app_drag_blocked(is_elevated, integrity_rid);

        Ok(WindowsDragDropEnvironment {
            is_elevated,
            integrity_level: integrity_level_name(integrity_rid).into(),
            explorer_to_app_drag_blocked: blocked,
            message: blocked.then_some(ELEVATED_DRAG_DROP_MESSAGE.into()),
        })
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
            parent_path: None,
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
            message: Some(
                "remote navigation targets are not supported by Windows shell operations yet"
                    .into(),
            ),
            exists: false,
            is_local: false,
            parent_path: None,
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
            return Ok(invalid_target_info(
                raw,
                "URL schemes are not supported as navigation targets",
            ));
        }

        let path = PathBuf::from(trimmed);
        if !path.is_absolute() {
            return Ok(invalid_target_info(
                raw,
                "navigation target must be an absolute local path",
            ));
        }

        let normalized_path = normalize_local_path(&path);
        let parent_path = path.parent().map(normalize_local_path);
        let display_name = path_display_name(&path, &normalized_path);

        match std::fs::symlink_metadata(&path) {
            Ok(metadata) => {
                let canonical_path = std::fs::canonicalize(&path)
                    .ok()
                    .map(|item| normalize_local_path(&item));
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
                    parent_path,
                })
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(NavigationTargetInfo {
                    path: trimmed.to_string(),
                    normalized_path: Some(normalized_path),
                    canonical_path: None,
                    display_name,
                    target_kind: NavigationTargetKind::Missing,
                    target_status: NavigationTargetStatus::Missing,
                    message: Some("path is missing or currently inaccessible".into()),
                    exists: false,
                    is_local: true,
                    parent_path,
                })
            }
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                Ok(NavigationTargetInfo {
                    path: trimmed.to_string(),
                    normalized_path: Some(normalized_path),
                    canonical_path: None,
                    display_name,
                    target_kind: NavigationTargetKind::Unknown,
                    target_status: NavigationTargetStatus::PermissionDenied,
                    message: Some(error.to_string()),
                    exists: false,
                    is_local: true,
                    parent_path,
                })
            }
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
                parent_path,
            }),
        }
    }

    pub fn validate_system_default_open_path(
        path: &str,
    ) -> std::result::Result<PathBuf, NavigationOpenValidationError> {
        let info =
            resolve_navigation_target(path).map_err(|_| NavigationOpenValidationError::Unknown)?;
        match info.target_status {
            NavigationTargetStatus::Ok => info
                .normalized_path
                .map(PathBuf::from)
                .ok_or(NavigationOpenValidationError::InvalidPath),
            NavigationTargetStatus::UnsupportedRemote => {
                Err(NavigationOpenValidationError::UnsupportedRemote)
            }
            NavigationTargetStatus::Missing => Err(NavigationOpenValidationError::Missing),
            NavigationTargetStatus::PermissionDenied => {
                Err(NavigationOpenValidationError::PermissionDenied)
            }
            NavigationTargetStatus::InvalidPath => Err(NavigationOpenValidationError::InvalidPath),
            NavigationTargetStatus::UnknownError => Err(NavigationOpenValidationError::Unknown),
        }
    }

    fn wide_null(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    fn file_clipboard_drop_effect(mode: SystemFileClipboardMode) -> u32 {
        match mode {
            SystemFileClipboardMode::Copy => DROPEFFECT_COPY.0,
            SystemFileClipboardMode::Cut => DROPEFFECT_MOVE.0,
        }
    }

    fn mode_from_drop_effect(effect: u32) -> SystemFileClipboardMode {
        if effect & DROPEFFECT_MOVE.0 != 0 {
            SystemFileClipboardMode::Cut
        } else {
            SystemFileClipboardMode::Copy
        }
    }

    fn encode_wide_path_list(paths: &[String]) -> Vec<u16> {
        let mut encoded = Vec::new();
        for path in paths {
            encoded.extend(OsStr::new(path).encode_wide());
            encoded.push(0);
        }
        encoded.push(0);
        encoded
    }

    fn build_hdrop_payload(paths: &[String]) -> Result<Vec<u8>> {
        if paths.is_empty() {
            bail!("system file clipboard requires at least one local path");
        }

        let wide_paths = encode_wide_path_list(paths);
        let header_size = std::mem::size_of::<DROPFILES>();
        let path_bytes_len = wide_paths
            .len()
            .checked_mul(std::mem::size_of::<u16>())
            .ok_or_else(|| anyhow!("system file clipboard payload is too large"))?;
        let total_size = header_size
            .checked_add(path_bytes_len)
            .ok_or_else(|| anyhow!("system file clipboard payload is too large"))?;
        let mut payload = vec![0_u8; total_size];

        let header = DROPFILES {
            pFiles: header_size as u32,
            pt: POINT { x: 0, y: 0 },
            fNC: false.into(),
            fWide: true.into(),
        };

        unsafe {
            copy_nonoverlapping(
                (&header as *const DROPFILES).cast::<u8>(),
                payload.as_mut_ptr(),
                header_size,
            );
            copy_nonoverlapping(
                wide_paths.as_ptr().cast::<u8>(),
                payload.as_mut_ptr().add(header_size),
                path_bytes_len,
            );
        }

        Ok(payload)
    }

    fn build_drop_effect_payload(mode: SystemFileClipboardMode) -> [u8; 4] {
        file_clipboard_drop_effect(mode).to_le_bytes()
    }

    unsafe fn global_alloc_from_bytes(bytes: &[u8]) -> Result<HGLOBAL> {
        let handle = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes.len())
            .context("failed to allocate global clipboard memory")?;
        let target = GlobalLock(handle);
        if target.is_null() {
            bail!("failed to lock global clipboard memory");
        }

        unsafe {
            copy_nonoverlapping(bytes.as_ptr(), target.cast::<u8>(), bytes.len());
            let _ = GlobalUnlock(handle);
        }

        Ok(handle)
    }

    struct ClipboardGuard;

    impl ClipboardGuard {
        fn open() -> Result<Self> {
            unsafe {
                OpenClipboard(None).context("failed to open system clipboard")?;
            }
            Ok(Self)
        }
    }

    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }

    fn preferred_drop_effect_format() -> Result<u32> {
        let format = unsafe { RegisterClipboardFormatW(CFSTR_PREFERREDDROPEFFECT) };
        if format == 0 {
            bail!("failed to register Preferred DropEffect clipboard format");
        }
        Ok(format)
    }

    pub fn set_system_file_clipboard(
        paths: Vec<String>,
        mode: SystemFileClipboardMode,
    ) -> Result<()> {
        let resolved_paths = validate_paths(paths)?;
        let paths = resolved_paths
            .iter()
            .map(|path| normalize_local_path(path))
            .collect::<Vec<_>>();
        let hdrop_payload = build_hdrop_payload(&paths)?;
        let drop_effect_payload = build_drop_effect_payload(mode);

        let _clipboard = ClipboardGuard::open()?;
        unsafe {
            EmptyClipboard().context("failed to clear system clipboard")?;

            let hdrop_memory = global_alloc_from_bytes(&hdrop_payload)?;
            SetClipboardData(CF_HDROP.0 as u32, Some(HANDLE(hdrop_memory.0)))
                .context("failed to set CF_HDROP clipboard data")?;

            let effect_format = preferred_drop_effect_format()?;
            let effect_memory = global_alloc_from_bytes(&drop_effect_payload)?;
            SetClipboardData(effect_format, Some(HANDLE(effect_memory.0)))
                .context("failed to set Preferred DropEffect clipboard data")?;
        }

        Ok(())
    }

    fn read_drop_effect_from_clipboard(format: u32) -> SystemFileClipboardMode {
        let effect = unsafe {
            let Ok(handle) = GetClipboardData(format) else {
                return SystemFileClipboardMode::Copy;
            };
            let locked = GlobalLock(HGLOBAL(handle.0));
            if locked.is_null() {
                return SystemFileClipboardMode::Copy;
            }
            let value = std::ptr::read_unaligned(locked.cast::<u32>());
            let _ = GlobalUnlock(HGLOBAL(handle.0));
            value
        };
        mode_from_drop_effect(effect)
    }

    fn read_hdrop_paths_from_clipboard() -> Result<Option<Vec<String>>> {
        let handle = unsafe {
            match GetClipboardData(CF_HDROP.0 as u32) {
                Ok(handle) => handle,
                Err(_) => return Ok(None),
            }
        };
        if handle.0.is_null() {
            return Ok(None);
        }

        let hdrop = HDROP(handle.0);
        let count = unsafe { DragQueryFileW(hdrop, 0xFFFF_FFFF, None) };
        if count == 0 {
            return Ok(None);
        }

        let mut paths = Vec::with_capacity(count as usize);
        for index in 0..count {
            let len = unsafe { DragQueryFileW(hdrop, index, None) };
            if len == 0 {
                continue;
            }
            let mut buffer = vec![0_u16; len as usize + 1];
            let written = unsafe { DragQueryFileW(hdrop, index, Some(&mut buffer)) };
            if written == 0 {
                continue;
            }
            buffer.truncate(written as usize);
            paths.push(String::from_utf16_lossy(&buffer));
        }

        Ok((!paths.is_empty()).then_some(paths))
    }

    pub fn read_system_file_clipboard() -> Result<Option<SystemFileClipboard>> {
        let _clipboard = ClipboardGuard::open()?;
        let Some(paths) = read_hdrop_paths_from_clipboard()? else {
            return Ok(None);
        };
        let effect_format = preferred_drop_effect_format()?;
        Ok(Some(SystemFileClipboard {
            mode: read_drop_effect_from_clipboard(effect_format),
            paths,
        }))
    }

    fn shell_execute_error_message(code: isize) -> String {
        match code {
            0 => "system default open failed: out of memory or resources".into(),
            2 => "file was not found".into(),
            3 => "path was not found".into(),
            5 => "access was denied".into(),
            31 => "no application is associated with this file type".into(),
            _ => format!("system default open failed with ShellExecuteW code {code}"),
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
            NavigationOpenValidationError::InvalidPath => {
                anyhow!("path must be an absolute local file system path")
            }
            NavigationOpenValidationError::UnsupportedRemote => {
                anyhow!("remote targets are not supported by system default open")
            }
            NavigationOpenValidationError::Missing => anyhow!("path does not exist"),
            NavigationOpenValidationError::PermissionDenied => anyhow!("access was denied"),
            NavigationOpenValidationError::Unknown => anyhow!("path could not be opened"),
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
                SW_SHOWNORMAL,
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
            Ok(Self(unsafe {
                CreatePopupMenu().context("failed to create popup menu")?
            }))
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
                SHParseDisplayName(
                    windows::core::PCWSTR(wide.as_ptr()),
                    None,
                    &mut pidl,
                    0,
                    None,
                )
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
        _absolute_pidls: Vec<OwnedPidl>,
    }

    #[implement(IDropSource)]
    struct FileDragSource {
        hwnd: HWND,
        // Emits the live client-space cursor position to the WebView during the
        // drag. SHDoDragDrop runs a modal loop on the main thread, so WRY's
        // native drag-drop events are queued on the (idle) tao event loop and
        // only flush in a burst at drop. GiveFeedback is the one callback OLE
        // invokes live on every mouse move, so it is the only place that can
        // drive an in-app drop highlight while an App-origin drag is airborne.
        emit_position: Box<dyn Fn(i32, i32)>,
    }

    #[allow(non_snake_case)]
    impl windows::Win32::System::Ole::IDropSource_Impl for FileDragSource_Impl {
        fn QueryContinueDrag(
            &self,
            escape_pressed: windows::core::BOOL,
            key_state: MODIFIERKEYS_FLAGS,
        ) -> windows::core::HRESULT {
            if escape_pressed.as_bool() {
                return DRAGDROP_S_CANCEL;
            }
            if !key_state.contains(MK_LBUTTON) {
                return DRAGDROP_S_DROP;
            }
            S_OK
        }

        fn GiveFeedback(&self, _effect: DROPEFFECT) -> windows::core::HRESULT {
            let mut point = POINT::default();
            unsafe {
                if GetCursorPos(&mut point).is_ok()
                    && ScreenToClient(self.hwnd, &mut point).as_bool()
                {
                    (self.emit_position)(point.x, point.y);
                }
            }
            DRAGDROP_S_USEDEFAULTCURSORS
        }
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
                    info.message.unwrap_or_else(|| {
                        "native context menu only supports existing local file system paths".into()
                    })
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
                .ok_or_else(|| {
                    anyhow!("native context menu requires items with a parent directory")
                })?;
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

    fn validate_background_path(raw: String) -> Result<PathBuf> {
        let info = resolve_navigation_target(&raw)?;
        if info.target_status != NavigationTargetStatus::Ok || !info.is_local || !info.exists {
            bail!(
                "{}",
                info.message.unwrap_or_else(|| {
                    "native background context menu only supports existing local directories".into()
                })
            );
        }
        if info.target_kind != NavigationTargetKind::Folder {
            bail!("native background context menu requires an existing local directory");
        }
        info.normalized_path
            .as_deref()
            .or(info.canonical_path.as_deref())
            .map(PathBuf::from)
            .ok_or_else(|| {
                anyhow!("native background context menu requires an absolute local directory")
            })
    }

    fn validate_file_operation_sources(paths: Vec<String>) -> Result<Vec<PathBuf>> {
        if paths.is_empty() {
            bail!("system file operation requires at least one source path");
        }

        paths
      .into_iter()
      .map(|raw| {
        let info = resolve_navigation_target(&raw)?;
        if info.target_status != NavigationTargetStatus::Ok || !info.is_local || !info.exists {
          bail!(
            "{}",
            info
              .message
              .unwrap_or_else(|| "system file operation only supports existing local file system paths".into())
          );
        }
        info
          .normalized_path
          .as_deref()
          .or(info.canonical_path.as_deref())
          .map(PathBuf::from)
          .ok_or_else(|| anyhow!("system file operation requires absolute local paths"))
      })
      .collect()
    }

    fn shell_item_from_path(path: &Path) -> Result<IShellItem> {
        let wide = wide_null(path.as_os_str());
        unsafe {
            SHCreateItemFromParsingName::<_, Option<&IBindCtx>, IShellItem>(
                PCWSTR(wide.as_ptr()),
                None,
            )
            .with_context(|| format!("failed to bind shell item {}", path.display()))
        }
    }

    fn system_file_operation_flags() -> windows::Win32::UI::Shell::FILEOPERATION_FLAGS {
        windows::Win32::UI::Shell::FILEOPERATION_FLAGS(
            FOF_ALLOWUNDO.0 | FOFX_ADDUNDORECORD.0 | FOFX_SHOWELEVATIONPROMPT.0,
        )
    }

    fn perform_system_file_operation_inner(
        request: SystemFileOperationRequest,
        hwnd_raw: isize,
    ) -> Result<()> {
        let _com = ComGuard::init()?;
        let hwnd = HWND(hwnd_raw as *mut std::ffi::c_void);
        if hwnd.0.is_null() {
            bail!("failed to resolve window handle");
        }

        let sources = validate_file_operation_sources(request.sources)?;
        let destination = validate_background_path(request.destination)?;
        let destination_item = shell_item_from_path(&destination)?;
        let operation: IFileOperation =
            unsafe { CoCreateInstance(&FileOperation, None, CLSCTX_ALL) }
                .context("failed to create Windows file operation")?;

        unsafe {
            operation
                .SetOwnerWindow(hwnd)
                .context("failed to set file operation owner window")?;
            operation
                .SetOperationFlags(system_file_operation_flags())
                .context("failed to configure Windows file operation")?;
        }

        for source in sources {
            let source_item = shell_item_from_path(&source)?;
            unsafe {
                match request.operation {
                    SystemFileOperationKind::Copy => operation
                        .CopyItem(
                            &source_item,
                            &destination_item,
                            PCWSTR::null(),
                            None::<&IFileOperationProgressSink>,
                        )
                        .with_context(|| {
                            format!("failed to queue copy for {}", source.display())
                        })?,
                    SystemFileOperationKind::Move => operation
                        .MoveItem(
                            &source_item,
                            &destination_item,
                            PCWSTR::null(),
                            None::<&IFileOperationProgressSink>,
                        )
                        .with_context(|| {
                            format!("failed to queue move for {}", source.display())
                        })?,
                }
            }
        }

        let perform_result = unsafe { operation.PerformOperations() };
        let aborted = unsafe { operation.GetAnyOperationsAborted() }
            .map(|value| value.as_bool())
            .unwrap_or(false);
        if aborted {
            return Ok(());
        }
        perform_result.context("Windows file operation failed")
    }

    fn bind_shell_selection(paths: &[PathBuf]) -> Result<ShellSelection> {
        let mut parent_folder = None;
        let mut child_pidls = Vec::with_capacity(paths.len());
        let mut absolute_pidls = Vec::with_capacity(paths.len());

        for path in paths {
            let absolute_pidl = OwnedPidl::parse(path)?;
            let mut child_pidl = null_mut();
            let folder: IShellFolder = unsafe {
                SHBindToParent(absolute_pidl.0.cast_const(), Some(&mut child_pidl)).with_context(
                    || format!("failed to bind shell parent for {}", path.display()),
                )?
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
            parent_folder: parent_folder
                .ok_or_else(|| anyhow!("no local paths available for native context menu"))?,
            child_pidls,
            _absolute_pidls: absolute_pidls,
        })
    }

    fn invoke_command(
        context_menu: &IContextMenu,
        hwnd: HWND,
        command_id: u32,
        command_first: u32,
    ) -> Result<()> {
        let command_offset = command_id
            .checked_sub(command_first)
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
            hIcon: Default::default(),
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

    fn show_context_menu(context_menu: &IContextMenu, hwnd: HWND, x: i32, y: i32) -> Result<bool> {
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
                None,
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

        let _ = invoke_command(context_menu, hwnd, command_id, CMD_FIRST);
        Ok(true)
    }

    fn menu_text(value: &str) -> Vec<u16> {
        wide_null(OsStr::new(value))
    }

    fn append_menu_item(
        menu: HMENU,
        flags: MENU_ITEM_FLAGS,
        command_id: u32,
        label: &str,
    ) -> Result<()> {
        let label = menu_text(label);
        unsafe {
            AppendMenuW(
                menu,
                flags | MF_STRING,
                command_id as usize,
                PCWSTR(label.as_ptr()),
            )
            .ok()
            .with_context(|| format!("failed to append menu item {label:?}"))?;
        }
        Ok(())
    }

    fn append_menu_separator(menu: HMENU) -> Result<()> {
        unsafe {
            AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null())
                .ok()
                .context("failed to append menu separator")?;
        }
        Ok(())
    }

    fn append_submenu(parent: HMENU, submenu: HMENU, label: &str) -> Result<()> {
        let label = menu_text(label);
        unsafe {
            AppendMenuW(
                parent,
                MF_POPUP | MF_STRING,
                submenu.0 as usize,
                PCWSTR(label.as_ptr()),
            )
            .ok()
            .with_context(|| format!("failed to append submenu {label:?}"))?;
        }
        Ok(())
    }

    fn checked_flag(checked: bool) -> MENU_ITEM_FLAGS {
        if checked {
            MF_CHECKED
        } else {
            MENU_ITEM_FLAGS(0)
        }
    }

    fn enabled_flag(enabled: bool) -> MENU_ITEM_FLAGS {
        if enabled {
            MENU_ITEM_FLAGS(0)
        } else {
            MF_GRAYED
        }
    }

    fn create_attached_submenu(
        parent: HMENU,
        label: &str,
        build: impl FnOnce(HMENU) -> Result<()>,
    ) -> Result<()> {
        let submenu = unsafe { CreatePopupMenu().context("failed to create submenu")? };
        if let Err(error) = build(submenu).and_then(|_| append_submenu(parent, submenu, label)) {
            unsafe {
                let _ = DestroyMenu(submenu);
            }
            return Err(error);
        }
        Ok(())
    }

    fn append_background_view_menu(
        parent: HMENU,
        options: NativeBackgroundContextMenuOptions,
    ) -> Result<()> {
        create_attached_submenu(parent, "视图", |submenu| {
            append_menu_item(
                submenu,
                checked_flag(
                    options.view_mode == NativeBackgroundContextMenuViewMode::ExtraLargeIcons,
                ),
                BACKGROUND_CMD_VIEW_EXTRA_LARGE,
                "超大图标",
            )?;
            append_menu_item(
                submenu,
                checked_flag(options.view_mode == NativeBackgroundContextMenuViewMode::LargeIcons),
                BACKGROUND_CMD_VIEW_LARGE,
                "大图标",
            )?;
            append_menu_item(
                submenu,
                checked_flag(options.view_mode == NativeBackgroundContextMenuViewMode::MediumIcons),
                BACKGROUND_CMD_VIEW_MEDIUM,
                "中等图标",
            )?;
            append_menu_item(
                submenu,
                checked_flag(options.view_mode == NativeBackgroundContextMenuViewMode::SmallIcons),
                BACKGROUND_CMD_VIEW_SMALL,
                "小图标",
            )?;
            append_menu_item(
                submenu,
                checked_flag(options.view_mode == NativeBackgroundContextMenuViewMode::List),
                BACKGROUND_CMD_VIEW_LIST,
                "列表",
            )?;
            append_menu_item(
                submenu,
                checked_flag(options.view_mode == NativeBackgroundContextMenuViewMode::Details),
                BACKGROUND_CMD_VIEW_DETAILS,
                "详细信息列表",
            )?;
            append_menu_item(
                submenu,
                checked_flag(options.view_mode == NativeBackgroundContextMenuViewMode::Tiles),
                BACKGROUND_CMD_VIEW_TILES,
                "平铺",
            )?;
            append_menu_item(
                submenu,
                checked_flag(options.view_mode == NativeBackgroundContextMenuViewMode::Content),
                BACKGROUND_CMD_VIEW_CONTENT,
                "内容",
            )
        })
    }

    fn append_background_sort_menu(
        parent: HMENU,
        options: NativeBackgroundContextMenuOptions,
    ) -> Result<()> {
        create_attached_submenu(parent, "排序方式", |submenu| {
            append_menu_item(
                submenu,
                checked_flag(options.sort.column_id == NativeBackgroundContextMenuSortColumn::Name),
                BACKGROUND_CMD_SORT_NAME,
                "名称",
            )?;
            append_menu_item(
                submenu,
                checked_flag(
                    options.sort.column_id == NativeBackgroundContextMenuSortColumn::Modified,
                ),
                BACKGROUND_CMD_SORT_MODIFIED,
                "修改日期",
            )?;
            append_menu_item(
                submenu,
                checked_flag(options.sort.column_id == NativeBackgroundContextMenuSortColumn::Type),
                BACKGROUND_CMD_SORT_TYPE,
                "类型",
            )?;
            append_menu_item(
                submenu,
                checked_flag(options.sort.column_id == NativeBackgroundContextMenuSortColumn::Size),
                BACKGROUND_CMD_SORT_SIZE,
                "大小",
            )?;
            append_menu_separator(submenu)?;
            append_menu_item(
                submenu,
                checked_flag(
                    options.sort.direction == NativeBackgroundContextMenuSortDirection::Asc,
                ),
                BACKGROUND_CMD_SORT_ASC,
                "递增",
            )?;
            append_menu_item(
                submenu,
                checked_flag(
                    options.sort.direction == NativeBackgroundContextMenuSortDirection::Desc,
                ),
                BACKGROUND_CMD_SORT_DESC,
                "递减",
            )
        })
    }

    fn append_background_custom_menu_items(
        menu: HMENU,
        options: NativeBackgroundContextMenuOptions,
    ) -> Result<()> {
        append_menu_item(
            menu,
            MENU_ITEM_FLAGS(0),
            BACKGROUND_CMD_CREATE_FILE,
            "新建文件",
        )?;
        append_menu_item(
            menu,
            MENU_ITEM_FLAGS(0),
            BACKGROUND_CMD_CREATE_FOLDER,
            "新建文件夹",
        )?;
        append_background_view_menu(menu, options)?;
        append_background_sort_menu(menu, options)?;
        append_menu_item(
            menu,
            enabled_flag(options.can_paste),
            BACKGROUND_CMD_PASTE,
            "粘贴",
        )?;
        append_menu_separator(menu)
    }

    fn custom_background_action_for_command(
        command_id: u32,
    ) -> Option<NativeBackgroundContextMenuAction> {
        match command_id {
            BACKGROUND_CMD_CREATE_FILE => Some(NativeBackgroundContextMenuAction::CreateFile),
            BACKGROUND_CMD_CREATE_FOLDER => Some(NativeBackgroundContextMenuAction::CreateFolder),
            BACKGROUND_CMD_VIEW_EXTRA_LARGE => {
                Some(NativeBackgroundContextMenuAction::SetViewMode {
                    view_mode: NativeBackgroundContextMenuViewMode::ExtraLargeIcons,
                })
            }
            BACKGROUND_CMD_VIEW_LARGE => Some(NativeBackgroundContextMenuAction::SetViewMode {
                view_mode: NativeBackgroundContextMenuViewMode::LargeIcons,
            }),
            BACKGROUND_CMD_VIEW_MEDIUM => Some(NativeBackgroundContextMenuAction::SetViewMode {
                view_mode: NativeBackgroundContextMenuViewMode::MediumIcons,
            }),
            BACKGROUND_CMD_VIEW_SMALL => Some(NativeBackgroundContextMenuAction::SetViewMode {
                view_mode: NativeBackgroundContextMenuViewMode::SmallIcons,
            }),
            BACKGROUND_CMD_VIEW_LIST => Some(NativeBackgroundContextMenuAction::SetViewMode {
                view_mode: NativeBackgroundContextMenuViewMode::List,
            }),
            BACKGROUND_CMD_VIEW_DETAILS => Some(NativeBackgroundContextMenuAction::SetViewMode {
                view_mode: NativeBackgroundContextMenuViewMode::Details,
            }),
            BACKGROUND_CMD_VIEW_TILES => Some(NativeBackgroundContextMenuAction::SetViewMode {
                view_mode: NativeBackgroundContextMenuViewMode::Tiles,
            }),
            BACKGROUND_CMD_VIEW_CONTENT => Some(NativeBackgroundContextMenuAction::SetViewMode {
                view_mode: NativeBackgroundContextMenuViewMode::Content,
            }),
            BACKGROUND_CMD_SORT_NAME => Some(NativeBackgroundContextMenuAction::SetSort {
                column_id: Some(NativeBackgroundContextMenuSortColumn::Name),
                direction: None,
            }),
            BACKGROUND_CMD_SORT_MODIFIED => Some(NativeBackgroundContextMenuAction::SetSort {
                column_id: Some(NativeBackgroundContextMenuSortColumn::Modified),
                direction: None,
            }),
            BACKGROUND_CMD_SORT_TYPE => Some(NativeBackgroundContextMenuAction::SetSort {
                column_id: Some(NativeBackgroundContextMenuSortColumn::Type),
                direction: None,
            }),
            BACKGROUND_CMD_SORT_SIZE => Some(NativeBackgroundContextMenuAction::SetSort {
                column_id: Some(NativeBackgroundContextMenuSortColumn::Size),
                direction: None,
            }),
            BACKGROUND_CMD_SORT_ASC => Some(NativeBackgroundContextMenuAction::SetSort {
                column_id: None,
                direction: Some(NativeBackgroundContextMenuSortDirection::Asc),
            }),
            BACKGROUND_CMD_SORT_DESC => Some(NativeBackgroundContextMenuAction::SetSort {
                column_id: None,
                direction: Some(NativeBackgroundContextMenuSortDirection::Desc),
            }),
            BACKGROUND_CMD_PASTE => Some(NativeBackgroundContextMenuAction::Paste),
            _ => None,
        }
    }

    fn show_background_context_menu(
        context_menu: &IContextMenu,
        hwnd: HWND,
        x: i32,
        y: i32,
        options: NativeBackgroundContextMenuOptions,
    ) -> Result<NativeBackgroundContextMenuResult> {
        let popup = PopupMenu::create()?;
        append_background_custom_menu_items(popup.handle(), options)?;
        unsafe {
            context_menu
                .QueryContextMenu(
                    popup.handle(),
                    BACKGROUND_CUSTOM_TOP_ITEM_COUNT,
                    BACKGROUND_SHELL_CMD_FIRST,
                    CMD_LAST,
                    CMF_NORMAL,
                )
                .ok()
                .context("failed to populate shell background context menu")?;
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
                None,
            )
        }
        .0 as u32;
        let menu_last_error = unsafe { GetLastError() };
        unsafe {
            let _ = PostMessageW(Some(hwnd), WM_NULL, WPARAM(0), LPARAM(0));
        }

        if command_id == 0 {
            return Ok(NativeBackgroundContextMenuResult {
                opened: did_native_menu_open(command_id, menu_last_error),
                action: None,
            });
        }

        if let Some(action) = custom_background_action_for_command(command_id) {
            return Ok(NativeBackgroundContextMenuResult {
                opened: true,
                action: Some(action),
            });
        }

        let _ = invoke_command(context_menu, hwnd, command_id, BACKGROUND_SHELL_CMD_FIRST);
        Ok(NativeBackgroundContextMenuResult {
            opened: true,
            action: None,
        })
    }

    fn show_native_context_menu_inner(
        paths: Vec<String>,
        x: i32,
        y: i32,
        hwnd_raw: isize,
    ) -> Result<bool> {
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

        show_context_menu(&context_menu, hwnd, x, y)
    }

    fn start_system_file_drag_inner(
        paths: Vec<String>,
        hwnd_raw: isize,
        emit_position: Box<dyn Fn(i32, i32)>,
    ) -> Result<SystemFileClipboardMode> {
        let _com = ComGuard::init()?;
        let hwnd = HWND(hwnd_raw as *mut std::ffi::c_void);
        if hwnd.0.is_null() {
            bail!("failed to resolve window handle");
        }

        let validated_paths = validate_paths(paths)?;
        let selection = bind_shell_selection(&validated_paths)?;
        let data_object: IDataObject = unsafe {
            selection
                .parent_folder
                .GetUIObjectOf(hwnd, &selection.child_pidls, None)
                .context("failed to bind shell selection to drag data object")?
        };
        let drop_source: IDropSource = FileDragSource {
            hwnd,
            emit_position,
        }
        .into();
        let allowed_effects = system_file_drag_allowed_effects();
        let effect = unsafe {
            SHDoDragDrop(Some(hwnd), &data_object, &drop_source, allowed_effects)
                .context("system file drag operation failed")?
        };

        if effect == DROPEFFECT_NONE {
            bail!("system file drag operation was cancelled");
        }

        Ok(mode_from_drop_effect(effect.0))
    }

    fn system_file_drag_allowed_effects() -> DROPEFFECT {
        DROPEFFECT_COPY
    }

    fn show_native_background_context_menu_inner(
        directory_path: String,
        x: i32,
        y: i32,
        options: NativeBackgroundContextMenuOptions,
        hwnd_raw: isize,
    ) -> Result<NativeBackgroundContextMenuResult> {
        let _com = ComGuard::init()?;
        let hwnd = HWND(hwnd_raw as *mut std::ffi::c_void);
        let directory = validate_background_path(directory_path)?;
        let absolute_pidl = OwnedPidl::parse(&directory)?;
        let mut child_pidl = null_mut();
        let parent_folder: IShellFolder = unsafe {
            SHBindToParent(absolute_pidl.0.cast_const(), Some(&mut child_pidl)).with_context(
                || format!("failed to bind shell parent for {}", directory.display()),
            )?
        };
        if child_pidl.is_null() {
            bail!(
                "failed to resolve shell directory item {}",
                directory.display()
            );
        }
        let folder: IShellFolder = unsafe {
            parent_folder
                .BindToObject(child_pidl.cast_const(), None)
                .with_context(|| format!("failed to bind shell folder {}", directory.display()))?
        };
        let context_menu: IContextMenu = unsafe {
            folder
                .CreateViewObject(hwnd)
                .context("failed to bind shell folder background to context menu")?
        };

        show_background_context_menu(&context_menu, hwnd, x, y, options)
    }

    pub async fn show_native_context_menu<R: Runtime>(
        paths: Vec<String>,
        x: i32,
        y: i32,
        window: &Window<R>,
    ) -> Result<bool> {
        let hwnd = window
            .hwnd()
            .context("failed to resolve Tauri window handle")?;
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

    pub async fn start_system_file_drag<R: Runtime>(
        paths: Vec<String>,
        window: &Window<R>,
    ) -> Result<SystemFileClipboardMode> {
        let hwnd = window
            .hwnd()
            .context("failed to resolve Tauri window handle")?;
        let hwnd_raw = hwnd.0 as isize;
        let emit_window = window.clone();
        let (sender, receiver) = tokio::sync::oneshot::channel();

        window
            .run_on_main_thread(move || {
                // Bridges the live OLE drag cursor position back to the WebView.
                // `emit` evaluates through WebView2 ExecuteScript, which does not
                // depend on the tao event loop that SHDoDragDrop has blocked, so
                // these reach JS live (unlike the buffered onDragDropEvent stream).
                let emit_position: Box<dyn Fn(i32, i32)> = Box::new(move |x, y| {
                    let _ = emit_window.emit("system_drag_position", [x, y]);
                });
                let _ = sender.send(start_system_file_drag_inner(paths, hwnd_raw, emit_position));
            })
            .context("failed to schedule system file drag on the Tauri main thread")?;

        receiver
            .await
            .map_err(|_| anyhow!("system file drag main-thread task was canceled"))?
    }

    pub async fn perform_system_file_operation<R: Runtime>(
        request: SystemFileOperationRequest,
        window: &Window<R>,
    ) -> Result<()> {
        let hwnd = window
            .hwnd()
            .context("failed to resolve Tauri window handle")?;
        let hwnd_raw = hwnd.0 as isize;

        tauri::async_runtime::spawn_blocking(move || {
            perform_system_file_operation_inner(request, hwnd_raw)
        })
        .await
        .map_err(|_| anyhow!("system file operation task was canceled"))?
    }

    pub async fn show_native_background_context_menu<R: Runtime>(
        directory_path: String,
        x: i32,
        y: i32,
        options: NativeBackgroundContextMenuOptions,
        window: &Window<R>,
    ) -> Result<NativeBackgroundContextMenuResult> {
        let hwnd = window
            .hwnd()
            .context("failed to resolve Tauri window handle")?;
        let hwnd_raw = hwnd.0 as isize;
        let (sender, receiver) = tokio::sync::oneshot::channel();

        window
            .run_on_main_thread(move || {
                let _ = sender.send(show_native_background_context_menu_inner(
                    directory_path,
                    x,
                    y,
                    options,
                    hwnd_raw,
                ));
            })
            .context(
                "failed to schedule native background context menu on the Tauri main thread",
            )?;

        receiver
            .await
            .map_err(|_| anyhow!("native background context menu main-thread task was canceled"))?
    }

    #[cfg(test)]
    mod tests {
        use anyhow::Result;

        use crate::domain::models::{
            NativeBackgroundContextMenuAction, NativeBackgroundContextMenuSortColumn,
            NativeBackgroundContextMenuSortDirection, NativeBackgroundContextMenuViewMode,
            SystemFileClipboardMode,
        };
        use windows::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_SUCCESS};
        use windows::Win32::System::Ole::{DROPEFFECT_COPY, DROPEFFECT_MOVE};
        use windows::Win32::System::SystemServices::{
            SECURITY_MANDATORY_HIGH_RID, SECURITY_MANDATORY_LOW_RID, SECURITY_MANDATORY_MEDIUM_RID,
            SECURITY_MANDATORY_SYSTEM_RID,
        };
        use windows::Win32::UI::Shell::DROPFILES;

        use super::{
            build_drop_effect_payload, build_hdrop_payload, custom_background_action_for_command,
            did_native_menu_open, explorer_to_app_drag_blocked, integrity_level_name,
            mode_from_drop_effect, resolve_navigation_target, system_file_drag_allowed_effects,
            validate_background_path, validate_paths, validate_shell_execute_result,
            validate_system_default_open_path, NavigationOpenValidationError,
            BACKGROUND_CMD_CREATE_FILE, BACKGROUND_CMD_PASTE, BACKGROUND_CMD_SORT_DESC,
            BACKGROUND_CMD_SORT_SIZE, BACKGROUND_CMD_VIEW_TILES,
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
        fn hdrop_payload_uses_wide_dropfiles_header_and_double_null_path_list() -> Result<()> {
            let paths = vec![
                "D:\\Projects\\Atlas\\README.md".to_string(),
                "D:\\Projects\\Atlas\\src".to_string(),
            ];

            let payload = build_hdrop_payload(&paths)?;
            let header_size = std::mem::size_of::<DROPFILES>();
            assert!(payload.len() > header_size);

            let header = unsafe { std::ptr::read_unaligned(payload.as_ptr().cast::<DROPFILES>()) };
            let pfiles = header.pFiles;
            let fwide = header.fWide;
            assert_eq!(pfiles, header_size as u32);
            assert_eq!(fwide.as_bool(), true);

            let path_bytes = &payload[header_size..];
            assert_eq!(path_bytes.len() % std::mem::size_of::<u16>(), 0);
            let wide_values = path_bytes
                .chunks_exact(std::mem::size_of::<u16>())
                .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
                .collect::<Vec<_>>();
            assert!(wide_values.ends_with(&[0, 0]));

            let decoded = wide_values
                .split(|value| *value == 0)
                .filter(|item| !item.is_empty())
                .map(String::from_utf16_lossy)
                .collect::<Vec<_>>();
            assert_eq!(decoded, paths);
            Ok(())
        }

        #[test]
        fn drop_effect_payload_maps_copy_cut_and_move_precedence() {
            assert_eq!(
                u32::from_le_bytes(build_drop_effect_payload(SystemFileClipboardMode::Copy)),
                DROPEFFECT_COPY.0
            );
            assert_eq!(
                u32::from_le_bytes(build_drop_effect_payload(SystemFileClipboardMode::Cut)),
                DROPEFFECT_MOVE.0
            );
            assert_eq!(
                mode_from_drop_effect(DROPEFFECT_COPY.0),
                SystemFileClipboardMode::Copy
            );
            assert_eq!(
                mode_from_drop_effect(DROPEFFECT_MOVE.0),
                SystemFileClipboardMode::Cut
            );
            assert_eq!(
                mode_from_drop_effect(DROPEFFECT_COPY.0 | DROPEFFECT_MOVE.0),
                SystemFileClipboardMode::Cut
            );
        }

        #[test]
        fn system_file_drag_out_allows_copy_only() {
            assert_eq!(system_file_drag_allowed_effects(), DROPEFFECT_COPY);
        }

        #[test]
        fn drag_drop_environment_marks_elevated_or_high_integrity_as_blocking_explorer_drops() {
            assert_eq!(integrity_level_name(0), "untrusted");
            assert_eq!(
                integrity_level_name(SECURITY_MANDATORY_LOW_RID as u32),
                "low"
            );
            assert_eq!(
                integrity_level_name(SECURITY_MANDATORY_MEDIUM_RID as u32),
                "medium"
            );
            assert_eq!(
                integrity_level_name(SECURITY_MANDATORY_HIGH_RID as u32),
                "high"
            );
            assert_eq!(
                integrity_level_name(SECURITY_MANDATORY_SYSTEM_RID as u32),
                "system"
            );

            assert!(!explorer_to_app_drag_blocked(
                false,
                SECURITY_MANDATORY_MEDIUM_RID as u32
            ));
            assert!(explorer_to_app_drag_blocked(
                true,
                SECURITY_MANDATORY_MEDIUM_RID as u32
            ));
            assert!(explorer_to_app_drag_blocked(
                false,
                SECURITY_MANDATORY_HIGH_RID as u32
            ));
        }

        #[test]
        fn validate_paths_rejects_remote_inputs() {
            assert!(validate_paths(vec!["sftp://deploy@example/root".into()]).is_err());
        }

        #[test]
        fn custom_background_menu_commands_map_to_frontend_actions() {
            assert_eq!(
                custom_background_action_for_command(BACKGROUND_CMD_CREATE_FILE),
                Some(NativeBackgroundContextMenuAction::CreateFile)
            );
            assert_eq!(
                custom_background_action_for_command(BACKGROUND_CMD_VIEW_TILES),
                Some(NativeBackgroundContextMenuAction::SetViewMode {
                    view_mode: NativeBackgroundContextMenuViewMode::Tiles
                })
            );
            assert_eq!(
                custom_background_action_for_command(BACKGROUND_CMD_SORT_SIZE),
                Some(NativeBackgroundContextMenuAction::SetSort {
                    column_id: Some(NativeBackgroundContextMenuSortColumn::Size),
                    direction: None
                })
            );
            assert_eq!(
                custom_background_action_for_command(BACKGROUND_CMD_SORT_DESC),
                Some(NativeBackgroundContextMenuAction::SetSort {
                    column_id: None,
                    direction: Some(NativeBackgroundContextMenuSortDirection::Desc)
                })
            );
            assert_eq!(
                custom_background_action_for_command(BACKGROUND_CMD_PASTE),
                Some(NativeBackgroundContextMenuAction::Paste)
            );
            assert_eq!(custom_background_action_for_command(9999), None);
        }

        #[test]
        fn validate_background_path_accepts_existing_local_directories_only() -> Result<()> {
            let temp = std::env::temp_dir().join(format!(
                "simplefilemanager-background-menu-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&temp)?;
            let file = temp.join("a.txt");
            std::fs::write(&file, "a")?;

            let directory = validate_background_path(temp.to_string_lossy().into_owned())?;
            let file_result = validate_background_path(file.to_string_lossy().into_owned());
            let remote_result = validate_background_path("sftp://deploy@example/root".into());

            let _ = std::fs::remove_dir_all(&temp);
            assert_eq!(
                directory.to_string_lossy().replace('/', "\\"),
                temp.to_string_lossy().replace('/', "\\")
            );
            assert!(file_result.is_err());
            assert!(remote_result.is_err());
            Ok(())
        }

        #[test]
        fn resolve_navigation_target_reports_remote_unsupported_without_touching_shell() {
            let info = resolve_navigation_target("sftp://deploy@example/root")
                .expect("target should resolve as unsupported");

            assert_eq!(
                info.target_kind,
                crate::domain::models::NavigationTargetKind::RemoteUnsupported
            );
            assert_eq!(
                info.target_status,
                crate::domain::models::NavigationTargetStatus::UnsupportedRemote
            );
            assert!(!info.exists);
            assert!(!info.is_local);
        }

        #[test]
        fn resolve_navigation_target_rejects_empty_relative_and_url_inputs() {
            for path in [
                "",
                "relative\\file.txt",
                "https://example.com/file.txt",
                "mailto:test@example.com",
            ] {
                let info =
                    resolve_navigation_target(path).expect("invalid targets should be classified");
                assert_eq!(
                    info.target_status,
                    crate::domain::models::NavigationTargetStatus::InvalidPath
                );
                assert_eq!(info.exists, false);
            }
        }

        #[test]
        fn resolve_navigation_target_reports_existing_files_and_folders() -> Result<()> {
            let temp = std::env::temp_dir().join(format!(
                "simplefilemanager-navigation-target-{}",
                uuid::Uuid::new_v4()
            ));
            let folder = temp.join("docs");
            let file = folder.join("readme.txt");
            std::fs::create_dir_all(&folder)?;
            std::fs::write(&file, "readme")?;

            let folder_info = resolve_navigation_target(&folder.to_string_lossy())?;
            let file_info = resolve_navigation_target(&file.to_string_lossy())?;

            let _ = std::fs::remove_dir_all(&temp);
            assert_eq!(
                folder_info.target_kind,
                crate::domain::models::NavigationTargetKind::Folder
            );
            assert_eq!(
                folder_info.target_status,
                crate::domain::models::NavigationTargetStatus::Ok
            );
            assert_eq!(
                file_info.target_kind,
                crate::domain::models::NavigationTargetKind::File
            );
            assert_eq!(
                file_info.parent_path.as_deref(),
                Some(folder.to_string_lossy().as_ref())
            );
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
            let temp = std::env::temp_dir().join(format!(
                "simplefilemanager-native-menu-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&temp)?;
            let local_file = temp.join("a.txt");
            std::fs::write(&local_file, "a")?;

            let result = validate_paths(vec![
                local_file.to_string_lossy().into_owned(),
                "ftp://deploy@example/root/b.txt".into(),
            ]);

            let _ = std::fs::remove_dir_all(&temp);
            assert!(result.is_err());
            Ok(())
        }

        #[test]
        fn validate_paths_rejects_mixed_parent_directories() -> Result<()> {
            let temp = std::env::temp_dir().join(format!(
                "simplefilemanager-native-menu-{}",
                uuid::Uuid::new_v4()
            ));
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
                right_file.to_string_lossy().into_owned(),
            ]);

            let _ = std::fs::remove_dir_all(&temp);
            assert!(result.is_err());
            Ok(())
        }

        #[test]
        fn validate_paths_accepts_multiple_items_from_same_parent() -> Result<()> {
            let temp = std::env::temp_dir().join(format!(
                "simplefilemanager-native-menu-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&temp)?;
            let first_file = temp.join("a.txt");
            let second_file = temp.join("b.txt");
            std::fs::write(&first_file, "a")?;
            std::fs::write(&second_file, "b")?;

            let result = validate_paths(vec![
                first_file.to_string_lossy().into_owned(),
                second_file.to_string_lossy().into_owned(),
            ])?;

            let _ = std::fs::remove_dir_all(&temp);
            assert_eq!(result.len(), 2);
            Ok(())
        }

        #[test]
        fn validate_paths_keeps_shell_friendly_non_verbatim_paths() -> Result<()> {
            let temp = std::env::temp_dir().join(format!(
                "simplefilemanager-native-menu-{}",
                uuid::Uuid::new_v4()
            ));
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
    get_windows_drag_drop_environment, open_path_with_system_default,
    perform_system_file_operation, read_system_file_clipboard, resolve_navigation_target,
    set_system_file_clipboard, show_native_background_context_menu, show_native_context_menu,
    start_system_file_drag,
};

#[cfg(not(windows))]
pub async fn show_native_context_menu<R: tauri::Runtime>(
    _paths: Vec<String>,
    _x: i32,
    _y: i32,
    _window: &tauri::Window<R>,
) -> anyhow::Result<bool> {
    anyhow::bail!("native context menu is only supported on Windows")
}

#[cfg(not(windows))]
pub async fn show_native_background_context_menu<R: tauri::Runtime>(
    _directory_path: String,
    _x: i32,
    _y: i32,
    _options: crate::domain::models::NativeBackgroundContextMenuOptions,
    _window: &tauri::Window<R>,
) -> anyhow::Result<crate::domain::models::NativeBackgroundContextMenuResult> {
    anyhow::bail!("native background context menu is only supported on Windows")
}

#[cfg(not(windows))]
pub fn resolve_navigation_target(
    raw: &str,
) -> anyhow::Result<crate::domain::models::NavigationTargetInfo> {
    use crate::domain::models::{
        NavigationTargetInfo, NavigationTargetKind, NavigationTargetStatus,
    };

    let trimmed = raw.trim();
    if navigation::is_remote_path(trimmed) {
        return Ok(NavigationTargetInfo {
            path: trimmed.into(),
            normalized_path: None,
            canonical_path: None,
            display_name: trimmed.into(),
            target_kind: NavigationTargetKind::RemoteUnsupported,
            target_status: NavigationTargetStatus::UnsupportedRemote,
            message: Some(
                "remote navigation targets are not supported by system shell operations yet".into(),
            ),
            exists: false,
            is_local: false,
            parent_path: None,
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
        parent_path: None,
    })
}

#[cfg(not(windows))]
pub fn validate_system_default_open_path(
    _path: &str,
) -> std::result::Result<std::path::PathBuf, NavigationOpenValidationError> {
    Err(NavigationOpenValidationError::InvalidPath)
}

#[cfg(not(windows))]
pub fn open_path_with_system_default(_path: String) -> anyhow::Result<()> {
    anyhow::bail!("system default open is only supported on Windows")
}

#[cfg(not(windows))]
pub fn set_system_file_clipboard(
    _paths: Vec<String>,
    _mode: crate::domain::models::SystemFileClipboardMode,
) -> anyhow::Result<()> {
    anyhow::bail!("system file clipboard is only supported on Windows")
}

#[cfg(not(windows))]
pub fn read_system_file_clipboard(
) -> anyhow::Result<Option<crate::domain::models::SystemFileClipboard>> {
    Ok(None)
}

#[cfg(not(windows))]
pub fn get_windows_drag_drop_environment(
) -> anyhow::Result<crate::domain::models::WindowsDragDropEnvironment> {
    Ok(crate::domain::models::WindowsDragDropEnvironment {
        is_elevated: false,
        integrity_level: "unsupported".into(),
        explorer_to_app_drag_blocked: false,
        message: None,
    })
}

#[cfg(not(windows))]
pub async fn start_system_file_drag<R: tauri::Runtime>(
    _paths: Vec<String>,
    _window: &tauri::Window<R>,
) -> anyhow::Result<crate::domain::models::SystemFileClipboardMode> {
    anyhow::bail!("system file drag is only supported on Windows")
}

#[cfg(not(windows))]
pub async fn perform_system_file_operation<R: tauri::Runtime>(
    _request: crate::domain::models::SystemFileOperationRequest,
    _window: &tauri::Window<R>,
) -> anyhow::Result<()> {
    anyhow::bail!("system file operations are only supported on Windows")
}

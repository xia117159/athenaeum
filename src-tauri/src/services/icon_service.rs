use anyhow::{bail, Result};
use base64::engine::general_purpose::STANDARD;

use crate::domain::models::{
    FileSystemIconKind, SystemIconBitmap, SystemIconImageList, SystemIconRequest,
};

fn normalize_extension(extension: Option<&str>) -> String {
    let normalized = extension.unwrap_or_default().trim().to_lowercase();
    if normalized.is_empty() {
        return String::new();
    }

    if normalized.starts_with('.') {
        normalized
    } else {
        format!(".{normalized}")
    }
}

fn infer_image_list_from_size(size: u32) -> SystemIconImageList {
    if size <= 16 {
        SystemIconImageList::Small
    } else if size <= 32 {
        SystemIconImageList::Large
    } else if size <= 48 {
        SystemIconImageList::ExtraLarge
    } else {
        SystemIconImageList::Jumbo
    }
}

fn resolve_image_list(request: &SystemIconRequest) -> SystemIconImageList {
    request
        .image_list
        .unwrap_or_else(|| infer_image_list_from_size(request.size))
}

fn image_list_cache_segment(image_list: SystemIconImageList) -> &'static str {
    match image_list {
        SystemIconImageList::SysSmall => "sys-small",
        SystemIconImageList::Small => "small",
        SystemIconImageList::Large => "large",
        SystemIconImageList::ExtraLarge => "extra-large",
        SystemIconImageList::Jumbo => "jumbo",
    }
}

/// Returns true when the path looks like a local Windows filesystem path
/// (drive-letter or UNC), so that shell overlay handlers can be invoked.
pub fn is_local_path(path: Option<&str>) -> bool {
    let path = match path {
        Some(p) => p.trim(),
        None => return false,
    };
    if path.is_empty() {
        return false;
    }
    // Remote URIs (sftp://, ftp://) are not local filesystem.
    if path.contains("://") {
        return false;
    }
    // Windows drive-letter paths (C:\, D:\) and UNC paths (\\server\share).
    let len = path.len();
    if len >= 3 {
        let bytes = path.as_bytes();
        if bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/') {
            return true;
        }
    }
    path.starts_with(r"\\")
}

/// Returns true when the request wants path-specific shell overlays and the
/// path is a real local filesystem path.
fn wants_overlay(request: &SystemIconRequest) -> bool {
    request.include_overlays
        && matches!(request.kind, FileSystemIconKind::File | FileSystemIconKind::Folder)
        && is_local_path(request.path.as_deref())
}

fn normalize_local_path(path: &str) -> String {
    path.trim().to_lowercase()
}

pub fn cache_key_for_request(request: &SystemIconRequest) -> String {
    let image_list = image_list_cache_segment(resolve_image_list(request));

    if wants_overlay(request) {
        let normalized_path = normalize_local_path(request.path.as_deref().unwrap_or(""));
        let kind_segment = match request.kind {
            FileSystemIconKind::File => "file",
            FileSystemIconKind::Folder => "folder",
            FileSystemIconKind::Drive => "drive",
            FileSystemIconKind::RemoteRoot => "remote-root",
        };
        return format!("{kind_segment}-overlay:{normalized_path}:{image_list}");
    }

    match request.kind {
        FileSystemIconKind::File => {
            let extension = normalize_extension(request.extension.as_deref());
            format!(
                "file:{}:{image_list}",
                if extension.is_empty() {
                    "__default__"
                } else {
                    &extension
                }
            )
        }
        FileSystemIconKind::Drive => format!(
            "drive:{}:{image_list}",
            request
                .path
                .as_deref()
                .unwrap_or("C:\\")
                .trim()
                .to_uppercase()
        ),
        FileSystemIconKind::RemoteRoot => format!("remote-root:{image_list}"),
        FileSystemIconKind::Folder => format!("folder:{image_list}"),
    }
}

#[cfg(windows)]
mod platform {
    use std::{mem::size_of, ptr::null_mut, slice};

    use anyhow::{anyhow, bail, Result};
    use base64::Engine as _;
    use windows::{
        core::{Interface, PCWSTR},
        Win32::{
            Foundation::{COLORREF, GetLastError},
            Graphics::Gdi::{
                CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
                SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
            },
            Storage::FileSystem::{
                FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_FLAGS_AND_ATTRIBUTES,
            },
            System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
            UI::{
                Controls::{HIMAGELIST, IImageList, ILD_TRANSPARENT, IMAGELISTDRAWPARAMS},
                Shell::{
                    SHGetFileInfoW, SHGetImageList, SHFILEINFOW, SHGFI_FLAGS, SHGFI_ICON,
                    SHGFI_LARGEICON, SHGFI_OVERLAYINDEX, SHGFI_SMALLICON, SHGFI_SYSICONINDEX,
                    SHGFI_USEFILEATTRIBUTES, SHIL_EXTRALARGE, SHIL_JUMBO, SHIL_LARGE, SHIL_SMALL,
                    SHIL_SYSSMALL,
                },
                WindowsAndMessaging::{DestroyIcon, DrawIconEx, DI_NORMAL, HICON},
            },
        },
    };

    use crate::domain::models::{
        FileSystemIconKind, SystemIconBitmap, SystemIconImageList, SystemIconRequest,
    };

    struct IconLookup {
        path: String,
        attributes: FILE_FLAGS_AND_ATTRIBUTES,
        image_list: SystemIconImageList,
        use_real_path: bool,
    }

    fn to_wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// RAII guard that initializes COM on the current thread and uninitializes
    /// it when dropped.  Shell overlay handlers are COM objects, so COM must be
    /// initialized before `SHGetFileInfoW` with `SHGFI_OVERLAYINDEX`.
    struct ComGuard;
    impl ComGuard {
        fn new() -> Self {
            // COINIT_APARTMENTTHREADED (STA) is required by most shell
            // extensions.  If COM is already initialized on this thread the
            // call returns S_FALSE (harmless).  If it was initialized as MTA
            // the call returns RPC_E_CHANGED_MODE – we ignore that and proceed;
            // the overlay lookup may still work in some cases.
            let _hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            ComGuard
        }
    }
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    /// Calls `SHGetFileInfoW` and returns the populated `SHFILEINFOW` on
    /// success, or the Win32 error on failure.
    fn call_shgetfileinfo(
        wide_path: &[u16],
        attributes: FILE_FLAGS_AND_ATTRIBUTES,
        flags: SHGFI_FLAGS,
    ) -> std::result::Result<SHFILEINFOW, u32> {
        let mut info = SHFILEINFOW::default();
        let result = unsafe {
            SHGetFileInfoW(
                PCWSTR(wide_path.as_ptr()),
                attributes,
                Some(&mut info),
                size_of::<SHFILEINFOW>() as u32,
                flags,
            )
        };
        if result == 0 {
            Err(unsafe { GetLastError().0 })
        } else {
            Ok(info)
        }
    }

    /// Returns true if the path is a drive root, e.g. `C:\` or `D:\`.
    /// Drive roots always exist and need SHGetFileInfoW without
    /// SHGFI_USEFILEATTRIBUTES to get the correct drive-type icon.
    fn is_drive_root(path: &str) -> bool {
        path.len() == 3
            && path.as_bytes().get(1) == Some(&b':')
            && (path.as_bytes().get(2) == Some(&b'\\') || path.as_bytes().get(2) == Some(&b'/'))
    }

    fn build_lookup(request: &SystemIconRequest) -> IconLookup {
        let image_list = super::resolve_image_list(request);
        let use_real_path = super::wants_overlay(request);

        match request.kind {
            FileSystemIconKind::Drive => IconLookup {
                path: request.path.clone().unwrap_or_else(|| "C:\\".to_string()),
                attributes: FILE_ATTRIBUTE_DIRECTORY,
                image_list,
                use_real_path: false,
            },
            FileSystemIconKind::Folder | FileSystemIconKind::RemoteRoot => IconLookup {
                path: request.path.clone().unwrap_or_else(|| "folder".to_string()),
                attributes: FILE_ATTRIBUTE_DIRECTORY,
                image_list,
                use_real_path,
            },
            FileSystemIconKind::File => {
                if use_real_path {
                    IconLookup {
                        path: request.path.clone().unwrap_or_else(|| "placeholder".to_string()),
                        attributes: FILE_ATTRIBUTE_NORMAL,
                        image_list,
                        use_real_path: true,
                    }
                } else {
                    let extension = super::normalize_extension(request.extension.as_deref());
                    let placeholder = if extension.is_empty() {
                        "placeholder".to_string()
                    } else {
                        format!("placeholder{extension}")
                    };

                    IconLookup {
                        path: placeholder,
                        attributes: FILE_ATTRIBUTE_NORMAL,
                        image_list,
                        use_real_path: false,
                    }
                }
            }
        }
    }

    fn image_list_kind_for_variant(image_list: SystemIconImageList) -> i32 {
        match image_list {
            SystemIconImageList::SysSmall => SHIL_SYSSMALL as i32,
            SystemIconImageList::Small => SHIL_SMALL as i32,
            SystemIconImageList::Large => SHIL_LARGE as i32,
            SystemIconImageList::ExtraLarge => SHIL_EXTRALARGE as i32,
            SystemIconImageList::Jumbo => SHIL_JUMBO as i32,
        }
    }

    fn image_list_icon_size(image_list: &IImageList) -> Result<u32> {
        let mut width = 0;
        let mut height = 0;
        unsafe {
            image_list
                .GetIconSize(&mut width, &mut height)
                .map_err(|error| {
                    anyhow!("failed to query Windows system image list size: {error}")
                })?;
        }

        if width <= 0 || height <= 0 {
            bail!("Windows system image list reported an invalid icon size");
        }

        Ok(width.max(height) as u32)
    }

    /// Converts an overlay index (stored in the upper 8 bits of `iIcon` when
    /// `SHGFI_OVERLAYINDEX` is used) into the mask expected by
    /// `IImageList::Draw` and `IImageList::GetIcon`.
    /// This replicates the Win32 `INDEXTOOVERLAYMASK` macro: `(index << 8)`.
    fn overlay_mask_from_icon_index(icon_index: i32) -> u32 {
        let overlay_index = (icon_index >> 24) & 0xFF;
        if overlay_index > 0 {
            (overlay_index as u32) << 8
        } else {
            0
        }
    }

    /// Extracts the overlay index (upper 8 bits) and the clean icon index
    /// (lower 24 bits) from the `iIcon` value returned by `SHGetFileInfoW`
    /// when `SHGFI_OVERLAYINDEX` is used.
    fn split_icon_and_overlay(icon_index: i32) -> (i32, u32) {
        let overlay_mask = overlay_mask_from_icon_index(icon_index);
        let clean_icon_index = icon_index & 0x00FFFFFF;
        (clean_icon_index, overlay_mask)
    }

    /// Draws an icon with its shell overlay directly onto a 32-bit RGBA DIB
    /// section using `IImageList::Draw`, which is the Microsoft-recommended
    /// method for rendering overlay icons.  Returns the RGBA pixel buffer.
    fn render_icon_with_overlay_draw(
        image_list: &IImageList,
        icon_index: i32,
        overlay_mask: u32,
        size: u32,
    ) -> Result<Vec<u8>> {
        let screen_dc = unsafe { GetDC(None) };
        if screen_dc.0.is_null() {
            bail!("failed to acquire screen device context");
        }

        let memory_dc = unsafe { CreateCompatibleDC(Some(screen_dc)) };
        if memory_dc.0.is_null() {
            unsafe { ReleaseDC(None, screen_dc) };
            bail!("failed to create memory device context");
        }

        let mut pixels = null_mut();
        let mut bitmap_info = BITMAPINFO::default();
        bitmap_info.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
        bitmap_info.bmiHeader.biWidth = size as i32;
        bitmap_info.bmiHeader.biHeight = -(size as i32);
        bitmap_info.bmiHeader.biPlanes = 1;
        bitmap_info.bmiHeader.biBitCount = 32;
        bitmap_info.bmiHeader.biCompression = BI_RGB.0;

        let result = (|| -> Result<Vec<u8>> {
            let dib = unsafe {
                CreateDIBSection(
                    Some(screen_dc),
                    &bitmap_info,
                    DIB_RGB_COLORS,
                    &mut pixels,
                    None,
                    0,
                )
            }?;
            let dib_object = HGDIOBJ(dib.0);
            let previous = unsafe { SelectObject(memory_dc, dib_object) };
            let byte_len = (size * size * 4) as usize;

            unsafe {
                std::ptr::write_bytes(pixels, 0, byte_len);
            }

            let draw_params = IMAGELISTDRAWPARAMS {
                cbSize: size_of::<IMAGELISTDRAWPARAMS>() as u32,
                himl: HIMAGELIST(image_list.as_raw() as isize),
                i: icon_index,
                hdcDst: memory_dc,
                x: 0,
                y: 0,
                cx: size as i32,
                cy: size as i32,
                xBitmap: 0,
                yBitmap: 0,
                rgbBk: COLORREF(0xFFFFFFFF), // CLR_NONE – transparent background
                rgbFg: COLORREF(0xFF000000), // CLR_DEFAULT – default foreground
                fStyle: ILD_TRANSPARENT.0 | overlay_mask,
                dwRop: 0,
                fState: 0,
                Frame: 0,
                crEffect: COLORREF(0),
            };

            let draw_result = unsafe { image_list.Draw(&draw_params) };

            let mut rgba = if draw_result.is_ok() {
                unsafe { slice::from_raw_parts(pixels.cast::<u8>(), byte_len) }.to_vec()
            } else {
                Vec::new()
            };

            unsafe {
                SelectObject(memory_dc, previous);
                let _ = DeleteObject(dib_object);
            }

            if rgba.is_empty() {
                return Err(anyhow!(
                    "IImageList::Draw failed for icon index {icon_index} with overlay mask 0x{overlay_mask:X}"
                ));
            }

            // BGRA → RGBA
            for chunk in rgba.chunks_exact_mut(4) {
                chunk.swap(0, 2);
            }

            Ok(rgba)
        })();

        unsafe {
            let _ = DeleteDC(memory_dc);
            ReleaseDC(None, screen_dc);
        }

        result
    }

    /// Result of resolving an icon: either an HICON to render with DrawIconEx,
    /// or pre-rendered RGBA pixels (used when IImageList::Draw was used for
    /// overlay compositing).
    enum IconRenderResult {
        Hicon(HICON, u32),
        Rgba(Vec<u8>, u32),
    }

    fn load_hicon_from_lookup(lookup: &IconLookup, overlay: bool) -> Result<IconRenderResult> {
        let wide_path = to_wide(&lookup.path);

        if overlay {
            return load_overlay_icon(lookup, &wide_path);
        }

        // Non-overlay path: always use SHGFI_USEFILEATTRIBUTES except for
        // drive roots, so SHGetFileInfoW doesn't require the path to exist
        // on disk.  This is essential for mock/test paths and remote paths
        // that don't exist locally.
        let base_flags = if is_drive_root(&lookup.path) {
            SHGFI_SYSICONINDEX
        } else {
            SHGFI_SYSICONINDEX | SHGFI_USEFILEATTRIBUTES
        };

        let info = call_shgetfileinfo(&wide_path, lookup.attributes, base_flags)
            .map_err(|err| anyhow!("SHGetFileInfoW returned 0 for {} (GetLastError={err})", lookup.path))?;

        let image_list =
            unsafe { SHGetImageList::<IImageList>(image_list_kind_for_variant(lookup.image_list)) }
                .map_err(|error| anyhow!("failed to access Windows system image list: {error}"))?;

        let icon_size = image_list_icon_size(&image_list)?;

        let hicon = unsafe { image_list.GetIcon(info.iIcon, ILD_TRANSPARENT.0) }
            .map_err(|error| anyhow!("failed to extract Windows shell icon: {error}"))?;

        if hicon.is_invalid() {
            bail!("failed to extract Windows shell icon for {}", lookup.path);
        }

        Ok(IconRenderResult::Hicon(hicon, icon_size))
    }

    /// Overlay-aware icon loading.  Tries multiple strategies to obtain an
    /// icon with shell overlays (Git status, shortcut arrow, etc.).
    fn load_overlay_icon(lookup: &IconLookup, wide_path: &[u16]) -> Result<IconRenderResult> {
        // COM must be initialized for shell overlay handler lookups.
        let _com = ComGuard::new();

        // ---- Strategy 1: SHGFI_SYSICONINDEX | SHGFI_OVERLAYINDEX ----
        // Real-path lookup that invokes dynamic overlay handlers (Git, Dropbox,
        // etc.).  Requires the path to exist on disk.
        let flags1 = SHGFI_SYSICONINDEX | SHGFI_OVERLAYINDEX;
        match call_shgetfileinfo(wide_path, lookup.attributes, flags1) {
            Ok(info) => {
                return finish_overlay_from_sysiconindex(lookup, &info);
            }
            Err(_err) => {}
        }

        // ---- Strategy 2: SHGFI_ICON | SHGFI_OVERLAYINDEX ----
        // Alternative real-path lookup that returns a pre-composited HICON.
        // Some Windows configurations accept this when Strategy 1 fails.
        let size_flag = match lookup.image_list {
            SystemIconImageList::SysSmall | SystemIconImageList::Small => SHGFI_SMALLICON,
            _ => SHGFI_LARGEICON,
        };
        let flags2 = SHGFI_ICON | SHGFI_OVERLAYINDEX | size_flag;
        match call_shgetfileinfo(wide_path, lookup.attributes, flags2) {
            Ok(info) => {
                if !info.hIcon.is_invalid() {
                    return finish_overlay_from_hicon(lookup, &info);
                }
            }
            Err(_err) => {}
        }

        // ---- Strategy 3: SHGFI_SYSICONINDEX | SHGFI_OVERLAYINDEX | SHGFI_USEFILEATTRIBUTES ----
        // Static overlay lookup that does NOT access the filesystem.  This
        // won't invoke dynamic overlay handlers (Git, Dropbox), but it CAN
        // return static overlays like the shortcut arrow for .lnk files.
        // Works for paths that don't exist on disk.
        let flags3 = SHGFI_SYSICONINDEX | SHGFI_OVERLAYINDEX | SHGFI_USEFILEATTRIBUTES;
        match call_shgetfileinfo(wide_path, lookup.attributes, flags3) {
            Ok(info) => {
                return finish_overlay_from_sysiconindex(lookup, &info);
            }
            Err(_err) => {}
        }

        bail!("all overlay strategies failed for {}", lookup.path);
    }

    /// Completes overlay rendering from a successful SHGFI_SYSICONINDEX call.
    fn finish_overlay_from_sysiconindex(
        lookup: &IconLookup,
        info: &SHFILEINFOW,
    ) -> Result<IconRenderResult> {
        let image_list =
            unsafe { SHGetImageList::<IImageList>(image_list_kind_for_variant(lookup.image_list)) }
                .map_err(|error| anyhow!("failed to access Windows system image list: {error}"))?;
        let icon_size = image_list_icon_size(&image_list)?;
        let (clean_icon_index, overlay_mask) = split_icon_and_overlay(info.iIcon);

        if overlay_mask > 0 {
            // IImageList::Draw – Microsoft-recommended method for overlay icons.
            match render_icon_with_overlay_draw(
                &image_list,
                clean_icon_index,
                overlay_mask,
                icon_size,
            ) {
                Ok(rgba) => return Ok(IconRenderResult::Rgba(rgba, icon_size)),
                Err(_e) => {}
            }

            // Fallback: GetIcon with overlay mask.
            let flags = ILD_TRANSPARENT.0 | overlay_mask;
            if let Ok(hicon) = unsafe { image_list.GetIcon(clean_icon_index, flags) } {
                if !hicon.is_invalid() {
                    return Ok(IconRenderResult::Hicon(hicon, icon_size));
                }
            }
        }

        // Final fallback: GetIcon without overlay mask.
        let hicon = unsafe { image_list.GetIcon(clean_icon_index, ILD_TRANSPARENT.0) }
            .map_err(|error| anyhow!("failed to extract Windows shell icon: {error}"))?;
        if hicon.is_invalid() {
            bail!("failed to extract Windows shell icon for {}", lookup.path);
        }
        Ok(IconRenderResult::Hicon(hicon, icon_size))
    }

    /// Completes overlay rendering from a successful SHGFI_ICON call.
    /// The HICON from `info.hIcon` already has the overlay composited.  We also
    /// extract the icon index + overlay mask from `info.iIcon` to try
    /// `IImageList::Draw` at the correct size (SHGFI_ICON only supports 16x16
    /// and 32x32; larger sizes need the image list).
    fn finish_overlay_from_hicon(
        lookup: &IconLookup,
        info: &SHFILEINFOW,
    ) -> Result<IconRenderResult> {
        let hicon_from_shgfi = info.hIcon;
        let (clean_icon_index, overlay_mask) = split_icon_and_overlay(info.iIcon);

        // Try to get the image list at the requested size for high-res rendering.
        let image_list_result = unsafe {
            SHGetImageList::<IImageList>(image_list_kind_for_variant(lookup.image_list))
        };

        if let Ok(image_list) = image_list_result {
            if let Ok(icon_size) = image_list_icon_size(&image_list) {
                if overlay_mask > 0 {
                    // Try IImageList::Draw at the correct size.
                    if let Ok(rgba) = render_icon_with_overlay_draw(
                        &image_list,
                        clean_icon_index,
                        overlay_mask,
                        icon_size,
                    ) {
                        unsafe { let _ = DestroyIcon(hicon_from_shgfi); }
                        return Ok(IconRenderResult::Rgba(rgba, icon_size));
                    }

                    // Try GetIcon with overlay mask at the correct size.
                    let flags = ILD_TRANSPARENT.0 | overlay_mask;
                    if let Ok(hicon) = unsafe { image_list.GetIcon(clean_icon_index, flags) } {
                        if !hicon.is_invalid() {
                            unsafe { let _ = DestroyIcon(hicon_from_shgfi); }
                            return Ok(IconRenderResult::Hicon(hicon, icon_size));
                        }
                    }
                }

                // Try GetIcon without overlay at the correct size.
                if let Ok(hicon) = unsafe { image_list.GetIcon(clean_icon_index, ILD_TRANSPARENT.0) } {
                    if !hicon.is_invalid() {
                        unsafe { let _ = DestroyIcon(hicon_from_shgfi); }
                        return Ok(IconRenderResult::Hicon(hicon, icon_size));
                    }
                }
            }
        }

        // Use the HICON from SHGFI_ICON directly.  DrawIconEx will stretch
        // it to the target size.
        let fallback_size = match lookup.image_list {
            SystemIconImageList::SysSmall | SystemIconImageList::Small => 16u32,
            _ => 32,
        };
        Ok(IconRenderResult::Hicon(hicon_from_shgfi, fallback_size))
    }

    fn load_icon_render_result(request: &SystemIconRequest) -> Result<IconRenderResult> {
        let lookup = build_lookup(request);

        if lookup.use_real_path {
            // Try overlay-aware lookup first (includes static overlay fallback
            // via SHGFI_USEFILEATTRIBUTES, so it works even for non-existent
            // paths).
            match load_hicon_from_lookup(&lookup, true) {
                Ok(result) => return Ok(result),
                Err(_e) => {}
            }
        }

        // Placeholder fallback (extension-based generic icon).
        // build_fallback_lookup uses generic paths like "folder" or
        // "placeholder.txt" with SHGFI_USEFILEATTRIBUTES, so it always works.
        let fallback_lookup = if lookup.use_real_path {
            build_fallback_lookup(request)
        } else {
            IconLookup {
                path: lookup.path.clone(),
                attributes: lookup.attributes,
                image_list: lookup.image_list,
                use_real_path: false,
            }
        };

        load_hicon_from_lookup(&fallback_lookup, false)
    }

    fn build_fallback_lookup(request: &SystemIconRequest) -> IconLookup {
        let image_list = super::resolve_image_list(request);

        match request.kind {
            FileSystemIconKind::Drive => IconLookup {
                path: request.path.clone().unwrap_or_else(|| "C:\\".to_string()),
                attributes: FILE_ATTRIBUTE_DIRECTORY,
                image_list,
                use_real_path: false,
            },
            FileSystemIconKind::Folder | FileSystemIconKind::RemoteRoot => IconLookup {
                path: "folder".to_string(),
                attributes: FILE_ATTRIBUTE_DIRECTORY,
                image_list,
                use_real_path: false,
            },
            FileSystemIconKind::File => {
                let extension = super::normalize_extension(request.extension.as_deref());
                let placeholder = if extension.is_empty() {
                    "placeholder".to_string()
                } else {
                    format!("placeholder{extension}")
                };

                IconLookup {
                    path: placeholder,
                    attributes: FILE_ATTRIBUTE_NORMAL,
                    image_list,
                    use_real_path: false,
                }
            }
        }
    }

    fn render_hicon_to_rgba(hicon: HICON, size: u32) -> Result<Vec<u8>> {
        let screen_dc = unsafe { GetDC(None) };
        if screen_dc.0.is_null() {
            bail!("failed to acquire screen device context");
        }

        let memory_dc = unsafe { CreateCompatibleDC(Some(screen_dc)) };
        if memory_dc.0.is_null() {
            unsafe {
                ReleaseDC(None, screen_dc);
            }
            bail!("failed to create memory device context");
        }

        let mut pixels = null_mut();
        let mut bitmap_info = BITMAPINFO::default();
        bitmap_info.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
        bitmap_info.bmiHeader.biWidth = size as i32;
        bitmap_info.bmiHeader.biHeight = -(size as i32);
        bitmap_info.bmiHeader.biPlanes = 1;
        bitmap_info.bmiHeader.biBitCount = 32;
        bitmap_info.bmiHeader.biCompression = BI_RGB.0;

        let result = (|| -> Result<Vec<u8>> {
            let dib = unsafe {
                CreateDIBSection(
                    Some(screen_dc),
                    &bitmap_info,
                    DIB_RGB_COLORS,
                    &mut pixels,
                    None,
                    0,
                )
            }?;
            let dib_object = HGDIOBJ(dib.0);
            let previous = unsafe { SelectObject(memory_dc, dib_object) };
            let byte_len = (size * size * 4) as usize;

            unsafe {
                std::ptr::write_bytes(pixels, 0, byte_len);
            }

            let draw_result = unsafe {
                DrawIconEx(
                    memory_dc,
                    0,
                    0,
                    hicon,
                    size as i32,
                    size as i32,
                    0,
                    None,
                    DI_NORMAL,
                )
            };
            let mut rgba = if draw_result.is_ok() {
                unsafe { slice::from_raw_parts(pixels.cast::<u8>(), byte_len) }.to_vec()
            } else {
                Vec::new()
            };

            unsafe {
                SelectObject(memory_dc, previous);
                let _ = DeleteObject(dib_object);
            }

            if rgba.is_empty() {
                return Err(anyhow!("failed to draw Windows shell icon"));
            }

            for chunk in rgba.chunks_exact_mut(4) {
                chunk.swap(0, 2);
            }

            Ok(rgba)
        })();

        unsafe {
            let _ = DeleteDC(memory_dc);
            ReleaseDC(None, screen_dc);
        }

        result
    }

    pub fn resolve_system_icon(request: &SystemIconRequest) -> Result<SystemIconBitmap> {
        let render_result = load_icon_render_result(request)?;

        let (rgba, size) = match render_result {
            IconRenderResult::Rgba(pixels, size) => (pixels, size),
            IconRenderResult::Hicon(hicon, size) => {
                let rgba = render_hicon_to_rgba(hicon, size);
                unsafe {
                    let _ = DestroyIcon(hicon);
                }
                (rgba?, size)
            }
        };

        Ok(SystemIconBitmap {
            width: size,
            height: size,
            rgba_base64: super::STANDARD.encode(rgba),
        })
    }
}

#[cfg(not(windows))]
mod platform {
    use anyhow::{bail, Result};

    use crate::domain::models::{SystemIconBitmap, SystemIconRequest};

    pub fn resolve_system_icon(_request: &SystemIconRequest) -> Result<SystemIconBitmap> {
        bail!("Windows shell icons are only available on Windows")
    }
}

pub fn resolve_system_icon(request: &SystemIconRequest) -> Result<SystemIconBitmap> {
    if request.size == 0 {
        bail!("icon size must be greater than zero");
    }

    platform::resolve_system_icon(request)
}

#[cfg(test)]
mod tests {
    use super::{cache_key_for_request, resolve_system_icon};
    use crate::domain::models::{FileSystemIconKind, SystemIconImageList, SystemIconRequest};

    #[test]
    fn cache_key_normalizes_file_extensions_and_sizes() {
        let lower = SystemIconRequest {
            kind: FileSystemIconKind::File,
            path: Some("C:\\Temp\\alpha.txt".into()),
            extension: Some(".txt".into()),
            size: 18,
            image_list: Some(SystemIconImageList::Small),
            include_overlays: false,
        };
        let upper = SystemIconRequest {
            kind: FileSystemIconKind::File,
            path: Some("D:\\Elsewhere\\BETA.TXT".into()),
            extension: Some("TXT".into()),
            size: 16,
            image_list: Some(SystemIconImageList::Small),
            include_overlays: false,
        };

        assert_eq!(cache_key_for_request(&lower), "file:.txt:small");
        assert_eq!(cache_key_for_request(&upper), "file:.txt:small");

        let larger = SystemIconRequest {
            kind: FileSystemIconKind::File,
            path: Some("C:\\Temp\\atlas.txt".into()),
            extension: Some(".txt".into()),
            size: 72,
            image_list: Some(SystemIconImageList::Jumbo),
            include_overlays: false,
        };

        assert_eq!(cache_key_for_request(&larger), "file:.txt:jumbo");
    }

    #[test]
    fn cache_key_distinguishes_drive_and_folder_icons() {
        let folder = SystemIconRequest {
            kind: FileSystemIconKind::Folder,
            path: Some("C:\\Users".into()),
            extension: None,
            size: 18,
            image_list: Some(SystemIconImageList::SysSmall),
            include_overlays: false,
        };
        let drive = SystemIconRequest {
            kind: FileSystemIconKind::Drive,
            path: Some("D:\\".into()),
            extension: None,
            size: 48,
            image_list: Some(SystemIconImageList::ExtraLarge),
            include_overlays: false,
        };
        let remote_root = SystemIconRequest {
            kind: FileSystemIconKind::RemoteRoot,
            path: None,
            extension: None,
            size: 16,
            image_list: Some(SystemIconImageList::Small),
            include_overlays: false,
        };

        assert_eq!(cache_key_for_request(&folder), "folder:sys-small");
        assert_eq!(cache_key_for_request(&drive), "drive:D:\\:extra-large");
        assert_eq!(cache_key_for_request(&remote_root), "remote-root:small");
    }

    #[test]
    fn cache_key_uses_path_specific_key_when_overlays_requested_for_local_file() {
        let with_overlay = SystemIconRequest {
            kind: FileSystemIconKind::File,
            path: Some("C:\\Projects\\report.txt".into()),
            extension: Some(".txt".into()),
            size: 16,
            image_list: Some(SystemIconImageList::Small),
            include_overlays: true,
        };
        let same_path_different_size = SystemIconRequest {
            kind: FileSystemIconKind::File,
            path: Some("C:\\Projects\\report.txt".into()),
            extension: Some(".txt".into()),
            size: 48,
            image_list: Some(SystemIconImageList::ExtraLarge),
            include_overlays: true,
        };

        assert_eq!(
            cache_key_for_request(&with_overlay),
            "file-overlay:c:\\projects\\report.txt:small"
        );
        assert_eq!(
            cache_key_for_request(&same_path_different_size),
            "file-overlay:c:\\projects\\report.txt:extra-large"
        );
    }

    #[test]
    fn cache_key_uses_path_specific_key_when_overlays_requested_for_local_folder() {
        let folder_overlay = SystemIconRequest {
            kind: FileSystemIconKind::Folder,
            path: Some("D:\\GitRepo".into()),
            extension: None,
            size: 16,
            image_list: Some(SystemIconImageList::SysSmall),
            include_overlays: true,
        };

        assert_eq!(
            cache_key_for_request(&folder_overlay),
            "folder-overlay:d:\\gitrepo:sys-small"
        );
    }

    #[test]
    fn cache_key_falls_back_to_extension_key_when_overlays_requested_without_local_path() {
        // Remote path – should NOT use overlay cache key.
        let remote_file = SystemIconRequest {
            kind: FileSystemIconKind::File,
            path: Some("sftp://host/path/file.txt".into()),
            extension: Some(".txt".into()),
            size: 16,
            image_list: Some(SystemIconImageList::Small),
            include_overlays: true,
        };
        assert_eq!(cache_key_for_request(&remote_file), "file:.txt:small");

        // No path – should NOT use overlay cache key.
        let no_path = SystemIconRequest {
            kind: FileSystemIconKind::File,
            path: None,
            extension: Some(".txt".into()),
            size: 16,
            image_list: Some(SystemIconImageList::Small),
            include_overlays: true,
        };
        assert_eq!(cache_key_for_request(&no_path), "file:.txt:small");

        // Overlay not requested – existing behavior.
        let no_overlay = SystemIconRequest {
            kind: FileSystemIconKind::File,
            path: Some("C:\\report.txt".into()),
            extension: Some(".txt".into()),
            size: 16,
            image_list: Some(SystemIconImageList::Small),
            include_overlays: false,
        };
        assert_eq!(cache_key_for_request(&no_overlay), "file:.txt:small");
    }

    #[test]
    fn cache_key_overlay_does_not_pollute_extension_cache() {
        let extension_only = SystemIconRequest {
            kind: FileSystemIconKind::File,
            path: Some("C:\\report.txt".into()),
            extension: Some(".txt".into()),
            size: 16,
            image_list: Some(SystemIconImageList::Small),
            include_overlays: false,
        };
        let with_overlay = SystemIconRequest {
            kind: FileSystemIconKind::File,
            path: Some("C:\\report.txt".into()),
            extension: Some(".txt".into()),
            size: 16,
            image_list: Some(SystemIconImageList::Small),
            include_overlays: true,
        };

        assert_eq!(cache_key_for_request(&extension_only), "file:.txt:small");
        assert_eq!(
            cache_key_for_request(&with_overlay),
            "file-overlay:c:\\report.txt:small"
        );
        assert_ne!(
            cache_key_for_request(&extension_only),
            cache_key_for_request(&with_overlay)
        );
    }

    #[cfg(windows)]
    #[test]
    fn resolve_system_icon_returns_rgba_payload_for_folder_and_file() {
        let folder = resolve_system_icon(&SystemIconRequest {
            kind: FileSystemIconKind::Folder,
            path: None,
            extension: None,
            size: 18,
            image_list: Some(SystemIconImageList::SysSmall),
            include_overlays: false,
        })
        .expect("resolve folder icon");
        let file = resolve_system_icon(&SystemIconRequest {
            kind: FileSystemIconKind::File,
            path: None,
            extension: Some(".txt".into()),
            size: 72,
            image_list: Some(SystemIconImageList::Jumbo),
            include_overlays: false,
        })
        .expect("resolve file icon");

        assert!(folder.width >= 16);
        assert_eq!(folder.width, folder.height);
        assert!(!folder.rgba_base64.is_empty());
        assert!(file.width >= 256);
        assert_eq!(file.width, file.height);
        assert!(!file.rgba_base64.is_empty());
    }
}

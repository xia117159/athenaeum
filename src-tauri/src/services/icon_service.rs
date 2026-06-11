use anyhow::{bail, Result};
use base64::engine::general_purpose::STANDARD;

use crate::domain::models::{FileSystemIconKind, SystemIconBitmap, SystemIconImageList, SystemIconRequest};

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
  request.image_list.unwrap_or_else(|| infer_image_list_from_size(request.size))
}

fn image_list_cache_segment(image_list: SystemIconImageList) -> &'static str {
  match image_list {
    SystemIconImageList::SysSmall => "sys-small",
    SystemIconImageList::Small => "small",
    SystemIconImageList::Large => "large",
    SystemIconImageList::ExtraLarge => "extra-large",
    SystemIconImageList::Jumbo => "jumbo"
  }
}

pub fn cache_key_for_request(request: &SystemIconRequest) -> String {
  let image_list = image_list_cache_segment(resolve_image_list(request));

  match request.kind {
    FileSystemIconKind::File => {
      let extension = normalize_extension(request.extension.as_deref());
      format!("file:{}:{image_list}", if extension.is_empty() { "__default__" } else { &extension })
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
    FileSystemIconKind::Folder => format!("folder:{image_list}")
  }
}

#[cfg(windows)]
mod platform {
  use std::{mem::size_of, ptr::null_mut, slice};

  use anyhow::{anyhow, bail, Result};
  use base64::Engine as _;
  use windows::{
    core::PCWSTR,
    Win32::{
      Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC, SelectObject, BI_RGB,
        BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, HGDIOBJ
      },
      Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_FLAGS_AND_ATTRIBUTES},
      UI::{
        Controls::{IImageList, ILD_TRANSPARENT},
        Shell::{
          SHGetFileInfoW, SHGetImageList, SHFILEINFOW, SHGFI_FLAGS, SHGFI_SYSICONINDEX, SHGFI_USEFILEATTRIBUTES,
          SHIL_EXTRALARGE, SHIL_JUMBO, SHIL_LARGE, SHIL_SMALL, SHIL_SYSSMALL
        },
        WindowsAndMessaging::{DestroyIcon, DrawIconEx, HICON, DI_NORMAL}
      }
    }
  };

  use crate::domain::models::{FileSystemIconKind, SystemIconBitmap, SystemIconImageList, SystemIconRequest};

  struct IconLookup {
    path: String,
    attributes: FILE_FLAGS_AND_ATTRIBUTES,
    image_list: SystemIconImageList
  }

  fn to_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
  }

  fn build_lookup(request: &SystemIconRequest) -> IconLookup {
    let image_list = super::resolve_image_list(request);

    match request.kind {
      FileSystemIconKind::Drive => IconLookup {
        path: request.path.clone().unwrap_or_else(|| "C:\\".to_string()),
        attributes: FILE_ATTRIBUTE_DIRECTORY,
        image_list
      },
      FileSystemIconKind::Folder | FileSystemIconKind::RemoteRoot => IconLookup {
        path: request.path.clone().unwrap_or_else(|| "folder".to_string()),
        attributes: FILE_ATTRIBUTE_DIRECTORY,
        image_list
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
          image_list
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
      SystemIconImageList::Jumbo => SHIL_JUMBO as i32
    }
  }

  fn image_list_icon_size(image_list: &IImageList) -> Result<u32> {
    let mut width = 0;
    let mut height = 0;
    unsafe {
      image_list
        .GetIconSize(&mut width, &mut height)
        .map_err(|error| anyhow!("failed to query Windows system image list size: {error}"))?;
    }

    if width <= 0 || height <= 0 {
      bail!("Windows system image list reported an invalid icon size");
    }

    Ok(width.max(height) as u32)
  }

  fn load_hicon(request: &SystemIconRequest) -> Result<(HICON, u32)> {
    let lookup = build_lookup(request);
    let wide_path = to_wide(&lookup.path);
    let mut info = SHFILEINFOW::default();
    let use_file_attributes = if matches!(request.kind, FileSystemIconKind::Drive) {
      SHGFI_FLAGS(0)
    } else {
      SHGFI_USEFILEATTRIBUTES
    };

    let result = unsafe {
      SHGetFileInfoW(
        PCWSTR(wide_path.as_ptr()),
        lookup.attributes,
        Some(&mut info),
        size_of::<SHFILEINFOW>() as u32,
        SHGFI_SYSICONINDEX | use_file_attributes
      )
    };

    if result == 0 || info.iIcon < 0 {
      bail!("failed to load Windows shell icon for {}", lookup.path);
    }

    let image_list = unsafe { SHGetImageList::<IImageList>(image_list_kind_for_variant(lookup.image_list)) }
      .map_err(|error| anyhow!("failed to access Windows system image list: {error}"))?;
    let hicon = unsafe { image_list.GetIcon(info.iIcon, ILD_TRANSPARENT.0) }
      .map_err(|error| anyhow!("failed to extract Windows shell icon: {error}"))?;
    let icon_size = image_list_icon_size(&image_list)?;

    if hicon.is_invalid() {
      bail!("failed to extract Windows shell icon for {}", lookup.path);
    }

    Ok((hicon, icon_size))
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
      let dib = unsafe { CreateDIBSection(Some(screen_dc), &bitmap_info, DIB_RGB_COLORS, &mut pixels, None, 0) }?;
      let dib_object = HGDIOBJ(dib.0);
      let previous = unsafe { SelectObject(memory_dc, dib_object) };
      let byte_len = (size * size * 4) as usize;

      unsafe {
        std::ptr::write_bytes(pixels, 0, byte_len);
      }

      let draw_result = unsafe { DrawIconEx(memory_dc, 0, 0, hicon, size as i32, size as i32, 0, None, DI_NORMAL) };
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
    let (hicon, size) = load_hicon(request)?;
    let rgba = render_hicon_to_rgba(hicon, size);
    unsafe {
      DestroyIcon(hicon)?;
    }

    let rgba = rgba?;
    Ok(SystemIconBitmap {
      width: size,
      height: size,
      rgba_base64: super::STANDARD.encode(rgba)
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
      image_list: Some(SystemIconImageList::Small)
    };
    let upper = SystemIconRequest {
      kind: FileSystemIconKind::File,
      path: Some("D:\\Elsewhere\\BETA.TXT".into()),
      extension: Some("TXT".into()),
      size: 16,
      image_list: Some(SystemIconImageList::Small)
    };

    assert_eq!(cache_key_for_request(&lower), "file:.txt:small");
    assert_eq!(cache_key_for_request(&upper), "file:.txt:small");

    let larger = SystemIconRequest {
      kind: FileSystemIconKind::File,
      path: Some("C:\\Temp\\atlas.txt".into()),
      extension: Some(".txt".into()),
      size: 72,
      image_list: Some(SystemIconImageList::Jumbo)
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
      image_list: Some(SystemIconImageList::SysSmall)
    };
    let drive = SystemIconRequest {
      kind: FileSystemIconKind::Drive,
      path: Some("D:\\".into()),
      extension: None,
      size: 48,
      image_list: Some(SystemIconImageList::ExtraLarge)
    };
    let remote_root = SystemIconRequest {
      kind: FileSystemIconKind::RemoteRoot,
      path: None,
      extension: None,
      size: 16,
      image_list: Some(SystemIconImageList::Small)
    };

    assert_eq!(cache_key_for_request(&folder), "folder:sys-small");
    assert_eq!(cache_key_for_request(&drive), "drive:D:\\:extra-large");
    assert_eq!(cache_key_for_request(&remote_root), "remote-root:small");
  }

  #[cfg(windows)]
  #[test]
  fn resolve_system_icon_returns_rgba_payload_for_folder_and_file() {
    let folder = resolve_system_icon(&SystemIconRequest {
      kind: FileSystemIconKind::Folder,
      path: None,
      extension: None,
      size: 18,
      image_list: Some(SystemIconImageList::SysSmall)
    })
    .expect("resolve folder icon");
    let file = resolve_system_icon(&SystemIconRequest {
      kind: FileSystemIconKind::File,
      path: None,
      extension: Some(".txt".into()),
      size: 72,
      image_list: Some(SystemIconImageList::Jumbo)
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

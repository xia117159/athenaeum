use anyhow::{Context, Result};
use std::{ffi::c_void, os::windows::ffi::OsStrExt, path::Path};
use windows::{
    core::{w, HRESULT, PCWSTR},
    Win32::{
        Foundation::{ERROR_CANCELLED, HWND},
        Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW},
        System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_INPROC_SERVER},
        UI::Shell::{
            Common::COMDLG_FILTERSPEC, FileOpenDialog, IFileOpenDialog, FOS_FILEMUSTEXIST,
            FOS_FORCEFILESYSTEM, FOS_PATHMUSTEXIST, SIGDN_FILESYSPATH,
        },
    },
};

pub(super) fn choose_program(owner: isize) -> Result<Option<String>> {
    unsafe {
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
            .context("无法创建 Windows 文件选择框")?;
        dialog.SetTitle(w!("选择打开文件的程序"))?;
        dialog.SetOptions(
            dialog.GetOptions()? | FOS_FILEMUSTEXIST | FOS_PATHMUSTEXIST | FOS_FORCEFILESYSTEM,
        )?;
        dialog.SetFileTypes(&[
            COMDLG_FILTERSPEC {
                pszName: w!("可执行程序"),
                pszSpec: w!("*.exe;*.com"),
            },
            COMDLG_FILTERSPEC {
                pszName: w!("所有文件"),
                pszSpec: w!("*.*"),
            },
        ])?;
        match dialog.Show(Some(HWND(owner as *mut c_void))) {
            Err(error) if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) => {
                return Ok(None)
            }
            result => result.context("无法显示程序选择框")?,
        }
        let selected = dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
        let result = selected.to_string();
        CoTaskMemFree(Some(selected.0.cast()));
        Ok(Some(result.context("无法读取所选程序的路径")?))
    }
}

fn query(data: &[u32], key: &str, unit_size: usize) -> Option<(*const c_void, usize)> {
    let wide: Vec<u16> = key.encode_utf16().chain(Some(0)).collect();
    let mut pointer = std::ptr::null_mut();
    let mut length = 0;
    let found = unsafe {
        VerQueryValueW(
            data.as_ptr().cast(),
            PCWSTR(wide.as_ptr()),
            &mut pointer,
            &mut length,
        )
    }
    .as_bool();
    let start = data.as_ptr() as usize;
    let address = pointer as usize;
    let bytes = (length as usize).checked_mul(unit_size)?;
    if !found
        || pointer.is_null()
        || address < start
        || address.checked_add(bytes)? > start + std::mem::size_of_val(data)
        || address % unit_size != 0
    {
        return None;
    }
    Some((pointer, length as usize))
}

pub(super) fn file_description(path: &Path) -> Option<String> {
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let size = unsafe { GetFileVersionInfoSizeW(PCWSTR(wide.as_ptr()), None) };
    if size == 0 || size > 16 * 1024 * 1024 {
        return None;
    }
    // Native version fields have word alignment; Vec<u32> guarantees it.
    let mut data = vec![0_u32; (size as usize).div_ceil(4)];
    unsafe { GetFileVersionInfoW(PCWSTR(wide.as_ptr()), None, size, data.as_mut_ptr().cast()) }
        .ok()?;
    let mut translations = Vec::new();
    if let Some((pointer, length)) = query(&data, r"\VarFileInfo\Translation", 1) {
        let bytes = unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(), length) };
        for pair in bytes.chunks_exact(4) {
            translations.push((
                u16::from_le_bytes([pair[0], pair[1]]),
                u16::from_le_bytes([pair[2], pair[3]]),
            ));
        }
    }
    translations.extend([(0x0409, 0x04b0), (0x0409, 0x04e4)]);
    for (language, codepage) in translations {
        let key = format!(r"\StringFileInfo\{language:04x}{codepage:04x}\FileDescription");
        let Some((pointer, length)) = query(&data, &key, 2) else {
            continue;
        };
        let words = unsafe { std::slice::from_raw_parts(pointer.cast::<u16>(), length) };
        let end = words
            .iter()
            .position(|word| *word == 0)
            .unwrap_or(words.len());
        if let Ok(description) = String::from_utf16(&words[..end]) {
            let description = description.trim();
            if !description.is_empty() {
                return Some(description.to_string());
            }
        }
    }
    None
}

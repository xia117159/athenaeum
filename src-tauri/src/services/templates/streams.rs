//! Windows $DATA streams. Share locks protect each opened stream, not the stream namespace.
use super::{
    compare_names,
    native::EntryHandle,
    owned::{self, OwnedStream},
};
use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use windows::Win32::System::SystemServices::FILE_NAMED_STREAMS;
use windows::Win32::{
    Foundation::{ERROR_HANDLE_EOF, ERROR_INSUFFICIENT_BUFFER, ERROR_MORE_DATA, HANDLE},
    Storage::FileSystem::*,
};

pub fn names(file: &File) -> Result<Vec<String>> {
    let handle = HANDLE(file.as_raw_handle());
    let mut flags = 0;
    unsafe { GetVolumeInformationByHandleW(handle, None, None, None, Some(&mut flags), None) }
        .context("无法读取数据流支持能力")?;
    if flags & FILE_NAMED_STREAMS == 0 {
        return Ok(Vec::new());
    }
    let mut buffer = vec![0u64; 128];
    loop {
        let result = unsafe {
            GetFileInformationByHandleEx(
                handle,
                FileStreamInfo,
                buffer.as_mut_ptr().cast(),
                (buffer.len() * 8) as u32,
            )
        };
        match result {
            Ok(()) => break,
            Err(error) if error.code() == ERROR_HANDLE_EOF.to_hresult() => return Ok(Vec::new()),
            Err(error)
                if [
                    ERROR_MORE_DATA.to_hresult(),
                    ERROR_INSUFFICIENT_BUFFER.to_hresult(),
                ]
                .contains(&error.code())
                    && buffer.len() < 2_097_152 =>
            {
                buffer.resize(buffer.len() * 2, 0);
            }
            Err(error) => return Err(error).context("无法读取完整命名数据流列表"),
        }
    }
    let mut result = Vec::new();
    let name_offset = std::mem::offset_of!(FILE_STREAM_INFO, StreamName);
    let mut offset = 0;
    loop {
        if offset + std::mem::size_of::<FILE_STREAM_INFO>() > buffer.len() * 8 {
            bail!("无效的数据流列表");
        }
        // Windows returns a sequence of aligned, variable-length FILE_STREAM_INFO records.
        let entry = unsafe {
            &*(buffer
                .as_ptr()
                .cast::<u8>()
                .add(offset)
                .cast::<FILE_STREAM_INFO>())
        };
        let length = entry.StreamNameLength as usize;
        if length % 2 != 0 || offset + name_offset + length > buffer.len() * 8 {
            bail!("无效的数据流名称长度");
        }
        if length == 0 && entry.NextEntryOffset == 0 {
            break;
        } // Empty directory with no streams.
        let wide = unsafe {
            std::slice::from_raw_parts(
                buffer
                    .as_ptr()
                    .cast::<u8>()
                    .add(offset + name_offset)
                    .cast::<u16>(),
                length / 2,
            )
        };
        let name = String::from_utf16(wide).context("数据流名称不是有效 Unicode")?;
        if name != "::$DATA" {
            validate_suffix(&name)?;
            result.push(name);
        }
        let next = entry.NextEntryOffset as usize;
        if next == 0 {
            break;
        }
        if next < name_offset + length || next % 8 != 0 {
            bail!("无效的数据流记录边界");
        }
        offset += next;
    }
    result.sort_by(|a, b| compare_names(a, b));
    Ok(result)
}

fn validate_suffix(name: &str) -> Result<()> {
    let Some(inner) = name
        .strip_prefix(':')
        .and_then(|name| name.strip_suffix(":$DATA"))
    else {
        bail!("不支持的数据流类型：{name}");
    };
    if inner.is_empty() || inner.contains([':', '\\', '/', '\0']) {
        bail!("无效的命名数据流：{name}");
    }
    Ok(())
}

pub fn path(base: &Path, suffix: &str) -> PathBuf {
    let mut name = base.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

pub fn open(base: &Path, suffix: &str, create: bool) -> Result<File> {
    validate_suffix(suffix)?;
    let stream_path = path(base, suffix);
    // FILE_SHARE_DELETE is required by the base object's existing DELETE handle.
    // Named-stream creation remains possible; undo must therefore be recoverable.
    OpenOptions::new()
        .read(true)
        .write(create)
        .create_new(create)
        .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_DELETE.0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0 | FILE_FLAG_BACKUP_SEMANTICS.0)
        .open(&stream_path)
        .with_context(|| format!("无法打开命名数据流：{}", stream_path.display()))
}

pub fn copy_contents(
    input: &mut File,
    output: &mut File,
    target: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(&str, u64),
) -> Result<Vec<u8>> {
    let mut buffer = vec![0; 256 * 1024];
    let mut hash = Sha256::new();
    loop {
        if cancel.load(Ordering::SeqCst) {
            bail!("已取消创建");
        }
        let len = input.read(&mut buffer)?;
        if len == 0 {
            break;
        }
        output.write_all(&buffer[..len])?;
        hash.update(&buffer[..len]);
        progress(&target.to_string_lossy(), len as u64);
    }
    output.sync_all()?;
    Ok(hash.finalize().to_vec())
}

pub fn copy(
    input: &EntryHandle,
    source: &Path,
    target: &Path,
    manifest: &mut Vec<OwnedStream>,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(&str, u64),
) -> Result<()> {
    let before = names(&input.file)?;
    let mut inputs = before
        .iter()
        .map(|name| open(source, name, false))
        .collect::<Result<Vec<_>>>()?;
    for (name, input) in before.iter().zip(&mut inputs) {
        let stream_path = path(target, name);
        let mut output = open(target, name, true)?;
        manifest.push(OwnedStream {
            name: name.clone(),
            digest: None,
        });
        let copied = copy_contents(input, &mut output, &stream_path, cancel, progress);
        manifest.last_mut().unwrap().digest = match &copied {
            Ok(hash) => Some(hash.clone()),
            Err(_) => owned::digest(
                &mut output,
                &stream_path,
                &AtomicBool::new(false),
                &mut |_, _| {},
            )
            .ok(),
        };
        copied?;
    }
    if names(&input.file)? != before {
        bail!("模板命名数据流在复制期间发生变化：{}", source.display());
    }
    Ok(())
}

pub fn validate(
    handle: &EntryHandle,
    base: &Path,
    manifest: &[OwnedStream],
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(&str, u64),
) -> Result<Vec<File>> {
    let actual = names(&handle.file)?;
    let mut expected = manifest.iter().collect::<Vec<_>>();
    expected.sort_by(|a, b| compare_names(&a.name, &b.name));
    if actual
        != expected
            .iter()
            .map(|entry| entry.name.clone())
            .collect::<Vec<_>>()
    {
        bail!("副本命名数据流已增加或移除，未撤销：{}", base.display());
    }
    let mut guards = Vec::new();
    for entry in expected {
        let mut file = open(base, &entry.name, false)?;
        let hash = owned::digest(&mut file, &path(base, &entry.name), cancel, progress)?;
        if entry.digest.as_ref() != Some(&hash) {
            bail!("副本命名数据流已修改，未撤销：{}", base.display());
        }
        guards.push(file);
    }
    Ok(guards)
}

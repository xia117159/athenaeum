use super::{path_eq, EntrySnapshot, FileIdentity};
use anyhow::{bail, Context, Result};
use chrono::{DateTime, Local, Utc};
use std::path::{Path, PathBuf};
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{CloseHandle, HANDLE},
        Storage::FileSystem::*,
    },
};

pub struct RenameHandle(HANDLE);
impl Drop for RenameHandle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

fn extended_path(path: &Path) -> Result<String> {
    let normalized = path
        .to_str()
        .context("文件路径不是有效 Unicode")?
        .replace('/', r"\");
    let text = normalized.as_str();
    if text.starts_with(r"\\?\") {
        return Ok(text.into());
    }
    if let Some(unc) = text.strip_prefix(r"\\") {
        return Ok(format!(r"\\?\UNC\{unc}"));
    }
    if !path.is_absolute() {
        bail!("需要本地绝对路径");
    }
    Ok(format!(r"\\?\{text}"))
}

impl RenameHandle {
    fn open(path: &Path, rename: bool, protect: bool) -> Result<Self> {
        let path_wide = extended_path(path)?
            .encode_utf16()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let share = if protect {
            FILE_SHARE_READ | FILE_SHARE_WRITE
        } else {
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
        };
        let access = FILE_READ_ATTRIBUTES.0 | if rename { DELETE.0 } else { 0 };
        let handle = unsafe {
            CreateFileW(
                PCWSTR(path_wide.as_ptr()),
                access,
                share,
                None,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                None,
            )
        }
        .with_context(|| format!("无法打开项目（可能已被占用）：{}", path.display()))?;
        Ok(Self(handle))
    }
    pub fn path(&self) -> Result<PathBuf> {
        let mut buffer = vec![0u16; 32768];
        let length = unsafe {
            GetFinalPathNameByHandleW(
                self.0,
                &mut buffer,
                GETFINALPATHNAMEBYHANDLE_FLAGS(FILE_NAME_NORMALIZED.0 | VOLUME_NAME_DOS.0),
            )
        };
        if length == 0 || length as usize >= buffer.len() {
            bail!(
                "无法确定项目的规范路径：{}",
                std::io::Error::last_os_error()
            );
        }
        let path =
            String::from_utf16(&buffer[..length as usize]).context("文件路径不是有效 Unicode")?;
        let path = if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{unc}")
        } else {
            path.strip_prefix(r"\\?\").unwrap_or(&path).to_owned()
        };
        Ok(PathBuf::from(path))
    }
    fn basic(&self) -> Result<BY_HANDLE_FILE_INFORMATION> {
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        unsafe { GetFileInformationByHandle(self.0, &mut info) }.context("无法读取文件身份")?;
        Ok(info)
    }
    pub fn identity(&self) -> Result<FileIdentity> {
        let basic = self.basic()?;
        let mut filesystem = vec![0u16; 64];
        unsafe {
            GetVolumeInformationByHandleW(self.0, None, None, None, None, Some(&mut filesystem))
        }
        .context("无法读取卷能力，尚未改动文件")?;
        let end = filesystem
            .iter()
            .position(|ch| *ch == 0)
            .unwrap_or(filesystem.len());
        let filesystem = String::from_utf16_lossy(&filesystem[..end]).to_ascii_uppercase();
        let mut info = FILE_ID_INFO::default();
        let has_full_id = unsafe {
            GetFileInformationByHandleEx(
                self.0,
                FileIdInfo,
                (&mut info as *mut FILE_ID_INFO).cast(),
                std::mem::size_of::<FILE_ID_INFO>() as u32,
            )
        }
        .is_ok()
            && info.FileId.Identifier != [0; 16];
        let (volume, id, id_bits) = if has_full_id {
            (info.VolumeSerialNumber, info.FileId.Identifier, 128)
        } else {
            if !matches!(filesystem.as_str(), "NTFS" | "FAT" | "FAT32" | "EXFAT") {
                bail!("卷 {filesystem} 无法提供可靠文件身份，尚未改动文件");
            }
            let index = (basic.nFileIndexHigh as u64) << 32 | basic.nFileIndexLow as u64;
            if index == 0 {
                bail!("卷没有提供可靠文件 ID，尚未改动文件");
            }
            let mut id = [0u8; 16];
            id[..8].copy_from_slice(&index.to_le_bytes());
            (basic.dwVolumeSerialNumber as u64, id, 64)
        };
        Ok(FileIdentity {
            version: 1,
            volume,
            id,
            id_bits,
            created: filetime_ticks(basic.ftCreationTime),
            kind: basic.dwFileAttributes
                & (FILE_ATTRIBUTE_DIRECTORY.0 | FILE_ATTRIBUTE_REPARSE_POINT.0),
            stable: matches!(filesystem.as_str(), "NTFS" | "REFS"),
        })
    }
    pub fn check_metadata(
        &self,
        modified: Option<DateTime<chrono::FixedOffset>>,
        length: u64,
    ) -> Result<()> {
        let basic = self.basic()?;
        let actual_length = ((basic.nFileSizeHigh as u64) << 32) | basic.nFileSizeLow as u64;
        if date(basic.ftLastWriteTime) != modified || actual_length != length {
            bail!("项目自预览后已改变，请重新预览");
        }
        Ok(())
    }
    pub fn rename_to(&self, parent: &GroupGuard, name: &str) -> Result<()> {
        if name.is_empty() || name == "." || name == ".." || name.contains(['\\', '/', '\0']) {
            bail!("无效的目标名称");
        }
        let parent_path = parent.chain.last().context("父目录句柄已关闭")?.path()?;
        let target = extended_path(&parent_path.join(name))?
            .encode_utf16()
            .collect::<Vec<_>>();
        let name_offset = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
        let bytes =
            (name_offset + (target.len() + 1) * 2).max(std::mem::size_of::<FILE_RENAME_INFO>());
        let mut aligned = vec![0u64; bytes.div_ceil(std::mem::size_of::<u64>())];
        // The variable-length Win32 struct requires aligned storage, byte length,
        // and a terminating UTF-16 NUL beyond FileNameLength.
        unsafe {
            let info = aligned.as_mut_ptr().cast::<FILE_RENAME_INFO>();
            (*info).Anonymous.ReplaceIfExists = false;
            (*info).RootDirectory = HANDLE::default();
            (*info).FileNameLength = (target.len() * 2) as u32;
            let output = (info.cast::<u8>()).add(name_offset).cast::<u16>();
            std::ptr::copy_nonoverlapping(target.as_ptr(), output, target.len());
            SetFileInformationByHandle(self.0, FileRenameInfo, info.cast(), bytes as u32)
                .with_context(|| format!("无法重命名为 {name}（目标可能已存在或文件被占用）"))?;
        }
        Ok(())
    }
}

fn filetime_ticks(time: windows::Win32::Foundation::FILETIME) -> i64 {
    ((time.dwHighDateTime as u64) << 32 | time.dwLowDateTime as u64) as i64
}
fn date(time: windows::Win32::Foundation::FILETIME) -> Option<DateTime<chrono::FixedOffset>> {
    let ticks = filetime_ticks(time);
    if ticks <= 0 {
        return None;
    }
    DateTime::<Utc>::from_timestamp(
        ticks / 10_000_000 - 11_644_473_600,
        ((ticks % 10_000_000) * 100) as u32,
    )
    .map(|time| time.with_timezone(&Local).fixed_offset())
}

pub fn snapshot(path: &Path) -> Result<EntrySnapshot> {
    if !path.is_absolute() {
        bail!("批量重命名需要本地绝对路径");
    }
    let handle = RenameHandle::open(path, false, false)?;
    let path = handle.path()?;
    let parent = path
        .parent()
        .filter(|_| path.file_name().is_some())
        .context("不能重命名根目录")?;
    let parent_handle = RenameHandle::open(parent, false, false)?;
    let identity = handle.identity()?;
    let parent_identity = parent_handle.identity()?;
    let basic = handle.basic()?;
    Ok(EntrySnapshot {
        path,
        is_directory: basic.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0,
        identity,
        parent_identity,
        modified: date(basic.ftLastWriteTime),
        created: date(basic.ftCreationTime),
        length: ((basic.nFileSizeHigh as u64) << 32) | basic.nFileSizeLow as u64,
    })
}

/// The entire resolved naming chain stays protected while a group uses absolute targets.
pub struct GroupGuard {
    chain: Vec<RenameHandle>,
    path: PathBuf,
}
impl GroupGuard {
    pub fn new(parent: &Path, expected: &FileIdentity) -> Result<Self> {
        let mut ancestors = parent
            .ancestors()
            .filter(|path| path.has_root())
            .collect::<Vec<_>>();
        ancestors.reverse();
        let mut chain = Vec::new();
        for path in ancestors {
            let handle = RenameHandle::open(path, false, true)?;
            let identity = handle.identity()?;
            if identity.kind & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
                || !path_eq(&handle.path()?, path)
            {
                bail!("父目录链已改变：{}", path.display());
            }
            chain.push(handle);
        }
        let parent_handle = chain.last().context("无效父目录")?;
        if parent_handle.identity()? != *expected {
            bail!("父目录已被替换：{}", parent.display());
        }
        Ok(Self {
            path: parent.to_path_buf(),
            chain,
        })
    }
    pub fn open_source(&self, path: &Path, identity: &FileIdentity) -> Result<RenameHandle> {
        if !path
            .parent()
            .is_some_and(|parent| path_eq(parent, &self.path))
        {
            bail!("源项目不属于预期目录");
        }
        let handle = RenameHandle::open(path, true, true)?;
        if handle.identity()? != *identity || handle.path()? != path {
            bail!("源项目已被替换或改名：{}", path.display());
        }
        Ok(handle)
    }
}

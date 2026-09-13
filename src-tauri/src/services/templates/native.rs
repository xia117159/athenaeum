//! Handle ownership for template copies. Name-chain guards and content locks are distinct.
pub use super::owned::Identity;
use anyhow::{bail, Context, Result};
use std::{
    fs::{File, OpenOptions},
    os::windows::{
        ffi::OsStrExt,
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Component, Path, PathBuf},
};
use windows::Win32::{Foundation::HANDLE, Storage::FileSystem::*};

pub struct EntryHandle {
    pub file: File,
    pub identity: Identity,
}
impl EntryHandle {
    pub fn open(path: &Path, deleting: bool) -> Result<Self> {
        // Metadata-only access does not participate in Windows share checks.
        let access = FILE_GENERIC_READ.0
            | if deleting {
                DELETE.0 | FILE_WRITE_ATTRIBUTES.0
            } else {
                0
            };
        // Directory write handles can turn an otherwise pinned directory into a junction.
        let file = OpenOptions::new()
            .access_mode(access)
            .share_mode(FILE_SHARE_READ.0)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0)
            .open(path)
            .with_context(|| format!("无法打开项目（可能正被占用）：{}", path.display()))?;
        Self::from_file(file)
    }
    pub fn create_file(path: &Path) -> Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .access_mode(FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0 | DELETE.0)
            .share_mode(FILE_SHARE_READ.0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
            .open(path)?;
        Self::from_created_file(file, path)
    }
    pub fn create_directory(path: &Path) -> Result<Self> {
        use windows::{
            core::PWSTR,
            Wdk::{
                Foundation::OBJECT_ATTRIBUTES,
                Storage::FileSystem::{
                    NtCreateFile, FILE_CREATE, FILE_DIRECTORY_FILE, FILE_OPEN_REPARSE_POINT,
                    FILE_SYNCHRONOUS_IO_NONALERT,
                },
            },
            Win32::{
                Foundation::{RtlNtStatusToDosError, OBJ_CASE_INSENSITIVE, UNICODE_STRING},
                System::IO::IO_STATUS_BLOCK,
            },
        };
        // CreateDirectory + OpenFile leaves a gap in which a reparse writer can replace
        // the new directory. NtCreateFile returns its exclusive handle atomically.
        let text = path.to_str().context("模板路径不是有效 Unicode")?;
        let nt_path = match text.strip_prefix(r"\\") {
            Some(unc) => format!(r"\??\UNC\{unc}"),
            None => format!(r"\??\{text}"),
        };
        let mut name = std::ffi::OsStr::new(&nt_path)
            .encode_wide()
            .collect::<Vec<_>>();
        let length = u16::try_from(name.len() * 2).context("新项目路径过长")?;
        let string = UNICODE_STRING {
            Length: length,
            MaximumLength: length,
            Buffer: PWSTR(name.as_mut_ptr()),
        };
        let attributes = OBJECT_ATTRIBUTES {
            Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
            ObjectName: &string,
            Attributes: OBJ_CASE_INSENSITIVE,
            ..Default::default()
        };
        let mut status_block = IO_STATUS_BLOCK::default();
        let mut handle = HANDLE::default();
        let status = unsafe {
            NtCreateFile(
                &mut handle,
                FILE_GENERIC_READ | DELETE,
                &attributes,
                &mut status_block,
                None,
                FILE_ATTRIBUTE_NORMAL,
                FILE_SHARE_READ,
                FILE_CREATE,
                FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
                None,
                0,
            )
        };
        if status.0 < 0 {
            return Err(std::io::Error::from_raw_os_error(
                unsafe { RtlNtStatusToDosError(status) } as i32,
            )
            .into());
        }
        let file = unsafe { File::from_raw_handle(handle.0) };
        #[cfg(test)]
        AFTER_DIRECTORY_CREATE.with(|hook| {
            if let Some(hook) = hook.borrow_mut().as_mut() {
                hook(path);
            }
        });
        Self::from_created_file(file, path)
    }
    pub fn from_file(file: File) -> Result<Self> {
        let identity = Self::read_identity(&file)?;
        Ok(Self { file, identity })
    }
    /// Read-only recovery display after a restart, including files held by an editor.
    /// This metadata handle does not pin the name and cannot authorize mutating that path.
    pub fn inspect_identity(path: &Path) -> Result<Identity> {
        let file = OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES.0)
            .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0 | FILE_SHARE_DELETE.0)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0)
            .open(path)?;
        Self::read_identity(&file)
    }
    fn from_created_file(file: File, path: &Path) -> Result<Self> {
        let identity = Self::read_identity(&file);
        #[cfg(test)]
        let identity = if FAIL_CREATED_IDENTITY.with(|fail| fail.get()) {
            Err(anyhow::anyhow!("injected identity failure"))
        } else {
            identity
        };
        match identity {
            Ok(identity) => Ok(Self { file, identity }),
            Err(error) => Err(error).with_context(|| {
                format!(
                    "新项目身份无法验证，需手工处理不完整副本：{}",
                    path.display()
                )
            }),
        }
    }
    fn read_identity(file: &File) -> Result<Identity> {
        let identity = crate::services::file_identity::read(HANDLE(file.as_raw_handle()))?;
        if identity.kind & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
            bail!("模板不支持符号链接或目录联接");
        }
        Ok(identity)
    }
    pub fn path(&self) -> Result<PathBuf> {
        let mut buffer = vec![0u16; 32768];
        let len = unsafe {
            GetFinalPathNameByHandleW(
                HANDLE(self.file.as_raw_handle()),
                &mut buffer,
                GETFINALPATHNAMEBYHANDLE_FLAGS(FILE_NAME_NORMALIZED.0 | VOLUME_NAME_DOS.0),
            )
        } as usize;
        if len == 0 || len >= buffer.len() {
            bail!("无法读取项目的规范路径");
        }
        let path = String::from_utf16(&buffer[..len]).context("模板路径不是有效 Unicode")?;
        Ok(if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
            PathBuf::from(format!(r"\\{unc}"))
        } else {
            PathBuf::from(path.strip_prefix(r"\\?\").unwrap_or(&path))
        })
    }
    pub fn delete(self) -> Result<()> {
        Self::dispose(&self.file)
    }
    pub fn hidden(&self) -> Result<bool> {
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        unsafe { GetFileInformationByHandle(HANDLE(self.file.as_raw_handle()), &mut info) }?;
        Ok(info.dwFileAttributes & FILE_ATTRIBUTE_HIDDEN.0 != 0)
    }
    pub fn set_hidden(&self, hidden: bool) -> Result<()> {
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        unsafe { GetFileInformationByHandle(HANDLE(self.file.as_raw_handle()), &mut info) }?;
        let mut attributes = info.dwFileAttributes & !FILE_ATTRIBUTE_NORMAL.0;
        if hidden {
            attributes |= FILE_ATTRIBUTE_HIDDEN.0;
        } else {
            attributes &= !FILE_ATTRIBUTE_HIDDEN.0;
        }
        if attributes == 0 {
            attributes = FILE_ATTRIBUTE_NORMAL.0;
        }
        let basic = FILE_BASIC_INFO {
            FileAttributes: attributes,
            ..Default::default()
        };
        unsafe {
            SetFileInformationByHandle(
                HANDLE(self.file.as_raw_handle()),
                FileBasicInfo,
                (&basic as *const FILE_BASIC_INFO).cast(),
                std::mem::size_of_val(&basic) as u32,
            )
        }
        .context("无法更新恢复副本的显示属性")?;
        Ok(())
    }
    pub fn rename_to(&self, parent: &DirectoryGuard, name: &str) -> Result<()> {
        use windows::{
            Wdk::Storage::FileSystem::{
                FileRenameInformation, NtSetInformationFile, FILE_RENAME_INFORMATION,
            },
            Win32::{Foundation::RtlNtStatusToDosError, System::IO::IO_STATUS_BLOCK},
        };
        super::validate_name(name)?;
        let source_path = self.path()?;
        if !source_path
            .parent()
            .is_some_and(|path| super::same_path(path, &parent.path))
        {
            bail!("恢复移动只允许在已保护的同一父目录内进行");
        }
        let target = parent.path.join(name);
        let wide = name.encode_utf16().collect::<Vec<_>>();
        let offset = std::mem::offset_of!(FILE_RENAME_INFORMATION, FileName);
        let length =
            (offset + (wide.len() + 1) * 2).max(std::mem::size_of::<FILE_RENAME_INFORMATION>());
        let mut buffer = vec![0u64; length.div_ceil(8)];
        // A NULL RootDirectory and a basename rename within the source handle's parent.
        // An explicit parent handle or absolute name reopens that directory for write access,
        // conflicting with our anti-reparse share lock. Both the source and its complete
        // parent chain remain pinned; the same-parent check above forbids cross-directory use.
        unsafe {
            let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
            (*info).Anonymous.ReplaceIfExists = false;
            (*info).RootDirectory = HANDLE::default();
            (*info).FileNameLength = (wide.len() * 2) as u32;
            std::ptr::copy_nonoverlapping(
                wide.as_ptr(),
                info.cast::<u8>().add(offset).cast::<u16>(),
                wide.len(),
            );
            let mut io = IO_STATUS_BLOCK::default();
            let status = NtSetInformationFile(
                HANDLE(self.file.as_raw_handle()),
                &mut io,
                info.cast(),
                length as u32,
                FileRenameInformation,
            );
            if status.0 < 0 {
                return Err(std::io::Error::from_raw_os_error(
                    RtlNtStatusToDosError(status) as i32,
                ))
                .with_context(|| {
                    format!(
                        "无法移动副本到 {}（目标可能已存在或被占用）",
                        target.display()
                    )
                });
            }
        }
        Ok(())
    }
    fn dispose(file: &File) -> Result<()> {
        let info = FILE_DISPOSITION_INFO {
            DeleteFile: true.into(),
        };
        unsafe {
            SetFileInformationByHandle(
                HANDLE(file.as_raw_handle()),
                FileDispositionInfo,
                (&info as *const FILE_DISPOSITION_INFO).cast(),
                std::mem::size_of_val(&info) as u32,
            )
        }
        .context("无法移除副本（目录可能非空或文件被占用）")?;
        Ok(())
    }
}

pub struct DirectoryGuard {
    pub path: PathBuf,
    pub identity: Identity,
    _chain: Vec<EntryHandle>,
}
impl DirectoryGuard {
    pub fn open(path: &Path) -> Result<Self> {
        if !path.is_absolute() {
            bail!("需要 Windows 文件系统的绝对文件夹路径");
        }
        for component in path.components() {
            match component {
                Component::Prefix(prefix)
                    if matches!(
                        prefix.kind(),
                        std::path::Prefix::Disk(_) | std::path::Prefix::UNC(_, _)
                    ) => {}
                Component::RootDir => {}
                Component::Normal(name) => {
                    super::validate_name(name.to_str().context("路径不是有效 Unicode")?)?
                }
                _ => bail!("不支持此文件夹路径"),
            }
        }
        let mut ancestors = path
            .ancestors()
            .filter(|p| p.has_root())
            .collect::<Vec<_>>();
        ancestors.reverse();
        let mut chain = Vec::new();
        for ancestor in ancestors {
            let handle = EntryHandle::open(ancestor, false)?;
            if !handle.identity.is_directory() {
                bail!("不是文件夹：{}", ancestor.display());
            }
            chain.push(handle);
        }
        let last = chain.last().context("无效的文件夹路径")?;
        Ok(Self {
            path: last.path()?,
            identity: last.identity.clone(),
            _chain: chain,
        })
    }
}

pub fn is_reparse(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
}

#[cfg(test)]
thread_local! {
    pub(super) static AFTER_DIRECTORY_CREATE: std::cell::RefCell<Option<Box<dyn FnMut(&Path)>>> = const { std::cell::RefCell::new(None) };
    pub(super) static FAIL_CREATED_IDENTITY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

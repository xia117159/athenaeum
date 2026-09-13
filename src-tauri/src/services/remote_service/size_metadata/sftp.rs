use crate::{domain::models::RemoteProfile, services::directory_size::metadata::MetadataKind};
use std::{path::Path, sync::atomic::{AtomicBool, Ordering}};
use crate::services::directory_size::{scan::MetadataSource, metadata::MetadataEntry};
use super::super::{connection::{connect_sftp_cancelled, setup_stage}, join_remote_path, validate_remote_entry_name};

pub(super) trait SftpRead {
    fn read(&mut self, path: &str, cancelled: &AtomicBool,
        visit: &mut dyn FnMut(String, ssh2::FileStat) -> bool) -> Result<(), String>;
}
pub(super) struct SftpMetadataSource<T: SftpRead> { pub transport: T }
impl<T: SftpRead> SftpMetadataSource<T> { pub fn new(transport: T) -> Self { Self { transport } } }
impl<T: SftpRead> MetadataSource for SftpMetadataSource<T> {
    fn read_directory(&mut self, path: &str, cancelled: &AtomicBool,
        visit: &mut dyn FnMut(MetadataEntry) -> bool) -> Result<(), String> {
        self.transport.read(path, cancelled, &mut |name, stat| {
            if cancelled.load(Ordering::Relaxed) { return false; }
            if matches!(name.as_str(), "." | "..") { return true; }
            let kind = if validate_remote_entry_name(&name).is_ok() { sftp_metadata_kind(&stat) } else { MetadataKind::Unknown };
            let directory_path = (kind == MetadataKind::Directory).then(|| join_remote_path(path, &name));
            visit(MetadataEntry { name, kind, directory_path })
        })
    }
}

pub(super) struct SftpSession {
    _session: ssh2::Session,
    sftp: ssh2::Sftp,
    profile: RemoteProfile,
    canonical_root: String,
}
impl SftpSession {
    pub fn open(profile: RemoteProfile, root: &str, cancelled: &AtomicBool) -> Result<Self, String> {
        super::validated_path(&profile, root)?;
        let (session, sftp) = connect_sftp_cancelled(&profile, cancelled)
            .map_err(|_| "SFTP 连接、认证或主机密钥校验失败".to_string())?;
        let canonical_root = setup_stage(Some(cancelled), || Ok(sftp.realpath(Path::new(&profile.root_path))?)).ok()
            .and_then(|path| path.to_str().map(str::to_owned)).ok_or_else(|| "SFTP 根路径无法验证".to_string())?;
        let result = Self { _session: session, sftp, profile, canonical_root };
        result.validate_directory(root, cancelled)?;
        Ok(result)
    }
    fn validate_directory(&self, path: &str, cancelled: &AtomicBool) -> Result<(), String> {
        super::validated_path(&self.profile, path)?;
        let stat = setup_stage(Some(cancelled), || Ok(self.sftp.lstat(Path::new(path))?))
            .map_err(|_| "SFTP 目录元数据无法读取或统计已取消".to_string())?;
        if sftp_metadata_kind(&stat) != MetadataKind::Directory { return Err("SFTP 统计不跟随链接或非目录目标".into()); }
        let canonical = setup_stage(Some(cancelled), || Ok(self.sftp.realpath(Path::new(path))?))
            .map_err(|_| "SFTP 目录实际路径无法验证或统计已取消".to_string())?;
        let canonical = canonical.to_str().ok_or_else(|| "SFTP 路径编码不可用".to_string())?;
        let root = self.canonical_root.trim_end_matches('/');
        if canonical != self.canonical_root && !canonical.starts_with(&format!("{root}/")) {
            return Err("SFTP 目录的实际路径超出连接根路径".into());
        }
        Ok(())
    }
}
impl SftpRead for SftpSession {
    fn read(&mut self, path: &str, cancelled: &AtomicBool,
        visit: &mut dyn FnMut(String, ssh2::FileStat) -> bool) -> Result<(), String> {
        if cancelled.load(Ordering::Relaxed) { return Err("目录统计已取消".into()); }
        // Directory-level containment checks do not add per-file stat requests.
        self.validate_directory(path, cancelled)?;
        let mut directory = setup_stage(Some(cancelled), || Ok(self.sftp.opendir(Path::new(path))?))
            .map_err(|_| "SFTP 目录无法打开或统计已取消".to_string())?;
        while !cancelled.load(Ordering::Relaxed) {
            match directory.readdir() {
                Ok((name, stat)) => if !visit(name.to_str().unwrap_or("").to_owned(), stat) { break; },
                Err(error) if error.code() == ssh2::ErrorCode::Session(-16) => break, // libssh2 READDIR EOF
                Err(_) => return Err("SFTP 目录元数据读取失败或超时".into()),
            }
        }
        Ok(())
    }
}

pub(crate) fn scanner_profile(profile: &RemoteProfile) -> RemoteProfile {
    let mut copy = profile.clone();
    copy.connect_timeout_secs = copy.connect_timeout_secs.clamp(1, 20);
    copy.command_timeout_secs = copy.command_timeout_secs.clamp(1, 20);
    copy
}

pub(crate) fn sftp_metadata_kind(stat: &ssh2::FileStat) -> MetadataKind {
    if stat.perm.is_none() { MetadataKind::Unknown }
    else if stat.file_type().is_symlink() { MetadataKind::Link }
    else if stat.is_dir() { MetadataKind::Directory }
    else if stat.is_file() { stat.size.map(MetadataKind::File).unwrap_or(MetadataKind::Unknown) }
    else { MetadataKind::Special }
}

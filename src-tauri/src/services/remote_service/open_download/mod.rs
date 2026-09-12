use super::size_metadata::{
    ftp::{CurlMetadataTransport, FtpMetadataSource, FtpTransport},
    FtpEntryKind,
};
use crate::domain::models::{LocationKind, RemoteProfile};
use anyhow::{bail, Context, Result};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

/// A dedicated single-file path. No recursive transfer adapter is used here.
pub fn download_file(
    profile: &RemoteProfile,
    path: &str,
    target: &Path,
    cancelled: &AtomicBool,
    progress: &mut dyn FnMut(u64),
) -> Result<()> {
    check_cancelled(cancelled)?;
    let profile = super::normalize_profile(profile.clone());
    super::validate_profile(&profile)?;
    super::validate_remote_operation_source(&profile, path)?;
    let path = super::size_metadata::validated_path(&profile, path).map_err(anyhow::Error::msg)?;
    if !target.is_absolute() {
        bail!("下载副本需要绝对路径");
    }
    match profile.protocol {
        LocationKind::Sftp => {
            let (_session, sftp) = super::connection::connect_sftp_cancelled(&profile, cancelled)
                .context("SFTP 连接、认证或主机密钥校验失败")?;
            let root = super::connection::setup_stage(Some(cancelled), || {
                Ok(sftp.realpath(Path::new(&profile.root_path))?)
            })?;
            let resolved = super::connection::setup_stage(Some(cancelled), || {
                Ok(sftp.realpath(Path::new(&path))?)
            })?;
            let root = root
                .to_str()
                .context("SFTP 根路径编码不可用")?
                .trim_end_matches('/');
            let resolved = resolved.to_str().context("SFTP 文件路径编码不可用")?;
            if resolved != root && !resolved.starts_with(&format!("{root}/")) {
                bail!("SFTP 文件实际路径超出连接根路径");
            }
            download_sftp(&mut NativeSftp(sftp), &path, target, cancelled, progress)
        }
        LocationKind::Ftp => {
            let mut source = FtpMetadataSource::new(CurlMetadataTransport {
                password: profile.password.clone(),
                profile: profile.clone(),
            });
            download_ftp(&mut source, &path, cancelled, || {
                check_cancelled(cancelled)?;
                let command = transfer_command(&profile, &path, target)?;
                // Reserve the target exclusively only after metadata authorizes a file.
                drop(
                    fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(target)
                        .context("无法创建下载副本")?,
                );
                run_transfer(
                    command,
                    target,
                    cancelled,
                    Duration::from_secs(profile.command_timeout_secs),
                    progress,
                )
            })
        }
        _ => bail!("文件下载只支持 FTP/SFTP"),
    }
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<()> {
    if cancelled.load(Ordering::Acquire) {
        bail!("文件打开已取消");
    }
    Ok(())
}

fn require_file(is_file: bool) -> Result<()> {
    if !is_file {
        bail!("远程目标不是普通文件，不能打开目录、链接或未知类型");
    }
    Ok(())
}

trait SftpFileSource {
    type Reader: Read;
    fn lstat(&mut self, path: &str) -> Result<ssh2::FileStat>;
    fn open(&mut self, path: &str) -> Result<(Self::Reader, ssh2::FileStat)>;
}

struct NativeSftp(ssh2::Sftp);
impl SftpFileSource for NativeSftp {
    type Reader = ssh2::File;
    fn lstat(&mut self, path: &str) -> Result<ssh2::FileStat> {
        self.0
            .lstat(Path::new(path))
            .context("无法读取 SFTP 文件类型")
    }
    fn open(&mut self, path: &str) -> Result<(Self::Reader, ssh2::FileStat)> {
        let mut file = self.0.open(Path::new(path)).context("无法读取 SFTP 文件")?;
        let stat = file.stat().context("无法验证 SFTP 文件句柄")?;
        Ok((file, stat))
    }
}

fn download_sftp<S: SftpFileSource>(
    source: &mut S,
    path: &str,
    target: &Path,
    cancelled: &AtomicBool,
    progress: &mut dyn FnMut(u64),
) -> Result<()> {
    check_cancelled(cancelled)?;
    let stat = source.lstat(path)?;
    require_file(stat.perm.is_some() && stat.is_file())?;
    check_cancelled(cancelled)?;
    let (mut remote, stat) = source.open(path)?;
    check_cancelled(cancelled)?;
    require_file(stat.perm.is_some() && stat.is_file())?;
    let mut local = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .context("无法创建下载副本")?;
    copy_cancellable(&mut remote, &mut local, cancelled, progress)
}

fn download_ftp<T: FtpTransport>(
    source: &mut FtpMetadataSource<T>,
    path: &str,
    cancelled: &AtomicBool,
    transfer: impl FnOnce() -> Result<()>,
) -> Result<()> {
    check_cancelled(cancelled)?;
    let (parent, name) = path.rsplit_once('/').context("FTP 文件路径无效")?;
    let mut kind = None;
    source
        .read_typed_facts(
            if parent.is_empty() { "/" } else { parent },
            cancelled,
            &mut |fact| {
                if fact.name == name {
                    kind = Some(fact.kind);
                    false
                } else {
                    true
                }
            },
        )
        .map_err(|error| anyhow::anyhow!("无法验证 FTP 文件类型：{}", error.message()))?;
    check_cancelled(cancelled)?;
    require_file(matches!(
        kind.context("FTP 文件不存在或服务器未提供可验证的文件类型")?,
        FtpEntryKind::File(_)
    ))?;
    transfer()
}

fn copy_cancellable(
    reader: &mut impl Read,
    writer: &mut impl Write,
    cancelled: &AtomicBool,
    progress: &mut dyn FnMut(u64),
) -> Result<()> {
    let mut buffer = [0_u8; 64 * 1024];
    let mut bytes = 0;
    let mut reported = Instant::now();
    loop {
        check_cancelled(cancelled)?;
        let count = reader.read(&mut buffer).context("远程文件读取失败或超时")?;
        check_cancelled(cancelled)?;
        if count == 0 {
            break;
        }
        writer
            .write_all(&buffer[..count])
            .context("无法写入下载副本")?;
        bytes += count as u64;
        if bytes == count as u64 || reported.elapsed() >= Duration::from_millis(100) {
            progress(bytes);
            reported = Instant::now();
        }
    }
    writer.flush().context("无法完成下载副本写入")?;
    progress(bytes);
    Ok(())
}

fn transfer_command(profile: &RemoteProfile, path: &str, target: &Path) -> Result<Command> {
    let executable = super::preferred_curl_executable().context("无法定位 curl 程序")?;
    let mut command = Command::new(executable);
    command.args([
        "--disable",
        "--silent",
        "--fail",
        "--globoff",
        "--connect-timeout",
        &profile.connect_timeout_secs.to_string(),
        "--max-time",
        &profile.command_timeout_secs.to_string(),
        "--output",
    ]);
    command.arg(target);
    super::apply_curl_transfer_mode(&mut command, profile);
    super::add_curl_auth(&mut command, profile, profile.password.as_deref())?;
    // A file URL has no trailing slash: curl issues one RETR, never a recursive listing.
    command
        .arg("--url")
        .arg(super::build_url(profile, Some(path)));
    Ok(command)
}

struct TransferChild(std::process::Child);
impl Drop for TransferChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn run_transfer(
    mut command: Command,
    target: &Path,
    cancelled: &AtomicBool,
    timeout: Duration,
    progress: &mut dyn FnMut(u64),
) -> Result<()> {
    check_cancelled(cancelled)?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = TransferChild(command.spawn().context("无法启动 FTP 下载进程")?);
    let started = Instant::now();
    loop {
        check_cancelled(cancelled)?;
        if started.elapsed() >= timeout {
            bail!("FTP 文件下载超时");
        }
        if let Some(status) = child.0.try_wait().context("无法读取 FTP 下载状态")? {
            if !status.success() {
                bail!(
                    "FTP 文件下载失败（退出码 {:?}），请检查连接、文件权限和服务器状态",
                    status.code()
                );
            }
            check_cancelled(cancelled)?;
            progress(fs::metadata(target).map_or(0, |metadata| metadata.len()));
            return Ok(());
        }
        progress(fs::metadata(target).map_or(0, |metadata| metadata.len()));
        thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
mod ftp_wire_tests;
#[cfg(all(test, windows))]
mod shutdown_tests;
#[cfg(test)]
mod tests;

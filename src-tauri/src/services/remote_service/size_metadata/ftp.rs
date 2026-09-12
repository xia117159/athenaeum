use std::sync::atomic::{AtomicBool, Ordering};
use crate::services::directory_size::{metadata::{MetadataEntry, MetadataKind}, scan::MetadataSource};
use super::{parse_ftp_line, RemoteFact, FtpEntryFact, FtpEntryKind, parser::parse_typed_ftp_line};
use super::super::join_remote_path;
use crate::domain::models::RemoteProfile;
use std::process::Command;

pub(super) fn metadata_command(profile: &RemoteProfile, password: Option<&str>, path: &str,
    command: ListingCommand) -> Result<Command, String> {
    use super::super::{preferred_curl_executable, add_curl_auth, apply_curl_transfer_mode};
    let executable = preferred_curl_executable().ok_or_else(|| "无法定位 curl 程序".to_string())?;
    let mut process = Command::new(executable);
    process.args(["--disable", "--silent", "--fail", "--request", if command == ListingCommand::Mlsd { "MLSD" } else { "LIST -a" },
        "--connect-timeout", &profile.connect_timeout_secs.to_string(), "--max-time", &profile.command_timeout_secs.to_string()]);
    apply_curl_transfer_mode(&mut process, profile);
    add_curl_auth(&mut process, profile, password).map_err(|_| "FTP 认证配置不可用".to_string())?;
    // A trailing slash is essential: without it curl treats the path as a RETR target.
    process.arg(super::path::metadata_url(profile, path)?);
    Ok(process)
}

pub(crate) struct CurlMetadataTransport { pub profile: RemoteProfile, pub password: Option<String> }
impl FtpTransport for CurlMetadataTransport {
    fn root_kind(&mut self, path: &str, cancelled: &AtomicBool) -> Result<MetadataKind, TransportError> {
        if cancelled.load(Ordering::Relaxed) { return Err(TransportError::Cancelled); }
        let command = super::ftp_root::root_command(&self.profile, self.password.as_deref(), path).map_err(TransportError::Failed)?;
        super::ftp_root::read_root(command, cancelled, std::time::Duration::from_secs(self.profile.command_timeout_secs))
    }
    fn list(&mut self, path: &str, command: ListingCommand, cancelled: &AtomicBool,
        visit: &mut dyn FnMut(&[u8]) -> bool) -> Result<(), TransportError> {
        super::validated_path(&self.profile, path)
            .map_err(|_| TransportError::Failed("远程目录超出连接根路径".into()))?;
        let process = metadata_command(&self.profile, self.password.as_deref(), path, command).map_err(TransportError::Failed)?;
        let result = super::process::stream_process(process, cancelled, super::process::OutputLimits {
            timeout: std::time::Duration::from_secs(self.profile.command_timeout_secs), ..Default::default()
        }, visit)?;
        match result.code {
            Some(0) => Ok(()),
            Some(19 | 21) if result.bytes == 0 => Err(TransportError::Unsupported),
            _ => Err(TransportError::Failed("FTP 目录元数据读取失败，请检查连接、权限及服务器支持".into())),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ListingCommand { Mlsd, ListAll }
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TransportError { Unsupported, Cancelled, OutputLimit(String), Failed(String) }
impl TransportError {
    pub fn message(self) -> String {
        match self {
            Self::Unsupported => "FTP 服务器不支持目录元数据列表".into(),
            Self::Cancelled => "目录统计已取消".into(),
            Self::Failed(message) | Self::OutputLimit(message) => message,
        }
    }
}

pub(crate) trait FtpTransport {
    fn root_kind(&mut self, path: &str, cancelled: &AtomicBool) -> Result<MetadataKind, TransportError>;
    fn list(&mut self, path: &str, command: ListingCommand, cancelled: &AtomicBool,
        visit: &mut dyn FnMut(&[u8]) -> bool) -> Result<(), TransportError>;
}

pub(crate) struct FtpMetadataSource<T: FtpTransport> {
    pub transport: T,
    mlsd: Option<bool>,
    root_checked: bool,
    incomplete: Option<&'static str>,
    pub malformed: bool,
}
impl<T: FtpTransport> FtpMetadataSource<T> {
    pub fn new(transport: T) -> Self { Self { transport, mlsd: None, root_checked: false, incomplete: None, malformed: false } }

    pub fn read_facts(&mut self, path: &str, cancelled: &AtomicBool,
        visit: &mut dyn FnMut(RemoteFact) -> bool) -> Result<(), TransportError> {
        self.read_parsed(path, cancelled, parse_ftp_line,
            || RemoteFact { name: String::new(), kind: MetadataKind::Unknown, modified_at: None }, visit)
    }

    pub fn read_typed_facts(&mut self, path: &str, cancelled: &AtomicBool,
        visit: &mut dyn FnMut(FtpEntryFact) -> bool) -> Result<(), TransportError> {
        self.read_parsed(path, cancelled, parse_typed_ftp_line,
            || FtpEntryFact { name: String::new(), kind: FtpEntryKind::Unknown, modified_at: None }, visit)
    }

    fn read_parsed<Fact>(&mut self, path: &str, cancelled: &AtomicBool,
        parse: fn(ListingCommand, &[u8]) -> Result<Option<Fact>, ()>,
        invalid: impl Fn() -> Fact, visit: &mut dyn FnMut(Fact) -> bool) -> Result<(), TransportError> {
        self.incomplete = None;
        self.malformed = false;
        let mut command = if self.mlsd == Some(false) { ListingCommand::ListAll } else { ListingCommand::Mlsd };
        loop {
            if cancelled.load(Ordering::Relaxed) { return Err(TransportError::Cancelled); }
            let mut any_output = false;
            let mut malformed = false;
            let result = self.transport.list(path, command, cancelled, &mut |line| {
                any_output = true;
                if cancelled.load(Ordering::Relaxed) { return false; }
                match parse(command, line) {
                    Ok(Some(fact)) => visit(fact),
                    Ok(None) => true,
                    Err(()) => { malformed = true; visit(invalid()) }
                }
            });
            match result {
                Err(TransportError::Unsupported) if command == ListingCommand::Mlsd && !any_output => {
                    self.mlsd = Some(false);
                    command = ListingCommand::ListAll;
                    continue;
                }
                Err(error) => return Err(error),
                Ok(()) => {}
            }
            self.mlsd = Some(command == ListingCommand::Mlsd);
            self.malformed = malformed;
            self.incomplete = if command == ListingCommand::ListAll {
                Some("FTP LIST -a 无法保证包含全部隐藏条目，仅提供部分统计")
            } else if malformed { Some("部分 FTP 目录元数据无法识别") } else { None };
            return Ok(());
        }
    }
}
impl<T: FtpTransport> MetadataSource for FtpMetadataSource<T> {
    fn read_directory(&mut self, path: &str, cancelled: &AtomicBool,
        visit: &mut dyn FnMut(MetadataEntry) -> bool) -> Result<(), String> {
        if !self.root_checked {
            if cancelled.load(Ordering::Relaxed) { return Err("目录统计已取消".into()); }
            match self.transport.root_kind(path, cancelled) {
                Ok(MetadataKind::Directory) | Err(TransportError::Unsupported) => self.root_checked = true,
                Ok(MetadataKind::Link) => return Err("FTP 根目录被服务器标记为链接，已跳过统计".into()),
                Ok(_) => return Err("FTP 根目标不是可统计的目录".into()),
                Err(TransportError::Cancelled) => return Err("目录统计已取消".into()),
                Err(error) => return Err(error.message()),
            }
            // Directory/unsupported means server-visible traversal only. FTP
            // may transparently report link targets as ordinary directories.
        }
        self.read_facts(path, cancelled, &mut |fact| {
            let directory_path = (fact.kind == MetadataKind::Directory).then(|| join_remote_path(path, &fact.name));
            visit(MetadataEntry { name: fact.name, kind: fact.kind, directory_path })
        }).map_err(TransportError::message)
    }
    fn incomplete_reason(&self) -> Option<&str> { self.incomplete }
}

use std::{collections::HashSet, process::Command, sync::atomic::AtomicBool, time::Duration};
use crate::{domain::models::RemoteProfile, services::directory_size::metadata::MetadataKind};
use super::{process::{stream_process, OutputLimits}, TransportError};

pub(super) fn root_command(profile: &RemoteProfile, password: Option<&str>, path: &str) -> Result<Command, String> {
    use super::super::{preferred_curl_executable, add_curl_auth, apply_curl_transfer_mode, build_url};
    let path = super::validated_path(profile, path)?;
    let operand = if path == "/" { "." } else { path.trim_start_matches('/') };
    let executable = preferred_curl_executable().ok_or_else(|| "无法定位 curl 程序".to_string())?;
    let mut command = Command::new(executable);
    command.args(["--disable", "--silent", "--fail", "--head", "--dump-header", "-", "--quote", &format!("MLST {operand}"),
        "--connect-timeout", &profile.connect_timeout_secs.to_string(), "--max-time", &profile.command_timeout_secs.to_string()]);
    apply_curl_transfer_mode(&mut command, profile);
    add_curl_auth(&mut command, profile, password).map_err(|_| "FTP 认证配置不可用".to_string())?;
    // Current FTP URLs are relative to the login directory. Query the raw named
    // object before CWD; inspecting '.' after entering it would hide a root link.
    command.arg(build_url(profile, Some("/")));
    Ok(command)
}

#[derive(Default)]
enum Phase { #[default] Login, Root, Facts, Rejected(u16), Done }
#[derive(Default)]
pub(super) struct MlstReply {
    phase: Phase,
    login_multiline: Option<u16>,
    code: Option<u16>,
    kind: Option<MetadataKind>,
    invalid: bool,
}
impl MlstReply {
    pub fn feed(&mut self, line: &[u8]) {
        if self.invalid { return; }
        let Ok(line) = std::str::from_utf8(line) else { self.invalid = true; return; };
        let line = line.trim_end_matches('\r');
        if line.chars().any(char::is_control) { self.invalid = true; return; }
        let status = status_line(line);
        match self.phase {
            Phase::Login => {
                if let Some(code) = self.login_multiline {
                    if status == Some((code, b' ')) {
                        self.login_multiline = None;
                        if code == 257 { self.phase = Phase::Root; }
                    }
                    return;
                }
                match status {
                    Some((code, b'-')) => self.login_multiline = Some(code),
                    Some((257, b' ')) => self.phase = Phase::Root,
                    Some((code, _)) if code < 400 => {},
                    _ => self.invalid = true,
                }
            }
            Phase::Root => match status {
                Some((250, b'-')) => self.phase = Phase::Facts,
                Some((code, separator)) if code >= 400 => {
                    self.code = Some(code);
                    self.phase = if separator == b'-' { Phase::Rejected(code) } else { Phase::Done };
                }
                _ => self.invalid = true,
            },
            Phase::Facts => {
                if status == Some((250, b' ')) { self.code = Some(250); self.phase = Phase::Done; }
                else if let Some(facts) = line.strip_prefix(' ') {
                    match root_fact(facts) {
                        Ok(kind) if self.kind.is_none() => self.kind = Some(kind),
                        _ => self.invalid = true,
                    }
                } else { self.invalid = true; }
            }
            Phase::Rejected(code) => {
                if status == Some((code, b' ')) { self.phase = Phase::Done; }
            }
            Phase::Done => {
                // A QUIT reply may follow the root response; later failure is
                // not a successful preflight even if facts were already read.
                if !line.is_empty() && !matches!(status, Some((221, _))) { self.invalid = true; }
            }
        }
    }
    pub fn finish(self, exit: Option<i32>) -> Result<MetadataKind, TransportError> {
        if !self.invalid && matches!(self.phase, Phase::Done) {
            if self.code == Some(250) && exit == Some(0) {
                if let Some(kind) = self.kind { return Ok(kind); }
            }
            if matches!(self.code, Some(500 | 502 | 504)) && exit == Some(21) {
                return Err(TransportError::Unsupported);
            }
        }
        Err(TransportError::Failed("FTP 根目录元数据读取失败或响应不完整，请检查权限及服务器支持".into()))
    }
}

fn status_line(line: &str) -> Option<(u16, u8)> {
    let bytes = line.as_bytes();
    (bytes.len() >= 4 && bytes[..3].iter().all(u8::is_ascii_digit) && matches!(bytes[3], b' ' | b'-'))
        .then(|| (line[..3].parse().expect("three ASCII digits"), bytes[3]))
}

fn root_fact(line: &str) -> Result<MetadataKind, ()> {
    let (facts, name) = line.split_once(' ').ok_or(())?;
    if !facts.ends_with(';') || name.is_empty() { return Err(()); }
    let mut keys = HashSet::new();
    let mut kind = None;
    let mut link = false;
    for fact in facts.split(';').filter(|fact| !fact.is_empty()) {
        let (key, value) = fact.split_once('=').ok_or(())?;
        let key = key.to_ascii_lowercase();
        if key.is_empty() || !keys.insert(key.clone()) { return Err(()); }
        match key.as_str() {
            "type" => kind = Some(value.to_ascii_lowercase()),
            "unix.slink" => link = true,
            _ => {},
        }
    }
    let kind = kind.ok_or(())?;
    if link || kind.starts_with("os.unix=slink") || kind.starts_with("os.unix=symlink") { return Ok(MetadataKind::Link); }
    match kind.as_str() {
        "dir" | "cdir" => Ok(MetadataKind::Directory),
        "file" => Ok(MetadataKind::File(0)), // Only the root's type is used; it is not a size measurement.
        _ => Err(()),
    }
}

pub(super) fn read_root(command: Command, cancelled: &AtomicBool, timeout: Duration) -> Result<MetadataKind, TransportError> {
    let mut reply = MlstReply::default();
    let exit = stream_process(command, cancelled, OutputLimits { bytes: 64 * 1024, timeout, ..Default::default() },
        &mut |line| { reply.feed(line); true })?;
    // Never stop at the first fact: only the actual process exit plus the full
    // response framing can distinguish unsupported from permission/truncation.
    reply.finish(exit.code)
}

mod windows_credentials;

use std::{
  env,
  fs,
  io,
  net::{TcpStream, ToSocketAddrs},
  path::{Path, PathBuf},
  process::{Command, Output},
  time::{Duration, SystemTime, UNIX_EPOCH}
};

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::{STANDARD, STANDARD_NO_PAD}, Engine as _};
use chrono::{TimeZone, Utc};
use sha2::{Digest, Sha256};
use ssh2::{CheckResult, FileStat, HostKeyType, KnownHostFileKind, KnownHostKeyFormat, Session, Sftp};

use crate::domain::models::{
  EntryDecoration, EntryKind, EntryViewModel, LocationDescriptor, LocationKind, RemoteAdapterKind, RemoteAuthKind,
  RemoteHostKeyInfo, RemoteHostKeyTrustState, RemoteProfile, RemoteProfileUpsertRequest, RemoteTestResult,
  RemoteTrustHostKeyRequest
};

pub fn validate_profile(profile: &RemoteProfile) -> Result<()> {
  if profile.id.trim().is_empty() {
    bail!("id is required");
  }
  if profile.name.trim().is_empty() {
    bail!("name is required");
  }
  if profile.host.trim().is_empty() {
    bail!("host is required");
  }
  if matches!(profile.auth_kind.clone(), RemoteAuthKind::Password | RemoteAuthKind::KeyFile)
    && profile.username.trim().is_empty()
  {
    bail!("username is required");
  }
  if !matches!(profile.protocol.clone(), LocationKind::Ftp | LocationKind::Sftp) {
    bail!("remote protocol must be ftp or sftp");
  }
  validate_remote_path(&profile.root_path)?;
  if profile.host.contains("://") || profile.host.contains('/') || profile.host.contains('\\') {
    bail!("host must not include a scheme or path");
  }
  if profile.port == 0 {
    bail!("port must be greater than zero");
  }
  if profile.connect_timeout_secs == 0 || profile.command_timeout_secs == 0 {
    bail!("timeouts must be greater than zero");
  }
  if matches!(profile.auth_kind.clone(), RemoteAuthKind::Anonymous) && !matches!(profile.protocol.clone(), LocationKind::Ftp) {
    bail!("anonymous auth is only supported for FTP");
  }
  if matches!(profile.auth_kind.clone(), RemoteAuthKind::KeyFile) {
    if !matches!(profile.protocol.clone(), LocationKind::Sftp) {
      bail!("key-file auth is only supported for SFTP");
    }
    if profile.private_key_path.as_deref().unwrap_or_default().trim().is_empty() {
      bail!("private key path is required for key-file auth");
    }
  }
  Ok(())
}

pub fn credential_target_for_profile(id: &str) -> String {
  format!("SimpleFileManager.Remote.{}", id.trim())
}

pub fn prepare_profile_for_save(
  request: RemoteProfileUpsertRequest,
  existing_credential_target: Option<&str>
) -> Result<RemoteProfile> {
  let mut profile = normalize_profile(request.profile);
  let existing_credential_target = existing_credential_target
    .and_then(|target| (!target.trim().is_empty()).then(|| target.to_string()));
  profile.credential_target = None;
  validate_profile(&profile)?;

  match profile.auth_kind.clone() {
    RemoteAuthKind::Anonymous => {
      if let Some(target) = existing_credential_target.as_deref() {
        let _ = windows_credentials::delete_secret(target);
      }
      profile.credential_target = None;
    }
    RemoteAuthKind::Password | RemoteAuthKind::KeyFile => {
      if let Some(secret) = request.password.as_deref().filter(|value| !value.trim().is_empty()) {
        let target = existing_credential_target.unwrap_or_else(|| credential_target_for_profile(&profile.id));
        windows_credentials::write_secret(&target, secret)?;
        profile.credential_target = Some(target);
      } else {
        profile.credential_target = existing_credential_target;
      }
    }
  }

  Ok(profile)
}

pub fn cleanup_profile_after_delete(profile: &RemoteProfile) {
  if let Some(target) = profile.credential_target.as_deref() {
    let _ = windows_credentials::delete_secret(target);
  }
}

pub fn test_profile(profile: &RemoteProfile, password: Option<&str>) -> Result<RemoteTestResult> {
  let profile = normalize_profile(profile.clone());
  validate_profile(&profile)?;
  select_adapter(&profile).test_profile(&profile, password)
}

pub fn fetch_host_key_info(profile: &RemoteProfile) -> Result<RemoteHostKeyInfo> {
  let profile = normalize_profile(profile.clone());
  validate_profile(&profile)?;
  if !matches!(profile.protocol, LocationKind::Sftp) {
    bail!("host key confirmation is only supported for SFTP profiles");
  }
  let session = connect_ssh_session(&profile)?;
  create_remote_host_key_info(&profile, &session)
}

pub fn trust_host_key(profile: &RemoteProfile, request: &RemoteTrustHostKeyRequest) -> Result<RemoteHostKeyInfo> {
  let profile = normalize_profile(profile.clone());
  validate_profile(&profile)?;
  if !matches!(profile.protocol, LocationKind::Sftp) {
    bail!("host key confirmation is only supported for SFTP profiles");
  }
  if request.profile_id != profile.id {
    bail!("host key profile id does not match");
  }
  if request.host != profile.host || request.port != profile.port {
    bail!("host key target does not match the remote profile");
  }

  let key = STANDARD
    .decode(request.key_base64.as_bytes())
    .context("host key is not valid base64")?;
  let host_key_type = host_key_type_from_algorithm(&request.algorithm)
    .ok_or_else(|| anyhow!("unsupported host key algorithm: {}", request.algorithm))?;
  write_known_host_entry(&profile, &key, host_key_type)?;
  fetch_host_key_info(&profile)
}

pub fn list_directory(profile: &RemoteProfile, password: Option<&str>, path: Option<&str>) -> Result<Vec<EntryViewModel>> {
  let profile = normalize_profile(profile.clone());
  validate_profile(&profile)?;
  if let Some(path) = path {
    validate_remote_path_within_root(&profile, path)?;
  }
  select_adapter(&profile).list_directory(&profile, password, path)
}

pub fn create_directory(profile: &RemoteProfile, password: Option<&str>, parent: &str, name: &str) -> Result<String> {
  let profile = normalize_profile(profile.clone());
  validate_profile(&profile)?;
  validate_remote_path_within_root(&profile, parent)?;
  validate_remote_entry_name(name)?;
  select_adapter(&profile).create_directory(&profile, password, parent, name)
}

pub fn delete_entries(profile: &RemoteProfile, password: Option<&str>, sources: &[String]) -> Result<Vec<String>> {
  let profile = normalize_profile(profile.clone());
  validate_profile(&profile)?;
  for source in sources {
    validate_remote_operation_source(&profile, source)?;
  }
  select_adapter(&profile).delete_entries(&profile, password, sources)
}

pub fn rename_entry(profile: &RemoteProfile, password: Option<&str>, source: &str, new_name: &str) -> Result<String> {
  let profile = normalize_profile(profile.clone());
  validate_profile(&profile)?;
  validate_remote_operation_source(&profile, source)?;
  validate_remote_entry_name(new_name)?;
  select_adapter(&profile).rename_entry(&profile, password, source, new_name)
}

pub fn upload_files(
  profile: &RemoteProfile,
  password: Option<&str>,
  local_sources: &[String],
  remote_destination: &str
) -> Result<Vec<String>> {
  let profile = normalize_profile(profile.clone());
  validate_profile(&profile)?;
  validate_remote_path_within_root(&profile, remote_destination)?;
  select_adapter(&profile).upload_files(&profile, password, local_sources, remote_destination)
}

pub fn download_entries(
  profile: &RemoteProfile,
  password: Option<&str>,
  remote_sources: &[String],
  local_destination: &str
) -> Result<Vec<String>> {
  let profile = normalize_profile(profile.clone());
  validate_profile(&profile)?;
  for source in remote_sources {
    validate_remote_operation_source(&profile, source)?;
  }
  select_adapter(&profile).download_entries(&profile, password, remote_sources, local_destination)
}

pub fn copy_entries(
  profile: &RemoteProfile,
  password: Option<&str>,
  remote_sources: &[String],
  remote_destination: &str
) -> Result<Vec<String>> {
  let profile = normalize_profile(profile.clone());
  validate_profile(&profile)?;
  for source in remote_sources {
    validate_remote_operation_source(&profile, source)?;
  }
  validate_remote_path_within_root(&profile, remote_destination)?;
  select_adapter(&profile).copy_entries(&profile, password, remote_sources, remote_destination)
}

pub fn move_entries(
  profile: &RemoteProfile,
  password: Option<&str>,
  remote_sources: &[String],
  remote_destination: &str
) -> Result<Vec<String>> {
  let profile = normalize_profile(profile.clone());
  validate_profile(&profile)?;
  for source in remote_sources {
    validate_remote_operation_source(&profile, source)?;
  }
  validate_remote_path_within_root(&profile, remote_destination)?;
  select_adapter(&profile).move_entries(&profile, password, remote_sources, remote_destination)
}

pub fn transfer_entries(
  source_profile: &RemoteProfile,
  source_password: Option<&str>,
  destination_profile: &RemoteProfile,
  destination_password: Option<&str>,
  remote_sources: &[String],
  remote_destination: &str,
  delete_sources: bool
) -> Result<Vec<String>> {
  let source_profile = normalize_profile(source_profile.clone());
  let destination_profile = normalize_profile(destination_profile.clone());
  validate_profile(&source_profile)?;
  validate_profile(&destination_profile)?;
  for source in remote_sources {
    validate_remote_operation_source(&source_profile, source)?;
  }
  validate_remote_path_within_root(&destination_profile, remote_destination)?;

  let temp_root = create_remote_transfer_temp_dir()?;
  let transfer_result = (|| {
    let downloaded = download_entries(
      &source_profile,
      source_password,
      remote_sources,
      &temp_root.to_string_lossy()
    )?;
    let uploaded = upload_files(
      &destination_profile,
      destination_password,
      &downloaded,
      remote_destination
    )?;
    if delete_sources {
      delete_entries(&source_profile, source_password, remote_sources)?;
    }
    Ok(uploaded)
  })();
  let cleanup_result = fs::remove_dir_all(&temp_root);

  match (transfer_result, cleanup_result) {
    (Ok(uploaded), Ok(())) => Ok(uploaded),
    (Ok(uploaded), Err(error)) if error.kind() == io::ErrorKind::NotFound => Ok(uploaded),
    (Ok(_), Err(error)) => Err(error).with_context(|| format!("failed to clean remote transfer temp directory {}", temp_root.display())),
    (Err(error), _) => Err(error)
  }
}

trait RemoteAdapter {
  fn kind(&self) -> RemoteAdapterKind;
  fn test_profile(&self, profile: &RemoteProfile, password: Option<&str>) -> Result<RemoteTestResult>;
  fn list_directory(&self, profile: &RemoteProfile, password: Option<&str>, path: Option<&str>) -> Result<Vec<EntryViewModel>>;
  fn create_directory(&self, profile: &RemoteProfile, password: Option<&str>, parent: &str, name: &str) -> Result<String>;
  fn delete_entries(&self, profile: &RemoteProfile, password: Option<&str>, sources: &[String]) -> Result<Vec<String>>;
  fn rename_entry(&self, profile: &RemoteProfile, password: Option<&str>, source: &str, new_name: &str) -> Result<String>;
  fn upload_files(
    &self,
    profile: &RemoteProfile,
    password: Option<&str>,
    local_sources: &[String],
    remote_destination: &str
  ) -> Result<Vec<String>>;
  fn download_entries(
    &self,
    profile: &RemoteProfile,
    password: Option<&str>,
    remote_sources: &[String],
    local_destination: &str
  ) -> Result<Vec<String>>;
  fn copy_entries(
    &self,
    profile: &RemoteProfile,
    password: Option<&str>,
    remote_sources: &[String],
    remote_destination: &str
  ) -> Result<Vec<String>>;
  fn move_entries(
    &self,
    profile: &RemoteProfile,
    password: Option<&str>,
    remote_sources: &[String],
    remote_destination: &str
  ) -> Result<Vec<String>>;
}

struct CurlRemoteAdapter;

impl RemoteAdapter for CurlRemoteAdapter {
  fn kind(&self) -> RemoteAdapterKind {
    RemoteAdapterKind::Curl
  }

  fn test_profile(&self, profile: &RemoteProfile, password: Option<&str>) -> Result<RemoteTestResult> {
    if matches!(profile.auth_kind.clone(), RemoteAuthKind::KeyFile) {
      return Ok(RemoteTestResult {
        success: false,
        message: "Key-file SFTP probing is not implemented yet".into(),
        adapter: self.kind(),
        details: vec!["Planned Windows path: invoke sftp.exe or curl --key with host-key controls.".into()]
      });
    }

    let output = run_curl_list(profile, password, None)?;
    if output.status.success() {
      Ok(RemoteTestResult {
        success: true,
        message: "Connection probe succeeded".into(),
        adapter: self.kind(),
        details: collect_probe_details(&output)
      })
    } else {
      Ok(RemoteTestResult {
        success: false,
        message: stderr_message(&output, "Remote probe failed"),
        adapter: self.kind(),
        details: collect_probe_details(&output)
      })
    }
  }

  fn list_directory(&self, profile: &RemoteProfile, password: Option<&str>, path: Option<&str>) -> Result<Vec<EntryViewModel>> {
    let output = run_curl_list(profile, password, path)?;
    if !output.status.success() {
      bail!("{}", stderr_message(&output, "remote directory listing failed"));
    }
    Ok(parse_listing_entries(profile, path, &output.stdout))
  }

  fn create_directory(&self, profile: &RemoteProfile, password: Option<&str>, parent: &str, name: &str) -> Result<String> {
    let created = join_remote_path(&normalize_remote_path(parent), name);
    let created = available_curl_conflict_path(profile, password, &created)?;
    run_curl_quotes(profile, password, &[format!("MKD {created}")])?;
    Ok(created)
  }

  fn delete_entries(&self, profile: &RemoteProfile, password: Option<&str>, sources: &[String]) -> Result<Vec<String>> {
    let mut deleted = Vec::new();
    for source in sources {
      let source = normalize_remote_path(source);
      delete_ftp_entry(profile, password, &source)?;
      deleted.push(source);
    }
    Ok(deleted)
  }

  fn rename_entry(&self, profile: &RemoteProfile, password: Option<&str>, source: &str, new_name: &str) -> Result<String> {
    let source = normalize_remote_path(source);
    let parent = remote_parent_path(&source).ok_or_else(|| anyhow!("cannot rename remote root"))?;
    let destination = join_remote_path(&parent, new_name);
    if remote_path_exists_via_curl(profile, password, &destination)? {
      bail!("remote destination already exists: {destination}");
    }
    run_curl_quotes(profile, password, &[format!("RNFR {source}"), format!("RNTO {destination}")])?;
    Ok(destination)
  }

  fn upload_files(
    &self,
    profile: &RemoteProfile,
    password: Option<&str>,
    local_sources: &[String],
    remote_destination: &str
  ) -> Result<Vec<String>> {
    let mut uploaded = Vec::new();
    for source in local_sources {
      let source_path = Path::new(source);
      let file_name = source_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| anyhow!("invalid local source path: {source}"))?;
      let target = join_remote_path(&normalize_remote_path(remote_destination), file_name);
      let target = available_curl_conflict_path(profile, password, &target)?;
      upload_path_with_curl(profile, password, source_path, &target)?;
      uploaded.push(target);
    }
    Ok(uploaded)
  }

  fn download_entries(
    &self,
    profile: &RemoteProfile,
    password: Option<&str>,
    remote_sources: &[String],
    local_destination: &str
  ) -> Result<Vec<String>> {
    let mut downloaded = Vec::new();
    for source in remote_sources {
      let source = normalize_remote_path(source);
      let file_name = remote_file_name(&source).ok_or_else(|| anyhow!("invalid remote source path: {source}"))?;
      let destination = available_local_conflict_path(&Path::new(local_destination).join(file_name));
      run_curl_download(profile, password, &source, &destination)?;
      downloaded.push(destination.to_string_lossy().into_owned());
    }
    Ok(downloaded)
  }

  fn copy_entries(
    &self,
    profile: &RemoteProfile,
    password: Option<&str>,
    remote_sources: &[String],
    remote_destination: &str
  ) -> Result<Vec<String>> {
    let temp_root = create_remote_transfer_temp_dir()?;
    let copy_result = (|| {
      let downloaded = self.download_entries(profile, password, remote_sources, &temp_root.to_string_lossy())?;
      self.upload_files(profile, password, &downloaded, remote_destination)
    })();
    let cleanup_result = fs::remove_dir_all(&temp_root);

    match (copy_result, cleanup_result) {
      (Ok(copied), Ok(())) => Ok(copied),
      (Ok(copied), Err(error)) if error.kind() == io::ErrorKind::NotFound => Ok(copied),
      (Ok(_), Err(error)) => Err(error).with_context(|| format!("failed to clean FTP copy temp directory {}", temp_root.display())),
      (Err(error), _) => Err(error)
    }
  }

  fn move_entries(
    &self,
    profile: &RemoteProfile,
    password: Option<&str>,
    remote_sources: &[String],
    remote_destination: &str
  ) -> Result<Vec<String>> {
    let mut moved = Vec::new();
    for source in remote_sources {
      let source = normalize_remote_path(source);
      let file_name = remote_file_name(&source).ok_or_else(|| anyhow!("invalid remote source path: {source}"))?;
      let destination = join_remote_path(&normalize_remote_path(remote_destination), &file_name);
      let destination = available_curl_conflict_path(profile, password, &destination)?;
      run_curl_quotes(profile, password, &[format!("RNFR {source}"), format!("RNTO {destination}")])?;
      moved.push(destination);
    }
    Ok(moved)
  }
}

struct SftpRemoteAdapter;

impl RemoteAdapter for SftpRemoteAdapter {
  fn kind(&self) -> RemoteAdapterKind {
    RemoteAdapterKind::Sftp
  }

  fn test_profile(&self, profile: &RemoteProfile, password: Option<&str>) -> Result<RemoteTestResult> {
    match connect_sftp(profile, password) {
      Ok((_, sftp)) => match sftp.readdir(Path::new(&profile.root_path)) {
        Ok(_) => Ok(RemoteTestResult {
          success: true,
          message: "SFTP connection probe succeeded".into(),
          adapter: self.kind(),
          details: Vec::new()
        }),
        Err(error) => Ok(RemoteTestResult {
          success: false,
          message: format!("SFTP connected but failed to read root: {error}"),
          adapter: self.kind(),
          details: Vec::new()
        })
      },
      Err(error) => Ok(RemoteTestResult {
        success: false,
        message: error.to_string(),
        adapter: self.kind(),
        details: Vec::new()
      })
    }
  }

  fn list_directory(&self, profile: &RemoteProfile, password: Option<&str>, path: Option<&str>) -> Result<Vec<EntryViewModel>> {
    let (_, sftp) = connect_sftp(profile, password)?;
    let base_path = normalize_remote_path(path.unwrap_or(&profile.root_path));
    let entries = sftp
      .readdir(Path::new(&base_path))
      .with_context(|| format!("failed to list remote directory {base_path}"))?;
    Ok(parse_sftp_entries(profile, &base_path, entries))
  }

  fn create_directory(&self, profile: &RemoteProfile, password: Option<&str>, parent: &str, name: &str) -> Result<String> {
    let (_, sftp) = connect_sftp(profile, password)?;
    let destination = join_remote_path(&normalize_remote_path(parent), name);
    let destination = available_sftp_conflict_path(&sftp, &destination);
    sftp
      .mkdir(Path::new(&destination), 0o755)
      .with_context(|| format!("failed to create remote directory {destination}"))?;
    Ok(destination)
  }

  fn delete_entries(&self, profile: &RemoteProfile, password: Option<&str>, sources: &[String]) -> Result<Vec<String>> {
    let (_, sftp) = connect_sftp(profile, password)?;
    let mut deleted = Vec::new();
    for source in sources {
      let source = normalize_remote_path(source);
      let stat = sftp.lstat(Path::new(&source)).with_context(|| format!("failed to stat remote path {source}"))?;
      if stat.is_dir() {
        remove_sftp_directory_recursively(&sftp, &source)?;
      } else {
        sftp.unlink(Path::new(&source)).with_context(|| format!("failed to delete remote file {source}"))?;
      }
      deleted.push(source);
    }
    Ok(deleted)
  }

  fn rename_entry(&self, profile: &RemoteProfile, password: Option<&str>, source: &str, new_name: &str) -> Result<String> {
    let (_, sftp) = connect_sftp(profile, password)?;
    let source = normalize_remote_path(source);
    let parent = remote_parent_path(&source).ok_or_else(|| anyhow!("cannot rename remote root"))?;
    let destination = join_remote_path(&parent, new_name);
    if sftp.lstat(Path::new(&destination)).is_ok() {
      bail!("remote destination already exists: {destination}");
    }
    sftp
      .rename(Path::new(&source), Path::new(&destination), None)
      .with_context(|| format!("failed to rename remote path {source} to {destination}"))?;
    Ok(destination)
  }

  fn upload_files(
    &self,
    profile: &RemoteProfile,
    password: Option<&str>,
    local_sources: &[String],
    remote_destination: &str
  ) -> Result<Vec<String>> {
    let (_, sftp) = connect_sftp(profile, password)?;
    let mut uploaded = Vec::new();
    for source in local_sources {
      let source_path = Path::new(source);
      let file_name = source_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| anyhow!("invalid local source path: {source}"))?;
      let target = join_remote_path(&normalize_remote_path(remote_destination), file_name);
      let target = available_sftp_conflict_path(&sftp, &target);
      upload_path_to_sftp(&sftp, source_path, &target)?;
      uploaded.push(target);
    }
    Ok(uploaded)
  }

  fn download_entries(
    &self,
    profile: &RemoteProfile,
    password: Option<&str>,
    remote_sources: &[String],
    local_destination: &str
  ) -> Result<Vec<String>> {
    let (_, sftp) = connect_sftp(profile, password)?;
    let mut downloaded = Vec::new();
    for source in remote_sources {
      let source = normalize_remote_path(source);
      let stat = sftp.lstat(Path::new(&source)).with_context(|| format!("failed to stat remote path {source}"))?;
      let file_name = remote_file_name(&source).ok_or_else(|| anyhow!("invalid remote source path: {source}"))?;
      let destination = available_local_conflict_path(&Path::new(local_destination).join(file_name));
      download_path_from_sftp(&sftp, &source, &stat, &destination)?;
      downloaded.push(destination.to_string_lossy().into_owned());
    }
    Ok(downloaded)
  }

  fn copy_entries(
    &self,
    profile: &RemoteProfile,
    password: Option<&str>,
    remote_sources: &[String],
    remote_destination: &str
  ) -> Result<Vec<String>> {
    let (_, sftp) = connect_sftp(profile, password)?;
    let mut copied = Vec::new();
    for source in remote_sources {
      let source = normalize_remote_path(source);
      let stat = sftp.lstat(Path::new(&source)).with_context(|| format!("failed to stat remote path {source}"))?;
      let file_name = remote_file_name(&source).ok_or_else(|| anyhow!("invalid remote source path: {source}"))?;
      let destination = join_remote_path(&normalize_remote_path(remote_destination), &file_name);
      let destination = available_sftp_conflict_path(&sftp, &destination);
      ensure_remote_not_inside_source(&source, &destination)?;
      copy_sftp_path(&sftp, &source, &stat, &destination)?;
      copied.push(destination);
    }
    Ok(copied)
  }

  fn move_entries(
    &self,
    profile: &RemoteProfile,
    password: Option<&str>,
    remote_sources: &[String],
    remote_destination: &str
  ) -> Result<Vec<String>> {
    let (_, sftp) = connect_sftp(profile, password)?;
    let mut moved = Vec::new();
    for source in remote_sources {
      let source = normalize_remote_path(source);
      let file_name = remote_file_name(&source).ok_or_else(|| anyhow!("invalid remote source path: {source}"))?;
      let destination = join_remote_path(&normalize_remote_path(remote_destination), &file_name);
      let destination = available_sftp_conflict_path(&sftp, &destination);
      ensure_remote_not_inside_source(&source, &destination)?;
      sftp
        .rename(Path::new(&source), Path::new(&destination), None)
        .with_context(|| format!("failed to move remote path {source} to {destination}"))?;
      moved.push(destination);
    }
    Ok(moved)
  }
}

struct UnsupportedRemoteAdapter;

impl RemoteAdapter for UnsupportedRemoteAdapter {
  fn kind(&self) -> RemoteAdapterKind {
    RemoteAdapterKind::Unsupported
  }

  fn test_profile(&self, _profile: &RemoteProfile, _password: Option<&str>) -> Result<RemoteTestResult> {
    Ok(RemoteTestResult {
      success: false,
      message: "No supported remote adapter was found on this machine".into(),
      adapter: self.kind(),
      details: vec!["Expected Windows path is curl.exe for password-based FTP/SFTP probing.".into()]
    })
  }

  fn list_directory(&self, _profile: &RemoteProfile, _password: Option<&str>, _path: Option<&str>) -> Result<Vec<EntryViewModel>> {
    bail!("remote directory listing is unavailable because no supported adapter was found")
  }

  fn create_directory(&self, _profile: &RemoteProfile, _password: Option<&str>, _parent: &str, _name: &str) -> Result<String> {
    bail!("remote directory creation is unavailable because no supported adapter was found")
  }

  fn delete_entries(&self, _profile: &RemoteProfile, _password: Option<&str>, _sources: &[String]) -> Result<Vec<String>> {
    bail!("remote delete is unavailable because no supported adapter was found")
  }

  fn rename_entry(&self, _profile: &RemoteProfile, _password: Option<&str>, _source: &str, _new_name: &str) -> Result<String> {
    bail!("remote rename is unavailable because no supported adapter was found")
  }

  fn upload_files(
    &self,
    _profile: &RemoteProfile,
    _password: Option<&str>,
    _local_sources: &[String],
    _remote_destination: &str
  ) -> Result<Vec<String>> {
    bail!("remote upload is unavailable because no supported adapter was found")
  }

  fn download_entries(
    &self,
    _profile: &RemoteProfile,
    _password: Option<&str>,
    _remote_sources: &[String],
    _local_destination: &str
  ) -> Result<Vec<String>> {
    bail!("remote download is unavailable because no supported adapter was found")
  }

  fn copy_entries(
    &self,
    _profile: &RemoteProfile,
    _password: Option<&str>,
    _remote_sources: &[String],
    _remote_destination: &str
  ) -> Result<Vec<String>> {
    bail!("remote copy is unavailable because no supported adapter was found")
  }

  fn move_entries(
    &self,
    _profile: &RemoteProfile,
    _password: Option<&str>,
    _remote_sources: &[String],
    _remote_destination: &str
  ) -> Result<Vec<String>> {
    bail!("remote move is unavailable because no supported adapter was found")
  }
}

fn select_adapter(profile: &RemoteProfile) -> Box<dyn RemoteAdapter + Send + Sync> {
  match profile.protocol {
    LocationKind::Sftp => Box::new(SftpRemoteAdapter),
    LocationKind::Ftp if preferred_curl_executable().is_some() => Box::new(CurlRemoteAdapter),
    _ => Box::new(UnsupportedRemoteAdapter)
  }
}

fn preferred_curl_executable() -> Option<&'static str> {
  if cfg!(target_os = "windows") && Command::new("curl.exe").arg("--version").output().is_ok() {
    Some("curl.exe")
  } else if Command::new("curl").arg("--version").output().is_ok() {
    Some("curl")
  } else {
    None
  }
}

fn normalize_profile(mut profile: RemoteProfile) -> RemoteProfile {
  profile.id = profile.id.trim().to_string();
  profile.name = profile.name.trim().to_string();
  profile.host = profile.host.trim().to_string();
  profile.username = profile.username.trim().to_string();
  profile.root_path = normalize_remote_path(&profile.root_path);
  if profile.port == 0 {
    profile.port = match profile.protocol {
      LocationKind::Ftp => 21,
      LocationKind::Sftp => 22,
      LocationKind::Local => 0
    };
  }
  if profile.connect_timeout_secs == 0 {
    profile.connect_timeout_secs = 10;
  }
  if profile.command_timeout_secs == 0 {
    profile.command_timeout_secs = 20;
  }
  profile
}

fn run_curl_list(profile: &RemoteProfile, password: Option<&str>, path: Option<&str>) -> Result<Output> {
  let executable = preferred_curl_executable().context("failed to locate curl executable")?;
  let mut command = Command::new(executable);
  command.args([
    "--silent",
    "--show-error",
    "--fail",
    "--list-only",
    "--connect-timeout",
    &profile.connect_timeout_secs.to_string(),
    "--max-time",
    &profile.command_timeout_secs.to_string()
  ]);

  apply_curl_transfer_mode(&mut command, profile);

  match profile.auth_kind.clone() {
    RemoteAuthKind::Anonymous => {}
    RemoteAuthKind::Password => {
      let secret = resolve_secret(profile, password).context("password is required for remote probing")?;
      command.arg("--user").arg(format!("{}:{secret}", profile.username));
    }
    RemoteAuthKind::KeyFile => {}
  }

  command.arg(build_url(profile, path));
  command.output().context("failed to launch curl for remote operation")
}

fn run_curl_quotes(profile: &RemoteProfile, password: Option<&str>, quotes: &[String]) -> Result<()> {
  let executable = preferred_curl_executable().context("failed to locate curl executable")?;
  let mut command = Command::new(executable);
  command.args([
    "--silent",
    "--show-error",
    "--fail",
    "--connect-timeout",
    &profile.connect_timeout_secs.to_string(),
    "--max-time",
    &profile.command_timeout_secs.to_string()
  ]);
  apply_curl_transfer_mode(&mut command, profile);
  add_curl_auth(&mut command, profile, password)?;
  for quote in quotes {
    command.arg("--quote").arg(quote);
  }
  command.arg(build_url(profile, Some("/")));
  let output = command.output().context("failed to launch curl for remote operation")?;
  if !output.status.success() {
    bail!("{}", stderr_message(&output, "remote operation failed"));
  }
  Ok(())
}

fn run_curl_upload(profile: &RemoteProfile, password: Option<&str>, local_source: &Path, remote_target: &str) -> Result<()> {
  let executable = preferred_curl_executable().context("failed to locate curl executable")?;
  let mut command = Command::new(executable);
  command.args([
    "--silent",
    "--show-error",
    "--fail",
    "--ftp-create-dirs",
    "--connect-timeout",
    &profile.connect_timeout_secs.to_string(),
    "--max-time",
    &profile.command_timeout_secs.to_string(),
    "--upload-file"
  ]);
  command.arg(local_source);
  apply_curl_transfer_mode(&mut command, profile);
  add_curl_auth(&mut command, profile, password)?;
  command.arg(build_url(profile, Some(remote_target)));
  let output = command.output().context("failed to launch curl for remote upload")?;
  if !output.status.success() {
    bail!("{}", stderr_message(&output, "remote upload failed"));
  }
  Ok(())
}

fn run_curl_download(profile: &RemoteProfile, password: Option<&str>, remote_source: &str, local_target: &Path) -> Result<()> {
  let executable = preferred_curl_executable().context("failed to locate curl executable")?;
  if let Some(parent) = local_target.parent() {
    fs::create_dir_all(parent).with_context(|| format!("failed to create {}", parent.display()))?;
  }
  let mut command = Command::new(executable);
  command.args([
    "--silent",
    "--show-error",
    "--fail",
    "--connect-timeout",
    &profile.connect_timeout_secs.to_string(),
    "--max-time",
    &profile.command_timeout_secs.to_string(),
    "--output"
  ]);
  command.arg(local_target);
  apply_curl_transfer_mode(&mut command, profile);
  add_curl_auth(&mut command, profile, password)?;
  command.arg(build_url(profile, Some(remote_source)));
  let output = command.output().context("failed to launch curl for remote download")?;
  if !output.status.success() {
    bail!("{}", stderr_message(&output, "remote download failed"));
  }
  Ok(())
}

fn apply_curl_transfer_mode(command: &mut Command, profile: &RemoteProfile) {
  if matches!(profile.protocol.clone(), LocationKind::Ftp) && !profile.passive_mode {
    command.arg("--ftp-port").arg("-");
  }
}

fn remote_path_exists_via_curl(profile: &RemoteProfile, password: Option<&str>, remote_path: &str) -> Result<bool> {
  let output = run_curl_list(profile, password, Some(remote_path))?;
  Ok(output.status.success())
}

fn available_curl_conflict_path(profile: &RemoteProfile, password: Option<&str>, destination: &str) -> Result<String> {
  let destination = normalize_remote_path(destination);
  if !remote_path_exists_via_curl(profile, password, &destination)? {
    return Ok(destination);
  }

  let parent = remote_parent_path(&destination).unwrap_or_else(|| "/".to_string());
  let file_name = remote_file_name(&destination).unwrap_or_else(|| "item".to_string());
  let (stem, extension) = split_remote_file_name(&file_name);
  for index in 1.. {
    let candidate_name = match extension {
      Some(extension) if !extension.is_empty() => format!("{stem} ({index}).{extension}"),
      _ => format!("{stem} ({index})")
    };
    let candidate = join_remote_path(&parent, &candidate_name);
    if !remote_path_exists_via_curl(profile, password, &candidate)? {
      return Ok(candidate);
    }
  }

  unreachable!("conflict index iteration is unbounded")
}

fn upload_path_with_curl(profile: &RemoteProfile, password: Option<&str>, local_source: &Path, remote_target: &str) -> Result<()> {
  let metadata = fs::symlink_metadata(local_source)
    .with_context(|| format!("failed to stat local path {}", local_source.display()))?;
  ensure_local_path_is_not_symlink(&metadata, local_source, "upload")?;
  if metadata.is_dir() && !metadata.file_type().is_symlink() {
    run_curl_quotes(profile, password, &[format!("MKD {}", normalize_remote_path(remote_target))])?;
    for entry in fs::read_dir(local_source).with_context(|| format!("failed to read {}", local_source.display()))? {
      let entry = entry.context("failed to read recursive local directory entry")?;
      let child_name = entry
        .file_name()
        .to_str()
        .ok_or_else(|| anyhow!("local path contains a non-Unicode file name: {}", entry.path().display()))?
        .to_string();
      validate_remote_entry_name(&child_name)?;
      let child_remote_target = join_remote_path(remote_target, &child_name);
      upload_path_with_curl(profile, password, &entry.path(), &child_remote_target)?;
    }
  } else {
    run_curl_upload(profile, password, local_source, remote_target)?;
  }
  Ok(())
}

fn delete_ftp_entry(profile: &RemoteProfile, password: Option<&str>, source: &str) -> Result<()> {
  let source = normalize_remote_path(source);
  if run_curl_quotes(profile, password, &[format!("DELE {source}")]).is_ok() {
    return Ok(());
  }

  delete_ftp_directory(profile, password, &source)
}

fn delete_ftp_directory(profile: &RemoteProfile, password: Option<&str>, source: &str) -> Result<()> {
  let output = run_curl_list(profile, password, Some(source))?;
  if !output.status.success() {
    run_curl_quotes(profile, password, &[format!("RMD {}", normalize_remote_path(source))])?;
    return Ok(());
  }

  for child in parse_curl_listing_child_paths(source, &output.stdout) {
    delete_ftp_entry(profile, password, &child)?;
  }

  run_curl_quotes(profile, password, &[format!("RMD {}", normalize_remote_path(source))])
}

fn parse_curl_listing_child_paths(base_path: &str, stdout: &[u8]) -> Vec<String> {
  let base_path = normalize_remote_path(base_path);
  String::from_utf8_lossy(stdout)
    .lines()
    .filter_map(|line| {
      let trimmed = line.trim().trim_end_matches('/');
      if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return None;
      }
      if trimmed.starts_with('/') {
        Some(normalize_remote_path(trimmed))
      } else {
        Some(join_remote_path(&base_path, trimmed))
      }
    })
    .filter(|path| path != &base_path)
    .collect()
}

fn add_curl_auth(command: &mut Command, profile: &RemoteProfile, password: Option<&str>) -> Result<()> {
  match profile.auth_kind.clone() {
    RemoteAuthKind::Anonymous => {}
    RemoteAuthKind::Password => {
      let secret = resolve_secret(profile, password).context("password is required for remote operation")?;
      command.arg("--user").arg(format!("{}:{secret}", profile.username));
    }
    RemoteAuthKind::KeyFile => bail!("key-file auth is not supported by the curl FTP adapter")
  }
  Ok(())
}

fn resolve_secret(profile: &RemoteProfile, password: Option<&str>) -> Option<String> {
  password
    .filter(|value| !value.trim().is_empty())
    .map(ToOwned::to_owned)
    .or_else(|| profile.credential_target.as_deref().and_then(windows_credentials::read_secret))
}

fn connect_sftp(profile: &RemoteProfile, password: Option<&str>) -> Result<(Session, Sftp)> {
  let session = connect_ssh_session(profile)?;
  verify_sftp_host_key(&session, profile)?;

  authenticate_sftp_session(&session, profile, password)?;

  let sftp = session.sftp().context("failed to open SFTP subsystem")?;
  Ok((session, sftp))
}

fn connect_ssh_session(profile: &RemoteProfile) -> Result<Session> {
  let address = (profile.host.as_str(), profile.port)
    .to_socket_addrs()
    .with_context(|| format!("failed to resolve {}:{}", profile.host, profile.port))?
    .next()
    .ok_or_else(|| anyhow!("failed to resolve {}:{}", profile.host, profile.port))?;
  let tcp = TcpStream::connect_timeout(&address, Duration::from_secs(profile.connect_timeout_secs))
    .with_context(|| format!("failed to connect to {}:{}", profile.host, profile.port))?;
  tcp
    .set_read_timeout(Some(Duration::from_secs(profile.command_timeout_secs)))
    .context("failed to configure SFTP read timeout")?;
  tcp
    .set_write_timeout(Some(Duration::from_secs(profile.command_timeout_secs)))
    .context("failed to configure SFTP write timeout")?;

  let mut session = Session::new().context("failed to create SSH session")?;
  session.set_tcp_stream(tcp);
  session.set_timeout(profile.command_timeout_secs.saturating_mul(1000).min(u32::MAX as u64) as u32);
  session.handshake().context("failed to complete SSH handshake")?;
  Ok(session)
}

fn authenticate_sftp_session(session: &Session, profile: &RemoteProfile, password: Option<&str>) -> Result<()> {
  match profile.auth_kind.clone() {
    RemoteAuthKind::Password => {
      let secret = resolve_secret(profile, password).context("password is required for SFTP operation")?;
      session
        .userauth_password(&profile.username, &secret)
        .context("SFTP password authentication failed")?;
    }
    RemoteAuthKind::KeyFile => {
      let private_key = profile
        .private_key_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .context("private key path is required for SFTP key-file auth")?;
      let passphrase = resolve_secret(profile, password);
      session
        .userauth_pubkey_file(
          &profile.username,
          None,
          Path::new(private_key),
          passphrase.as_deref()
        )
        .context("SFTP key-file authentication failed")?;
    }
    RemoteAuthKind::Anonymous => bail!("anonymous auth is not supported for SFTP")
  }

  if !session.authenticated() {
    bail!("SFTP authentication failed");
  }

  Ok(())
}

fn verify_sftp_host_key(session: &Session, profile: &RemoteProfile) -> Result<()> {
  if profile.ignore_host_key {
    return Ok(());
  }

  let known_hosts_path = known_hosts_path()?;
  if !known_hosts_path.exists() {
    bail!(
      "SFTP host key is not trusted yet; add {}:{} to known_hosts or enable ignoreHostKey for this profile",
      profile.host,
      profile.port
    );
  }

  let mut known_hosts = session.known_hosts().context("failed to initialize known_hosts checker")?;
  known_hosts
    .read_file(&known_hosts_path, KnownHostFileKind::OpenSSH)
    .with_context(|| format!("failed to read {}", known_hosts_path.display()))?;
  let (key, _) = session.host_key().context("SFTP server did not provide a host key")?;
  match known_hosts.check_port(&profile.host, profile.port, key) {
    CheckResult::Match => Ok(()),
    CheckResult::NotFound => bail!(
      "SFTP host key is not trusted yet; add {}:{} to known_hosts or enable ignoreHostKey for this profile",
      profile.host,
      profile.port
    ),
    CheckResult::Mismatch => bail!("SFTP host key mismatch for {}:{}", profile.host, profile.port),
    CheckResult::Failure => bail!("failed to verify SFTP host key for {}:{}", profile.host, profile.port)
  }
}

fn known_hosts_path() -> Result<PathBuf> {
  Ok(
    dirs::home_dir()
      .map(|home| home.join(".ssh").join("known_hosts"))
      .context("failed to locate home directory for known_hosts")?
  )
}

fn known_hosts_host(profile: &RemoteProfile) -> String {
  let default_port = match profile.protocol {
    LocationKind::Sftp => 22,
    LocationKind::Ftp => 21,
    LocationKind::Local => 0
  };
  if profile.port == default_port {
    profile.host.clone()
  } else {
    format!("[{}]:{}", profile.host, profile.port)
  }
}

fn host_key_algorithm(key_type: HostKeyType) -> &'static str {
  match key_type {
    HostKeyType::Rsa => "ssh-rsa",
    HostKeyType::Dss => "ssh-dss",
    HostKeyType::Ecdsa256 => "ecdsa-sha2-nistp256",
    HostKeyType::Ecdsa384 => "ecdsa-sha2-nistp384",
    HostKeyType::Ecdsa521 => "ecdsa-sha2-nistp521",
    HostKeyType::Ed25519 => "ssh-ed25519",
    HostKeyType::Unknown => "unknown"
  }
}

fn host_key_type_from_algorithm(algorithm: &str) -> Option<HostKeyType> {
  match algorithm {
    "ssh-rsa" => Some(HostKeyType::Rsa),
    "ssh-dss" => Some(HostKeyType::Dss),
    "ecdsa-sha2-nistp256" => Some(HostKeyType::Ecdsa256),
    "ecdsa-sha2-nistp384" => Some(HostKeyType::Ecdsa384),
    "ecdsa-sha2-nistp521" => Some(HostKeyType::Ecdsa521),
    "ssh-ed25519" => Some(HostKeyType::Ed25519),
    _ => None
  }
}

fn host_key_fingerprint_sha256(key: &[u8]) -> String {
  let digest = Sha256::digest(key);
  format!("SHA256:{}", STANDARD_NO_PAD.encode(digest))
}

fn host_key_trust_state(session: &Session, profile: &RemoteProfile, key: &[u8]) -> Result<RemoteHostKeyTrustState> {
  let path = known_hosts_path()?;
  if !path.exists() {
    return Ok(RemoteHostKeyTrustState::Unknown);
  }

  let mut known_hosts = session.known_hosts().context("failed to initialize known_hosts checker")?;
  known_hosts
    .read_file(&path, KnownHostFileKind::OpenSSH)
    .with_context(|| format!("failed to read {}", path.display()))?;

  Ok(match known_hosts.check_port(&profile.host, profile.port, key) {
    CheckResult::Match => RemoteHostKeyTrustState::Trusted,
    CheckResult::Mismatch => RemoteHostKeyTrustState::Mismatch,
    CheckResult::NotFound | CheckResult::Failure => RemoteHostKeyTrustState::Unknown
  })
}

fn create_remote_host_key_info(profile: &RemoteProfile, session: &Session) -> Result<RemoteHostKeyInfo> {
  let (key, key_type) = session.host_key().context("SFTP server did not provide a host key")?;
  let algorithm = host_key_algorithm(key_type).to_string();
  if algorithm == "unknown" {
    bail!("SFTP server provided an unsupported host key type");
  }

  let key_base64 = STANDARD.encode(key);
  let known_hosts_entry = format!("{} {} {}", known_hosts_host(profile), algorithm, key_base64);
  Ok(RemoteHostKeyInfo {
    profile_id: profile.id.clone(),
    host: profile.host.clone(),
    port: profile.port,
    algorithm,
    fingerprint_sha256: host_key_fingerprint_sha256(key),
    key_base64,
    known_hosts_entry,
    trust_state: host_key_trust_state(session, profile, key)?
  })
}

fn write_known_host_entry(profile: &RemoteProfile, key: &[u8], key_type: HostKeyType) -> Result<()> {
  let path = known_hosts_path()?;
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).with_context(|| format!("failed to create {}", parent.display()))?;
  }

  let session = connect_ssh_session(profile)?;
  let (current_key, current_key_type) = session.host_key().context("SFTP server did not provide a host key")?;
  if current_key != key || !matches_host_key_type(current_key_type, key_type) {
    bail!("SFTP host key changed before it could be trusted");
  }

  let mut known_hosts = session.known_hosts().context("failed to initialize known_hosts writer")?;
  if path.exists() {
    known_hosts
      .read_file(&path, KnownHostFileKind::OpenSSH)
      .with_context(|| format!("failed to read {}", path.display()))?;
  }

  known_hosts
    .add(
      &known_hosts_host(profile),
      key,
      &format!("SimpleFileManager {}", profile.name),
      KnownHostKeyFormat::from(key_type)
    )
    .context("failed to add SFTP host key to known_hosts")?;
  known_hosts
    .write_file(&path, KnownHostFileKind::OpenSSH)
    .with_context(|| format!("failed to write {}", path.display()))?;
  Ok(())
}

fn matches_host_key_type(left: HostKeyType, right: HostKeyType) -> bool {
  host_key_algorithm(left) == host_key_algorithm(right)
}

fn build_url(profile: &RemoteProfile, path: Option<&str>) -> String {
  let scheme = match profile.protocol {
    LocationKind::Ftp => "ftp",
    LocationKind::Sftp => "sftp",
    LocationKind::Local => "file"
  };
  let remote_path = normalize_remote_path(path.unwrap_or(&profile.root_path));
  let suffix = encode_remote_url_path(&remote_path);
  if suffix.is_empty() {
    format!("{scheme}://{}:{}/", profile.host, profile.port)
  } else {
    format!("{scheme}://{}:{}/{}", profile.host, profile.port, suffix)
  }
}

fn encode_remote_url_path(path: &str) -> String {
  normalize_remote_path(path)
    .trim_start_matches('/')
    .split('/')
    .filter(|segment| !segment.is_empty())
    .map(percent_encode_path_segment)
    .collect::<Vec<_>>()
    .join("/")
}

fn percent_encode_path_segment(segment: &str) -> String {
  let mut encoded = String::new();
  for byte in segment.as_bytes() {
    match *byte {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => encoded.push(*byte as char),
      value => encoded.push_str(&format!("%{value:02X}"))
    }
  }
  encoded
}

fn normalize_remote_path(path: &str) -> String {
  let normalized = path
    .trim()
    .replace('\\', "/")
    .split('/')
    .filter(|segment| !segment.is_empty())
    .collect::<Vec<_>>()
    .join("/");
  if normalized.is_empty() {
    "/".to_string()
  } else {
    format!("/{normalized}")
  }
}

fn validate_remote_entry_name(name: &str) -> Result<()> {
  let candidate = name.trim();
  if candidate.is_empty() {
    bail!("remote entry name cannot be empty");
  }
  if candidate == "." || candidate == ".." {
    bail!("remote entry name must not be a dot segment");
  }
  if candidate.contains('/') || candidate.contains('\\') {
    bail!("remote entry name must not include path separators");
  }
  if candidate.chars().any(|character| character.is_control()) {
    bail!("remote entry name must not include control characters");
  }
  Ok(())
}

fn validate_remote_path(path: &str) -> Result<()> {
  if path.chars().any(|character| character.is_control()) {
    bail!("remote path must not include control characters");
  }

  for segment in path.replace('\\', "/").split('/').filter(|segment| !segment.is_empty()) {
    if segment == "." || segment == ".." {
      bail!("remote path must not include dot segments");
    }
  }

  Ok(())
}

fn remote_path_is_within_root(profile: &RemoteProfile, path: &str) -> bool {
  let root = normalize_remote_path(&profile.root_path);
  let path = normalize_remote_path(path);
  root == "/" || path == root || path.starts_with(&format!("{}/", root.trim_end_matches('/')))
}

fn validate_remote_path_within_root(profile: &RemoteProfile, path: &str) -> Result<()> {
  validate_remote_path(path)?;
  if !remote_path_is_within_root(profile, path) {
    bail!("remote path must be within the profile root");
  }
  Ok(())
}

fn validate_remote_operation_source(profile: &RemoteProfile, path: &str) -> Result<()> {
  validate_remote_path_within_root(profile, path)?;
  let normalized = normalize_remote_path(path);
  if normalized == normalize_remote_path(&profile.root_path) {
    bail!("remote profile root cannot be used as a file operation source");
  }
  Ok(())
}

fn remote_parent_path(path: &str) -> Option<String> {
  let normalized = normalize_remote_path(path);
  if normalized == "/" {
    return None;
  }
  let trimmed = normalized.trim_end_matches('/');
  let index = trimmed.rfind('/')?;
  if index == 0 {
    Some("/".to_string())
  } else {
    Some(trimmed[..index].to_string())
  }
}

fn remote_file_name(path: &str) -> Option<String> {
  normalize_remote_path(path)
    .trim_end_matches('/')
    .rsplit('/')
    .next()
    .map(ToOwned::to_owned)
    .filter(|value| !value.is_empty())
}

fn available_remote_conflict_path<F>(destination: &str, exists: F) -> String
where
  F: Fn(&str) -> bool
{
  let destination = normalize_remote_path(destination);
  if !exists(&destination) {
    return destination;
  }

  let parent = remote_parent_path(&destination).unwrap_or_else(|| "/".to_string());
  let file_name = remote_file_name(&destination).unwrap_or_else(|| "item".to_string());
  let (stem, extension) = split_remote_file_name(&file_name);
  for index in 1.. {
    let candidate_name = match extension {
      Some(extension) if !extension.is_empty() => format!("{stem} ({index}).{extension}"),
      _ => format!("{stem} ({index})")
    };
    let candidate = join_remote_path(&parent, &candidate_name);
    if !exists(&candidate) {
      return candidate;
    }
  }

  unreachable!("conflict index iteration is unbounded")
}

fn split_remote_file_name(file_name: &str) -> (&str, Option<&str>) {
  match file_name.rsplit_once('.') {
    Some((stem, extension)) if !stem.is_empty() => (stem, Some(extension)),
    _ => (file_name, None)
  }
}

fn available_sftp_conflict_path(sftp: &Sftp, destination: &str) -> String {
  available_remote_conflict_path(destination, |candidate| sftp.lstat(Path::new(candidate)).is_ok())
}

fn available_local_conflict_path(destination: &Path) -> PathBuf {
  if !destination.exists() {
    return destination.to_path_buf();
  }

  let parent = destination.parent().unwrap_or_else(|| Path::new(""));
  let stem = destination
    .file_stem()
    .and_then(|value| value.to_str())
    .or_else(|| destination.file_name().and_then(|value| value.to_str()))
    .unwrap_or("item");
  let extension = destination.extension().and_then(|value| value.to_str());
  for index in 1.. {
    let file_name = match extension {
      Some(extension) if !extension.is_empty() => format!("{stem} ({index}).{extension}"),
      _ => format!("{stem} ({index})")
    };
    let candidate = parent.join(file_name);
    if !candidate.exists() {
      return candidate;
    }
  }

  unreachable!("conflict index iteration is unbounded")
}

fn create_remote_transfer_temp_dir() -> Result<PathBuf> {
  let nanos = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_nanos();
  let path = env::temp_dir().join(format!("sfm-remote-transfer-{}-{nanos}", std::process::id()));
  fs::create_dir_all(&path).with_context(|| format!("failed to create remote transfer temp directory {}", path.display()))?;
  Ok(path)
}

fn parse_listing_entries(profile: &RemoteProfile, path: Option<&str>, stdout: &[u8]) -> Vec<EntryViewModel> {
  let base_path = normalize_remote_path(path.unwrap_or(&profile.root_path));
  String::from_utf8_lossy(stdout)
    .lines()
    .filter(|line| !line.trim().is_empty())
    .map(|line| {
      let trimmed = line.trim();
      let is_directory = trimmed.ends_with('/');
      let name = trimmed.trim_end_matches('/').to_string();
      let remote_path = join_remote_path(&base_path, &name);

      EntryViewModel {
        path: remote_path.clone(),
        name,
        extension: (!is_directory)
          .then(|| remote_path.rsplit('.').next().unwrap_or_default().to_string())
          .filter(|value| !value.is_empty() && value != &remote_path),
        kind: if is_directory { EntryKind::Directory } else { EntryKind::File },
        size: None,
        modified_at: None,
        is_hidden: false,
        is_read_only: false,
        is_symlink: false,
        location: LocationDescriptor {
          kind: profile.protocol.clone(),
          path: remote_path,
          connection_id: Some(profile.id.clone())
        },
        decoration: EntryDecoration::default()
      }
    })
    .collect()
}

fn parse_sftp_entries(profile: &RemoteProfile, base_path: &str, entries: Vec<(PathBuf, ssh2::FileStat)>) -> Vec<EntryViewModel> {
  let mut mapped = entries
    .into_iter()
    .filter_map(|(path, stat)| {
      let name = path.file_name().and_then(|value| value.to_str())?.to_string();
      if name == "." || name == ".." {
        return None;
      }
      let remote_path = join_remote_path(base_path, &name);
      let is_directory = stat.is_dir();
      let modified_at = stat
        .mtime
        .and_then(|seconds| Utc.timestamp_opt(seconds as i64, 0).single());
      Some(EntryViewModel {
        path: remote_path.clone(),
        name,
        extension: (!is_directory)
          .then(|| remote_path.rsplit('.').next().unwrap_or_default().to_string())
          .filter(|value| !value.is_empty() && value != &remote_path),
        kind: if is_directory { EntryKind::Directory } else { EntryKind::File },
        size: (!is_directory).then_some(stat.size).flatten(),
        modified_at,
        is_hidden: remote_file_name(&remote_path)
          .map(|value| value.starts_with('.'))
          .unwrap_or(false),
        is_read_only: stat.perm.map(|perm| perm & 0o200 == 0).unwrap_or(false),
        is_symlink: stat.file_type().is_symlink(),
        location: LocationDescriptor {
          kind: profile.protocol.clone(),
          path: remote_path,
          connection_id: Some(profile.id.clone())
        },
        decoration: EntryDecoration::default()
      })
    })
    .collect::<Vec<_>>();

  mapped.sort_by(|left, right| match (&left.kind, &right.kind) {
    (EntryKind::Directory, EntryKind::File) => std::cmp::Ordering::Less,
    (EntryKind::File, EntryKind::Directory) => std::cmp::Ordering::Greater,
    _ => left.name.to_lowercase().cmp(&right.name.to_lowercase())
  });
  mapped
}

fn upload_file_to_sftp(sftp: &Sftp, local_source: &Path, remote_target: &str) -> Result<()> {
  let mut local_file = fs::File::open(local_source)
    .with_context(|| format!("failed to open local file {}", local_source.display()))?;
  let mut remote_file = sftp
    .create(Path::new(remote_target))
    .with_context(|| format!("failed to create remote file {remote_target}"))?;
  io::copy(&mut local_file, &mut remote_file).with_context(|| {
    format!(
      "failed to upload {} to {remote_target}",
      local_source.display()
    )
  })?;
  Ok(())
}

fn download_file_from_sftp(sftp: &Sftp, remote_source: &str, local_target: &Path) -> Result<()> {
  if let Some(parent) = local_target.parent() {
    fs::create_dir_all(parent).with_context(|| format!("failed to create {}", parent.display()))?;
  }
  let mut remote_file = sftp
    .open(Path::new(remote_source))
    .with_context(|| format!("failed to open remote file {remote_source}"))?;
  let mut local_file = fs::File::create(local_target)
    .with_context(|| format!("failed to create local file {}", local_target.display()))?;
  io::copy(&mut remote_file, &mut local_file).with_context(|| {
    format!(
      "failed to download {remote_source} to {}",
      local_target.display()
    )
  })?;
  Ok(())
}

fn upload_path_to_sftp(sftp: &Sftp, local_source: &Path, remote_target: &str) -> Result<()> {
  let metadata = fs::symlink_metadata(local_source)
    .with_context(|| format!("failed to stat local path {}", local_source.display()))?;
  ensure_local_path_is_not_symlink(&metadata, local_source, "upload")?;
  if metadata.is_dir() && !metadata.file_type().is_symlink() {
    sftp
      .mkdir(Path::new(remote_target), 0o755)
      .with_context(|| format!("failed to create remote directory {remote_target}"))?;
    for entry in fs::read_dir(local_source).with_context(|| format!("failed to read {}", local_source.display()))? {
      let entry = entry.context("failed to read recursive local directory entry")?;
      let child_name = entry
        .file_name()
        .to_str()
        .ok_or_else(|| anyhow!("local path contains a non-Unicode file name: {}", entry.path().display()))?
        .to_string();
      validate_remote_entry_name(&child_name)?;
      let child_remote_target = join_remote_path(remote_target, &child_name);
      upload_path_to_sftp(sftp, &entry.path(), &child_remote_target)?;
    }
  } else {
    upload_file_to_sftp(sftp, local_source, remote_target)?;
  }
  Ok(())
}

fn download_path_from_sftp(sftp: &Sftp, remote_source: &str, stat: &FileStat, local_target: &Path) -> Result<()> {
  ensure_remote_stat_is_not_symlink(stat, remote_source, "download")?;
  if stat.is_dir() {
    fs::create_dir_all(local_target)
      .with_context(|| format!("failed to create local directory {}", local_target.display()))?;
    for (child_path, child_stat) in sftp
      .readdir(Path::new(remote_source))
      .with_context(|| format!("failed to read remote directory {remote_source}"))?
    {
      let name = child_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| anyhow!("remote path contains a non-Unicode file name under {remote_source}"))?
        .to_string();
      if name == "." || name == ".." {
        continue;
      }
      validate_remote_entry_name(&name)?;
      let child_remote_source = join_remote_path(remote_source, &name);
      let child_local_target = local_target.join(name);
      download_path_from_sftp(sftp, &child_remote_source, &child_stat, &child_local_target)?;
    }
  } else {
    download_file_from_sftp(sftp, remote_source, local_target)?;
  }
  Ok(())
}

fn copy_sftp_file(sftp: &Sftp, remote_source: &str, remote_target: &str) -> Result<()> {
  let mut source_file = sftp
    .open(Path::new(remote_source))
    .with_context(|| format!("failed to open remote file {remote_source}"))?;
  let mut target_file = sftp
    .create(Path::new(remote_target))
    .with_context(|| format!("failed to create remote file {remote_target}"))?;
  io::copy(&mut source_file, &mut target_file)
    .with_context(|| format!("failed to copy remote file {remote_source} to {remote_target}"))?;
  Ok(())
}

fn copy_sftp_path(sftp: &Sftp, remote_source: &str, stat: &FileStat, remote_target: &str) -> Result<()> {
  ensure_remote_stat_is_not_symlink(stat, remote_source, "copy")?;
  if stat.is_dir() {
    sftp
      .mkdir(Path::new(remote_target), 0o755)
      .with_context(|| format!("failed to create remote directory {remote_target}"))?;
    for (child_path, child_stat) in sftp
      .readdir(Path::new(remote_source))
      .with_context(|| format!("failed to read remote directory {remote_source}"))?
    {
      let name = child_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| anyhow!("remote path contains a non-Unicode file name under {remote_source}"))?
        .to_string();
      if name == "." || name == ".." {
        continue;
      }
      validate_remote_entry_name(&name)?;
      let child_source = join_remote_path(remote_source, &name);
      let child_target = join_remote_path(remote_target, &name);
      copy_sftp_path(sftp, &child_source, &child_stat, &child_target)?;
    }
  } else {
    copy_sftp_file(sftp, remote_source, remote_target)?;
  }
  Ok(())
}

fn remove_sftp_directory_recursively(sftp: &Sftp, remote_source: &str) -> Result<()> {
  for (child_path, child_stat) in sftp
    .readdir(Path::new(remote_source))
    .with_context(|| format!("failed to read remote directory {remote_source}"))?
  {
    let name = child_path
      .file_name()
      .and_then(|value| value.to_str())
      .ok_or_else(|| anyhow!("remote path contains a non-Unicode file name under {remote_source}"))?
      .to_string();
    if name == "." || name == ".." {
      continue;
    }
    validate_remote_entry_name(&name)?;
    let child_source = join_remote_path(remote_source, &name);
    if child_stat.is_dir() {
      remove_sftp_directory_recursively(sftp, &child_source)?;
    } else {
      sftp
        .unlink(Path::new(&child_source))
        .with_context(|| format!("failed to delete remote file {child_source}"))?;
    }
  }
  sftp
    .rmdir(Path::new(remote_source))
    .with_context(|| format!("failed to delete remote directory {remote_source}"))?;
  Ok(())
}

fn ensure_local_path_is_not_symlink(metadata: &fs::Metadata, path: &Path, operation: &str) -> Result<()> {
  if metadata.file_type().is_symlink() {
    bail!(
      "local symbolic link {operation} is not supported: {}",
      path.display()
    );
  }
  Ok(())
}

fn ensure_remote_stat_is_not_symlink(stat: &FileStat, path: &str, operation: &str) -> Result<()> {
  if stat.file_type().is_symlink() {
    bail!("remote symbolic link {operation} is not supported: {path}");
  }
  Ok(())
}

fn ensure_remote_not_inside_source(source: &str, destination: &str) -> Result<()> {
  let source = normalize_remote_path(source);
  let destination = normalize_remote_path(destination);
  if destination == source || destination.starts_with(&format!("{}/", source.trim_end_matches('/'))) {
    bail!("remote destination must not be inside the source path");
  }
  Ok(())
}

fn join_remote_path(base_path: &str, name: &str) -> String {
  if base_path == "/" {
    format!("/{}", name.trim_start_matches('/'))
  } else {
    format!("{}/{}", base_path.trim_end_matches('/'), name.trim_start_matches('/'))
  }
}

fn stderr_message(output: &Output, fallback: &str) -> String {
  let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
  if stderr.is_empty() {
    fallback.to_string()
  } else {
    stderr
  }
}

fn collect_probe_details(output: &Output) -> Vec<String> {
  let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
  if stderr.is_empty() {
    Vec::new()
  } else {
    vec![stderr]
  }
}

#[cfg(test)]
mod tests {
  use super::{
    available_remote_conflict_path, build_url, copy_entries, create_directory, delete_entries, download_entries,
    credential_target_for_profile, encode_remote_url_path, ensure_remote_not_inside_source, ensure_remote_stat_is_not_symlink,
    host_key_algorithm, host_key_fingerprint_sha256, host_key_type_from_algorithm, join_remote_path, known_hosts_host,
    list_directory, move_entries, normalize_profile, normalize_remote_path, parse_curl_listing_child_paths,
    parse_listing_entries, parse_sftp_entries, preferred_curl_executable, prepare_profile_for_save, remote_file_name,
    remote_parent_path, remote_path_is_within_root, rename_entry, select_adapter, test_profile, transfer_entries, upload_files, validate_profile,
    validate_remote_entry_name, validate_remote_path, validate_remote_path_within_root
  };
  use std::{env, fs, path::PathBuf};

  use ssh2::{FileStat, HostKeyType};
  use uuid::Uuid;

  use crate::domain::models::{
    EntryKind, LocationKind, RemoteAdapterKind, RemoteAuthKind, RemoteProfile, RemoteProfileUpsertRequest
  };

  fn sample_profile() -> RemoteProfile {
    RemoteProfile {
      id: "remote-1".into(),
      name: "Demo".into(),
      protocol: LocationKind::Sftp,
      host: "example.com".into(),
      port: 22,
      username: "user".into(),
      root_path: "/".into(),
      auth_kind: RemoteAuthKind::Password,
      private_key_path: None,
      passive_mode: true,
      ignore_host_key: false,
      connect_timeout_secs: 10,
      command_timeout_secs: 20,
      credential_target: None
    }
  }

  #[test]
  fn rejects_local_protocol_for_remote_profile() {
    let mut profile = sample_profile();
    profile.protocol = LocationKind::Local;
    assert!(validate_profile(&profile).is_err());
  }

  #[test]
  fn rejects_key_file_for_ftp() {
    let mut profile = sample_profile();
    profile.protocol = LocationKind::Ftp;
    profile.auth_kind = RemoteAuthKind::KeyFile;
    profile.private_key_path = Some("id_ed25519".into());
    assert!(validate_profile(&profile).is_err());
  }

  #[test]
  fn normalizes_profile_defaults_and_paths() {
    let mut profile = sample_profile();
    profile.id = " remote-1 ".into();
    profile.name = " Demo ".into();
    profile.host = " example.com ".into();
    profile.username = " user ".into();
    profile.root_path = "folder\\inner".into();
    profile.connect_timeout_secs = 0;
    profile.command_timeout_secs = 0;

    let normalized = normalize_profile(profile);
    assert_eq!(normalized.id, "remote-1");
    assert_eq!(normalized.name, "Demo");
    assert_eq!(normalized.host, "example.com");
    assert_eq!(normalized.username, "user");
    assert_eq!(normalized.root_path, "/folder/inner");
    assert_eq!(normalized.connect_timeout_secs, 10);
    assert_eq!(normalized.command_timeout_secs, 20);
  }

  #[test]
  fn formats_known_hosts_target_for_default_and_non_default_sftp_ports() {
    let mut profile = sample_profile();
    profile.host = "192.168.1.12".into();
    profile.port = 22;
    assert_eq!(known_hosts_host(&profile), "192.168.1.12");

    profile.port = 6666;
    assert_eq!(known_hosts_host(&profile), "[192.168.1.12]:6666");
  }

  #[test]
  fn formats_host_key_algorithms_and_sha256_fingerprints() {
    assert_eq!(host_key_algorithm(HostKeyType::Ed25519), "ssh-ed25519");
    assert_eq!(host_key_algorithm(HostKeyType::Ecdsa256), "ecdsa-sha2-nistp256");
    let parsed_key_type = host_key_type_from_algorithm("ssh-ed25519").expect("ed25519 key type should parse");
    assert_eq!(host_key_algorithm(parsed_key_type), "ssh-ed25519");
    assert!(host_key_type_from_algorithm("unknown").is_none());
    assert_eq!(host_key_fingerprint_sha256(b"demo-key"), "SHA256:xIoB9J/Q8sxAS8PLvIDpFFej1Bu0KaaVJD3kxheUFVw");
  }

  #[test]
  fn parses_directory_listing_output() {
    let entries = parse_listing_entries(&sample_profile(), Some("/"), b"logs/\nreport.txt\n");
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].path, "/logs");
    assert_eq!(entries[1].path, "/report.txt");
  }

  #[test]
  fn supports_key_file_prepare_without_secret() {
    let mut profile = sample_profile();
    profile.auth_kind = RemoteAuthKind::KeyFile;
    profile.private_key_path = Some("id_ed25519".into());

    let profile = prepare_profile_for_save(
      RemoteProfileUpsertRequest {
        profile,
        password: None
      },
      None
    )
    .expect("profile should prepare");

    assert_eq!(profile.auth_kind, RemoteAuthKind::KeyFile);
    assert_eq!(profile.private_key_path.as_deref(), Some("id_ed25519"));
    assert_eq!(profile.credential_target, None);
  }

  #[test]
  fn prepare_profile_for_save_ignores_client_credential_target() {
    let mut profile = sample_profile();
    profile.credential_target = Some("attacker-controlled-target".into());

    let prepared = prepare_profile_for_save(
      RemoteProfileUpsertRequest {
        profile,
        password: None
      },
      Some("SimpleFileManager.Remote.remote-1")
    )
    .expect("profile should prepare");

    assert_eq!(
      prepared.credential_target.as_deref(),
      Some("SimpleFileManager.Remote.remote-1")
    );
    assert_eq!(credential_target_for_profile(" remote-2 "), "SimpleFileManager.Remote.remote-2");
  }

  #[test]
  fn selects_sftp_adapter_without_curl_dependency() {
    let mut profile = sample_profile();
    profile.auth_kind = RemoteAuthKind::KeyFile;
    profile.private_key_path = Some("id_ed25519".into());
    assert_eq!(select_adapter(&profile).kind(), RemoteAdapterKind::Sftp);
  }

  #[test]
  fn selects_curl_adapter_for_ftp_when_available() {
    if preferred_curl_executable().is_none() {
      return;
    }

    let mut profile = sample_profile();
    profile.protocol = LocationKind::Ftp;
    profile.port = 21;
    assert_eq!(select_adapter(&profile).kind(), RemoteAdapterKind::Curl);
  }

  #[test]
  fn normalizes_remote_paths() {
    assert_eq!(normalize_remote_path("folder\\inner"), "/folder/inner");
    assert_eq!(join_remote_path("/", "child"), "/child");
    assert_eq!(join_remote_path("/folder", "child"), "/folder/child");
  }

  #[test]
  fn builds_encoded_remote_urls_for_curl() {
    let mut profile = sample_profile();
    profile.protocol = LocationKind::Ftp;
    profile.host = "ftp.example.test".into();
    profile.port = 2121;
    assert_eq!(encode_remote_url_path("/folder/report 100%.txt"), "folder/report%20100%25.txt");
    assert_eq!(build_url(&profile, Some("/folder/# release/报告.txt")), "ftp://ftp.example.test:2121/folder/%23%20release/%E6%8A%A5%E5%91%8A.txt");
    assert_eq!(build_url(&profile, Some("/")), "ftp://ftp.example.test:2121/");
  }

  #[test]
  fn parses_curl_listing_children_under_base_path() {
    assert_eq!(
      parse_curl_listing_child_paths("/folder", b"child.txt\nnested/\n/absolute/path.txt\n.\n..\n"),
      vec![
        "/folder/child.txt".to_string(),
        "/folder/nested".to_string(),
        "/absolute/path.txt".to_string()
      ]
    );
  }

  #[test]
  fn resolves_remote_parent_names_and_conflicts() {
    assert_eq!(remote_parent_path("/folder/report.txt").as_deref(), Some("/folder"));
    assert_eq!(remote_parent_path("/report.txt").as_deref(), Some("/"));
    assert_eq!(remote_parent_path("/"), None);
    assert_eq!(remote_file_name("/folder/report.txt").as_deref(), Some("report.txt"));

    let existing = ["/folder/report.txt", "/folder/report (1).txt"];
    let available = available_remote_conflict_path("/folder/report.txt", |candidate| existing.contains(&candidate));
    assert_eq!(available, "/folder/report (2).txt");

    let existing = ["/folder/README"];
    let available = available_remote_conflict_path("/folder/README", |candidate| existing.contains(&candidate));
    assert_eq!(available, "/folder/README (1)");
  }

  #[test]
  fn rejects_unsafe_remote_names_and_paths() {
    assert!(validate_remote_entry_name(".").is_err());
    assert!(validate_remote_entry_name("..").is_err());
    assert!(validate_remote_entry_name("folder/name").is_err());
    assert!(validate_remote_entry_name("bad\nname").is_err());
    assert!(validate_remote_path("/safe/path").is_ok());
    assert!(validate_remote_path("/safe/../path").is_err());
    assert!(validate_remote_path("/bad\rpath").is_err());
    assert!(super::validate_remote_operation_source(&sample_profile(), "/").is_err());
  }

  #[test]
  fn rejects_remote_paths_outside_profile_root() {
    let mut profile = sample_profile();
    profile.root_path = "/home/cheng/root".into();

    assert!(remote_path_is_within_root(&profile, "/home/cheng/root"));
    assert!(remote_path_is_within_root(&profile, "/home/cheng/root/file.txt"));
    assert!(!remote_path_is_within_root(&profile, "/home/cheng/root2/file.txt"));
    assert!(!remote_path_is_within_root(&profile, "/etc/passwd"));
    assert!(validate_remote_path_within_root(&profile, "/home/cheng/root/child").is_ok());
    assert!(validate_remote_path_within_root(&profile, "/home/cheng/root2/child").is_err());
  }

  #[test]
  fn rejects_remote_transfer_sources_outside_source_profile_root_before_connecting() {
    let mut source = sample_profile();
    source.root_path = "/home/cheng/root".into();
    let mut destination = sample_profile();
    destination.id = "remote-2".into();
    destination.host = "destination.invalid".into();
    destination.root_path = "/inbox".into();

    let result = transfer_entries(
      &source,
      Some("unused"),
      &destination,
      Some("unused"),
      &["/etc/passwd".into()],
      "/inbox",
      false
    );

    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("remote path must be within the profile root"));
  }

  #[test]
  fn rejects_remote_transfer_destinations_outside_destination_profile_root_before_connecting() {
    let mut source = sample_profile();
    source.root_path = "/home/cheng/root".into();
    let mut destination = sample_profile();
    destination.id = "remote-2".into();
    destination.host = "destination.invalid".into();
    destination.root_path = "/inbox".into();

    let result = transfer_entries(
      &source,
      Some("unused"),
      &destination,
      Some("unused"),
      &["/home/cheng/root/report.txt".into()],
      "/outside",
      true
    );

    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("remote path must be within the profile root"));
  }

  #[test]
  fn rejects_file_operations_targeting_profile_root() {
    let mut profile = sample_profile();
    profile.root_path = "/home/cheng/root".into();

    assert!(super::validate_remote_operation_source(&profile, "/home/cheng/root/file.txt").is_ok());
    assert!(super::validate_remote_operation_source(&profile, "/home/cheng/root").is_err());
    assert!(super::validate_remote_operation_source(&profile, "/home/cheng/root2/file.txt").is_err());
  }

  #[test]
  fn rejects_sftp_symlink_transfer_sources() {
    let symlink = FileStat {
      size: Some(5),
      uid: None,
      gid: None,
      perm: Some(0o120777),
      atime: None,
      mtime: None
    };

    assert!(ensure_remote_stat_is_not_symlink(&symlink, "/root/link", "download").is_err());
  }

  #[test]
  fn rejects_remote_destination_inside_source() {
    assert!(ensure_remote_not_inside_source("/folder", "/folder-copy").is_ok());
    assert!(ensure_remote_not_inside_source("/folder", "/other/folder").is_ok());
    assert!(ensure_remote_not_inside_source("/folder", "/folder").is_err());
    assert!(ensure_remote_not_inside_source("/folder", "/folder/child").is_err());
  }

  #[test]
  fn parses_sftp_entries_with_metadata() {
    let profile = sample_profile();
    let entries = parse_sftp_entries(
      &profile,
      "/base",
      vec![
        (
          PathBuf::from("zeta.txt"),
          FileStat {
            size: Some(12),
            uid: None,
            gid: None,
            perm: Some(0o100444),
            atime: None,
            mtime: Some(1_700_000_000)
          }
        ),
        (
          PathBuf::from(".config"),
          FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: Some(0o040755),
            atime: None,
            mtime: None
          }
        ),
        (
          PathBuf::from("link"),
          FileStat {
            size: Some(5),
            uid: None,
            gid: None,
            perm: Some(0o120777),
            atime: None,
            mtime: None
          }
        )
      ]
    );

    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].name, ".config");
    assert_eq!(entries[0].kind, EntryKind::Directory);
    assert!(entries[0].is_hidden);
    assert_eq!(entries[1].name, "link");
    assert!(entries[1].is_symlink);
    assert_eq!(entries[2].name, "zeta.txt");
    assert_eq!(entries[2].kind, EntryKind::File);
    assert_eq!(entries[2].size, Some(12));
    assert!(entries[2].is_read_only);
    assert!(entries[2].modified_at.is_some());
  }

  #[test]
  #[ignore = "requires a reachable SFTP server and SFM_SFTP_PASSWORD"]
  fn sftp_password_profile_round_trips_files_and_directories() -> anyhow::Result<()> {
    let password = env::var("SFM_SFTP_PASSWORD").expect("SFM_SFTP_PASSWORD must be set");
    let root_path = env::var("SFM_SFTP_ROOT").unwrap_or_else(|_| "/home/cheng".to_string());
    let name = format!("sfm-it-{}", Uuid::new_v4());
    let profile = RemoteProfile {
      id: "sftp-it".into(),
      name: "SFTP Integration".into(),
      protocol: LocationKind::Sftp,
      host: env::var("SFM_SFTP_HOST").unwrap_or_else(|_| "127.0.0.1".to_string()),
      port: env::var("SFM_SFTP_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(6666),
      username: env::var("SFM_SFTP_USERNAME").unwrap_or_else(|_| "cheng".to_string()),
      root_path: root_path.clone(),
      auth_kind: RemoteAuthKind::Password,
      private_key_path: None,
      passive_mode: true,
      ignore_host_key: true,
      connect_timeout_secs: 10,
      command_timeout_secs: 20,
      credential_target: None
    };

    let remote_root = join_remote_path(&root_path, &name);
    let remote_archive = join_remote_path(&remote_root, "archive");
    let local_root = env::temp_dir().join(format!("sfm-sftp-it-{}", Uuid::new_v4()));
    let local_upload_dir = local_root.join("local-dir");
    let local_download_dir = local_root.join("download");

    struct Cleanup<'a> {
      profile: &'a RemoteProfile,
      password: &'a str,
      remote_root: String,
      local_root: PathBuf
    }

    impl Drop for Cleanup<'_> {
      fn drop(&mut self) {
        let _ = delete_entries(self.profile, Some(self.password), &[self.remote_root.clone()]);
        let _ = fs::remove_dir_all(&self.local_root);
      }
    }

    let _cleanup = Cleanup {
      profile: &profile,
      password: &password,
      remote_root: remote_root.clone(),
      local_root: local_root.clone()
    };

    fs::create_dir_all(&local_upload_dir)?;
    fs::write(local_root.join("local.txt"), "uploaded file")?;
    fs::write(local_upload_dir.join("nested.txt"), "uploaded directory file")?;

    let probe = test_profile(&profile, Some(&password))?;
    assert!(probe.success, "SFTP probe failed: {}", probe.message);

    assert_eq!(create_directory(&profile, Some(&password), &root_path, &name)?, remote_root);
    assert_eq!(
      create_directory(&profile, Some(&password), &remote_root, "archive")?,
      remote_archive
    );

    let uploaded = upload_files(
      &profile,
      Some(&password),
      &[
        local_root.join("local.txt").to_string_lossy().into_owned(),
        local_upload_dir.to_string_lossy().into_owned(),
      ],
      &remote_root
    )?;
    assert!(uploaded.contains(&join_remote_path(&remote_root, "local.txt")));
    assert!(uploaded.contains(&join_remote_path(&remote_root, "local-dir")));

    let renamed = rename_entry(
      &profile,
      Some(&password),
      &join_remote_path(&remote_root, "local.txt"),
      "renamed.txt"
    )?;
    assert_eq!(renamed, join_remote_path(&remote_root, "renamed.txt"));

    let copied = copy_entries(
      &profile,
      Some(&password),
      &[join_remote_path(&remote_root, "local-dir")],
      &remote_root
    )?;
    assert_eq!(copied, vec![join_remote_path(&remote_root, "local-dir (1)")]);

    let moved = move_entries(
      &profile,
      Some(&password),
      &[join_remote_path(&remote_root, "renamed.txt")],
      &remote_archive
    )?;
    assert_eq!(moved, vec![join_remote_path(&remote_archive, "renamed.txt")]);

    let downloaded = download_entries(
      &profile,
      Some(&password),
      &[remote_root.clone()],
      &local_download_dir.to_string_lossy()
    )?;
    assert_eq!(downloaded.len(), 1);
    assert!(PathBuf::from(&downloaded[0]).join("archive").join("renamed.txt").exists());
    assert!(PathBuf::from(&downloaded[0]).join("local-dir").join("nested.txt").exists());
    assert!(PathBuf::from(&downloaded[0]).join("local-dir (1)").join("nested.txt").exists());

    delete_entries(&profile, Some(&password), &[remote_root.clone()])?;
    let parent_entries = list_directory(&profile, Some(&password), Some(&root_path))?;
    assert!(!parent_entries.iter().any(|entry| entry.name == name));

    Ok(())
  }
}

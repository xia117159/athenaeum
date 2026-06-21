use std::{fs, path::PathBuf};

use anyhow::{bail, Context, Result};
use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    Engine as _,
};
use sha2::{Digest, Sha256};
use ssh2::{CheckResult, HostKeyType, KnownHostFileKind, KnownHostKeyFormat, Session};

use crate::domain::models::{
    LocationKind, RemoteHostKeyInfo, RemoteHostKeyTrustState, RemoteProfile,
};

pub(super) fn verify_sftp_host_key(session: &Session, profile: &RemoteProfile) -> Result<()> {
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

    let mut known_hosts = session
        .known_hosts()
        .context("failed to initialize known_hosts checker")?;
    known_hosts
        .read_file(&known_hosts_path, KnownHostFileKind::OpenSSH)
        .with_context(|| format!("failed to read {}", known_hosts_path.display()))?;
    let (key, _) = session
        .host_key()
        .context("SFTP server did not provide a host key")?;
    match known_hosts.check_port(&profile.host, profile.port, key) {
        CheckResult::Match => Ok(()),
        CheckResult::NotFound => bail!(
            "SFTP host key is not trusted yet; add {}:{} to known_hosts or enable ignoreHostKey for this profile",
            profile.host,
            profile.port
        ),
        CheckResult::Mismatch => {
            bail!("SFTP host key mismatch for {}:{}", profile.host, profile.port)
        }
        CheckResult::Failure => {
            bail!("failed to verify SFTP host key for {}:{}", profile.host, profile.port)
        }
    }
}

fn known_hosts_path() -> Result<PathBuf> {
    Ok(dirs::home_dir()
        .map(|home| home.join(".ssh").join("known_hosts"))
        .context("failed to locate home directory for known_hosts")?)
}

pub(super) fn known_hosts_host(profile: &RemoteProfile) -> String {
    let default_port = match profile.protocol {
        LocationKind::Sftp => 22,
        LocationKind::Ftp => 21,
        LocationKind::Local => 0,
    };
    if profile.port == default_port {
        profile.host.clone()
    } else {
        format!("[{}]:{}", profile.host, profile.port)
    }
}

pub(super) fn host_key_algorithm(key_type: HostKeyType) -> &'static str {
    match key_type {
        HostKeyType::Rsa => "ssh-rsa",
        HostKeyType::Dss => "ssh-dss",
        HostKeyType::Ecdsa256 => "ecdsa-sha2-nistp256",
        HostKeyType::Ecdsa384 => "ecdsa-sha2-nistp384",
        HostKeyType::Ecdsa521 => "ecdsa-sha2-nistp521",
        HostKeyType::Ed25519 => "ssh-ed25519",
        HostKeyType::Unknown => "unknown",
    }
}

pub(super) fn host_key_type_from_algorithm(algorithm: &str) -> Option<HostKeyType> {
    match algorithm {
        "ssh-rsa" => Some(HostKeyType::Rsa),
        "ssh-dss" => Some(HostKeyType::Dss),
        "ecdsa-sha2-nistp256" => Some(HostKeyType::Ecdsa256),
        "ecdsa-sha2-nistp384" => Some(HostKeyType::Ecdsa384),
        "ecdsa-sha2-nistp521" => Some(HostKeyType::Ecdsa521),
        "ssh-ed25519" => Some(HostKeyType::Ed25519),
        _ => None,
    }
}

pub(super) fn host_key_fingerprint_sha256(key: &[u8]) -> String {
    let digest = Sha256::digest(key);
    format!("SHA256:{}", STANDARD_NO_PAD.encode(digest))
}

fn host_key_trust_state(
    session: &Session,
    profile: &RemoteProfile,
    key: &[u8],
) -> Result<RemoteHostKeyTrustState> {
    let path = known_hosts_path()?;
    if !path.exists() {
        return Ok(RemoteHostKeyTrustState::Unknown);
    }

    let mut known_hosts = session
        .known_hosts()
        .context("failed to initialize known_hosts checker")?;
    known_hosts
        .read_file(&path, KnownHostFileKind::OpenSSH)
        .with_context(|| format!("failed to read {}", path.display()))?;

    Ok(
        match known_hosts.check_port(&profile.host, profile.port, key) {
            CheckResult::Match => RemoteHostKeyTrustState::Trusted,
            CheckResult::Mismatch => RemoteHostKeyTrustState::Mismatch,
            CheckResult::NotFound | CheckResult::Failure => RemoteHostKeyTrustState::Unknown,
        },
    )
}

pub(super) fn create_remote_host_key_info(
    profile: &RemoteProfile,
    session: &Session,
) -> Result<RemoteHostKeyInfo> {
    let (key, key_type) = session
        .host_key()
        .context("SFTP server did not provide a host key")?;
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
        trust_state: host_key_trust_state(session, profile, key)?,
    })
}

pub(super) fn write_known_host_entry(
    profile: &RemoteProfile,
    key: &[u8],
    key_type: HostKeyType,
) -> Result<()> {
    let path = known_hosts_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }

    let session = super::connect_ssh_session(profile)?;
    let (current_key, current_key_type) = session
        .host_key()
        .context("SFTP server did not provide a host key")?;
    if current_key != key || !matches_host_key_type(current_key_type, key_type) {
        bail!("SFTP host key changed before it could be trusted");
    }

    let mut known_hosts = session
        .known_hosts()
        .context("failed to initialize known_hosts writer")?;
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
            KnownHostKeyFormat::from(key_type),
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

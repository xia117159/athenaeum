use serde::{Deserialize, Serialize};

use super::LocationKind;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RemoteAuthKind {
    Password,
    KeyFile,
    Anonymous,
}

impl Default for RemoteAuthKind {
    fn default() -> Self {
        Self::Password
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RemoteAdapterKind {
    Curl,
    Sftp,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProfile {
    pub id: String,
    pub name: String,
    pub protocol: LocationKind,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub root_path: String,
    #[serde(default)]
    pub auth_kind: RemoteAuthKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_key_path: Option<String>,
    #[serde(default = "default_remote_passive_mode")]
    pub passive_mode: bool,
    #[serde(default)]
    pub ignore_host_key: bool,
    #[serde(default = "default_remote_connect_timeout_secs")]
    pub connect_timeout_secs: u64,
    #[serde(default = "default_remote_command_timeout_secs")]
    pub command_timeout_secs: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_target: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProfileUpsertRequest {
    pub profile: RemoteProfile,
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirectoryRequest {
    pub profile_id: String,
    pub password: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileOperationRequest {
    pub profile_id: String,
    pub password: Option<String>,
    pub sources: Vec<String>,
    pub destination: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RemoteTransferOperation {
    Copy,
    Move,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTransferRequest {
    pub operation: RemoteTransferOperation,
    pub source_profile_id: String,
    pub source_password: Option<String>,
    pub destination_profile_id: String,
    pub destination_password: Option<String>,
    pub sources: Vec<String>,
    pub destination: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRenameRequest {
    pub profile_id: String,
    pub password: Option<String>,
    pub source: String,
    pub new_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCreateDirectoryRequest {
    pub profile_id: String,
    pub password: Option<String>,
    pub parent: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHostKeyInfo {
    pub profile_id: String,
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint_sha256: String,
    pub key_base64: String,
    pub known_hosts_entry: String,
    pub trust_state: RemoteHostKeyTrustState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RemoteHostKeyTrustState {
    Trusted,
    Unknown,
    Mismatch,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTrustHostKeyRequest {
    pub profile_id: String,
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub key_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTestResult {
    pub success: bool,
    pub message: String,
    pub adapter: RemoteAdapterKind,
    #[serde(default)]
    pub details: Vec<String>,
}

fn default_remote_passive_mode() -> bool {
    true
}

fn default_remote_connect_timeout_secs() -> u64 {
    10
}

fn default_remote_command_timeout_secs() -> u64 {
    20
}

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DirectorySizeTarget {
    Local { path: String },
    Remote { #[serde(rename = "profileId")] profile_id: String, path: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeDirectorySizesRequest {
    pub consumer_id: String,
    pub target: DirectorySizeTarget,
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DirectorySizePhase { #[default] Queued, Scanning, Complete, Partial, Failed, Cancelled, Stale }

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DirectorySizeFreshness { Monitored, #[default] Snapshot }

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySizeSnapshot {
    pub consumer_id: String,
    pub generation: u64,
    pub sequence: u64,
    pub phase: DirectorySizePhase,
    pub known_bytes: String,
    pub total_bytes: Option<String>,
    pub files: u64,
    pub directories: u64,
    pub skipped_links: u64,
    pub skipped_special: u64,
    pub errors: u64,
    pub freshness: DirectorySizeFreshness,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupDirectorySizesRequest { pub consumer_id: String, pub generation: u64, pub paths: Vec<String> }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DirectorySizeRecordState { Complete, Partial, Unknown }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySizeRecord {
    pub path: String,
    pub state: DirectorySizeRecordState,
    pub bytes: Option<String>,
    pub size_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySizeLookup {
    pub consumer_id: String,
    pub generation: u64,
    pub sequence: u64,
    pub stale: bool,
    pub directories: Vec<DirectorySizeRecord>,
}

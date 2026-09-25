use serde::{Deserialize, Serialize};
#[path = "directory_size_diagnostics.rs"]
mod diagnostics;
pub use diagnostics::*;
#[path = "directory_size_cache.rs"]
mod cache;
pub use cache::*;
#[path = "directory_size_views.rs"]
mod views;
pub use views::*;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DirectorySizeTarget {
    Local { path: String },
    Remote { #[serde(rename = "profileId")] profile_id: String, path: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "SubscribeDirectorySizesWire")]
pub struct SubscribeDirectorySizesRequest {
    pub consumer_id: String,
    pub target: DirectorySizeTarget,
    #[serde(default)]
    pub refresh: bool,
    #[serde(flatten)]
    pub handoff: Option<DirectorySizeHandoff>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscribeDirectorySizesWire {
    consumer_id: String, target: DirectorySizeTarget, #[serde(default)] refresh: bool,
    #[serde(flatten)] extra: std::collections::HashMap<String, serde_json::Value>,
}
impl TryFrom<SubscribeDirectorySizesWire> for SubscribeDirectorySizesRequest {
    type Error = String;
    fn try_from(mut wire: SubscribeDirectorySizesWire) -> Result<Self, Self::Error> {
        let slot = wire.extra.remove("slotId"); let revision = wire.extra.remove("slotRevision"); let from = wire.extra.remove("handoffFrom");
        let handoff = match (slot, revision, from) {
            (None, None, None) => None,
            (Some(slot), Some(revision), from) => Some(DirectorySizeHandoff {
                slot_id: serde_json::from_value(slot).map_err(|error| error.to_string())?,
                slot_revision: serde_json::from_value(revision).map_err(|error| error.to_string())?,
                handoff_from: serde_json::from_value(from.unwrap_or(serde_json::Value::Null)).map_err(|error| error.to_string())?,
            }),
            _ => return Err("目录统计交接字段不完整".into()),
        };
        Ok(Self { consumer_id: wire.consumer_id, target: wire.target, refresh: wire.refresh, handoff })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySizeHandoff {
    pub slot_id: String,
    pub slot_revision: u32,
    #[serde(default)]
    pub handoff_from: Option<String>,
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
    #[serde(default)] pub cache_revision: String,
    #[serde(default)] pub artifact_revision: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_at: Option<chrono::DateTime<chrono::Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<chrono::DateTime<chrono::Utc>>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySizeCache {
    pub generation: u64,
    pub sequence: u64,
    pub directories: Vec<DirectorySizeRecord>,
    #[serde(default)]
    pub historical: bool,
    #[serde(default)] pub revision: String,
    #[serde(default)] pub artifact_revision: String,
}

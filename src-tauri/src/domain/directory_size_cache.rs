use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};
use super::DirectorySizeRecord;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySizeCacheObject { pub path: String, pub created_at: DateTime<Utc> }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupDirectorySizeCacheRequest {
    pub path: String, pub request_version: u64, pub entries: Vec<DirectorySizeCacheObject>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DirectorySizeCacheStatus { Hit, Miss, Pending }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySizeCacheEntry { pub path: String, pub status: DirectorySizeCacheStatus, pub record: Option<DirectorySizeRecord> }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySizeCacheLookup {
    pub path: String, pub request_version: u64, pub revision: String, pub entries: Vec<DirectorySizeCacheEntry>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySizeCacheUpdated { pub path: String, pub revision: String, pub owner_epoch: String }

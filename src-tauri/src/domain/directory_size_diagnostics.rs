use super::DirectorySizePhase;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DirectorySizeCacheReason {
    LiveHit, HistoryHit, NoAcceptedResult, WatchLost, IdentityPending,
    ScopeEvicted, FingerprintMismatch, ObjectMismatch, StorageUnavailable, Unsupported,
}

/// Exact-path durable presence, independent of live validity/object identity.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DirectorySizeDiskRead { Hit, Miss, Pending, Unavailable }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySizeCandidate {
    pub path: String, pub phase: DirectorySizePhase, pub generation: String, pub sequence: String,
    pub monitored: bool, pub identity_known: bool, pub identity_expired: bool,
    pub result_present: bool, pub scope_present: bool, pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySizeTransition {
    pub path: String, pub generation: String, pub phase: DirectorySizePhase, pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySizeDiagnostics {
    pub path: String, pub reason: DirectorySizeCacheReason,
    pub disk_read: DirectorySizeDiskRead,
    pub live_rejection: Option<DirectorySizeCacheReason>,
    pub listing_fingerprint: Option<String>, pub display_records: usize,
    pub history_enabled: bool, pub cache_bytes: String, pub scan_jobs_started: String,
    pub candidates: Vec<DirectorySizeCandidate>, pub transitions: Vec<DirectorySizeTransition>,
    pub storage: DirectorySizeStorageDiagnostics,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySizeStorageDiagnostics {
    pub ready: bool, pub read_only: bool, pub reads_disabled: bool, pub capacity_pressure: bool,
    pub queue_bytes: String, pub queue_limit_bytes: String, pub dropped_records: String, pub physical_bytes: String,
    pub last_commit: Option<chrono::DateTime<chrono::Utc>>, pub last_error: Option<String>,
}
impl Default for DirectorySizeStorageDiagnostics {
    fn default() -> Self {
        Self { ready: false, read_only: false, reads_disabled: false, capacity_pressure: false,
            queue_bytes: "0".into(), queue_limit_bytes: (8 << 20).to_string(), dropped_records: "0".into(),
            physical_bytes: "0".into(), last_commit: None, last_error: None }
    }
}

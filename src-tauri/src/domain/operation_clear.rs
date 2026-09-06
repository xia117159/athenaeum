use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OperationClearScope {
    Problems,
    Completed,
    History,
    All,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationClearRequest {
    pub scope: OperationClearScope,
    pub confirm_undo_loss: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OperationClearStatus {
    ConfirmationRequired,
    Cleared,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationClearOutcome {
    pub status: OperationClearStatus,
    pub eligible_undoable_count: usize,
    pub removed_task_ids: Vec<String>,
    pub removed_record_ids: Vec<String>,
    pub task_clear_watermark: u64,
    pub history_clear_watermark: u64,
    pub protected_record_ids: Vec<String>,
    pub cleanup_warnings: Vec<String>,
}

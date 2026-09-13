use super::rename_expression::Diagnostic;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBatchRenameRequest {
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewBatchRenameRequest {
    pub session_id: String,
    pub expression: String,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvalidateBatchRenameRequest {
    pub session_id: String,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyBatchRenameRequest {
    pub session_id: String,
    pub preview_id: String,
    pub request_id: String,
    pub source: super::models::OperationRequestSource,
    pub panel_id: String,
    pub tab_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BatchRenameRowStatus {
    Unchanged,
    Changed,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRenameRow {
    pub id: String,
    pub source_path: String,
    pub parent_path: String,
    pub old_name: String,
    pub new_name: Option<String>,
    pub target_path: Option<String>,
    pub is_directory: bool,
    pub status: BatchRenameRowStatus,
    pub diagnostic: Option<Diagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRenameSessionSnapshot {
    pub session_id: String,
    pub frozen_at: String,
    pub items: Vec<BatchRenameRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRenamePreview {
    pub session_id: String,
    pub revision: u64,
    pub expression: String,
    pub preview_id: Option<String>,
    pub items: Vec<BatchRenameRow>,
    pub diagnostics: Vec<Diagnostic>,
    pub changed_count: usize,
    pub can_apply: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn apply_contract_requires_a_known_source_and_server_preview() {
        let request = serde_json::json!({"sessionId":"session", "previewId":"preview", "requestId":"request",
            "source":"shortcut", "panelId":"left", "tabId":"tab"});
        let decoded: ApplyBatchRenameRequest = serde_json::from_value(request.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), request);
        let mut invalid = request.clone();
        invalid["source"] = "arbitrary".into();
        assert!(serde_json::from_value::<ApplyBatchRenameRequest>(invalid).is_err());
        let mut invalid = request;
        invalid.as_object_mut().unwrap().remove("previewId");
        assert!(serde_json::from_value::<ApplyBatchRenameRequest>(invalid).is_err());
    }
}

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use chrono::Utc;
use uuid::Uuid;

use crate::domain::models::{OperationHistoryRecord, OperationHistoryStatus};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum UndoAction {
    DeleteCreated {
        path: PathBuf,
    },
    RecreateDirectory {
        path: PathBuf,
    },
    MoveBack {
        from: PathBuf,
        to: PathBuf,
    },
    RestoreTrash {
        trash_path: PathBuf,
        original_path: PathBuf,
    },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UndoPayload {
    pub(super) actions: Vec<UndoAction>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OperationJournalDisk {
    pub(super) history: Vec<OperationHistoryRecord>,
    pub(super) history_sequence: u64,
    pub(super) undo_payloads: HashMap<String, UndoPayload>,
}

pub(super) fn normalize_reloaded_journal(
    mut records: Vec<OperationHistoryRecord>,
    mut undo_payloads: HashMap<String, UndoPayload>,
) -> (Vec<OperationHistoryRecord>, HashMap<String, UndoPayload>) {
    let mut undoable_record_ids = Vec::new();
    for record in &mut records {
        if matches!(
            record.status,
            OperationHistoryStatus::Undoing | OperationHistoryStatus::PendingConfirmation
        ) {
            record.status = OperationHistoryStatus::Failed;
            record.blocked_reason = Some("Operation did not finish before the app closed.".into());
            record.undo_task_id = None;
            record.updated_at = Utc::now();
        } else if matches!(record.status, OperationHistoryStatus::Undoable) {
            match undo_payloads
                .get(&record.record_id)
                .and_then(validate_undo_payload_entities)
            {
                Some(reason) => {
                    record.status = OperationHistoryStatus::Blocked;
                    record.blocked_reason = Some(reason);
                    record.updated_at = Utc::now();
                }
                None if undo_payloads.contains_key(&record.record_id) => {
                    undoable_record_ids.push(record.record_id.clone());
                }
                None => {
                    record.status = OperationHistoryStatus::Blocked;
                    record.blocked_reason = Some("Undo payload is no longer available.".into());
                    record.updated_at = Utc::now();
                }
            }
        }
    }
    undo_payloads.retain(|record_id, _| undoable_record_ids.iter().any(|id| id == record_id));
    records.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    (records, undo_payloads)
}

fn validate_undo_payload_entities(payload: &UndoPayload) -> Option<String> {
    for action in &payload.actions {
        match action {
            UndoAction::DeleteCreated { path } => {
                if !path.exists() {
                    return Some(format!("Undo target no longer exists: {}", path.display()));
                }
            }
            UndoAction::RecreateDirectory { .. } => {}
            UndoAction::MoveBack { from, .. } => {
                if !from.exists() {
                    return Some(format!(
                        "Moved item is no longer available: {}",
                        from.display()
                    ));
                }
            }
            UndoAction::RestoreTrash { trash_path, .. } => {
                if !trash_path.exists() {
                    return Some(format!(
                        "Trash payload is no longer available: {}",
                        trash_path.display()
                    ));
                }
            }
        }
    }
    None
}

pub(super) fn corrupt_journal_path(file_path: &Path) -> PathBuf {
    file_path.with_extension(format!("json.corrupt-{}", Uuid::new_v4()))
}

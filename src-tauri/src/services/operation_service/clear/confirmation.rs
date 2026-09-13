use super::{
    HashSet, OperationClearOutcome, OperationClearScope, OperationClearStatus,
    OperationHistoryRecord, OperationStore, UndoPayload,
};
use anyhow::Result;
use sha2::{Digest, Sha256};

impl OperationStore {
    pub(super) fn template_recovery_confirmation(
        &self,
        records: &[OperationHistoryRecord],
        scope: &OperationClearScope,
    ) -> Result<Option<String>> {
        let mut assets = records
            .iter()
            .flat_map(|record| {
                self.undo_payloads
                    .get(&record.record_id)
                    .and_then(UndoPayload::templates)
                    .into_iter()
                    .flatten()
                    .filter(|tree| tree.recovery_prepared)
                    .map(move |tree| {
                        (
                            &record.record_id,
                            &tree.recovery_path,
                            &tree.parent_identity,
                            tree.nodes.first().map(|node| &node.identity),
                        )
                    })
            })
            .collect::<Vec<_>>();
        if assets.is_empty() {
            return Ok(None);
        }
        assets.sort_by(|left, right| (left.0, left.1).cmp(&(right.0, right.1)));
        // Bind confirmation to the actual recovery locations and ownership, not a count
        // or a mutable UI snapshot. The store lock covers comparison through cleanup.
        Ok(Some(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(scope, assets))?)
        )))
    }

    pub(super) fn confirmation_required(
        &self,
        count: usize,
        recovery_count: usize,
        recovery_confirmation: Option<String>,
        protected: HashSet<String>,
    ) -> OperationClearOutcome {
        OperationClearOutcome {
            status: OperationClearStatus::ConfirmationRequired,
            eligible_undoable_count: count,
            eligible_recovery_count: recovery_count,
            recovery_confirmation,
            removed_task_ids: Vec::new(),
            removed_record_ids: Vec::new(),
            task_clear_watermark: self.task_sequence,
            history_clear_watermark: self.history_sequence,
            protected_record_ids: protected.into_iter().collect(),
            cleanup_warnings: Vec::new(),
        }
    }
}

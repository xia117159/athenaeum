use super::{OperationHistoryRecord, OperationStore, UndoPayload};
#[cfg(not(windows))]
use anyhow::Result;

impl OperationStore {
    pub(in crate::services::operation_service) fn template_recovery_count(
        &self,
        records: &[OperationHistoryRecord],
    ) -> usize {
        records
            .iter()
            .filter_map(|record| {
                self.undo_payloads
                    .get(&record.record_id)
                    .and_then(UndoPayload::templates)
            })
            // A location may reappear between this prompt and purge. Require confirmation
            // for all durable recovery intents, even if some have already been removed.
            .flatten()
            .filter(|tree| tree.recovery_prepared)
            .count()
    }

    pub(in crate::services::operation_service) fn cleanup_template_records(
        &self,
        removed: &mut Vec<OperationHistoryRecord>,
        sizes: Option<&crate::services::directory_size::DirectorySizeService>,
    ) -> Vec<String> {
        let mut warnings = Vec::new();
        removed.retain(|record| {
            let Some(trees) = self
                .undo_payloads
                .get(&record.record_id)
                .and_then(UndoPayload::templates)
            else {
                return true;
            };
            let paths: Vec<_> = trees.iter().filter(|tree| tree.recovery_prepared).map(|tree| tree.recovery_path.clone()).collect();
            let _size_change = sizes.filter(|_| !paths.is_empty()).map(|sizes| sizes.namespace_change(&paths));
            #[cfg(windows)]
            let result = crate::services::templates::owned::purge_recovery(trees);
            #[cfg(not(windows))]
            let result: Result<()> = if trees.iter().any(|tree| tree.recovery_prepared) {
                Err(anyhow::anyhow!("恢复副本只能在 Windows 上清理"))
            } else {
                Ok(())
            };
            if let Err(error) = result {
                warnings.push(format!(
                    "恢复副本清理未完成，已保留操作记录以便重试：{error:#}"
                ));
                false
            } else {
                true
            }
        });
        warnings
    }
}

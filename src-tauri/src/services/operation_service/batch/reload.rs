use super::*;

fn diagnostic_payload(attempt: &str, message: String) -> BatchPayload {
    BatchPayload {
        version: 1,
        batch_id: attempt.into(),
        task_id: attempt.into(),
        attempt_id: attempt.into(),
        attempt_task_id: attempt.into(),
        direction: Direction::Recovery,
        created_at: Utc::now(),
        entries: vec![],
        pending_recovery: true,
        committed_attempts: vec![],
        log_attempts: vec![attempt.into()],
        recovery_diagnostic: Some(message),
        step_count: 0,
        current_entry: None,
    }
}

#[cfg(all(test, windows))]
mod tests;

impl OperationStore {
    fn recheck_unavailable_batches(&mut self) {
        let candidates = self
            .history
            .iter()
            .filter(|record| record.status == OperationHistoryStatus::Blocked)
            .filter_map(|record| {
                self.undo_payloads
                    .get(&record.record_id)
                    .and_then(UndoPayload::batch)
            })
            .filter(|payload| {
                payload
                    .entries
                    .iter()
                    .any(|entry| entry.identity_unavailable)
                    && !payload.entries.iter().any(|entry| entry.identity_uncertain)
                    && payload.committed_attempts.contains(&payload.attempt_id)
            })
            .cloned()
            .collect::<Vec<_>>();
        for mut payload in candidates {
            // The latest settled attempt contains the complete current mapping, even
            // if an earlier forward attempt still needs recovery and retains its log.
            // Unresolved Pending steps still require replay; a path probe cannot settle them.
            for entry in &mut payload.entries {
                entry.verify_identity();
            }
            if !payload.identity_unknown() {
                self.retain_recovered_batch(
                    &payload,
                    OperationHistoryStatus::Undoable,
                    Some("原项目已恢复可访问，可以重试恢复名称。".into()),
                );
            }
        }
    }
    pub(super) fn remove_resolved_batch_log(&mut self, root: &Path, attempt: &str) {
        // Keep the retry trigger until the diagnostic retirement is durable.
        if self.discard_recovery_diagnostic(attempt) {
            let _ = recovery::remove_log(root, attempt);
        }
    }
    fn discard_recovery_diagnostic(&mut self, source: &str) -> bool {
        let diagnostic = self.undo_payloads.get(source).and_then(UndoPayload::batch);
        if !diagnostic.is_some_and(|payload| {
            payload.entries.is_empty()
                && payload.batch_id == source
                && payload.attempt_id == source
                && payload.direction == Direction::Recovery
                && payload.recovery_diagnostic.is_some()
        }) {
            return true;
        }
        let mut disk = OperationJournalDisk {
            history: self.history.clone(),
            history_sequence: self.history_sequence + 1,
            undo_payloads: self.undo_payloads.clone(),
        };
        disk.history.retain(|record| record.record_id != source);
        disk.undo_payloads.remove(source);
        // Only retire the placeholder after its replacement (or safe cleanup) is durable.
        if self.persist_journal_disk(&disk).is_ok() {
            self.history = disk.history;
            self.history_sequence = disk.history_sequence;
            self.undo_payloads = disk.undo_payloads;
            true
        } else {
            false
        }
    }
    fn retain_recovered_batch(
        &mut self,
        payload: &BatchPayload,
        status: OperationHistoryStatus,
        reason: Option<String>,
    ) -> bool {
        match self.commit_batch_record(payload, status.clone(), reason.clone()) {
            Ok(_) => true,
            Err(error) => {
                let reason = Some(format!(
                    "{}；恢复历史暂时无法写入：{error}。日志已保留。",
                    reason.as_deref().unwrap_or("发现未完成的批量重命名")
                ));
                let (disk, index) = self.staged_batch_record(payload, status, reason);
                self.install_batch_disk(disk, index);
                false
            }
        }
    }
    pub fn recover_batch_logs(&mut self) -> Result<()> {
        let root = self.batch_log_root()?;
        let acknowledged = self
            .durable_batch_journal()
            .map(|disk| {
                disk.undo_payloads
                    .values()
                    .filter_map(UndoPayload::batch)
                    .flat_map(|payload| payload.committed_attempts.iter().cloned())
                    .collect::<std::collections::HashSet<_>>()
            })
            .unwrap_or_default();
        let listing = match fs::read_dir(&root) {
            Ok(entries) => Some(entries),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                let payload = diagnostic_payload(
                    "batch-recovery-unavailable",
                    format!("无法读取恢复日志目录 {}：{error}", root.display()),
                );
                self.retain_recovered_batch(
                    &payload,
                    OperationHistoryStatus::Blocked,
                    payload.recovery_diagnostic.clone(),
                );
                return Ok(());
            }
        };
        let directory_readable = listing.is_some();
        let mut mappings_durable = true;
        let mut pending = Vec::new();
        if let Some(listing) = listing {
            for entry in listing {
                let entry = entry?;
                let path = entry.path();
                if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                    continue;
                }
                let Some(attempt) = path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .map(str::to_owned)
                else {
                    continue;
                };
                if Uuid::parse_str(&attempt).is_err() {
                    continue;
                }
                // A committed journal entry remains authoritative even if the old
                // log is unreadable, or the renamed file has since been edited.
                if acknowledged.contains(&attempt) {
                    self.remove_resolved_batch_log(&root, &attempt);
                    continue;
                }
                pending.push((attempt.clone(), recovery::read_log(&root, &attempt)));
            }
        }
        // Later attempts contain the complete current mapping of earlier attempts.
        pending
            .sort_by_key(|(_, log)| log.as_ref().map_or(0, |log| log.payload.log_attempts.len()));
        for (attempt, log) in pending {
            let recovered = match log {
                Ok(log) => log,
                Err(error) => {
                    let payload = diagnostic_payload(
                        &attempt,
                        format!(
                            "恢复日志 {} 需要人工检查：{error}",
                            root.join(format!("{attempt}.jsonl")).display()
                        ),
                    );
                    mappings_durable &= self.retain_recovered_batch(
                        &payload,
                        OperationHistoryStatus::Blocked,
                        payload.recovery_diagnostic.clone(),
                    );
                    continue;
                }
            };
            let mut payload = recovered.payload;
            let existing_record = self
                .history
                .iter()
                .find(|record| record.record_id == payload.batch_id)
                .cloned();
            if existing_record
                .as_ref()
                .is_some_and(|record| record.status == OperationHistoryStatus::Undone)
                && !self.undo_payloads.contains_key(&payload.batch_id)
            {
                self.remove_resolved_batch_log(&root, &attempt);
                continue;
            }
            if let Some(existing) = self
                .undo_payloads
                .get(&payload.batch_id)
                .and_then(UndoPayload::batch)
            {
                if acknowledged.contains(&attempt) {
                    self.remove_resolved_batch_log(&root, &attempt);
                    continue;
                }
                if existing.log_attempts.len() > payload.log_attempts.len()
                    && existing.attempt_id != attempt
                {
                    continue; // Retain older evidence without replacing a newer recovery mapping.
                }
                if existing.attempt_id == attempt
                    // Equal watermarks prefer fresh log resolution, including a
                    // Pending whose identity was temporarily unavailable on startup.
                    && existing.step_count > payload.step_count
                    && existing_record
                        .as_ref()
                        .is_some_and(|record| record.status != OperationHistoryStatus::Undoing)
                {
                    payload = existing.clone();
                    for entry in &mut payload.entries {
                        entry.verify_identity();
                    }
                }
            }
            if payload.direction == Direction::Forward
                && (recovered.restored
                    || !recovered.had_steps
                    || (!payload.identity_unknown()
                        && payload
                            .entries
                            .iter()
                            .all(|entry| entry.current_path == entry.original_path)))
            {
                self.remove_resolved_batch_log(&root, &attempt);
                continue;
            }
            payload.pending_recovery =
                payload.pending_recovery || (recovered.had_steps && !recovered.restored);
            if recovered.restored || !recovered.had_steps {
                if !payload.committed_attempts.contains(&attempt) {
                    payload.committed_attempts.push(attempt.clone());
                }
            }
            let status = if payload.identity_unknown() {
                OperationHistoryStatus::Blocked
            } else {
                OperationHistoryStatus::Undoable
            };
            let reason = payload.recovery_diagnostic.clone().or_else(|| {
                Some(
                    if payload.identity_unknown() {
                        "部分项目身份已改变，请检查恢复日志及原位置。"
                    } else if payload.pending_recovery {
                        "上次批量重命名未完成，可通过撤销恢复原名。"
                    } else {
                        "上次撤销未完成，可以重试。"
                    }
                    .into(),
                )
            });
            if self.retain_recovered_batch(&payload, status, reason) {
                self.discard_recovery_diagnostic(&attempt);
            } else {
                mappings_durable = false;
            }
        }
        if directory_readable && mappings_durable {
            self.discard_recovery_diagnostic("batch-recovery-unavailable");
        }
        let interrupted = self
            .history
            .iter()
            .filter(|record| record.status == OperationHistoryStatus::Undoing)
            .filter_map(|record| {
                self.undo_payloads
                    .get(&record.record_id)
                    .and_then(UndoPayload::batch)
                    .cloned()
            })
            .collect::<Vec<_>>();
        for mut payload in interrupted {
            payload.pending_recovery = true;
            self.retain_recovered_batch(
                &payload,
                OperationHistoryStatus::Undoable,
                Some("上次撤销中断，可继续恢复名称。".into()),
            );
        }
        self.recheck_unavailable_batches();
        let ids = self
            .history
            .iter()
            .map(|record| record.record_id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            self.cleanup_committed_batch_logs(&id);
        }
        Ok(())
    }
}

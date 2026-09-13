use super::*;
use crate::services::batch_rename::{
    native,
    plan::RenamePlan,
    transaction::{recovery, BatchPayload, BatchRunOutcome, Direction},
};
mod reload;
mod worker;
pub use worker::execute_batch;

impl OperationStore {
    pub fn batch_log_root(&self) -> Result<PathBuf> {
        Ok(self
            .file_path
            .as_deref()
            .and_then(Path::parent)
            .context("操作历史存储尚未初始化")?
            .join("batch-rename-recovery"))
    }
    pub fn queue_batch(
        &mut self,
        mut intent: OperationIntent,
        plan: &RenamePlan,
    ) -> Result<(OperationServiceResult, Option<BatchPayload>)> {
        self.batch_log_root()?;
        intent.kind = OperationIntentKind::Rename;
        intent.sources = Some(
            plan.items
                .iter()
                .map(|item| local_ref(&item.snapshot.path))
                .collect(),
        );
        intent.source_path = None;
        intent.new_name = None;
        let (mut result, execute) = self.queue_operation(intent);
        if !execute {
            return Ok((result, None));
        }
        let payload =
            BatchPayload::forward(plan, &result.snapshot.task_id, &Uuid::new_v4().to_string());
        result.snapshot.label = label(&payload);
        result.snapshot.total_entries = Some(payload.entries.len());
        result.snapshot.affected_roots = roots(&payload);
        for item in &plan.items {
            if let Some(parent) = item.final_path.parent() {
                let root = local_ref(parent);
                if !result.snapshot.affected_roots.contains(&root) {
                    result.snapshot.affected_roots.push(root);
                }
            }
        }
        for event in &mut result.task_events {
            event.snapshot = result.snapshot.clone();
        }
        if let Some(task) = self
            .tasks
            .iter_mut()
            .find(|task| task.task_id == result.snapshot.task_id)
        {
            *task = result.snapshot.clone();
        }
        Ok((result, Some(payload)))
    }
    fn staged_batch_record(
        &self,
        payload: &BatchPayload,
        status: OperationHistoryStatus,
        reason: Option<String>,
    ) -> (OperationJournalDisk, usize) {
        let mut disk = OperationJournalDisk {
            history: self.history.clone(),
            history_sequence: self.history_sequence + 1,
            undo_payloads: self.undo_payloads.clone(),
        };
        let index = if let Some(index) = disk
            .history
            .iter()
            .position(|record| record.record_id == payload.batch_id)
        {
            index
        } else {
            disk.history.push(OperationHistoryRecord {
                record_id: payload.batch_id.clone(),
                task_id: payload.task_id.clone(),
                kind: OperationIntentKind::Rename,
                label: label(payload),
                status: status.clone(),
                created_at: payload.created_at,
                updated_at: Utc::now(),
                undo_task_id: None,
                blocked_reason: None,
                payload_expires_at: None,
                affected_roots: roots(payload),
            });
            disk.history.len() - 1
        };
        let record = &mut disk.history[index];
        record.status = status;
        record.label = label(payload);
        record.blocked_reason = reason;
        record.updated_at = Utc::now();
        record.affected_roots = roots(payload);
        if payload.direction != Direction::Forward {
            record.undo_task_id = Some(payload.attempt_task_id.clone());
        }
        disk.undo_payloads
            .insert(payload.batch_id.clone(), undo_payload(payload.clone()));
        (disk, index)
    }
    fn install_batch_disk(
        &mut self,
        disk: OperationJournalDisk,
        index: usize,
    ) -> OperationHistoryEventEnvelope {
        self.history = disk.history;
        self.history_sequence = disk.history_sequence;
        self.undo_payloads = disk.undo_payloads;
        OperationHistoryEventEnvelope {
            record: self.history[index].clone(),
            history_sequence: self.history_sequence,
        }
    }
    fn commit_batch_record(
        &mut self,
        payload: &BatchPayload,
        status: OperationHistoryStatus,
        reason: Option<String>,
    ) -> Result<OperationHistoryEventEnvelope> {
        let (disk, index) = self.staged_batch_record(payload, status, reason);
        self.persist_journal_disk(&disk)?;
        Ok(self.install_batch_disk(disk, index))
    }
    pub fn commit_batch_success(
        &mut self,
        payload: &BatchPayload,
    ) -> Result<OperationHistoryEventEnvelope> {
        let status = if payload.direction == Direction::Forward {
            OperationHistoryStatus::Undoable
        } else {
            OperationHistoryStatus::Undone
        };
        self.commit_batch_record(payload, status, None)
    }
    pub fn finish_batch(
        &mut self,
        mut outcome: BatchRunOutcome,
        before: &[PathBuf],
    ) -> Result<OperationServiceResult> {
        let task_id = outcome.payload.attempt_task_id.clone();
        let task_index = self
            .tasks
            .iter()
            .position(|task| task.task_id == task_id)
            .context("批量任务已不存在")?;
        let mut history_events = Vec::new();
        if !outcome.committed
            && (outcome.payload.direction != Direction::Forward || !outcome.restored)
        {
            if outcome.restored && !outcome.payload.pending_recovery {
                for attempt in &outcome.payload.log_attempts {
                    if !outcome.payload.committed_attempts.contains(attempt) {
                        outcome.payload.committed_attempts.push(attempt.clone());
                    }
                }
            }
            let status = if outcome.payload.identity_unknown() {
                OperationHistoryStatus::Blocked
            } else {
                OperationHistoryStatus::Undoable
            };
            match self.commit_batch_record(&outcome.payload, status.clone(), outcome.error.clone())
            {
                Ok(event) => history_events.push(event),
                Err(error) => {
                    let message = format!(
                        "{}；历史写入失败：{error}。恢复日志已保留。",
                        outcome.error.as_deref().unwrap_or("操作未完成")
                    );
                    outcome.error = Some(message.clone());
                    let (disk, index) =
                        self.staged_batch_record(&outcome.payload, status, Some(message));
                    history_events.push(self.install_batch_disk(disk, index));
                }
            }
        }
        let mut task = self.tasks[task_index].clone();
        task.status = if outcome.committed {
            OperationTaskStatus::Succeeded
        } else if outcome.cancelled {
            OperationTaskStatus::Cancelled
        } else {
            OperationTaskStatus::Failed
        };
        task.finished_at = Some(Utc::now());
        task.cancelable = false;
        task.undoable = self.history.iter().any(|record| {
            record.record_id == outcome.payload.batch_id
                && record.status == OperationHistoryStatus::Undoable
        });
        task.affected_roots = roots(&outcome.payload);
        task.message = if outcome.committed {
            Some(
                if outcome.payload.direction == Direction::Forward {
                    "批量重命名完成"
                } else {
                    "整批名称已恢复"
                }
                .into(),
            )
        } else {
            outcome.error.clone()
        };
        if let Some(warning) = outcome.cleanup_warning {
            task.message = Some(format!(
                "{}；{warning}",
                task.message.as_deref().unwrap_or_default()
            ));
        }
        task.entry_results = outcome
            .payload
            .entries
            .iter()
            .enumerate()
            .map(|(index, entry)| {
                let source = before.get(index).unwrap_or(&entry.original_path);
                OperationEntryResult {
                    entry_result_id: format!("{task_id}-{index}"),
                    source: Some(local_ref(source)),
                    destination: Some(local_ref(&entry.current_path)),
                    kind: if !outcome.committed {
                        OperationEntryResultKind::Failed
                    } else if source == &entry.current_path {
                        OperationEntryResultKind::Skipped
                    } else {
                        OperationEntryResultKind::Renamed
                    },
                    error: (!outcome.committed).then(|| OperationError {
                        code: OperationErrorCode::IoError,
                        message: outcome.error.clone().unwrap_or_else(|| "操作未完成".into()),
                        path: Some(local_ref(&entry.current_path)),
                        retryable: !entry.identity_unknown(),
                        source: OperationErrorSource::LocalFs,
                    }),
                }
            })
            .collect();
        task.completed_entries = if outcome.committed {
            task.entry_results.len()
        } else {
            0
        };
        task.failed_entries = if outcome.committed {
            0
        } else {
            task.entry_results.len()
        };
        self.task_cancellations.remove(&task_id);
        self.in_flight_undo_paths.remove(&task_id);
        let mut task_events = Vec::new();
        self.commit_task_snapshot(&mut task, &mut task_events);
        self.cleanup_committed_batch_logs(&outcome.payload.batch_id);
        Ok(OperationServiceResult {
            snapshot: task,
            task_events,
            history_events,
            conflict: None,
        })
    }
    pub(crate) fn prepare_batch_undo(
        &mut self,
        id: String,
        request: String,
    ) -> Result<(OperationServiceResult, OperationUndoExecution)> {
        let index = self
            .history
            .iter()
            .position(|record| record.record_id == id)
            .context("操作历史不存在")?;
        let payload = self
            .undo_payloads
            .get(&id)
            .context("撤销数据已不存在")?
            .clone();
        if let Some(task_id) = self.request_to_task.get(&request) {
            if self.history[index].undo_task_id.as_ref() == Some(task_id) {
                let snapshot = self
                    .tasks
                    .iter()
                    .find(|task| task.task_id == *task_id)
                    .context("撤销任务不存在")?
                    .clone();
                return Ok((
                    OperationServiceResult {
                        snapshot,
                        task_events: vec![],
                        history_events: vec![],
                        conflict: None,
                    },
                    OperationUndoExecution {
                        task_id: task_id.clone(),
                        record_id: id,
                        payload,
                        already_started: true,
                    },
                ));
            }
            bail!("此请求 ID 已用于其他操作");
        }
        if self.history[index].status != OperationHistoryStatus::Undoable {
            bail!("此批次暂时无法撤销");
        }
        let task_id = Uuid::new_v4().to_string();
        let batch = payload
            .batch()
            .context("无效批次撤销数据")?
            .clone()
            .for_undo(&task_id);
        if batch.identity_unknown() {
            bail!("无法确认原文件身份，请先检查恢复记录");
        }
        self.batch_log_root()?;
        let event = self.commit_batch_record(&batch, OperationHistoryStatus::Undoing, None)?;
        let now = Utc::now();
        let mut task = OperationTaskSnapshot {
            task_id: task_id.clone(),
            request_id: request.clone(),
            kind: OperationIntentKind::Undo,
            label: format!(
                "{} {}",
                if batch.pending_recovery {
                    "恢复"
                } else {
                    "撤销"
                },
                label(&batch)
            ),
            status: OperationTaskStatus::Running,
            created_at: now,
            started_at: Some(now),
            finished_at: None,
            total_entries: Some(batch.entries.len()),
            completed_entries: 0,
            failed_entries: 0,
            total_bytes: None,
            completed_bytes: None,
            current_path: None,
            message: None,
            cancelable: true,
            undoable: false,
            affected_roots: roots(&batch),
            entry_results: vec![],
            sequence: 0,
            updated_at: now,
        };
        self.request_to_task.insert(request, task_id.clone());
        self.task_cancellations
            .insert(task_id.clone(), Arc::new(AtomicBool::new(false)));
        let mut task_events = Vec::new();
        self.commit_task_snapshot(&mut task, &mut task_events);
        Ok((
            OperationServiceResult {
                snapshot: task,
                task_events,
                history_events: vec![event],
                conflict: None,
            },
            OperationUndoExecution {
                task_id,
                record_id: id,
                payload: undo_payload(batch),
                already_started: false,
            },
        ))
    }
    pub fn batch_progress(&mut self, payload: &BatchPayload) -> Option<OperationServiceResult> {
        let mut task = self
            .tasks
            .iter()
            .find(|task| task.task_id == payload.attempt_task_id)?
            .clone();
        task.completed_entries = payload
            .entries
            .iter()
            .filter(|entry| {
                native::name_of(&entry.current_path).ok() == Some(entry.target_name.as_str())
            })
            .count();
        task.current_path = payload
            .current_entry
            .and_then(|index| payload.entries.get(index))
            .map(|entry| entry.original_path.to_string_lossy().into_owned());
        task.message = Some(format!(
            "正在{}：{} / {}",
            if payload.direction == Direction::Forward {
                "重命名"
            } else {
                "恢复名称"
            },
            task.completed_entries,
            payload.entries.len()
        ));
        let mut task_events = Vec::new();
        self.commit_task_snapshot(&mut task, &mut task_events);
        Some(OperationServiceResult {
            snapshot: task,
            task_events,
            history_events: vec![],
            conflict: None,
        })
    }
    pub(super) fn batch_record_protected(&self, record_id: &str) -> bool {
        self.undo_payloads
            .get(record_id)
            .and_then(UndoPayload::batch)
            .is_some_and(|payload| {
                payload.pending_recovery
                    || payload.identity_unknown()
                    || self
                        .batch_log_root()
                        .map(|root| recovery::has_logs(&root, payload))
                        .unwrap_or(true)
            })
    }
    fn durable_batch_journal(&self) -> Option<OperationJournalDisk> {
        // A failed persist may leave a useful RAM-only recovery record. Only the
        // canonical journal can authorize deleting its last durable log.
        serde_json::from_slice(&fs::read(self.file_path.as_ref()?).ok()?).ok()
    }
    fn cleanup_committed_batch_logs(&mut self, id: &str) {
        let Some(payload) = self
            .undo_payloads
            .get(id)
            .and_then(UndoPayload::batch)
            .cloned()
        else {
            return;
        };
        let Ok(root) = self.batch_log_root() else {
            return;
        };
        let Some(durable) = self.durable_batch_journal() else {
            return;
        };
        let Some(acknowledged) = durable.undo_payloads.get(id).and_then(UndoPayload::batch) else {
            return;
        };
        for attempt in &acknowledged.committed_attempts {
            self.remove_resolved_batch_log(&root, attempt);
        }
        if !payload.pending_recovery
            && !recovery::has_logs(&root, &payload)
            && self.history.iter().any(|record| {
                record.record_id == id && record.status == OperationHistoryStatus::Undone
            })
        {
            let mut disk = OperationJournalDisk {
                history: self.history.clone(),
                history_sequence: self.history_sequence,
                undo_payloads: self.undo_payloads.clone(),
            };
            disk.undo_payloads.remove(id);
            if self.persist_journal_disk(&disk).is_ok() {
                self.undo_payloads = disk.undo_payloads;
            }
        }
    }
}

impl OperationUndoExecution {
    pub(crate) fn batch_payload(&self) -> Option<BatchPayload> {
        self.payload.batch().cloned()
    }
    pub(crate) fn already_started(&self) -> bool {
        self.already_started
    }
}
fn undo_payload(payload: BatchPayload) -> UndoPayload {
    UndoPayload {
        actions: vec![UndoAction::BatchRename {
            payload: Box::new(payload),
        }],
    }
}
fn local_ref(path: &Path) -> OperationPathRef {
    OperationPathRef::Local {
        path: path.to_string_lossy().into_owned(),
    }
}
fn label(payload: &BatchPayload) -> String {
    format!(
        "{}批量重命名 {} 个项目",
        if payload.pending_recovery {
            "恢复"
        } else {
            ""
        },
        payload.entries.len()
    )
}
fn roots(payload: &BatchPayload) -> Vec<OperationPathRef> {
    let mut paths = std::collections::BTreeSet::new();
    for entry in &payload.entries {
        if let Some(parent) = entry.original_path.parent() {
            paths.insert(parent.to_path_buf());
        }
        if let Some(parent) = entry.current_path.parent() {
            paths.insert(parent.to_path_buf());
        }
    }
    paths.iter().map(|path| local_ref(path)).collect()
}

#[cfg(all(test, windows))]
mod tests;

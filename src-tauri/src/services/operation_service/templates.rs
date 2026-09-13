use super::*;
use crate::{
    domain::models::{CreateTemplateItemsRequest, OperationRequestSource},
    services::{
        templates::copy::{self, CopyOutcome},
        AppState,
    },
};
use std::time::{Duration, Instant};
mod undo;
pub(super) use undo::execute_undo;

fn local(path: &Path) -> OperationPathRef {
    OperationPathRef::Local {
        path: path.to_string_lossy().into_owned(),
    }
}
fn copy_intent(request: &CreateTemplateItemsRequest) -> OperationIntent {
    OperationIntent {
        request_id: request.request_id.clone(),
        source: OperationRequestSource::ContextMenu,
        panel_id: request.panel_id.clone(),
        tab_id: request.tab_id.clone(),
        kind: OperationIntentKind::Copy,
        sources: Some(
            request
                .relative_paths
                .iter()
                .map(|p| local(&Path::new(&request.template_root).join(p)))
                .collect(),
        ),
        destination: Some(local(Path::new(&request.destination))),
        source_path: None,
        new_name: None,
        parent: None,
        name: None,
        undo_record_id: None,
        conflict_policy: None,
    }
}

impl OperationStore {
    pub fn queue_template_creation(
        &mut self,
        request: &CreateTemplateItemsRequest,
    ) -> Result<(OperationServiceResult, bool)> {
        if request.request_id.trim().is_empty()
            || request.relative_paths.is_empty()
            || request.relative_paths.len() > 4096
        {
            bail!("新建项目请求无效，一次最多选择 4096 个模板");
        }
        self.file_path.as_ref().context("操作历史尚未初始化")?;
        let (mut result, execute) = self.queue_operation(copy_intent(request));
        if execute {
            result.snapshot.label = format!("新建项目（{}）", request.relative_paths.len());
            if let Some(task) = self
                .tasks
                .iter_mut()
                .find(|task| task.task_id == result.snapshot.task_id)
            {
                *task = result.snapshot.clone();
            }
            for event in &mut result.task_events {
                event.snapshot = result.snapshot.clone();
            }
        } else if !result.snapshot.label.starts_with("新建项目（") {
            bail!("此请求 ID 已用于其他操作");
        }
        Ok((result, execute))
    }
    fn template_history(
        &mut self,
        record: OperationHistoryRecord,
        payload: UndoPayload,
        remove: bool,
    ) -> Result<OperationHistoryEventEnvelope> {
        let mut disk = OperationJournalDisk {
            history: self.history.clone(),
            history_sequence: self.history_sequence + 1,
            undo_payloads: self.undo_payloads.clone(),
        };
        if let Some(index) = disk
            .history
            .iter()
            .position(|item| item.record_id == record.record_id)
        {
            disk.history[index] = record.clone();
        } else {
            disk.history.push(record.clone());
        }
        if remove {
            disk.undo_payloads.remove(&record.record_id);
        } else {
            disk.undo_payloads.insert(record.record_id.clone(), payload);
        }
        self.persist_journal_disk(&disk)?;
        self.history = disk.history;
        self.history_sequence = disk.history_sequence;
        self.undo_payloads = disk.undo_payloads;
        Ok(OperationHistoryEventEnvelope {
            record,
            history_sequence: self.history_sequence,
        })
    }
    fn template_progress(
        &mut self,
        id: &str,
        path: &str,
        bytes: u64,
        message: &str,
        cancelable: bool,
    ) -> Option<OperationServiceResult> {
        let mut task = self.tasks.iter().find(|task| task.task_id == id)?.clone();
        task.current_path = Some(path.into());
        task.completed_bytes = Some(bytes);
        task.message = Some(message.into());
        task.cancelable = cancelable;
        let mut task_events = Vec::new();
        self.commit_task_snapshot(&mut task, &mut task_events);
        Some(OperationServiceResult {
            snapshot: task,
            task_events,
            history_events: vec![],
            conflict: None,
        })
    }
    fn finish_template_creation(
        &mut self,
        id: &str,
        outcome: Result<CopyOutcome>,
    ) -> Result<OperationServiceResult> {
        let mut task = self
            .tasks
            .iter()
            .find(|task| task.task_id == id)
            .context("模板创建任务已不存在")?
            .clone();
        let out = outcome.unwrap_or_else(|error| CopyOutcome {
            failures: vec![(PathBuf::new(), format!("{error:#}"))],
            ..CopyOutcome::default()
        });
        task.status = if out.cancelled {
            OperationTaskStatus::Cancelled
        } else if out.failures.is_empty() {
            OperationTaskStatus::Succeeded
        } else if out.created.is_empty() {
            OperationTaskStatus::Failed
        } else {
            OperationTaskStatus::PartialSucceeded
        };
        task.completed_entries = out.created.len();
        task.failed_entries = out.failures.len();
        task.entry_results = out
            .created
            .iter()
            .map(|(source, dest)| OperationEntryResult {
                entry_result_id: Uuid::new_v4().to_string(),
                source: Some(local(source)),
                destination: Some(local(dest)),
                kind: OperationEntryResultKind::Created,
                error: None,
            })
            .collect();
        for (path, message) in &out.failures {
            task.entry_results.push(failed_result(
                Uuid::new_v4().to_string(),
                (!path.as_os_str().is_empty()).then(|| local(path)),
                OperationErrorSource::LocalFs,
                anyhow::anyhow!(message.clone()),
            ));
        }
        task.message = Some(format!(
            "{}已创建 {} 个项目{}",
            if out.cancelled {
                "创建已取消，"
            } else {
                ""
            },
            out.created.len(),
            out.failures
                .first()
                .map(|(_, error)| format!("；{error}"))
                .unwrap_or_default()
        ));
        task.cancelable = false;
        task.finished_at = Some(Utc::now());
        task.undoable = !out.owned.is_empty();
        let mut history_events = Vec::new();
        if !out.owned.is_empty() {
            let now = Utc::now();
            let mut record = OperationHistoryRecord {
                recovery_items: Vec::new(),
                record_id: Uuid::new_v4().to_string(),
                task_id: id.into(),
                kind: OperationIntentKind::Copy,
                label: task.label.clone(),
                status: OperationHistoryStatus::Undoable,
                created_at: now,
                updated_at: now,
                undo_task_id: None,
                blocked_reason: None,
                payload_expires_at: None,
                affected_roots: task.affected_roots.clone(),
            };
            let payload = UndoPayload {
                actions: vec![UndoAction::TemplateCreation { trees: out.owned }],
            };
            match self.template_history(record.clone(), payload.clone(), false) {
                Ok(event) => history_events.push(event),
                Err(error) => {
                    let message = format!(
                        "{}；副本已创建，历史保存失败：{error:#}。本次运行中仍可撤销。",
                        task.message.as_deref().unwrap_or("")
                    );
                    record.blocked_reason = Some(message.clone());
                    task.message = Some(message);
                    if task.status == OperationTaskStatus::Succeeded {
                        task.status = OperationTaskStatus::PartialSucceeded;
                    }
                    self.undo_payloads.insert(record.record_id.clone(), payload);
                    self.history.push(record.clone());
                    self.history_sequence += 1;
                    history_events.push(OperationHistoryEventEnvelope {
                        record,
                        history_sequence: self.history_sequence,
                    });
                }
            }
        }
        self.task_cancellations.remove(id);
        let mut task_events = Vec::new();
        self.commit_task_snapshot(&mut task, &mut task_events);
        Ok(OperationServiceResult {
            snapshot: task,
            task_events,
            history_events,
            conflict: None,
        })
    }
}
pub fn execute_creation(
    state: &AppState,
    task_id: &str,
    request: CreateTemplateItemsRequest,
    root: &str,
    emit: &dyn Fn(&OperationServiceResult),
) -> Result<()> {
    let running = state
        .operations
        .lock()
        .expect("operations poisoned")
        .mark_operation_running(task_id);
    if let Some(running) = running {
        emit(&running);
        if running.snapshot.status == OperationTaskStatus::Cancelled {
            state
                .operations
                .lock()
                .expect("operations poisoned")
                .task_cancellations
                .remove(task_id);
            return Ok(());
        }
    }
    let cancel = state
        .operations
        .lock()
        .expect("operations poisoned")
        .operation_cancellation(task_id)
        .context("创建任务已结束")?;
    let mut bytes = 0;
    let mut last = Instant::now() - Duration::from_secs(1);
    let outcome = copy::create(
        root,
        &request.template_root,
        &request.destination,
        &request.relative_paths,
        &cancel,
        &mut |path, delta| {
            bytes += delta;
            if last.elapsed() >= Duration::from_millis(150) {
                last = Instant::now();
                let progress = state
                    .operations
                    .lock()
                    .expect("operations poisoned")
                    .template_progress(task_id, path, bytes, "正在复制模板…", true);
                if let Some(progress) = progress {
                    emit(&progress);
                }
            }
        },
    );
    let finished = state
        .operations
        .lock()
        .expect("operations poisoned")
        .finish_template_creation(task_id, outcome)?;
    emit(&finished);
    Ok(())
}

#[cfg(test)]
mod tests;

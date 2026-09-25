use super::*;
use crate::services::templates::owned;
use std::cell::Cell;

impl OperationStore {
    pub(in crate::services::operation_service) fn prepare_template_undo(
        &mut self,
        id: String,
        request_id: String,
    ) -> Result<(OperationServiceResult, OperationUndoExecution)> {
        let record = self
            .history
            .iter()
            .find(|record| record.record_id == id)
            .context("操作历史不存在")?
            .clone();
        let payload = self
            .undo_payloads
            .get(&id)
            .context("模板撤销清单已不存在")?
            .clone();
        if let Some(task_id) = self.request_to_task.get(&request_id) {
            if record.undo_task_id.as_ref() != Some(task_id) {
                bail!("此请求 ID 已用于其他操作");
            }
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
        if record.status != OperationHistoryStatus::Undoable {
            bail!("当前操作暂时无法撤销");
        }
        let task_id = Uuid::new_v4().to_string();
        let now = Utc::now();
        let event = self.template_history(
            OperationHistoryRecord {
                status: OperationHistoryStatus::Undoing,
                undo_task_id: Some(task_id.clone()),
                updated_at: now,
                blocked_reason: None,
                ..record.clone()
            },
            payload.clone(),
            false,
        )?;
        let mut task = OperationTaskSnapshot {
            task_id: task_id.clone(),
            request_id: request_id.clone(),
            kind: OperationIntentKind::Undo,
            label: format!("撤销 {}", record.label),
            status: OperationTaskStatus::Running,
            created_at: now,
            started_at: Some(now),
            finished_at: None,
            total_entries: Some(payload.templates().context("无效模板撤销清单")?.len()),
            completed_entries: 0,
            failed_entries: 0,
            total_bytes: None,
            completed_bytes: Some(0),
            current_path: None,
            message: Some("正在校验副本…".into()),
            cancelable: true,
            undoable: false,
            affected_roots: record.affected_roots,
            entry_results: vec![],
            sequence: 0,
            updated_at: now,
        };
        self.request_to_task.insert(request_id, task_id.clone());
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
                payload,
                already_started: false,
            },
        ))
    }
    fn finish_template_undo(
        &mut self,
        execution: &OperationUndoExecution,
        result: Result<()>,
        cancelled: bool,
    ) -> Result<OperationServiceResult> {
        let mut task = self
            .tasks
            .iter()
            .find(|task| task.task_id == execution.task_id)
            .context("撤销任务不存在")?
            .clone();
        let record = self
            .history
            .iter()
            .find(|record| record.record_id == execution.record_id)
            .context("历史不存在")?
            .clone();
        let mut error = result.err().map(|error| format!("{error:#}"));
        let recovery_results = execution
            .payload
            .templates()
            .unwrap()
            .iter()
            .map(|tree| {
                let recovered = tree.recovery_moved && tree.recovery_path.exists();
                OperationEntryResult {
                    entry_result_id: Uuid::new_v4().to_string(),
                    source: Some(local(&tree.path)),
                    destination: recovered.then(|| local(&tree.recovery_path)),
                    kind: if recovered {
                        OperationEntryResultKind::Moved
                    } else {
                        OperationEntryResultKind::Deleted
                    },
                    error: None,
                }
            })
            .collect::<Vec<_>>();
        let mut history_events = Vec::new();
        let desired = OperationHistoryRecord {
            status: if error.is_none() {
                OperationHistoryStatus::Undone
            } else {
                OperationHistoryStatus::Undoable
            },
            blocked_reason: error.clone(),
            recovery_items: owned::recovery_items(execution.payload.templates().unwrap()),
            updated_at: Utc::now(),
            ..record.clone()
        };
        match self.template_history(desired.clone(), execution.payload.clone(), false) {
            Ok(event) => history_events.push(event),
            Err(failure) => {
                error = Some(format!(
                    "{}；撤销历史保存失败：{failure:#}。请重试以校验并更新记录。",
                    error.as_deref().unwrap_or("副本已移除")
                ));
                let index = self
                    .history
                    .iter()
                    .position(|item| item.record_id == record.record_id)
                    .unwrap();
                self.history[index] = OperationHistoryRecord {
                    status: OperationHistoryStatus::Undoable,
                    blocked_reason: error.clone(),
                    ..desired
                };
                self.undo_payloads
                    .insert(record.record_id.clone(), execution.payload.clone());
                self.history_sequence += 1;
                history_events.push(OperationHistoryEventEnvelope {
                    record: self.history[index].clone(),
                    history_sequence: self.history_sequence,
                });
            }
        }
        task.entry_results = if let Some(error) = &error {
            vec![failed_result(
                Uuid::new_v4().to_string(),
                None,
                OperationErrorSource::JournalStore,
                anyhow::anyhow!(error.clone()),
            )]
        } else {
            recovery_results
        };
        task.failed_entries = usize::from(error.is_some());
        task.completed_entries = if error.is_none() {
            task.entry_results.len()
        } else {
            0
        };
        task.status = if error.is_none() {
            OperationTaskStatus::Succeeded
        } else if cancelled {
            OperationTaskStatus::Cancelled
        } else {
            OperationTaskStatus::Failed
        };
        task.message = Some(
            error.unwrap_or_else(|| "已撤销模板创建，恢复副本将保留至明确清理操作历史".into()),
        );
        task.finished_at = Some(Utc::now());
        task.cancelable = false;
        self.task_cancellations.remove(&task.task_id);
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

pub(in crate::services::operation_service) fn execute_undo(
    state: &AppState,
    mut execution: OperationUndoExecution,
    emit: &dyn Fn(&OperationServiceResult),
) -> Result<()> {
    let cancel = state
        .operations
        .lock()
        .expect("operations poisoned")
        .operation_cancellation(&execution.task_id)
        .context("撤销任务已结束")?;
    let deleting = Cell::new(false);
    let mut bytes = 0;
    let mut last = Instant::now() - Duration::from_secs(1);
    let mut trees = execution
        .payload
        .templates()
        .context("模板撤销清单不存在")?
        .to_vec();
    let changed_paths: Vec<_> = trees.iter().flat_map(|tree| [tree.path.clone(), tree.recovery_path.clone()]).collect();
    let _size_change = state.directory_sizes.namespace_change(&changed_paths);
    let result = owned::remove(
        &mut trees,
        &cancel,
        &mut |path, delta| {
            bytes += delta;
            if last.elapsed() >= Duration::from_millis(150) {
                last = Instant::now();
                let progress = state
                    .operations
                    .lock()
                    .expect("operations poisoned")
                    .template_progress(
                        &execution.task_id,
                        path,
                        bytes,
                        if deleting.get() {
                            "正在移除副本…"
                        } else {
                            "正在校验副本…"
                        },
                        !deleting.get(),
                    );
                if let Some(progress) = progress {
                    emit(&progress);
                }
            }
        },
        &mut |prepared| {
            let history = {
                let mut store = state.operations.lock().expect("operations poisoned");
                if cancel.load(Ordering::SeqCst) {
                    bail!("已取消撤销，副本已保留");
                }
                let record = store
                    .history
                    .iter()
                    .find(|record| record.record_id == execution.record_id)
                    .context("历史不存在")?
                    .clone();
                store.template_history(
                    record,
                    UndoPayload {
                        actions: vec![UndoAction::TemplateCreation {
                            trees: prepared.to_vec(),
                        }],
                    },
                    false,
                )?
            };
            let snapshot = state
                .operations
                .lock()
                .expect("operations poisoned")
                .tasks
                .iter()
                .find(|task| task.task_id == execution.task_id)
                .context("撤销任务不存在")?
                .clone();
            emit(&OperationServiceResult {
                snapshot,
                task_events: vec![],
                history_events: vec![history],
                conflict: None,
            });
            Ok(())
        },
        &mut || {
            let progress = {
                let mut store = state.operations.lock().expect("operations poisoned");
                if cancel.load(Ordering::SeqCst) {
                    bail!("已取消撤销，副本已保留");
                }
                deleting.set(true);
                store.template_progress(&execution.task_id, "", 0, "正在移除副本…", false)
            };
            if let Some(progress) = progress {
                emit(&progress);
            }
            Ok(())
        },
    );
    execution.payload = UndoPayload {
        actions: vec![UndoAction::TemplateCreation { trees }],
    };
    let finished = state
        .operations
        .lock()
        .expect("operations poisoned")
        .finish_template_undo(&execution, result, cancel.load(Ordering::SeqCst))?;
    emit(&finished);
    Ok(())
}

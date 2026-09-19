use super::*;
use crate::services::{
    batch_rename::transaction::{self, Checkpoint},
    AppState,
};
use std::time::{Duration, Instant};

/// Coordinates the existing task store without holding its mutex during filesystem work.
pub fn execute_batch(
    state: &AppState,
    payload: BatchPayload,
    emit: &dyn Fn(&OperationServiceResult),
) -> Result<OperationServiceResult> {
    let before = payload
        .entries
        .iter()
        .map(|entry| entry.current_path.clone())
        .collect::<Vec<_>>();
    let task_id = payload.attempt_task_id.clone();
    let (root, cancellation, running) =
        {
            let mut store = state.operations.lock().expect("operation store poisoned");
            if let Some(task) = store.tasks.iter().find(|task| {
                task.task_id == task_id && task.status == OperationTaskStatus::Cancelled
            }) {
                return Ok(OperationServiceResult {
                    snapshot: task.clone(),
                    task_events: vec![],
                    history_events: vec![],
                    conflict: None,
                });
            }
            let root = store.batch_log_root()?;
            let cancellation = store
                .operation_cancellation(&task_id)
                .context("批量任务取消状态不存在")?;
            let running = store.mark_operation_running(&task_id);
            (root, cancellation, running)
        };
    if let Some(running) = running {
        emit(&running);
    }
    let initial = payload.clone();
    let paths = payload.entries.iter().filter_map(|entry| Some((entry.current_path.clone(), entry.current_path.parent()?.join(&entry.target_name)))).collect::<Vec<_>>();
    let mut sizes = state.directory_sizes.begin_rename(&paths, payload.direction == transaction::Direction::Forward && !payload.identity_unknown());
    let mut progress_at = Instant::now();
    let execution = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        transaction::run_with_size_session(
            payload,
            &root,
            &cancellation,
            &mut |payload| {
                let result = {
                    let mut store = state.operations.lock().expect("operation store poisoned");
                    let event = store.commit_batch_success(payload)?;
                    OperationServiceResult {
                        snapshot: store
                            .tasks
                            .iter()
                            .find(|task| task.task_id == task_id)
                            .context("批量任务不存在")?
                            .clone(),
                        task_events: vec![],
                        history_events: vec![event],
                        conflict: None,
                    }
                };
                emit(&result);
                Ok(())
            },
            &mut |point, payload| {
                if point == Checkpoint::BeforeCommit
                    || (point == Checkpoint::AfterApplied
                        && progress_at.elapsed() >= Duration::from_millis(75))
                {
                    progress_at = Instant::now();
                    let progress = state
                        .operations
                        .lock()
                        .expect("operation store poisoned")
                        .batch_progress(payload);
                    if let Some(progress) = progress {
                        emit(&progress);
                    }
                }
                Ok(())
            },
            Some(&mut sizes),
        )
    }));
    let normal_return = execution.is_ok();
    let outcome = match execution {
        Ok(outcome) => outcome,
        Err(_) => {
            let committed = state
                .operations
                .lock()
                .expect("operation store poisoned")
                .undo_payloads
                .get(&initial.batch_id)
                .and_then(UndoPayload::batch)
                .filter(|batch| batch.committed_attempts.contains(&initial.attempt_id))
                .cloned();
            if let Some(payload) = committed {
                BatchRunOutcome {
                    payload,
                    committed: true,
                    restored: false,
                    cancelled: false,
                    error: None,
                    cleanup_warning: Some("操作已提交，恢复日志将稍后清理。".into()),
                }
            } else {
                let mut payload = match recovery::read_log(&root, &initial.attempt_id) {
                    Ok(log) => log.payload,
                    Err(error) => {
                        let mut payload = initial;
                        payload.recovery_diagnostic =
                            Some(format!("操作中断，恢复记录无法读取：{error}"));
                        payload
                    }
                };
                payload.pending_recovery = true;
                BatchRunOutcome {
                    payload,
                    committed: false,
                    restored: false,
                    cancelled: false,
                    error: Some("批量操作意外中断，恢复记录已保留。".into()),
                    cleanup_warning: None,
                }
            }
        }
    };
    sizes.finish(normal_return && outcome.committed && outcome.payload.direction == transaction::Direction::Forward);
    let finished = state
        .operations
        .lock()
        .expect("operation store poisoned")
        .finish_batch(outcome, &before)?;
    emit(&finished);
    Ok(finished)
}

use std::{
  collections::HashMap,
  fs,
  path::{Path, PathBuf},
  sync::{
    atomic::{AtomicBool, Ordering},
    Arc
  }
};

use anyhow::{bail, Context, Result};
use chrono::Utc;
use uuid::Uuid;

use crate::{
  domain::models::{
    ConflictResolutionKind, OperationConflictRequest, OperationConflictResolution, OperationEntryKindSnapshot,
    OperationEntryResult, OperationEntryResultKind, OperationError, OperationErrorCode, OperationErrorSource,
    OperationHistoryEventEnvelope, OperationHistoryListSnapshot, OperationHistoryRecord, OperationHistoryStatus,
    OperationIntent, OperationIntentKind, OperationPathRef, OperationTaskEventEnvelope, OperationTaskListSnapshot,
    OperationTaskSnapshot, OperationTaskStatus
  },
  services::fs_service
};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
enum UndoAction {
  DeleteCreated { path: PathBuf },
  RecreateDirectory { path: PathBuf },
  MoveBack { from: PathBuf, to: PathBuf },
  RestoreTrash { trash_path: PathBuf, original_path: PathBuf }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UndoPayload {
  actions: Vec<UndoAction>
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct OperationJournalDisk {
  history: Vec<OperationHistoryRecord>,
  history_sequence: u64,
  undo_payloads: HashMap<String, UndoPayload>
}

#[derive(Debug, Clone)]
struct PendingConflict {
  conflict: OperationConflictRequest,
  intent: OperationIntent,
  continuation: OperationContinuation
}

#[derive(Debug, Clone, Default)]
pub(crate) struct OperationContinuation {
  entry_results: Vec<OperationEntryResult>,
  undo_actions: Vec<UndoAction>,
  next_source_index: usize
}

pub(crate) struct OperationConflictExecution {
  pub task_id: String,
  pub intent: OperationIntent,
  pub continuation: OperationContinuation,
  pub resolution: OperationConflictResolution,
  pub cancellation: Arc<AtomicBool>
}

pub(crate) struct OperationUndoExecution {
  task_id: String,
  record_id: String,
  payload: UndoPayload
}

pub(crate) struct OperationUndoExecutionResult {
  task_id: String,
  record_id: String,
  entry_results: Vec<OperationEntryResult>,
  failed_entries: usize
}

#[derive(Debug, Clone)]
pub struct OperationServiceResult {
  pub snapshot: OperationTaskSnapshot,
  pub task_events: Vec<OperationTaskEventEnvelope>,
  pub history_events: Vec<OperationHistoryEventEnvelope>,
  pub conflict: Option<OperationConflictRequest>
}

#[derive(Default)]
pub struct OperationStore {
  tasks: Vec<OperationTaskSnapshot>,
  history: Vec<OperationHistoryRecord>,
  task_sequence: u64,
  history_sequence: u64,
  request_to_task: HashMap<String, String>,
  pending_conflicts: HashMap<String, PendingConflict>,
  undo_payloads: HashMap<String, UndoPayload>,
  task_cancellations: HashMap<String, Arc<AtomicBool>>,
  file_path: Option<PathBuf>
}

pub(crate) struct ExecutionResult {
  status: OperationTaskStatus,
  message: Option<String>,
  affected_roots: Vec<OperationPathRef>,
  entry_results: Vec<OperationEntryResult>,
  undo_payload: Option<UndoPayload>,
  conflict: Option<OperationConflictRequest>,
  continuation: Option<OperationContinuation>
}

impl OperationStore {
  pub fn load_from(file_path: PathBuf) -> Result<Self> {
    if !file_path.exists() {
      return Ok(Self {
        file_path: Some(file_path),
        ..Self::default()
      });
    }

    let content = match fs::read_to_string(&file_path) {
      Ok(content) => content,
      Err(_) => {
        return Ok(Self {
          file_path: Some(file_path),
          ..Self::default()
        });
      }
    };
    let disk: OperationJournalDisk = match serde_json::from_str(&content) {
      Ok(disk) => disk,
      Err(_) => {
        let _ = fs::rename(&file_path, corrupt_journal_path(&file_path));
        return Ok(Self {
          file_path: Some(file_path),
          ..Self::default()
        });
      }
    };
    let (history, undo_payloads) = normalize_reloaded_journal(disk.history, disk.undo_payloads);
    Ok(Self {
      history_sequence: disk.history_sequence.max(history.len() as u64),
      history,
      undo_payloads,
      file_path: Some(file_path),
      ..Self::default()
    })
  }

  pub fn persist_journal(&self) -> Result<()> {
    let file_path = self.file_path.as_ref().context("operation journal path not initialized")?;
    if let Some(parent) = file_path.parent() {
      fs::create_dir_all(parent).context("failed to create operation journal directory")?;
    }

    let disk = OperationJournalDisk {
      history: self.history.clone(),
      history_sequence: self.history_sequence,
      undo_payloads: self.undo_payloads.clone()
    };
    let temp_path = file_path.with_extension(format!("json.tmp-{}", Uuid::new_v4()));
    let backup_path = file_path.with_extension(format!("json.bak-{}", Uuid::new_v4()));
    let content = serde_json::to_vec_pretty(&disk).context("failed to serialize operation journal")?;
    fs::write(&temp_path, content).context("failed to write operation journal temp file")?;
    if file_path.exists() {
      fs::rename(file_path, &backup_path).context("failed to stage existing operation journal")?;
    }
    if let Err(error) = fs::rename(&temp_path, file_path) {
      if backup_path.exists() {
        let _ = fs::rename(&backup_path, file_path);
      }
      let _ = fs::remove_file(&temp_path);
      return Err(error).context("failed to commit operation journal");
    }
    if backup_path.exists() {
      let _ = fs::remove_file(backup_path);
    }
    Ok(())
  }

  pub fn list_tasks(&self) -> OperationTaskListSnapshot {
    OperationTaskListSnapshot {
      tasks: self.tasks.clone(),
      task_sequence: self.task_sequence
    }
  }

  pub fn list_history(&self) -> OperationHistoryListSnapshot {
    OperationHistoryListSnapshot {
      records: self.history.clone(),
      history_sequence: self.history_sequence
    }
  }

  #[cfg(test)]
  pub fn start_operation(&mut self, intent: OperationIntent, app_data_dir: Option<PathBuf>) -> OperationServiceResult {
    let (mut result, should_execute) = self.queue_operation(intent.clone());
    if !should_execute {
      return result;
    }

    if let Some(running) = self.mark_operation_running(&result.snapshot.task_id) {
      result.snapshot = running.snapshot;
      result.task_events.extend(running.task_events);
    }

    let cancellation = self
      .operation_cancellation(&result.snapshot.task_id)
      .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
    let execution = execute_operation_task(&result.snapshot.task_id, &intent, app_data_dir, cancellation, None);
    if let Some(finished) = self.finish_operation(&result.snapshot.task_id, &intent, execution) {
      result.snapshot = finished.snapshot;
      result.task_events.extend(finished.task_events);
      result.history_events.extend(finished.history_events);
      result.conflict = finished.conflict;
    }

    result
  }

  pub fn queue_operation(&mut self, intent: OperationIntent) -> (OperationServiceResult, bool) {
    if let Some(task_id) = self.request_to_task.get(&intent.request_id) {
      if let Some(snapshot) = self.tasks.iter().find(|task| &task.task_id == task_id).cloned() {
        return (
          OperationServiceResult {
            snapshot,
            task_events: Vec::new(),
            history_events: Vec::new(),
            conflict: None
          },
          false
        );
      }
    }

    let task_id = Uuid::new_v4().to_string();
    let now = Utc::now();
    let mut task = OperationTaskSnapshot {
      task_id: task_id.clone(),
      request_id: intent.request_id.clone(),
      kind: intent.kind.clone(),
      label: operation_label(&intent),
      status: OperationTaskStatus::Queued,
      created_at: now,
      started_at: None,
      finished_at: None,
      total_entries: Some(intent_entry_count(&intent)),
      completed_entries: 0,
      failed_entries: 0,
      total_bytes: None,
      completed_bytes: None,
      current_path: None,
      message: None,
      cancelable: true,
      undoable: false,
      affected_roots: affected_roots_for_intent(&intent),
      entry_results: Vec::new(),
      sequence: 0,
      updated_at: now
    };

    let mut task_events = Vec::new();
    self.request_to_task.insert(intent.request_id.clone(), task_id.clone());
    self
      .task_cancellations
      .insert(task_id.clone(), Arc::new(AtomicBool::new(false)));
    self.commit_task_snapshot(&mut task, &mut task_events);

    (
      OperationServiceResult {
        snapshot: task,
        task_events,
        history_events: Vec::new(),
        conflict: None
      },
      true
    )
  }

  pub fn mark_operation_running(&mut self, task_id: &str) -> Option<OperationServiceResult> {
    let task_index = self.tasks.iter().position(|task| task.task_id == task_id)?;
    let mut task = self.tasks[task_index].clone();
    if !matches!(task.status, OperationTaskStatus::Queued) {
      return Some(OperationServiceResult {
        snapshot: task,
        task_events: Vec::new(),
        history_events: Vec::new(),
        conflict: None
      });
    }

    if self
      .task_cancellations
      .get(task_id)
      .map(|flag| flag.load(Ordering::SeqCst))
      .unwrap_or(false)
    {
      task.status = OperationTaskStatus::Cancelled;
      task.finished_at = Some(Utc::now());
      task.cancelable = false;
      task.message = Some("Operation cancelled.".into());
    } else {
      task.status = OperationTaskStatus::Running;
      task.started_at = Some(Utc::now());
      task.message = Some("Operation is running.".into());
    }

    let mut task_events = Vec::new();
    self.commit_task_snapshot(&mut task, &mut task_events);
    Some(OperationServiceResult {
      snapshot: task,
      task_events,
      history_events: Vec::new(),
      conflict: None
    })
  }

  pub fn operation_cancellation(&self, task_id: &str) -> Option<Arc<AtomicBool>> {
    self.task_cancellations.get(task_id).cloned()
  }

  pub(crate) fn finish_operation(
    &mut self,
    task_id: &str,
    intent: &OperationIntent,
    execution: ExecutionResult
  ) -> Option<OperationServiceResult> {
    let task_index = self.tasks.iter().position(|task| task.task_id == task_id)?;
    let mut task = self.tasks[task_index].clone();
    if matches!(task.status, OperationTaskStatus::Cancelled) {
      self.task_cancellations.remove(task_id);
      return Some(OperationServiceResult {
        snapshot: task,
        task_events: Vec::new(),
        history_events: Vec::new(),
        conflict: None
      });
    }

    task.status = execution.status;
    task.finished_at = if execution.conflict.is_none() {
      Some(Utc::now())
    } else {
      None
    };
    task.cancelable = matches!(task.status, OperationTaskStatus::WaitingConflict | OperationTaskStatus::Running);
    task.undoable = execution.undo_payload.is_some()
      && matches!(
        task.status,
        OperationTaskStatus::Succeeded | OperationTaskStatus::PartialSucceeded | OperationTaskStatus::Cancelled
      );
    task.message = execution.message;
    task.affected_roots = execution.affected_roots;
    task.entry_results = execution.entry_results;
    task.completed_entries = task
      .entry_results
      .iter()
      .filter(|result| !matches!(result.kind, OperationEntryResultKind::Failed))
      .count();
    task.failed_entries = task
      .entry_results
      .iter()
      .filter(|result| matches!(result.kind, OperationEntryResultKind::Failed))
      .count();

    let mut task_events = Vec::new();
    let mut history_events = Vec::new();
    if let Some(conflict) = &execution.conflict {
      task.status = OperationTaskStatus::WaitingConflict;
      self.pending_conflicts.insert(
        conflict.conflict_id.clone(),
        PendingConflict {
          conflict: conflict.clone(),
          intent: intent.clone(),
          continuation: execution.continuation.unwrap_or_default()
        }
      );
    } else if let Some(payload) = execution.undo_payload {
      let event = self.create_history_record(&task, payload, OperationHistoryStatus::Undoable, None);
      history_events.push(event);
    } else if matches!(task.status, OperationTaskStatus::Succeeded) {
      let event = self.create_history_record(
        &task,
        UndoPayload { actions: Vec::new() },
        OperationHistoryStatus::NotUndoable,
        Some("Operation is not undoable.".into())
      );
      history_events.push(event);
    }

    self.commit_task_snapshot(&mut task, &mut task_events);
    if !matches!(task.status, OperationTaskStatus::WaitingConflict | OperationTaskStatus::Running | OperationTaskStatus::Cancelling) {
      self.task_cancellations.remove(task_id);
    }

    Some(OperationServiceResult {
      snapshot: task,
      task_events,
      history_events,
      conflict: execution.conflict
    })
  }

  #[cfg(test)]
  pub fn resolve_conflict(
    &mut self,
    resolution: OperationConflictResolution,
    app_data_dir: Option<PathBuf>
  ) -> Result<OperationServiceResult> {
    let (mut result, execution) = self.prepare_conflict_resolution(resolution)?;
    let task_id = execution.task_id.clone();
    let intent = execution.intent.clone();
    let operation = execute_conflict_resolution(execution, app_data_dir);
    let mut finished = self
      .finish_operation(&task_id, &intent, operation)
      .context("conflict task disappeared before it could finish")?;
    result.task_events.extend(finished.task_events);
    finished.task_events = result.task_events;
    Ok(finished)
  }

  pub fn prepare_conflict_resolution(
    &mut self,
    resolution: OperationConflictResolution
  ) -> Result<(OperationServiceResult, OperationConflictExecution)> {
    let pending = self
      .pending_conflicts
      .remove(&resolution.conflict_id)
      .context("conflict request is no longer available")?;
    let task_id = pending.conflict.task_id.clone();
    let task_index = self
      .tasks
      .iter()
      .position(|task| task.task_id == task_id)
      .context("conflict task is no longer available")?;
    let mut task = self.tasks[task_index].clone();
    let mut task_events = Vec::new();

    task.status = OperationTaskStatus::Running;
    task.message = Some("Applying conflict decision.".into());
    self.commit_task_snapshot(&mut task, &mut task_events);

    let cancellation = self
      .operation_cancellation(&task_id)
      .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
    let result = OperationServiceResult {
      snapshot: task,
      task_events,
      history_events: Vec::new(),
      conflict: None
    };
    let execution = OperationConflictExecution {
      task_id,
      intent: pending.intent,
      continuation: pending.continuation,
      resolution,
      cancellation,
    };
    Ok((result, execution))
  }

  pub fn cancel_task(&mut self, task_id: &str) -> Option<OperationServiceResult> {
    let task_index = self.tasks.iter().position(|task| task.task_id == task_id)?;
    let mut task = self.tasks[task_index].clone();
    if matches!(
      task.status,
      OperationTaskStatus::Succeeded | OperationTaskStatus::Failed | OperationTaskStatus::Cancelled | OperationTaskStatus::PartialSucceeded
    ) {
      return Some(OperationServiceResult {
        snapshot: task,
        task_events: Vec::new(),
        history_events: Vec::new(),
        conflict: None
      });
    }

    if let Some(flag) = self.task_cancellations.get(task_id) {
      flag.store(true, Ordering::SeqCst);
    }
    self
      .pending_conflicts
      .retain(|_, pending| pending.conflict.task_id != task_id);
    if matches!(task.status, OperationTaskStatus::Running) {
      task.status = OperationTaskStatus::Cancelling;
      task.cancelable = false;
      task.message = Some("Cancelling operation.".into());
    } else {
      task.status = OperationTaskStatus::Cancelled;
      task.finished_at = Some(Utc::now());
      task.cancelable = false;
      task.message = Some("Operation cancelled.".into());
      self.task_cancellations.remove(task_id);
    }
    let mut task_events = Vec::new();
    self.commit_task_snapshot(&mut task, &mut task_events);
    Some(OperationServiceResult {
      snapshot: task,
      task_events,
      history_events: Vec::new(),
      conflict: None
    })
  }

  #[cfg(test)]
  pub fn undo_latest(&mut self, request_id: String) -> Result<OperationServiceResult> {
    let (prepared, execution) = self.prepare_undo_latest(request_id)?;
    let undo_result = execute_undo_task(execution);
    let mut finished = self.finish_undo_operation(undo_result)?;
    let mut task_events = prepared.task_events;
    task_events.extend(finished.task_events);
    finished.task_events = task_events;
    let mut history_events = prepared.history_events;
    history_events.extend(finished.history_events);
    finished.history_events = history_events;
    Ok(finished)
  }

  #[cfg(test)]
  #[allow(dead_code)]
  pub fn undo_record(&mut self, record_id: String, request_id: String) -> Result<OperationServiceResult> {
    let (prepared, execution) = self.prepare_undo_record(record_id, request_id)?;
    let undo_result = execute_undo_task(execution);
    let mut finished = self.finish_undo_operation(undo_result)?;
    let mut task_events = prepared.task_events;
    task_events.extend(finished.task_events);
    finished.task_events = task_events;
    let mut history_events = prepared.history_events;
    history_events.extend(finished.history_events);
    finished.history_events = history_events;
    Ok(finished)
  }

  pub fn prepare_undo_latest(
    &mut self,
    request_id: String
  ) -> Result<(OperationServiceResult, OperationUndoExecution)> {
    let record = self
      .history
      .iter()
      .filter(|record| matches!(record.status, OperationHistoryStatus::Undoable))
      .max_by(|left, right| left.created_at.cmp(&right.created_at))
      .cloned()
      .context("no undoable operation is available")?;

    self.prepare_undo_record(record.record_id, request_id)
  }

  pub fn prepare_undo_record(
    &mut self,
    record_id: String,
    request_id: String
  ) -> Result<(OperationServiceResult, OperationUndoExecution)> {
    let record_index = self
      .history
      .iter()
      .position(|record| record.record_id == record_id)
      .context("operation history record was not found")?;
    if !matches!(self.history[record_index].status, OperationHistoryStatus::Undoable) {
      bail!("operation history record is not undoable");
    }

    let payload = self
      .undo_payloads
      .remove(&record_id)
      .context("undo payload is no longer available")?;

    let task_id = Uuid::new_v4().to_string();
    let now = Utc::now();
    let mut task = OperationTaskSnapshot {
      task_id: task_id.clone(),
      request_id,
      kind: OperationIntentKind::Undo,
      label: format!("Undo {}", self.history[record_index].label),
      status: OperationTaskStatus::Running,
      created_at: now,
      started_at: Some(now),
      finished_at: None,
      total_entries: Some(payload.actions.len()),
      completed_entries: 0,
      failed_entries: 0,
      total_bytes: None,
      completed_bytes: None,
      current_path: None,
      message: None,
      cancelable: false,
      undoable: false,
      affected_roots: self.history[record_index].affected_roots.clone(),
      entry_results: Vec::new(),
      sequence: 0,
      updated_at: now
    };

    let mut task_events = Vec::new();
    self.commit_task_snapshot(&mut task, &mut task_events);

    self.history[record_index].status = OperationHistoryStatus::Undoing;
    self.history[record_index].undo_task_id = Some(task_id.clone());
    let history_events = vec![self.commit_history_index(record_index)];

    Ok((
      OperationServiceResult {
        snapshot: task,
        task_events,
        history_events,
        conflict: None
      },
      OperationUndoExecution {
        task_id,
        record_id,
        payload
      }
    ))
  }

  pub fn finish_undo_operation(
    &mut self,
    result: OperationUndoExecutionResult
  ) -> Result<OperationServiceResult> {
    let task_index = self
      .tasks
      .iter()
      .position(|task| task.task_id == result.task_id)
      .context("undo task disappeared before it could finish")?;
    let mut task = self.tasks[task_index].clone();

    task.entry_results = result.entry_results;
    task.completed_entries = task.entry_results.len().saturating_sub(result.failed_entries);
    task.failed_entries = result.failed_entries;
    task.status = if result.failed_entries == 0 {
      OperationTaskStatus::Succeeded
    } else if task.completed_entries > 0 {
      OperationTaskStatus::PartialSucceeded
    } else {
      OperationTaskStatus::Failed
    };
    task.finished_at = Some(Utc::now());
    task.message = if result.failed_entries == 0 {
      Some("Undo completed.".into())
    } else {
      Some("Undo completed with errors.".into())
    };
    let mut task_events = Vec::new();
    self.commit_task_snapshot(&mut task, &mut task_events);

    let record_index = self
      .history
      .iter()
      .position(|record| record.record_id == result.record_id)
      .context("operation history record disappeared during undo")?;
    self.history[record_index].status = if result.failed_entries == 0 {
      OperationHistoryStatus::Undone
    } else {
      OperationHistoryStatus::Failed
    };
    self.history[record_index].updated_at = Utc::now();
    let history_events = vec![self.commit_history_index(record_index)];

    Ok(OperationServiceResult {
      snapshot: task,
      task_events,
      history_events,
      conflict: None
    })
  }

  fn commit_task_snapshot(
    &mut self,
    task: &mut OperationTaskSnapshot,
    events: &mut Vec<OperationTaskEventEnvelope>
  ) {
    self.task_sequence += 1;
    task.sequence = self.task_sequence;
    task.updated_at = Utc::now();
    match self.tasks.iter().position(|existing| existing.task_id == task.task_id) {
      Some(index) => self.tasks[index] = task.clone(),
      None => self.tasks.push(task.clone())
    }
    events.push(OperationTaskEventEnvelope {
      task_id: task.task_id.clone(),
      sequence: task.sequence,
      updated_at: task.updated_at,
      snapshot: task.clone()
    });
  }

  fn create_history_record(
    &mut self,
    task: &OperationTaskSnapshot,
    payload: UndoPayload,
    status: OperationHistoryStatus,
    blocked_reason: Option<String>
  ) -> OperationHistoryEventEnvelope {
    let record_id = Uuid::new_v4().to_string();
    let now = Utc::now();
    let record = OperationHistoryRecord {
      record_id: record_id.clone(),
      task_id: task.task_id.clone(),
      kind: task.kind.clone(),
      label: task.label.clone(),
      status,
      created_at: now,
      updated_at: now,
      undo_task_id: None,
      blocked_reason,
      payload_expires_at: None,
      affected_roots: task.affected_roots.clone()
    };
    if !payload.actions.is_empty() {
      self.undo_payloads.insert(record_id.clone(), payload);
    }
    self.history.push(record);
    self.commit_history_index(self.history.len() - 1)
  }

  fn commit_history_index(&mut self, record_index: usize) -> OperationHistoryEventEnvelope {
    self.history_sequence += 1;
    self.history[record_index].updated_at = Utc::now();
    let envelope = OperationHistoryEventEnvelope {
      record: self.history[record_index].clone(),
      history_sequence: self.history_sequence
    };
    let _ = self.persist_journal();
    envelope
  }
}

fn normalize_reloaded_journal(
  mut records: Vec<OperationHistoryRecord>,
  mut undo_payloads: HashMap<String, UndoPayload>
) -> (Vec<OperationHistoryRecord>, HashMap<String, UndoPayload>) {
  let mut undoable_record_ids = Vec::new();
  for record in &mut records {
    if matches!(record.status, OperationHistoryStatus::Undoing | OperationHistoryStatus::PendingConfirmation) {
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
          return Some(format!("Moved item is no longer available: {}", from.display()));
        }
      }
      UndoAction::RestoreTrash { trash_path, .. } => {
        if !trash_path.exists() {
          return Some(format!("Trash payload is no longer available: {}", trash_path.display()));
        }
      }
    }
  }
  None
}

fn corrupt_journal_path(file_path: &Path) -> PathBuf {
  file_path.with_extension(format!("json.corrupt-{}", Uuid::new_v4()))
}

pub(crate) fn execute_operation_task(
  task_id: &str,
  intent: &OperationIntent,
  app_data_dir: Option<PathBuf>,
  cancellation: Arc<AtomicBool>,
  resolution: Option<OperationConflictResolution>
) -> ExecutionResult {
  match execute_local_intent(
    task_id,
    intent,
    app_data_dir,
    &cancellation,
    resolution.as_ref()
  ) {
    Ok(result) => result,
    Err(error) => {
      if cancellation.load(Ordering::SeqCst) {
        return ExecutionResult {
          status: OperationTaskStatus::Cancelled,
          message: Some("Operation cancelled.".into()),
          affected_roots: affected_roots_for_intent(intent),
          entry_results: Vec::new(),
          undo_payload: None,
          conflict: None,
          continuation: None
        };
      }

      ExecutionResult {
        status: OperationTaskStatus::Failed,
        message: Some(error.to_string()),
        affected_roots: affected_roots_for_intent(intent),
        entry_results: vec![failed_result(
          format!("{task_id}-failed"),
          intent.sources.as_ref().and_then(|sources| sources.first()).cloned(),
          OperationErrorSource::LocalFs,
          error
        )],
        undo_payload: None,
        conflict: None,
        continuation: None
      }
    }
  }
}

pub(crate) fn execute_undo_task(execution: OperationUndoExecution) -> OperationUndoExecutionResult {
  let mut entry_results = Vec::new();
  let mut failed_entries = 0usize;
  for (index, action) in execution.payload.actions.iter().enumerate().rev() {
    match apply_undo_action(action) {
      Ok(result) => entry_results.push(result),
      Err(error) => {
        failed_entries += 1;
        entry_results.push(failed_result(
          format!("undo-{index}"),
          None,
          OperationErrorSource::JournalStore,
          error
        ));
      }
    }
  }
  OperationUndoExecutionResult {
    task_id: execution.task_id,
    record_id: execution.record_id,
    entry_results,
    failed_entries
  }
}

fn execute_local_intent(
  task_id: &str,
  intent: &OperationIntent,
  app_data_dir: Option<PathBuf>,
  cancellation: &AtomicBool,
  resolution: Option<&OperationConflictResolution>
) -> Result<ExecutionResult> {
  check_cancelled(cancellation)?;
  if intent_has_remote_path(intent) {
    return Ok(ExecutionResult {
      status: OperationTaskStatus::Failed,
      message: Some("Task mode does not support remote file operations yet.".into()),
      affected_roots: affected_roots_for_intent(intent),
      entry_results: vec![failed_result(
        format!("{task_id}-remote-unsupported"),
        None,
        OperationErrorSource::RemoteFs,
        anyhow::anyhow!("remote task execution is not supported yet")
      )],
      undo_payload: None,
      conflict: None,
      continuation: None
    });
  }

  match intent.kind {
    OperationIntentKind::Copy => execute_copy_or_move(task_id, intent, app_data_dir, cancellation, resolution, false),
    OperationIntentKind::Move => execute_copy_or_move(task_id, intent, app_data_dir, cancellation, resolution, true),
    OperationIntentKind::Delete => execute_delete(task_id, intent, app_data_dir, cancellation),
    OperationIntentKind::Rename => execute_rename(task_id, intent, app_data_dir, cancellation, resolution),
    OperationIntentKind::CreateDirectory => execute_create(task_id, intent, app_data_dir, cancellation, resolution, true),
    OperationIntentKind::CreateFile => execute_create(task_id, intent, app_data_dir, cancellation, resolution, false),
    OperationIntentKind::Undo => bail!("undo intent must be routed through undo_operation")
  }
}

fn execute_copy_or_move(
  task_id: &str,
  intent: &OperationIntent,
  app_data_dir: Option<PathBuf>,
  cancellation: &AtomicBool,
  resolution: Option<&OperationConflictResolution>,
  move_source: bool
) -> Result<ExecutionResult> {
  execute_copy_or_move_continuation(
    task_id,
    intent,
    app_data_dir,
    cancellation,
    OperationContinuation::default(),
    resolution,
    move_source
  )
}

fn execute_copy_or_move_continuation(
  task_id: &str,
  intent: &OperationIntent,
  app_data_dir: Option<PathBuf>,
  cancellation: &AtomicBool,
  mut continuation: OperationContinuation,
  resolution: Option<&OperationConflictResolution>,
  move_source: bool
) -> Result<ExecutionResult> {
  let sources = required_sources(intent)?;
  let destination_root = local_path(intent.destination.as_ref(), "destination")?;
  let apply_to_all = resolution
    .map(|resolution| resolution.apply_to_all)
    .unwrap_or(false);
  let resolved_source_index = continuation.next_source_index;

  for index in continuation.next_source_index..sources.len() {
    check_cancelled(cancellation)?;
    let source_ref = &sources[index];
    let source = PathBuf::from(local_path(Some(source_ref), "source")?);
    let file_name = source
      .file_name()
      .context("source path does not have a file name")?;
    let base_destination = Path::new(destination_root).join(file_name);
    ensure_not_descendant(&source, Path::new(destination_root))?;

    let entry_resolution = if index == resolved_source_index || apply_to_all {
      resolution
    } else {
      None
    };
    if base_destination.exists() && entry_resolution.is_none() {
      return Ok(conflict_execution(
        intent,
        continuation,
        create_conflict_request(task_id, source_ref.clone(), &base_destination),
        index
      ));
    }

    let decision = resolve_destination(&base_destination, entry_resolution)?;
    execute_copy_or_move_entry(
      task_id,
      index,
      source_ref,
      &source,
      &base_destination,
      decision,
      app_data_dir.as_ref(),
      cancellation,
      move_source,
      &mut continuation
    )?;
    continuation.next_source_index = index + 1;
  }

  Ok(success_execution(
    intent,
    continuation.entry_results,
    continuation.undo_actions
  ))
}

fn execute_copy_or_move_entry(
  task_id: &str,
  index: usize,
  source_ref: &OperationPathRef,
  source: &Path,
  base_destination: &Path,
  decision: DestinationDecision,
  app_data_dir: Option<&PathBuf>,
  cancellation: &AtomicBool,
  move_source: bool,
  continuation: &mut OperationContinuation
) -> Result<()> {
  if decision.skip {
    continuation.entry_results.push(OperationEntryResult {
      entry_result_id: format!("{task_id}-{index}"),
      source: Some(source_ref.clone()),
      destination: Some(OperationPathRef::Local {
        path: base_destination.to_string_lossy().into_owned()
      }),
      kind: OperationEntryResultKind::Skipped,
      error: None
    });
    return Ok(());
  }

  if decision.merge_directory {
    let mut undo_actions = merge_directory_exact(source, &decision.destination, move_source, cancellation)?;
    continuation.undo_actions.append(&mut undo_actions);
    continuation.entry_results.push(OperationEntryResult {
      entry_result_id: format!("{task_id}-{index}"),
      source: Some(source_ref.clone()),
      destination: Some(OperationPathRef::Local {
        path: decision.destination.to_string_lossy().into_owned()
      }),
      kind: if move_source {
        OperationEntryResultKind::Moved
      } else {
        OperationEntryResultKind::Created
      },
      error: None
    });
    return Ok(());
  }

  if decision.destination.exists() && !decision.replace {
    bail!("destination already exists: {}", decision.destination.display());
  }

  let mut restore_backup = None;
  if decision.replace && decision.destination.exists() {
    let backup = trash_destination(task_id, app_data_dir, &decision.destination)?;
    let backup = move_entry_exact(&decision.destination, &backup, cancellation)?;
    restore_backup = Some((backup, decision.destination.clone()));
  }

  let actual_destination = if move_source {
    move_entry_exact(source, &decision.destination, cancellation)?
  } else {
    copy_recursively_exact(source, &decision.destination, cancellation)?
  };
  let destination_ref = OperationPathRef::Local {
    path: actual_destination.to_string_lossy().into_owned()
  };

  if let Some((trash_path, original_path)) = restore_backup {
    continuation.undo_actions.push(UndoAction::RestoreTrash {
      trash_path,
      original_path
    });
  }
  if move_source {
    continuation.undo_actions.push(UndoAction::MoveBack {
      from: actual_destination.clone(),
      to: source.to_path_buf()
    });
  } else {
    continuation.undo_actions.push(UndoAction::DeleteCreated {
      path: actual_destination.clone()
    });
  }

  continuation.entry_results.push(OperationEntryResult {
    entry_result_id: format!("{task_id}-{index}"),
    source: Some(source_ref.clone()),
    destination: Some(destination_ref),
    kind: if move_source {
      OperationEntryResultKind::Moved
    } else {
      OperationEntryResultKind::Created
    },
    error: None
  });
  Ok(())
}

fn conflict_execution(
  intent: &OperationIntent,
  mut continuation: OperationContinuation,
  conflict: OperationConflictRequest,
  next_source_index: usize
) -> ExecutionResult {
  continuation.next_source_index = next_source_index;
  ExecutionResult {
    status: OperationTaskStatus::WaitingConflict,
    message: Some("Waiting for conflict decision.".into()),
    affected_roots: affected_roots_for_intent(intent),
    entry_results: continuation.entry_results.clone(),
    undo_payload: None,
    conflict: Some(conflict),
    continuation: Some(continuation)
  }
}

pub(crate) fn execute_conflict_resolution(
  execution: OperationConflictExecution,
  app_data_dir: Option<PathBuf>
) -> ExecutionResult {
  execute_pending_conflict(
    &execution.task_id,
    &execution.intent,
    app_data_dir,
    execution.cancellation,
    execution.continuation,
    execution.resolution
  )
}

fn execute_pending_conflict(
  task_id: &str,
  intent: &OperationIntent,
  app_data_dir: Option<PathBuf>,
  cancellation: Arc<AtomicBool>,
  continuation: OperationContinuation,
  resolution: OperationConflictResolution
) -> ExecutionResult {
  let result = match intent.kind {
    OperationIntentKind::Copy => execute_copy_or_move_continuation(
      task_id,
      intent,
      app_data_dir,
      &cancellation,
      continuation,
      Some(&resolution),
      false
    ),
    OperationIntentKind::Move => execute_copy_or_move_continuation(
      task_id,
      intent,
      app_data_dir,
      &cancellation,
      continuation,
      Some(&resolution),
      true
    ),
    _ => execute_local_intent(
      task_id,
      intent,
      app_data_dir,
      &cancellation,
      Some(&resolution)
    )
  };

  match result {
    Ok(result) => result,
    Err(error) => {
      if cancellation.load(Ordering::SeqCst) {
        ExecutionResult {
          status: OperationTaskStatus::Cancelled,
          message: Some("Operation cancelled.".into()),
          affected_roots: affected_roots_for_intent(intent),
          entry_results: Vec::new(),
          undo_payload: None,
          conflict: None,
          continuation: None
        }
      } else {
        ExecutionResult {
          status: OperationTaskStatus::Failed,
          message: Some(error.to_string()),
          affected_roots: affected_roots_for_intent(intent),
          entry_results: vec![failed_result(
            format!("{task_id}-failed"),
            intent.sources.as_ref().and_then(|sources| sources.first()).cloned(),
            OperationErrorSource::LocalFs,
            error
          )],
          undo_payload: None,
          conflict: None,
          continuation: None
        }
      }
    }
  }
}

fn execute_delete(
  task_id: &str,
  intent: &OperationIntent,
  app_data_dir: Option<PathBuf>,
  cancellation: &AtomicBool
) -> Result<ExecutionResult> {
  let sources = required_sources(intent)?;
  let mut results = Vec::new();
  let mut undo_actions = Vec::new();
  for (index, source_ref) in sources.iter().enumerate() {
    if cancellation.load(Ordering::SeqCst) {
      return Ok(cancelled_execution(intent, results, undo_actions));
    }
    let source = PathBuf::from(local_path(Some(source_ref), "source")?);
    let trash_path = trash_destination(task_id, app_data_dir.as_ref(), &source)?;
    move_entry_exact(&source, &trash_path, cancellation)?;
    undo_actions.push(UndoAction::RestoreTrash {
      trash_path: trash_path.clone(),
      original_path: source.clone()
    });
    results.push(OperationEntryResult {
      entry_result_id: format!("{task_id}-{index}"),
      source: Some(source_ref.clone()),
      destination: Some(OperationPathRef::Local {
        path: trash_path.to_string_lossy().into_owned()
      }),
      kind: OperationEntryResultKind::Trashed,
      error: None
    });
  }
  Ok(success_execution(intent, results, undo_actions))
}

fn execute_rename(
  task_id: &str,
  intent: &OperationIntent,
  app_data_dir: Option<PathBuf>,
  cancellation: &AtomicBool,
  resolution: Option<&OperationConflictResolution>
) -> Result<ExecutionResult> {
  check_cancelled(cancellation)?;
  let source_ref = intent
    .source_path
    .as_ref()
    .context("sourcePath is required for rename")?;
  let source = PathBuf::from(local_path(Some(source_ref), "sourcePath")?);
  let new_name = intent
    .new_name
    .as_deref()
    .context("newName is required for rename")?;
  let parent = source.parent().context("cannot rename a root path")?;
  let destination = parent.join(new_name);

  if destination.exists() && resolution.is_none() {
    return Ok(ExecutionResult {
      status: OperationTaskStatus::WaitingConflict,
      message: Some("Waiting for conflict decision.".into()),
      affected_roots: affected_roots_for_intent(intent),
      entry_results: Vec::new(),
      undo_payload: None,
      conflict: Some(create_conflict_request(task_id, source_ref.clone(), &destination)),
      continuation: None
    });
  }

  let decision = resolve_destination(&destination, resolution)?;
  if decision.skip {
    return Ok(success_execution(
      intent,
      vec![OperationEntryResult {
        entry_result_id: format!("{task_id}-0"),
        source: Some(source_ref.clone()),
        destination: Some(OperationPathRef::Local {
          path: destination.to_string_lossy().into_owned()
        }),
        kind: OperationEntryResultKind::Skipped,
        error: None
      }],
      Vec::new()
    ));
  }

  let mut undo_actions = Vec::new();
  let mut restore_backup = None;
  if decision.replace && decision.destination.exists() {
    let backup = trash_destination(task_id, app_data_dir.as_ref(), &decision.destination)?;
    let backup = move_entry_exact(&decision.destination, &backup, cancellation)?;
    restore_backup = Some((backup, decision.destination.clone()));
  }

  check_cancelled(cancellation)?;
  fs::rename(&source, &decision.destination).with_context(|| {
    format!(
      "failed to rename {} to {}",
      source.display(),
      decision.destination.display()
    )
  })?;
  undo_actions.push(UndoAction::MoveBack {
    from: decision.destination.clone(),
    to: source.clone()
  });
  if let Some((trash_path, original_path)) = restore_backup {
    undo_actions.push(UndoAction::RestoreTrash {
      trash_path,
      original_path
    });
  }

  Ok(success_execution(
    intent,
    vec![OperationEntryResult {
      entry_result_id: format!("{task_id}-0"),
      source: Some(source_ref.clone()),
      destination: Some(OperationPathRef::Local {
        path: decision.destination.to_string_lossy().into_owned()
      }),
      kind: OperationEntryResultKind::Renamed,
      error: None
    }],
    undo_actions
  ))
}

fn execute_create(
  task_id: &str,
  intent: &OperationIntent,
  _app_data_dir: Option<PathBuf>,
  cancellation: &AtomicBool,
  resolution: Option<&OperationConflictResolution>,
  directory: bool
) -> Result<ExecutionResult> {
  check_cancelled(cancellation)?;
  let parent_ref = intent.parent.as_ref().context("parent is required")?;
  let parent = PathBuf::from(local_path(Some(parent_ref), "parent")?);
  let name = intent.name.as_deref().context("name is required")?;
  let destination = parent.join(name);

  if destination.exists() && resolution.is_none() {
    return Ok(ExecutionResult {
      status: OperationTaskStatus::WaitingConflict,
      message: Some("Waiting for conflict decision.".into()),
      affected_roots: affected_roots_for_intent(intent),
      entry_results: Vec::new(),
      undo_payload: None,
      conflict: Some(create_conflict_request(task_id, parent_ref.clone(), &destination)),
      continuation: None
    });
  }

  let decision = resolve_destination(&destination, resolution)?;
  if decision.skip {
    return Ok(success_execution(
      intent,
      vec![OperationEntryResult {
        entry_result_id: format!("{task_id}-0"),
        source: None,
        destination: Some(OperationPathRef::Local {
          path: destination.to_string_lossy().into_owned()
        }),
        kind: OperationEntryResultKind::Skipped,
        error: None
      }],
      Vec::new()
    ));
  }
  if decision.replace && decision.destination.exists() {
    bail!("replace is not supported for create operations");
  }

  let created = if directory {
    fs_service::create_directory(
      decision.destination.parent().unwrap_or(&parent),
      decision
        .destination
        .file_name()
        .and_then(|value| value.to_str())
        .context("invalid create directory name")?
    )?
  } else {
    fs_service::create_file(
      decision.destination.parent().unwrap_or(&parent),
      decision
        .destination
        .file_name()
        .and_then(|value| value.to_str())
        .context("invalid create file name")?
    )?
  };

  Ok(success_execution(
    intent,
    vec![OperationEntryResult {
      entry_result_id: format!("{task_id}-0"),
      source: None,
      destination: Some(OperationPathRef::Local {
        path: created.to_string_lossy().into_owned()
      }),
      kind: OperationEntryResultKind::Created,
      error: None
    }],
    vec![UndoAction::DeleteCreated { path: created }]
  ))
}

fn success_execution(
  intent: &OperationIntent,
  entry_results: Vec<OperationEntryResult>,
  undo_actions: Vec<UndoAction>
) -> ExecutionResult {
  ExecutionResult {
    status: OperationTaskStatus::Succeeded,
    message: Some("Operation completed.".into()),
    affected_roots: affected_roots_for_intent(intent),
    entry_results,
    undo_payload: (!undo_actions.is_empty()).then_some(UndoPayload {
      actions: undo_actions
    }),
    conflict: None,
    continuation: None
  }
}

struct DestinationDecision {
  destination: PathBuf,
  skip: bool,
  replace: bool,
  merge_directory: bool
}

fn resolve_destination(
  base_destination: &Path,
  resolution: Option<&OperationConflictResolution>
) -> Result<DestinationDecision> {
  let Some(resolution) = resolution else {
    return Ok(DestinationDecision {
      destination: base_destination.to_path_buf(),
      skip: false,
      replace: false,
      merge_directory: false
    });
  };

  match resolution.resolution {
    ConflictResolutionKind::Skip => Ok(DestinationDecision {
      destination: base_destination.to_path_buf(),
      skip: true,
      replace: false,
      merge_directory: false
    }),
    ConflictResolutionKind::KeepBoth => Ok(DestinationDecision {
      destination: fs_service::available_conflict_path(base_destination),
      skip: false,
      replace: false,
      merge_directory: false
    }),
    ConflictResolutionKind::Rename => {
      if resolution.apply_to_all {
        bail!("rename conflict resolution cannot be applied to all conflicts");
      }
      let new_name = resolution
        .new_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .context("newName is required for rename conflict resolution")?;
      Ok(DestinationDecision {
        destination: base_destination
          .parent()
          .unwrap_or_else(|| Path::new(""))
          .join(new_name),
        skip: false,
        replace: false,
        merge_directory: false
      })
    }
    ConflictResolutionKind::Replace => Ok(DestinationDecision {
      destination: base_destination.to_path_buf(),
      skip: false,
      replace: true,
      merge_directory: false
    }),
    ConflictResolutionKind::MergeDirectory => Ok(DestinationDecision {
      destination: base_destination.to_path_buf(),
      skip: false,
      replace: false,
      merge_directory: true
    })
  }
}

fn create_conflict_request(task_id: &str, source: OperationPathRef, destination: &Path) -> OperationConflictRequest {
  let existing_kind = entry_kind_snapshot(destination);
  let incoming_kind = source
    .local_path()
    .map(Path::new)
    .map(entry_kind_snapshot)
    .unwrap_or(OperationEntryKindSnapshot::Unknown);
  let suggested_name = fs_service::available_conflict_path(destination)
    .file_name()
    .and_then(|value| value.to_str())
    .map(|value| value.to_string());
  let mut allowed_resolutions = vec![
    ConflictResolutionKind::Replace,
    ConflictResolutionKind::Skip,
    ConflictResolutionKind::KeepBoth,
    ConflictResolutionKind::Rename
  ];
  if matches!(existing_kind, OperationEntryKindSnapshot::Directory)
    && matches!(incoming_kind, OperationEntryKindSnapshot::Directory)
  {
    allowed_resolutions.push(ConflictResolutionKind::MergeDirectory);
  }
  OperationConflictRequest {
    conflict_id: Uuid::new_v4().to_string(),
    task_id: task_id.into(),
    created_at: Utc::now(),
    source: Some(source),
    destination: OperationPathRef::Local {
      path: destination.to_string_lossy().into_owned()
    },
    existing_kind,
    incoming_kind,
    suggested_name,
    allowed_resolutions,
    message: format!("{} already exists.", destination.display())
  }
}

fn entry_kind_snapshot(path: &Path) -> OperationEntryKindSnapshot {
  match fs::symlink_metadata(path) {
    Ok(metadata) if metadata.is_dir() => OperationEntryKindSnapshot::Directory,
    Ok(metadata) if metadata.is_file() => OperationEntryKindSnapshot::File,
    _ => OperationEntryKindSnapshot::Unknown
  }
}

fn apply_undo_action(action: &UndoAction) -> Result<OperationEntryResult> {
  match action {
    UndoAction::DeleteCreated { path } => {
      remove_path(path)?;
      Ok(OperationEntryResult {
        entry_result_id: Uuid::new_v4().to_string(),
        source: Some(OperationPathRef::Local {
          path: path.to_string_lossy().into_owned()
        }),
        destination: None,
        kind: OperationEntryResultKind::Deleted,
        error: None
      })
    }
    UndoAction::RecreateDirectory { path } => {
      fs::create_dir_all(path).with_context(|| format!("failed to recreate directory {}", path.display()))?;
      Ok(OperationEntryResult {
        entry_result_id: Uuid::new_v4().to_string(),
        source: None,
        destination: Some(OperationPathRef::Local {
          path: path.to_string_lossy().into_owned()
        }),
        kind: OperationEntryResultKind::Created,
        error: None
      })
    }
    UndoAction::MoveBack { from, to } => {
      if to.exists() {
        bail!("cannot restore {}, destination already exists", to.display());
      }
      let cancellation = AtomicBool::new(false);
      move_entry_exact(from, to, &cancellation)?;
      Ok(OperationEntryResult {
        entry_result_id: Uuid::new_v4().to_string(),
        source: Some(OperationPathRef::Local {
          path: from.to_string_lossy().into_owned()
        }),
        destination: Some(OperationPathRef::Local {
          path: to.to_string_lossy().into_owned()
        }),
        kind: OperationEntryResultKind::Moved,
        error: None
      })
    }
    UndoAction::RestoreTrash {
      trash_path,
      original_path
    } => {
      if original_path.exists() {
        bail!("cannot restore {}, destination already exists", original_path.display());
      }
      let cancellation = AtomicBool::new(false);
      move_entry_exact(trash_path, original_path, &cancellation)?;
      Ok(OperationEntryResult {
        entry_result_id: Uuid::new_v4().to_string(),
        source: Some(OperationPathRef::Local {
          path: trash_path.to_string_lossy().into_owned()
        }),
        destination: Some(OperationPathRef::Local {
          path: original_path.to_string_lossy().into_owned()
        }),
        kind: OperationEntryResultKind::Moved,
        error: None
      })
    }
  }
}

fn remove_path(path: &Path) -> Result<()> {
  let metadata = fs::symlink_metadata(path).with_context(|| format!("failed to stat {}", path.display()))?;
  if metadata.is_dir() && !metadata.file_type().is_symlink() {
    fs::remove_dir_all(path).with_context(|| format!("failed to remove directory {}", path.display()))?;
  } else {
    fs::remove_file(path).with_context(|| format!("failed to remove file {}", path.display()))?;
  }
  Ok(())
}

fn check_cancelled(cancellation: &AtomicBool) -> Result<()> {
  if cancellation.load(Ordering::SeqCst) {
    bail!("operation cancelled");
  }
  Ok(())
}

fn cancelled_execution(
  intent: &OperationIntent,
  entry_results: Vec<OperationEntryResult>,
  undo_actions: Vec<UndoAction>
) -> ExecutionResult {
  ExecutionResult {
    status: OperationTaskStatus::Cancelled,
    message: Some("Operation cancelled.".into()),
    affected_roots: affected_roots_for_intent(intent),
    entry_results,
    undo_payload: (!undo_actions.is_empty()).then_some(UndoPayload {
      actions: undo_actions
    }),
    conflict: None,
    continuation: None
  }
}

fn copy_recursively_exact(source: &Path, destination: &Path, cancellation: &AtomicBool) -> Result<PathBuf> {
  check_cancelled(cancellation)?;
  let metadata = fs::symlink_metadata(source).with_context(|| format!("failed to stat {}", source.display()))?;
  if destination.exists() {
    bail!("destination already exists: {}", destination.display());
  }

  if metadata.is_dir() && !metadata.file_type().is_symlink() {
    fs::create_dir_all(destination).with_context(|| format!("failed to create directory {}", destination.display()))?;
    for entry in fs::read_dir(source).with_context(|| format!("failed to read {}", source.display()))? {
      check_cancelled(cancellation)?;
      let entry = entry.context("failed to read recursive directory entry")?;
      copy_recursively_exact(&entry.path(), &destination.join(entry.file_name()), cancellation)?;
    }
  } else {
    if let Some(parent) = destination.parent() {
      fs::create_dir_all(parent).with_context(|| format!("failed to create {}", parent.display()))?;
    }
    fs::copy(source, destination).with_context(|| {
      format!(
        "failed to copy {} to {}",
        source.display(),
        destination.display()
      )
    })?;
  }

  Ok(destination.to_path_buf())
}

fn merge_directory_exact(
  source: &Path,
  destination: &Path,
  move_source: bool,
  cancellation: &AtomicBool
) -> Result<Vec<UndoAction>> {
  check_cancelled(cancellation)?;
  let source_metadata = fs::symlink_metadata(source).with_context(|| format!("failed to stat {}", source.display()))?;
  let destination_metadata = fs::symlink_metadata(destination)
    .with_context(|| format!("failed to stat {}", destination.display()))?;
  if !source_metadata.is_dir()
    || source_metadata.file_type().is_symlink()
    || !destination_metadata.is_dir()
    || destination_metadata.file_type().is_symlink()
  {
    bail!("merge directory conflict resolution requires two real directories");
  }

  let mut undo_actions = Vec::new();
  for entry in fs::read_dir(source).with_context(|| format!("failed to read {}", source.display()))? {
    check_cancelled(cancellation)?;
    let entry = entry.context("failed to read merge directory entry")?;
    let source_child = entry.path();
    let destination_child = destination.join(entry.file_name());
    if destination_child.exists() {
      let source_child_metadata = fs::symlink_metadata(&source_child)
        .with_context(|| format!("failed to stat {}", source_child.display()))?;
      let destination_child_metadata = fs::symlink_metadata(&destination_child)
        .with_context(|| format!("failed to stat {}", destination_child.display()))?;
      if source_child_metadata.is_dir()
        && !source_child_metadata.file_type().is_symlink()
        && destination_child_metadata.is_dir()
        && !destination_child_metadata.file_type().is_symlink()
      {
        undo_actions.extend(merge_directory_exact(
          &source_child,
          &destination_child,
          move_source,
          cancellation
        )?);
        continue;
      }
      bail!("merge conflict requires another decision for {}", destination_child.display());
    }

    if move_source {
      let moved = move_entry_exact(&source_child, &destination_child, cancellation)?;
      undo_actions.push(UndoAction::MoveBack {
        from: moved,
        to: source_child
      });
    } else {
      let copied = copy_recursively_exact(&source_child, &destination_child, cancellation)?;
      undo_actions.push(UndoAction::DeleteCreated { path: copied });
    }
  }

  if move_source {
    fs::remove_dir(source).with_context(|| format!("failed to remove merged source directory {}", source.display()))?;
    undo_actions.push(UndoAction::RecreateDirectory {
      path: source.to_path_buf()
    });
  }

  Ok(undo_actions)
}

fn move_entry_exact(source: &Path, destination: &Path, cancellation: &AtomicBool) -> Result<PathBuf> {
  check_cancelled(cancellation)?;
  if destination.exists() {
    bail!("destination already exists: {}", destination.display());
  }

  match fs::rename(source, destination) {
    Ok(_) => Ok(destination.to_path_buf()),
    Err(_) => {
      let copied = copy_recursively_exact(source, destination, cancellation)?;
      remove_path(source)?;
      Ok(copied)
    }
  }
}

fn trash_destination(task_id: &str, app_data_dir: Option<&PathBuf>, source: &Path) -> Result<PathBuf> {
  let root = app_data_dir
    .cloned()
    .unwrap_or_else(|| std::env::temp_dir().join("SimpleFileManager"))
    .join("operation-trash")
    .join(task_id);
  fs::create_dir_all(&root).with_context(|| format!("failed to create trash root {}", root.display()))?;
  let file_name = source
    .file_name()
    .and_then(|value| value.to_str())
    .unwrap_or("entry");
  Ok(fs_service::available_conflict_path(&root.join(file_name)))
}

fn required_sources(intent: &OperationIntent) -> Result<&Vec<OperationPathRef>> {
  let sources = intent.sources.as_ref().context("sources are required")?;
  if sources.is_empty() {
    bail!("sources cannot be empty");
  }
  Ok(sources)
}

fn local_path<'a>(path_ref: Option<&'a OperationPathRef>, label: &str) -> Result<&'a str> {
  path_ref
    .and_then(OperationPathRef::local_path)
    .with_context(|| format!("{label} must be a local path"))
}

fn ensure_not_descendant(source: &Path, destination_root: &Path) -> Result<()> {
  let source = source.canonicalize().unwrap_or_else(|_| source.to_path_buf());
  let destination = destination_root
    .canonicalize()
    .unwrap_or_else(|_| destination_root.to_path_buf());
  if destination == source || destination.starts_with(&source) {
    bail!("cannot copy or move a directory into itself or its descendants");
  }
  Ok(())
}

fn failed_result(
  entry_result_id: String,
  path: Option<OperationPathRef>,
  source: OperationErrorSource,
  error: anyhow::Error
) -> OperationEntryResult {
  OperationEntryResult {
    entry_result_id,
    source: path.clone(),
    destination: None,
    kind: OperationEntryResultKind::Failed,
    error: Some(OperationError {
      code: OperationErrorCode::IoError,
      message: error.to_string(),
      path,
      retryable: false,
      source
    })
  }
}

fn operation_label(intent: &OperationIntent) -> String {
  match intent.kind {
    OperationIntentKind::Copy => format!("Copy {} item(s)", intent_entry_count(intent)),
    OperationIntentKind::Move => format!("Move {} item(s)", intent_entry_count(intent)),
    OperationIntentKind::Delete => format!("Delete {} item(s)", intent_entry_count(intent)),
    OperationIntentKind::Rename => "Rename item".into(),
    OperationIntentKind::CreateDirectory => "Create folder".into(),
    OperationIntentKind::CreateFile => "Create file".into(),
    OperationIntentKind::Undo => "Undo operation".into()
  }
}

fn intent_entry_count(intent: &OperationIntent) -> usize {
  match intent.kind {
    OperationIntentKind::Copy | OperationIntentKind::Move | OperationIntentKind::Delete => {
      intent.sources.as_ref().map(Vec::len).unwrap_or(0)
    }
    _ => 1
  }
}

fn intent_has_remote_path(intent: &OperationIntent) -> bool {
  intent
    .sources
    .as_ref()
    .map(|sources| sources.iter().any(|source| matches!(source, OperationPathRef::Remote { .. })))
    .unwrap_or(false)
    || matches!(intent.destination, Some(OperationPathRef::Remote { .. }))
    || matches!(intent.source_path, Some(OperationPathRef::Remote { .. }))
    || matches!(intent.parent, Some(OperationPathRef::Remote { .. }))
}

fn affected_roots_for_intent(intent: &OperationIntent) -> Vec<OperationPathRef> {
  let mut roots = Vec::new();
  if let Some(destination) = &intent.destination {
    roots.push(parent_ref(destination.clone()));
  }
  if let Some(parent) = &intent.parent {
    roots.push(parent.clone());
  }
  if let Some(source_path) = &intent.source_path {
    roots.push(parent_ref(source_path.clone()));
  }
  if let Some(sources) = &intent.sources {
    roots.extend(sources.iter().cloned().map(parent_ref));
  }
  dedupe_path_refs(roots)
}

fn parent_ref(path_ref: OperationPathRef) -> OperationPathRef {
  match path_ref {
    OperationPathRef::Local { path } => OperationPathRef::Local {
      path: Path::new(&path)
        .parent()
        .map(|parent| parent.to_string_lossy().into_owned())
        .unwrap_or(path)
    },
    OperationPathRef::Remote {
      profile_id,
      remote_path,
      protocol
    } => {
      let parent = remote_path
        .trim_end_matches('/')
        .rsplit_once('/')
        .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
        .unwrap_or("/");
      OperationPathRef::Remote {
        profile_id,
        remote_path: parent.into(),
        protocol
      }
    }
  }
}

fn dedupe_path_refs(paths: Vec<OperationPathRef>) -> Vec<OperationPathRef> {
  let mut seen = Vec::<String>::new();
  let mut result = Vec::new();
  for path in paths {
    let key = match &path {
      OperationPathRef::Local { path } => format!("local:{path}"),
      OperationPathRef::Remote {
        profile_id,
        remote_path,
        protocol
      } => format!("remote:{protocol:?}:{profile_id}:{remote_path}")
    };
    if seen.iter().any(|item| item == &key) {
      continue;
    }
    seen.push(key);
    result.push(path);
  }
  result
}

#[cfg(test)]
mod tests {
  use std::{
    fs,
    sync::atomic::Ordering,
    time::{SystemTime, UNIX_EPOCH}
  };

  use super::{execute_operation_task, execute_undo_task, OperationStore};
  use crate::domain::models::{
    ConflictResolutionKind, OperationConflictResolution, OperationIntent, OperationIntentKind, OperationPathRef,
    OperationHistoryStatus, OperationRequestSource, OperationTaskStatus
  };

  fn unique_temp_path(label: &str) -> std::path::PathBuf {
    let unique = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .expect("time went backwards")
      .as_nanos();
    std::env::temp_dir().join(format!("simplefilemanager-operation-{label}-{unique}"))
  }

  fn local(path: &std::path::Path) -> OperationPathRef {
    OperationPathRef::Local {
      path: path.to_string_lossy().into_owned()
    }
  }

  fn copy_intent(source: &std::path::Path, destination: &std::path::Path) -> OperationIntent {
    OperationIntent {
      request_id: "request-copy".into(),
      source: OperationRequestSource::Paste,
      panel_id: None,
      tab_id: None,
      kind: OperationIntentKind::Copy,
      sources: Some(vec![local(source)]),
      destination: Some(local(destination)),
      source_path: None,
      new_name: None,
      parent: None,
      name: None,
      undo_record_id: None,
      conflict_policy: None
    }
  }

  #[test]
  fn copy_operation_creates_history_and_undo_deletes_created_target() {
    let root = unique_temp_path("copy-undo");
    let source = root.join("source");
    let destination = root.join("destination");
    fs::create_dir_all(&source).expect("create source");
    fs::create_dir_all(&destination).expect("create destination");
    fs::write(source.join("report.txt"), "hello").expect("write source");

    let mut store = OperationStore::default();
    let result = store.start_operation(copy_intent(&source.join("report.txt"), &destination), Some(root.clone()));

    assert_eq!(result.snapshot.status, OperationTaskStatus::Succeeded);
    assert!(destination.join("report.txt").exists());
    assert_eq!(store.list_history().records.len(), 1);

    let undo = store
      .undo_latest("request-undo".into())
      .expect("undo latest copy");
    assert_eq!(undo.snapshot.status, OperationTaskStatus::Succeeded);
    assert!(!destination.join("report.txt").exists());

    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn preparing_undo_does_not_apply_file_changes_until_worker_finishes() {
    let root = unique_temp_path("undo-worker");
    let source = root.join("source");
    let destination = root.join("destination");
    fs::create_dir_all(&source).expect("create source");
    fs::create_dir_all(&destination).expect("create destination");
    fs::write(source.join("report.txt"), "hello").expect("write source");

    let mut store = OperationStore::default();
    let result = store.start_operation(copy_intent(&source.join("report.txt"), &destination), Some(root.clone()));
    assert_eq!(result.snapshot.status, OperationTaskStatus::Succeeded);
    assert!(destination.join("report.txt").exists());

    let (prepared, execution) = store
      .prepare_undo_latest("request-undo-worker".into())
      .expect("prepare latest undo");
    assert_eq!(prepared.snapshot.status, OperationTaskStatus::Running);
    assert!(destination.join("report.txt").exists());
    assert!(store
      .list_history()
      .records
      .iter()
      .any(|record| matches!(record.status, OperationHistoryStatus::Undoing)));

    let undo_result = execute_undo_task(execution);
    let finished = store
      .finish_undo_operation(undo_result)
      .expect("finish undo operation");

    assert_eq!(finished.snapshot.status, OperationTaskStatus::Succeeded);
    assert!(!destination.join("report.txt").exists());

    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn operation_journal_persists_history_and_undo_payloads() {
    let root = unique_temp_path("journal-roundtrip");
    let source = root.join("source");
    let destination = root.join("destination");
    fs::create_dir_all(&source).expect("create source");
    fs::create_dir_all(&destination).expect("create destination");
    fs::write(source.join("report.txt"), "hello").expect("write source");
    let journal_path = root.join("operation-journal.json");

    let mut store = OperationStore::load_from(journal_path.clone()).expect("load empty journal");
    let result = store.start_operation(copy_intent(&source.join("report.txt"), &destination), Some(root.clone()));

    assert_eq!(result.snapshot.status, OperationTaskStatus::Succeeded);
    assert!(journal_path.exists());
    assert_eq!(store.list_history().records.len(), 1);

    let mut reloaded = OperationStore::load_from(journal_path).expect("reload journal");
    assert_eq!(reloaded.list_history().records.len(), 1);

    let undo = reloaded
      .undo_latest("request-undo-after-reload".into())
      .expect("undo after reload");
    assert_eq!(undo.snapshot.status, OperationTaskStatus::Succeeded);
    assert!(!destination.join("report.txt").exists());

    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn operation_journal_load_tolerates_corrupt_file() {
    let root = unique_temp_path("journal-corrupt");
    fs::create_dir_all(&root).expect("create root");
    let journal_path = root.join("operation-journal.json");
    fs::write(&journal_path, "{not-json").expect("write corrupt journal");

    let store = OperationStore::load_from(journal_path.clone()).expect("corrupt journal should not block startup");

    assert!(store.list_history().records.is_empty());
    assert!(!journal_path.exists());
    assert!(
      fs::read_dir(&root)
        .expect("read root")
        .flatten()
        .any(|entry| entry.file_name().to_string_lossy().contains("corrupt"))
    );

    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn operation_journal_blocks_undo_when_trash_payload_is_missing_on_reload() {
    let root = unique_temp_path("journal-missing-trash");
    let source = root.join("source");
    fs::create_dir_all(&source).expect("create source");
    fs::write(source.join("report.txt"), "hello").expect("write source");
    let deleted_path = source.join("report.txt");
    let journal_path = root.join("operation-journal.json");

    let mut store = OperationStore::load_from(journal_path.clone()).expect("load journal");
    let result = store.start_operation(
      OperationIntent {
        request_id: "request-delete-missing-trash".into(),
        source: OperationRequestSource::Toolbar,
        panel_id: None,
        tab_id: None,
        kind: OperationIntentKind::Delete,
        sources: Some(vec![local(&deleted_path)]),
        destination: None,
        source_path: None,
        new_name: None,
        parent: None,
        name: None,
        undo_record_id: None,
        conflict_policy: None
      },
      Some(root.clone())
    );
    assert_eq!(result.snapshot.status, OperationTaskStatus::Succeeded);

    fs::remove_dir_all(root.join("operation-trash")).expect("remove trash payload");
    let reloaded = OperationStore::load_from(journal_path).expect("reload journal");
    let records = reloaded.list_history().records;

    assert_eq!(records.len(), 1);
    assert_eq!(records[0].status, OperationHistoryStatus::Blocked);
    assert!(records[0]
      .blocked_reason
      .as_deref()
      .unwrap_or_default()
      .contains("Trash payload is no longer available"));

    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn queued_operation_does_not_mutate_files_until_worker_executes() {
    let root = unique_temp_path("queued-worker");
    let source = root.join("source");
    let destination = root.join("destination");
    fs::create_dir_all(&source).expect("create source");
    fs::create_dir_all(&destination).expect("create destination");
    fs::write(source.join("report.txt"), "hello").expect("write source");

    let mut store = OperationStore::default();
    let intent = copy_intent(&source.join("report.txt"), &destination);
    let (queued, should_execute) = store.queue_operation(intent.clone());

    assert!(should_execute);
    assert_eq!(queued.snapshot.status, OperationTaskStatus::Queued);
    assert!(!destination.join("report.txt").exists());

    let running = store
      .mark_operation_running(&queued.snapshot.task_id)
      .expect("mark running");
    assert_eq!(running.snapshot.status, OperationTaskStatus::Running);

    let cancellation = store
      .operation_cancellation(&queued.snapshot.task_id)
      .expect("cancellation token");
    let execution = execute_operation_task(
      &queued.snapshot.task_id,
      &intent,
      Some(root.clone()),
      cancellation,
      None
    );
    let finished = store
      .finish_operation(&queued.snapshot.task_id, &intent, execution)
      .expect("finish operation");

    assert_eq!(finished.snapshot.status, OperationTaskStatus::Succeeded);
    assert!(destination.join("report.txt").exists());

    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn cancelling_running_operation_sets_token_and_prevents_pending_write() {
    let root = unique_temp_path("cancel-worker");
    let source = root.join("source");
    let destination = root.join("destination");
    fs::create_dir_all(&source).expect("create source");
    fs::create_dir_all(&destination).expect("create destination");
    fs::write(source.join("report.txt"), "hello").expect("write source");

    let mut store = OperationStore::default();
    let intent = copy_intent(&source.join("report.txt"), &destination);
    let (queued, should_execute) = store.queue_operation(intent.clone());
    assert!(should_execute);
    store
      .mark_operation_running(&queued.snapshot.task_id)
      .expect("mark running");
    let cancellation = store
      .operation_cancellation(&queued.snapshot.task_id)
      .expect("cancellation token");

    let cancelling = store
      .cancel_task(&queued.snapshot.task_id)
      .expect("cancel running task");
    assert_eq!(cancelling.snapshot.status, OperationTaskStatus::Cancelling);
    assert!(cancellation.load(Ordering::SeqCst));

    let execution = execute_operation_task(
      &queued.snapshot.task_id,
      &intent,
      Some(root.clone()),
      cancellation,
      None
    );
    let finished = store
      .finish_operation(&queued.snapshot.task_id, &intent, execution)
      .expect("finish cancelled operation");

    assert_eq!(finished.snapshot.status, OperationTaskStatus::Cancelled);
    assert!(!destination.join("report.txt").exists());

    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn delete_operation_uses_app_managed_trash_and_undo_restores_original() {
    let root = unique_temp_path("delete-undo");
    let source = root.join("source");
    fs::create_dir_all(&source).expect("create source");
    fs::write(source.join("report.txt"), "hello").expect("write source");
    let deleted_path = source.join("report.txt");

    let mut store = OperationStore::default();
    let result = store.start_operation(
      OperationIntent {
        request_id: "request-delete".into(),
        source: OperationRequestSource::Toolbar,
        panel_id: None,
        tab_id: None,
        kind: OperationIntentKind::Delete,
        sources: Some(vec![local(&deleted_path)]),
        destination: None,
        source_path: None,
        new_name: None,
        parent: None,
        name: None,
        undo_record_id: None,
        conflict_policy: None
      },
      Some(root.clone())
    );

    assert_eq!(result.snapshot.status, OperationTaskStatus::Succeeded);
    assert!(!deleted_path.exists());
    assert!(root.join("operation-trash").exists());

    let undo = store
      .undo_latest("request-delete-undo".into())
      .expect("undo latest delete");
    assert_eq!(undo.snapshot.status, OperationTaskStatus::Succeeded);
    assert_eq!(fs::read_to_string(deleted_path).expect("read restored"), "hello");

    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn copy_conflict_waits_for_resolution_and_keep_both_uses_numbered_destination() {
    let root = unique_temp_path("conflict");
    let source = root.join("source");
    let destination = root.join("destination");
    fs::create_dir_all(&source).expect("create source");
    fs::create_dir_all(&destination).expect("create destination");
    fs::write(source.join("report.txt"), "incoming").expect("write source");
    fs::write(destination.join("report.txt"), "existing").expect("write existing");

    let mut store = OperationStore::default();
    let result = store.start_operation(copy_intent(&source.join("report.txt"), &destination), Some(root.clone()));
    assert_eq!(result.snapshot.status, OperationTaskStatus::WaitingConflict);
    let conflict_id = result.conflict.expect("conflict request").conflict_id;

    let resolved = store
      .resolve_conflict(
        OperationConflictResolution {
          conflict_id,
          resolution: ConflictResolutionKind::KeepBoth,
          new_name: None,
          apply_to_all: true
        },
        Some(root.clone())
      )
      .expect("resolve conflict");

    assert_eq!(resolved.snapshot.status, OperationTaskStatus::Succeeded);
    assert_eq!(fs::read_to_string(destination.join("report.txt")).expect("read existing"), "existing");
    assert_eq!(fs::read_to_string(destination.join("report (1).txt")).expect("read copy"), "incoming");

    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn directory_conflict_allows_merge_directory_and_merges_children() {
    let root = unique_temp_path("conflict-merge-directory");
    let source = root.join("source");
    let destination = root.join("destination");
    fs::create_dir_all(source.join("docs")).expect("create source docs");
    fs::create_dir_all(destination.join("docs")).expect("create destination docs");
    fs::write(source.join("docs").join("incoming.txt"), "incoming").expect("write incoming");
    fs::write(destination.join("docs").join("existing.txt"), "existing").expect("write existing");

    let mut store = OperationStore::default();
    let result = store.start_operation(copy_intent(&source.join("docs"), &destination), Some(root.clone()));
    assert_eq!(result.snapshot.status, OperationTaskStatus::WaitingConflict);
    let conflict = result.conflict.expect("directory conflict request");
    assert!(conflict
      .allowed_resolutions
      .iter()
      .any(|resolution| matches!(resolution, ConflictResolutionKind::MergeDirectory)));

    let resolved = store
      .resolve_conflict(
        OperationConflictResolution {
          conflict_id: conflict.conflict_id,
          resolution: ConflictResolutionKind::MergeDirectory,
          new_name: None,
          apply_to_all: false
        },
        Some(root.clone())
      )
      .expect("merge directory conflict");

    assert_eq!(resolved.snapshot.status, OperationTaskStatus::Succeeded);
    assert_eq!(
      fs::read_to_string(destination.join("docs").join("existing.txt")).expect("read existing"),
      "existing"
    );
    assert_eq!(
      fs::read_to_string(destination.join("docs").join("incoming.txt")).expect("read incoming"),
      "incoming"
    );

    let undo = store.undo_latest("request-undo-merge".into()).expect("undo merge copy");
    assert_eq!(undo.snapshot.status, OperationTaskStatus::Succeeded);
    assert!(!destination.join("docs").join("incoming.txt").exists());
    assert!(destination.join("docs").join("existing.txt").exists());

    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn copy_conflict_without_apply_to_all_prompts_again_for_next_conflict() {
    let root = unique_temp_path("conflict-repeat");
    let source = root.join("source");
    let destination = root.join("destination");
    fs::create_dir_all(&source).expect("create source");
    fs::create_dir_all(&destination).expect("create destination");
    fs::write(source.join("a.txt"), "incoming-a").expect("write source a");
    fs::write(source.join("b.txt"), "incoming-b").expect("write source b");
    fs::write(destination.join("a.txt"), "existing-a").expect("write existing a");
    fs::write(destination.join("b.txt"), "existing-b").expect("write existing b");

    let mut store = OperationStore::default();
    let result = store.start_operation(
      OperationIntent {
        request_id: "request-copy-two-conflicts".into(),
        source: OperationRequestSource::Paste,
        panel_id: None,
        tab_id: None,
        kind: OperationIntentKind::Copy,
        sources: Some(vec![local(&source.join("a.txt")), local(&source.join("b.txt"))]),
        destination: Some(local(&destination)),
        source_path: None,
        new_name: None,
        parent: None,
        name: None,
        undo_record_id: None,
        conflict_policy: None
      },
      Some(root.clone())
    );
    assert_eq!(result.snapshot.status, OperationTaskStatus::WaitingConflict);
    let first_conflict_id = result.conflict.expect("first conflict").conflict_id;

    let second_wait = store
      .resolve_conflict(
        OperationConflictResolution {
          conflict_id: first_conflict_id,
          resolution: ConflictResolutionKind::KeepBoth,
          new_name: None,
          apply_to_all: false
        },
        Some(root.clone())
      )
      .expect("resolve first conflict");

    assert_eq!(second_wait.snapshot.status, OperationTaskStatus::WaitingConflict);
    assert_eq!(fs::read_to_string(destination.join("a (1).txt")).expect("read copied a"), "incoming-a");
    assert!(!destination.join("b (1).txt").exists());

    let second_conflict_id = second_wait.conflict.expect("second conflict").conflict_id;
    let resolved = store
      .resolve_conflict(
        OperationConflictResolution {
          conflict_id: second_conflict_id,
          resolution: ConflictResolutionKind::KeepBoth,
          new_name: None,
          apply_to_all: false
        },
        Some(root.clone())
      )
      .expect("resolve second conflict");

    assert_eq!(resolved.snapshot.status, OperationTaskStatus::Succeeded);
    assert_eq!(fs::read_to_string(destination.join("b (1).txt")).expect("read copied b"), "incoming-b");

    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn copy_conflict_apply_to_all_reuses_resolution_for_remaining_conflicts() {
    let root = unique_temp_path("conflict-apply-all");
    let source = root.join("source");
    let destination = root.join("destination");
    fs::create_dir_all(&source).expect("create source");
    fs::create_dir_all(&destination).expect("create destination");
    fs::write(source.join("a.txt"), "incoming-a").expect("write source a");
    fs::write(source.join("b.txt"), "incoming-b").expect("write source b");
    fs::write(destination.join("a.txt"), "existing-a").expect("write existing a");
    fs::write(destination.join("b.txt"), "existing-b").expect("write existing b");

    let mut store = OperationStore::default();
    let result = store.start_operation(
      OperationIntent {
        request_id: "request-copy-apply-all".into(),
        source: OperationRequestSource::Paste,
        panel_id: None,
        tab_id: None,
        kind: OperationIntentKind::Copy,
        sources: Some(vec![local(&source.join("a.txt")), local(&source.join("b.txt"))]),
        destination: Some(local(&destination)),
        source_path: None,
        new_name: None,
        parent: None,
        name: None,
        undo_record_id: None,
        conflict_policy: None
      },
      Some(root.clone())
    );
    assert_eq!(result.snapshot.status, OperationTaskStatus::WaitingConflict);
    let conflict_id = result.conflict.expect("conflict").conflict_id;

    let resolved = store
      .resolve_conflict(
        OperationConflictResolution {
          conflict_id,
          resolution: ConflictResolutionKind::KeepBoth,
          new_name: None,
          apply_to_all: true
        },
        Some(root.clone())
      )
      .expect("resolve all conflicts");

    assert_eq!(resolved.snapshot.status, OperationTaskStatus::Succeeded);
    assert_eq!(fs::read_to_string(destination.join("a (1).txt")).expect("read copied a"), "incoming-a");
    assert_eq!(fs::read_to_string(destination.join("b (1).txt")).expect("read copied b"), "incoming-b");

    let _ = fs::remove_dir_all(root);
  }
}

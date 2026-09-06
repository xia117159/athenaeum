use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum JournalPersistStep {
    TempWrite,
    BackupCopy,
    CommitReplace,
}

pub(super) fn journal_backup_path(file_path: &Path) -> PathBuf {
    file_path.with_extension("json.bak")
}

pub(super) fn recover_journal_path(file_path: &Path) -> Result<PathBuf> {
    if file_path.exists() {
        return Ok(file_path.to_path_buf());
    }
    let backup_path = journal_backup_path(file_path);
    if !backup_path.exists() {
        return Ok(file_path.to_path_buf());
    }
    match fs::rename(&backup_path, file_path) {
        Ok(()) => Ok(file_path.to_path_buf()),
        Err(_) if file_path.exists() => Ok(file_path.to_path_buf()),
        Err(_) => Ok(backup_path),
    }
}

fn fail_at(configured: Option<JournalPersistStep>, step: JournalPersistStep) -> Result<()> {
    if configured == Some(step) {
        bail!("injected operation journal {step:?} failure");
    }
    Ok(())
}

#[cfg(windows)]
fn replace_temp_file(temp_path: &Path, file_path: &Path, replacing: bool) -> Result<()> {
    if !replacing {
        return fs::rename(temp_path, file_path).context("failed to install operation journal");
    }
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH},
    };
    let replaced = file_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let replacement = temp_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    unsafe {
        ReplaceFileW(
            PCWSTR(replaced.as_ptr()),
            PCWSTR(replacement.as_ptr()),
            PCWSTR::null(),
            REPLACEFILE_WRITE_THROUGH,
            None,
            None,
        )
    }
    .context("failed to atomically replace operation journal")
}

#[cfg(not(windows))]
fn replace_temp_file(temp_path: &Path, file_path: &Path, _replacing: bool) -> Result<()> {
    fs::rename(temp_path, file_path).context("failed to atomically replace operation journal")
}

fn persist_journal_disk_inner(
    file_path: &Path,
    disk: &OperationJournalDisk,
    failure: Option<JournalPersistStep>,
) -> Result<()> {
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).context("failed to create operation journal directory")?;
    }

    let temp_path = file_path.with_extension(format!("json.tmp-{}", Uuid::new_v4()));
    let backup_path = journal_backup_path(file_path);
    let content =
        serde_json::to_vec_pretty(disk).context("failed to serialize operation journal")?;
    fail_at(failure, JournalPersistStep::TempWrite)?;
    let mut temp_file =
        File::create(&temp_path).context("failed to create operation journal temp file")?;
    if let Err(error) = temp_file
        .write_all(&content)
        .and_then(|_| temp_file.sync_all())
    {
        let _ = fs::remove_file(&temp_path);
        return Err(error).context("failed to write operation journal temp file");
    }
    drop(temp_file);
    let replacing = file_path.exists();
    if replacing {
        if let Err(error) = fail_at(failure, JournalPersistStep::BackupCopy).and_then(|_| {
            fs::copy(file_path, &backup_path)
                .map(|_| ())
                .context("failed to back up operation journal")
        }) {
            let _ = fs::remove_file(&temp_path);
            return Err(error);
        }
        if let Err(error) = OpenOptions::new()
            .write(true)
            .open(&backup_path)
            .and_then(|file| file.sync_all())
        {
            let _ = fs::remove_file(&temp_path);
            return Err(error).context("failed to sync operation journal backup");
        }
    }
    let commit = fail_at(failure, JournalPersistStep::CommitReplace)
        .and_then(|_| replace_temp_file(&temp_path, file_path, replacing));
    if let Err(error) = commit {
        let _ = fs::remove_file(&temp_path);
        return Err(error)
            .context("failed to commit operation journal; previous journal remains canonical");
    }
    if backup_path.exists() {
        let _ = fs::remove_file(backup_path);
    }
    Ok(())
}

pub(super) fn persist_journal_disk(file_path: &Path, disk: &OperationJournalDisk) -> Result<()> {
    persist_journal_disk_inner(file_path, disk, None)
}

#[cfg(test)]
pub(super) fn persist_journal_disk_with_failure(
    file_path: &Path,
    disk: &OperationJournalDisk,
    failure: JournalPersistStep,
) -> Result<()> {
    persist_journal_disk_inner(file_path, disk, Some(failure))
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

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn unique_temp_path(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time went backwards")
            .as_nanos();
        std::env::temp_dir().join(format!("athenaeum-journal-{label}-{unique}"))
    }

    #[test]
    fn failed_persist_stages_leave_the_previous_canonical_journal_readable() {
        for step in [
            JournalPersistStep::TempWrite,
            JournalPersistStep::BackupCopy,
            JournalPersistStep::CommitReplace,
        ] {
            let root = unique_temp_path("stage-failure");
            let file_path = root.join("operation-journal.json");
            let previous = OperationJournalDisk {
                history_sequence: 11,
                ..OperationJournalDisk::default()
            };
            let replacement = OperationJournalDisk {
                history_sequence: 12,
                ..OperationJournalDisk::default()
            };
            persist_journal_disk(&file_path, &previous).expect("persist previous journal");

            let error = persist_journal_disk_with_failure(&file_path, &replacement, step);

            assert!(error.is_err(), "{step:?} must report failure");
            let canonical: OperationJournalDisk = serde_json::from_str(
                &fs::read_to_string(&file_path).expect("previous canonical journal remains"),
            )
            .expect("previous canonical journal remains valid");
            assert_eq!(canonical.history_sequence, previous.history_sequence);
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn missing_canonical_journal_recovers_from_the_stable_backup() {
        let root = unique_temp_path("backup-recovery");
        let file_path = root.join("operation-journal.json");
        let backup_path = journal_backup_path(&file_path);
        let previous = OperationJournalDisk {
            history_sequence: 21,
            ..OperationJournalDisk::default()
        };
        persist_journal_disk(&file_path, &previous).expect("persist journal");
        fs::rename(&file_path, &backup_path).expect("simulate interrupted replacement");

        let recovered_path = recover_journal_path(&file_path).expect("recover journal path");

        let recovered: OperationJournalDisk = serde_json::from_str(
            &fs::read_to_string(recovered_path).expect("read recovered journal"),
        )
        .expect("parse recovered journal");
        assert_eq!(recovered.history_sequence, previous.history_sequence);
        let _ = fs::remove_dir_all(root);
    }
}

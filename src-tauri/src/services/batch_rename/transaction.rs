use super::{
    native::{self, FileIdentity},
    plan::RenamePlan,
};
use anyhow::Result;
use chrono::{DateTime, FixedOffset, Utc};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};
use uuid::Uuid;
pub mod recovery;
#[cfg(windows)]
mod runner;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Forward,
    Undo,
    Recovery,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchEntry {
    pub original_path: PathBuf,
    pub current_path: PathBuf,
    pub target_name: String,
    pub identity: FileIdentity,
    pub parent_identity: FileIdentity,
    pub is_directory: bool,
    /// The last mutation did not establish an unambiguous object identity.
    pub identity_uncertain: bool,
    /// A known identity could not be verified at its path on the last reload.
    #[serde(default)]
    pub identity_unavailable: bool,
    pub expected_modified: Option<DateTime<FixedOffset>>,
    pub expected_length: u64,
}

impl BatchEntry {
    pub fn identity_unknown(&self) -> bool {
        self.identity_uncertain || self.identity_unavailable
    }
    pub fn verify_identity(&mut self) {
        self.identity_unavailable = !native::snapshot(&self.current_path).is_ok_and(|actual| {
            actual.identity == self.identity
                && actual.parent_identity == self.parent_identity
                && actual.path == self.current_path
        });
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchPayload {
    pub version: u32,
    pub batch_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub attempt_task_id: String,
    pub direction: Direction,
    pub created_at: DateTime<Utc>,
    pub entries: Vec<BatchEntry>,
    pub pending_recovery: bool,
    pub committed_attempts: Vec<String>,
    pub log_attempts: Vec<String>,
    #[serde(default)]
    pub recovery_diagnostic: Option<String>,
    #[serde(default)]
    pub step_count: u64,
    #[serde(skip)]
    pub current_entry: Option<usize>,
}

impl BatchPayload {
    pub fn forward(plan: &RenamePlan, task_id: &str, batch_id: &str) -> Self {
        let attempt_id = Uuid::new_v4().to_string();
        Self {
            version: 1,
            batch_id: batch_id.into(),
            task_id: task_id.into(),
            attempt_task_id: task_id.into(),
            log_attempts: vec![attempt_id.clone()],
            attempt_id,
            direction: Direction::Forward,
            created_at: Utc::now(),
            pending_recovery: false,
            committed_attempts: Vec::new(),
            recovery_diagnostic: None,
            step_count: 0,
            current_entry: None,
            entries: plan
                .items
                .iter()
                .map(|item| BatchEntry {
                    original_path: item.snapshot.path.clone(),
                    current_path: item.snapshot.path.clone(),
                    target_name: item.target_name.clone(),
                    identity: item.snapshot.identity.clone(),
                    parent_identity: item.snapshot.parent_identity.clone(),
                    is_directory: item.snapshot.is_directory,
                    identity_uncertain: false,
                    identity_unavailable: false,
                    expected_modified: item.snapshot.modified,
                    expected_length: item.snapshot.length,
                })
                .collect(),
        }
    }
    pub fn for_undo(mut self, task_id: &str) -> Self {
        self.attempt_id = Uuid::new_v4().to_string();
        self.attempt_task_id = task_id.into();
        self.log_attempts.push(self.attempt_id.clone());
        self.direction = if self.pending_recovery {
            Direction::Recovery
        } else {
            Direction::Undo
        };
        self.step_count = 0;
        self.current_entry = None;
        for entry in &mut self.entries {
            entry.target_name = native::name_of(&entry.original_path)
                .unwrap_or_default()
                .into();
        }
        self
    }
    pub fn identity_unknown(&self) -> bool {
        self.recovery_diagnostic.is_some() || self.entries.iter().any(BatchEntry::identity_unknown)
    }
    fn moved(
        &mut self,
        index: usize,
        from: &Path,
        to: &Path,
        identity: Option<FileIdentity>,
    ) -> Result<()> {
        let is_directory = self
            .entries
            .get(index)
            .ok_or_else(|| anyhow::anyhow!("无效恢复条目"))?
            .is_directory;
        for (other_index, entry) in self.entries.iter_mut().enumerate() {
            if is_directory {
                if entry
                    .current_path
                    .parent()
                    .is_some_and(|parent| native::path_eq(parent, from))
                {
                    if let Some(identity) = &identity {
                        entry.parent_identity = identity.clone();
                    } else {
                        entry.identity_uncertain = true;
                    }
                }
                entry.current_path = native::rewrite_descendant(&entry.current_path, from, to);
            } else if other_index == index {
                entry.current_path = to.to_path_buf();
            }
        }
        let entry = &mut self.entries[index];
        if let Some(identity) = identity {
            entry.identity = identity;
            entry.identity_uncertain = false;
            entry.identity_unavailable = false;
        } else {
            entry.identity_uncertain = true;
        }
        self.step_count += 1;
        self.current_entry = Some(index);
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Checkpoint {
    Prepared,
    BeforePending,
    BeforeRename,
    AfterRename,
    AfterApplied,
    BeforeCommit,
    BeforeRollback,
}
pub type Observer<'a> = dyn FnMut(Checkpoint, &BatchPayload) -> Result<()> + 'a;

pub struct BatchRunOutcome {
    pub payload: BatchPayload,
    pub committed: bool,
    pub restored: bool,
    pub cancelled: bool,
    pub error: Option<String>,
    pub cleanup_warning: Option<String>,
}

pub fn run(
    payload: BatchPayload,
    log_root: &Path,
    cancelled: &AtomicBool,
    commit: &mut dyn FnMut(&BatchPayload) -> Result<()>,
    observer: &mut Observer<'_>,
) -> BatchRunOutcome {
    #[cfg(windows)]
    {
        runner::run(payload, log_root, cancelled, commit, observer)
    }
    #[cfg(not(windows))]
    {
        let _ = (log_root, cancelled, commit, observer);
        BatchRunOutcome {
            payload,
            committed: false,
            restored: true,
            cancelled: false,
            error: Some("此平台不支持安全批量重命名".into()),
            cleanup_warning: None,
        }
    }
}

#[cfg(all(test, windows))]
mod tests;

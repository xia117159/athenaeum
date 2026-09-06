use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    fs,
    io::ErrorKind,
    path::{Component, Path, PathBuf},
};

use anyhow::Result;

use crate::domain::models::{
    OperationClearOutcome, OperationClearRequest, OperationClearScope, OperationClearStatus,
    OperationHistoryRecord, OperationHistoryStatus, OperationTaskSnapshot, OperationTaskStatus,
};

use super::{journal::OperationJournalDisk, OperationStore, UndoAction, UndoPayload};

mod artifact;
#[cfg(test)]
mod batch_tests;
#[cfg(test)]
mod identity_tests;

pub(super) use artifact::restore_trash_paths;
use artifact::{is_strict_descendant, normalized_components, VerifiedCleanupRoot};
use artifact::{InspectedPathIdentity, PathIdentityBarrier};

#[cfg(test)]
thread_local! {
    static CLEANUP_BEFORE_CANDIDATE_HOOK: std::cell::RefCell<Option<Box<dyn FnMut(&Path)>>> =
        std::cell::RefCell::new(None);
    static CLEANUP_PREFLIGHT_METADATA_FAILURE: std::cell::RefCell<Option<PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn set_cleanup_before_candidate_hook(hook: Option<Box<dyn FnMut(&Path)>>) {
    CLEANUP_BEFORE_CANDIDATE_HOOK.with(|current| *current.borrow_mut() = hook);
}

#[cfg(test)]
fn run_cleanup_before_candidate_hook(candidate: &Path) {
    CLEANUP_BEFORE_CANDIDATE_HOOK.with(|current| {
        if let Some(hook) = current.borrow_mut().as_mut() {
            hook(candidate);
        }
    });
}

#[cfg(test)]
fn set_cleanup_preflight_metadata_failure(path: Option<PathBuf>) {
    CLEANUP_PREFLIGHT_METADATA_FAILURE.with(|current| *current.borrow_mut() = path);
}

fn cleanup_preflight_metadata(path: &Path) -> std::io::Result<fs::Metadata> {
    #[cfg(test)]
    if CLEANUP_PREFLIGHT_METADATA_FAILURE.with(|current| current.borrow().as_deref() == Some(path))
    {
        return Err(std::io::Error::new(
            ErrorKind::PermissionDenied,
            "injected cleanup preflight metadata failure",
        ));
    }
    fs::symlink_metadata(path)
}

const MAX_CLEANUP_WARNINGS: usize = 20;

fn retain_cleanup_warning(warnings: &mut Vec<String>, omitted: &mut usize, warning: String) {
    if warnings.len() < MAX_CLEANUP_WARNINGS - 1 {
        warnings.push(warning);
    } else {
        *omitted += 1;
    }
}

#[cfg(windows)]
fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn unlink_link(path: &Path, metadata: &fs::Metadata) -> std::io::Result<()> {
    if metadata.is_dir() {
        fs::remove_dir(path)
    } else {
        fs::remove_file(path)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntryType {
    Directory,
    File,
    LinkOrReparse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CleanupCandidateOutcome {
    Removed,
    AlreadyAbsent,
    DisappearedAfterPlanning,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    entry_type: EntryType,
    #[cfg(windows)]
    volume_serial_number: u32,
    #[cfg(windows)]
    file_index: u64,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(not(any(windows, unix)))]
    length: u64,
}

fn entry_type(metadata: &fs::Metadata) -> EntryType {
    if is_link_or_reparse(metadata) {
        EntryType::LinkOrReparse
    } else if metadata.is_dir() {
        EntryType::Directory
    } else {
        EntryType::File
    }
}

#[cfg(windows)]
fn file_identity(path: &Path, metadata: &fs::Metadata) -> Option<FileIdentity> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::CloseHandle,
            Storage::FileSystem::{
                CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
                FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
                FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
            },
        },
    };

    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            FILE_READ_ATTRIBUTES.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            None,
        )
        .ok()?
    };
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    let inspected = unsafe { GetFileInformationByHandle(handle, &mut information) }.is_ok();
    let _ = unsafe { CloseHandle(handle) };
    inspected.then_some(FileIdentity {
        entry_type: entry_type(metadata),
        volume_serial_number: information.dwVolumeSerialNumber,
        file_index: ((information.nFileIndexHigh as u64) << 32) | information.nFileIndexLow as u64,
    })
}

#[cfg(unix)]
fn file_identity(_path: &Path, metadata: &fs::Metadata) -> Option<FileIdentity> {
    use std::os::unix::fs::MetadataExt;
    Some(FileIdentity {
        entry_type: entry_type(metadata),
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(not(any(windows, unix)))]
fn file_identity(_path: &Path, metadata: &fs::Metadata) -> Option<FileIdentity> {
    Some(FileIdentity {
        entry_type: entry_type(metadata),
        length: metadata.len(),
    })
}

fn inspect_identity(path: &Path) -> Result<FileIdentity, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        format!(
            "cleanup path changed while inspecting {}: {error}",
            path.display()
        )
    })?;
    file_identity(path, &metadata)
        .ok_or_else(|| format!("cannot determine cleanup path identity: {}", path.display()))
}

fn remove_tree_no_follow(
    path: &Path,
    expected_identity: Option<&FileIdentity>,
    before_child_remove: &mut impl FnMut(&Path),
) -> std::io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if expected_identity
        .is_some_and(|expected| file_identity(path, &metadata).as_ref() != Some(expected))
    {
        return Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "cleanup path identity changed before removal",
        ));
    }
    if is_link_or_reparse(&metadata) {
        return unlink_link(path, &metadata);
    }
    if !metadata.is_dir() {
        return fs::remove_file(path);
    }
    for entry in fs::read_dir(path)? {
        let child = entry?.path();
        let metadata = fs::symlink_metadata(&child)?;
        let identity = file_identity(&child, &metadata).ok_or_else(|| {
            std::io::Error::new(
                ErrorKind::InvalidData,
                format!(
                    "cannot determine cleanup path identity: {}",
                    child.display()
                ),
            )
        })?;
        before_child_remove(&child);
        remove_tree_no_follow(&child, Some(&identity), before_child_remove)?;
    }
    fs::remove_dir(path)
}

#[cfg(test)]
fn cleanup_candidate(root: &Path, candidate: &Path) -> Result<CleanupCandidateOutcome, String> {
    cleanup_candidate_with_protected(root, candidate, &[], None)
}

fn cleanup_candidate_with_protected(
    root: &Path,
    candidate: &Path,
    protected: &[InspectedPathIdentity],
    expected: Option<&InspectedPathIdentity>,
) -> Result<CleanupCandidateOutcome, String> {
    cleanup_candidate_with_hooks(root, candidate, protected, expected, || {}, |_| {})
}

#[cfg(test)]
fn cleanup_candidate_with_hook(
    root: &Path,
    candidate: &Path,
    before_remove: impl FnOnce(),
) -> Result<CleanupCandidateOutcome, String> {
    cleanup_candidate_with_hooks(root, candidate, &[], None, before_remove, |_| {})
}

fn cleanup_candidate_with_hooks(
    root: &Path,
    candidate: &Path,
    protected: &[InspectedPathIdentity],
    expected: Option<&InspectedPathIdentity>,
    before_remove: impl FnOnce(),
    mut before_child_remove: impl FnMut(&Path),
) -> Result<CleanupCandidateOutcome, String> {
    let root_parts = normalized_components(root)
        .ok_or_else(|| format!("unsafe operation-trash root: {}", root.display()))?;
    let candidate_parts = normalized_components(candidate)
        .ok_or_else(|| format!("unsafe operation-trash path: {}", candidate.display()))?;
    if !is_strict_descendant(&root_parts, &candidate_parts) {
        return Err(format!(
            "path is not an owned operation-trash descendant: {}",
            candidate.display()
        ));
    }
    let root_metadata = fs::symlink_metadata(root).map_err(|error| {
        format!(
            "cannot inspect operation-trash root {}: {error}",
            root.display()
        )
    })?;
    if !root_metadata.is_dir() || is_link_or_reparse(&root_metadata) {
        return Err(format!(
            "operation-trash root is not an ordinary directory: {}",
            root.display()
        ));
    }
    let candidate_identity = match fs::symlink_metadata(candidate) {
        Ok(metadata) => file_identity(candidate, &metadata).ok_or_else(|| {
            format!(
                "cannot determine cleanup path identity: {}",
                candidate.display()
            )
        })?,
        Err(error) if error.kind() == ErrorKind::NotFound && expected.is_none() => {
            return Ok(CleanupCandidateOutcome::AlreadyAbsent)
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Ok(CleanupCandidateOutcome::DisappearedAfterPlanning)
        }
        Err(error) => {
            return Err(format!(
                "cannot inspect cleanup path {}: {error}",
                candidate.display()
            ))
        }
    };
    let mut current = root.to_path_buf();
    let mut inspected = vec![(current.clone(), inspect_identity(&current)?)];
    let suffix = candidate
        .components()
        .skip(root_parts.len())
        .collect::<Vec<_>>();
    for (index, component) in suffix.iter().enumerate() {
        let Component::Normal(value) = component else {
            return Err(format!(
                "unsafe cleanup component in {}",
                candidate.display()
            ));
        };
        current.push(value);
        let metadata = fs::symlink_metadata(&current).map_err(|error| {
            format!(
                "cleanup path changed while inspecting {}: {error}",
                current.display()
            )
        })?;
        if index + 1 < suffix.len() && is_link_or_reparse(&metadata) {
            return Err(format!(
                "cleanup path crosses a link or reparse point: {}",
                current.display()
            ));
        }
        let identity = file_identity(&current, &metadata).ok_or_else(|| {
            format!(
                "cannot determine cleanup path identity: {}",
                current.display()
            )
        })?;
        inspected.push((current.clone(), identity));
    }
    if inspected.last().map(|(_, identity)| identity) != Some(&candidate_identity) {
        return Err(format!(
            "cleanup path identity changed while inspecting {}",
            candidate.display()
        ));
    }
    let inspected_identity = InspectedPathIdentity::from_chain(
        candidate,
        inspected.iter().map(|(_, identity)| *identity).collect(),
    )
    .ok_or_else(|| {
        format!(
            "cannot determine cleanup directory entry identity: {}",
            candidate.display()
        )
    })?;
    if expected.is_some_and(|expected| inspected_identity != *expected) {
        return Err(format!(
            "cleanup path identity changed since planning: {}",
            candidate.display()
        ));
    }
    if protected
        .iter()
        .any(|identity| inspected_identity.overlaps(identity))
    {
        return Err(format!(
            "operation-trash artifact is still required by another undo: {}",
            candidate.display()
        ));
    }
    before_remove();
    for (path, identity) in &inspected {
        if inspect_identity(path)? != *identity {
            return Err(format!(
                "cleanup path identity changed before removal: {}",
                path.display()
            ));
        }
    }
    remove_tree_no_follow(
        &current,
        Some(&candidate_identity),
        &mut before_child_remove,
    )
    .map_err(|error| {
        format!(
            "cannot remove operation-trash artifact {}: {error}",
            candidate.display()
        )
    })?;
    Ok(CleanupCandidateOutcome::Removed)
}

fn is_terminal(status: &OperationTaskStatus) -> bool {
    matches!(
        status,
        OperationTaskStatus::Succeeded
            | OperationTaskStatus::Failed
            | OperationTaskStatus::PartialSucceeded
            | OperationTaskStatus::Cancelled
    )
}

fn history_matches_scope(scope: &OperationClearScope, status: &OperationHistoryStatus) -> bool {
    match scope {
        OperationClearScope::Problems => matches!(status, OperationHistoryStatus::Failed),
        OperationClearScope::History | OperationClearScope::All => true,
        OperationClearScope::Completed => false,
    }
}

impl OperationStore {
    pub fn clear_records(
        &mut self,
        request: OperationClearRequest,
        operation_trash_root: Option<&Path>,
    ) -> Result<OperationClearOutcome> {
        let all_protected = self.protected_history_record_ids();
        let protected = self
            .history
            .iter()
            .filter(|record| {
                all_protected.contains(&record.record_id)
                    && history_matches_scope(&request.scope, &record.status)
            })
            .map(|record| record.record_id.clone())
            .collect::<HashSet<_>>();
        let remove_history = |record: &&OperationHistoryRecord| {
            !all_protected.contains(&record.record_id)
                && history_matches_scope(&request.scope, &record.status)
        };
        let removed_history = self
            .history
            .iter()
            .filter(remove_history)
            .cloned()
            .collect::<Vec<_>>();
        let undoable_count = removed_history
            .iter()
            .filter(|record| matches!(record.status, OperationHistoryStatus::Undoable))
            .count();
        if undoable_count > 0 && !request.confirm_undo_loss {
            return Ok(self.confirmation_required(undoable_count, protected));
        }

        let remove_task = |task: &&OperationTaskSnapshot| match request.scope {
            OperationClearScope::Problems => matches!(
                task.status,
                OperationTaskStatus::Failed | OperationTaskStatus::PartialSucceeded
            ),
            OperationClearScope::Completed | OperationClearScope::All => is_terminal(&task.status),
            OperationClearScope::History => false,
        };
        let removed_task_ids = self
            .tasks
            .iter()
            .filter(remove_task)
            .map(|task| task.task_id.clone())
            .collect::<Vec<_>>();
        let removed_record_ids = removed_history
            .iter()
            .map(|record| record.record_id.clone())
            .collect::<Vec<_>>();
        let removed_tasks = removed_task_ids.iter().cloned().collect::<HashSet<_>>();
        let removed_records = removed_record_ids.iter().cloned().collect::<HashSet<_>>();
        let tasks = self
            .tasks
            .iter()
            .filter(|task| !removed_tasks.contains(&task.task_id))
            .cloned()
            .collect();
        let history: Vec<_> = self
            .history
            .iter()
            .filter(|record| !removed_records.contains(&record.record_id))
            .cloned()
            .collect();
        let mut request_to_task = self.request_to_task.clone();
        request_to_task.retain(|_, task_id| !removed_tasks.contains(task_id));
        let removed_payloads = removed_record_ids
            .iter()
            .filter_map(|id| self.undo_payloads.get(id).cloned())
            .collect::<Vec<_>>();
        let mut undo_payloads = self.undo_payloads.clone();
        undo_payloads.retain(|id, _| !removed_records.contains(id));
        let task_watermark = self.task_sequence + u64::from(!removed_task_ids.is_empty());
        let history_watermark = self.history_sequence + u64::from(!removed_record_ids.is_empty());

        if !removed_record_ids.is_empty() {
            self.persist_journal_disk(&OperationJournalDisk {
                history: history.clone(),
                history_sequence: history_watermark,
                undo_payloads: undo_payloads.clone(),
            })?;
        }
        self.tasks = tasks;
        self.history = history;
        self.request_to_task = request_to_task;
        self.undo_payloads = undo_payloads;
        self.task_sequence = task_watermark;
        self.history_sequence = history_watermark;

        let warnings = self.cleanup_removed_payloads(removed_payloads, operation_trash_root);
        let mut protected_record_ids = protected.into_iter().collect::<Vec<_>>();
        protected_record_ids.sort();
        Ok(OperationClearOutcome {
            status: OperationClearStatus::Cleared,
            eligible_undoable_count: undoable_count,
            removed_task_ids,
            removed_record_ids,
            task_clear_watermark: task_watermark,
            history_clear_watermark: history_watermark,
            protected_record_ids,
            cleanup_warnings: warnings,
        })
    }

    fn protected_history_record_ids(&self) -> HashSet<String> {
        self.history
            .iter()
            .filter(|record| {
                matches!(
                    record.status,
                    OperationHistoryStatus::Undoing | OperationHistoryStatus::PendingConfirmation
                ) || record.undo_task_id.as_ref().is_some_and(|id| {
                    self.tasks
                        .iter()
                        .any(|task| task.task_id == *id && !is_terminal(&task.status))
                })
            })
            .map(|record| record.record_id.clone())
            .collect()
    }

    fn confirmation_required(
        &self,
        count: usize,
        protected: HashSet<String>,
    ) -> OperationClearOutcome {
        OperationClearOutcome {
            status: OperationClearStatus::ConfirmationRequired,
            eligible_undoable_count: count,
            removed_task_ids: Vec::new(),
            removed_record_ids: Vec::new(),
            task_clear_watermark: self.task_sequence,
            history_clear_watermark: self.history_sequence,
            protected_record_ids: protected.into_iter().collect(),
            cleanup_warnings: Vec::new(),
        }
    }

    fn cleanup_removed_payloads(
        &self,
        payloads: Vec<UndoPayload>,
        root: Option<&Path>,
    ) -> Vec<String> {
        let candidates = payloads
            .iter()
            .flat_map(restore_trash_paths)
            .collect::<Vec<_>>();
        if candidates.is_empty() {
            return Vec::new();
        }
        let Some(root) = root else {
            return vec![
                "operation-trash root is unavailable; physical cleanup was skipped".into(),
            ];
        };
        let verified_root = match VerifiedCleanupRoot::new(root) {
            Ok(verified) => verified,
            Err(warning) => return vec![warning],
        };
        let root_parts = verified_root.components();
        let protected = self
            .undo_payloads
            .values()
            .flat_map(restore_trash_paths)
            .chain(self.in_flight_undo_paths.values().flatten().cloned())
            .map(|path| InspectedPathIdentity::inspect(root_parts, root, &path))
            .collect::<std::result::Result<Vec<_>, _>>()
            .ok();
        let mut unique = HashMap::<Vec<OsString>, PathBuf>::new();
        let mut warnings = Vec::new();
        let mut omitted_warnings = 0;
        for candidate in candidates {
            match normalized_components(&candidate) {
                Some(key) => {
                    unique.entry(key).or_insert(candidate);
                }
                None => retain_cleanup_warning(
                    &mut warnings,
                    &mut omitted_warnings,
                    format!("unsafe operation-trash path: {}", candidate.display()),
                ),
            }
        }
        let mut planned = Vec::new();
        let mut planning_barriers = Vec::<PathIdentityBarrier>::new();
        let mut abort_planning = false;
        for (key, candidate) in unique {
            if !is_strict_descendant(root_parts, &key) {
                retain_cleanup_warning(
                    &mut warnings,
                    &mut omitted_warnings,
                    format!(
                        "path is not an owned operation-trash descendant: {}",
                        candidate.display()
                    ),
                );
                continue;
            }
            match cleanup_preflight_metadata(&candidate) {
                Err(error) if error.kind() == ErrorKind::NotFound => continue,
                Err(error) => {
                    retain_cleanup_warning(
                        &mut warnings,
                        &mut omitted_warnings,
                        format!(
                            "cannot inspect cleanup path {}: {error}",
                            candidate.display()
                        ),
                    );
                    abort_planning = true;
                    continue;
                }
                Ok(_) => {}
            }
            let identity = match InspectedPathIdentity::inspect(root_parts, root, &candidate) {
                Ok(identity) => identity,
                Err(failure) => {
                    retain_cleanup_warning(
                        &mut warnings,
                        &mut omitted_warnings,
                        format!("cannot safely plan cleanup path: {}", candidate.display()),
                    );
                    match failure.into_barrier() {
                        Some(barrier) => planning_barriers.push(barrier),
                        None => abort_planning = true,
                    }
                    continue;
                }
            };
            planned.push((key, candidate, identity));
        }
        planned.sort_by(|(left, _, _), (right, _, _)| right.len().cmp(&left.len()));
        if abort_planning {
            planned.clear();
        } else if let Err(warning) = verified_root.ensure_current(root) {
            retain_cleanup_warning(&mut warnings, &mut omitted_warnings, warning);
            planned.clear();
        }
        let mut failed_identities = planning_barriers;
        let mut completed_identities = Vec::<InspectedPathIdentity>::new();
        for (_, candidate, identity) in planned {
            if let Err(warning) = verified_root.ensure_current(root) {
                retain_cleanup_warning(&mut warnings, &mut omitted_warnings, warning);
                break;
            }
            let Some(protected) = protected.as_deref() else {
                retain_cleanup_warning(
                    &mut warnings,
                    &mut omitted_warnings,
                    format!(
                        "operation-trash artifact is still required by another undo: {}",
                        candidate.display()
                    ),
                );
                continue;
            };
            if failed_identities
                .iter()
                .any(|failed| failed.overlaps(&identity))
            {
                retain_cleanup_warning(
                    &mut warnings,
                    &mut omitted_warnings,
                    format!(
                        "operation-trash artifact overlaps an earlier failed cleanup: {}",
                        candidate.display()
                    ),
                );
                continue;
            }
            #[cfg(test)]
            run_cleanup_before_candidate_hook(&candidate);
            match cleanup_candidate_with_protected(root, &candidate, protected, Some(&identity)) {
                Ok(CleanupCandidateOutcome::Removed) => completed_identities.push(identity),
                Ok(CleanupCandidateOutcome::AlreadyAbsent) => {}
                Ok(CleanupCandidateOutcome::DisappearedAfterPlanning)
                    if completed_identities
                        .iter()
                        .any(|completed| completed.same_entry(&identity)) => {}
                Ok(CleanupCandidateOutcome::DisappearedAfterPlanning) => {
                    failed_identities.push(identity.into());
                    retain_cleanup_warning(
                        &mut warnings,
                        &mut omitted_warnings,
                        format!(
                            "cleanup path disappeared since planning: {}",
                            candidate.display()
                        ),
                    );
                }
                Err(warning) => {
                    failed_identities.push(identity.into());
                    retain_cleanup_warning(&mut warnings, &mut omitted_warnings, warning);
                }
            }
        }
        if omitted_warnings > 0 {
            warnings.push(format!(
                "{omitted_warnings} additional cleanup warnings omitted"
            ));
        }
        warnings
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;
    use crate::domain::models::{
        OperationClearRequest, OperationClearScope, OperationClearStatus, OperationHistoryRecord,
        OperationHistoryStatus, OperationIntent, OperationIntentKind, OperationPathRef,
        OperationRequestSource,
    };

    use crate::services::operation_service::execute_undo_task;

    fn unique_temp_path(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time went backwards")
            .as_nanos();
        std::env::temp_dir().join(format!("athenaeum-operation-{label}-{unique}"))
    }

    fn local(path: &Path) -> OperationPathRef {
        OperationPathRef::Local {
            path: path.to_string_lossy().into_owned(),
        }
    }

    fn copy_intent(source: &Path, destination: &Path) -> OperationIntent {
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
            conflict_policy: None,
        }
    }

    fn history_record(
        record_id: &str,
        task_id: &str,
        status: OperationHistoryStatus,
    ) -> OperationHistoryRecord {
        let now = chrono::Utc::now();
        OperationHistoryRecord {
            record_id: record_id.into(),
            task_id: task_id.into(),
            kind: OperationIntentKind::Delete,
            label: record_id.into(),
            status,
            created_at: now,
            updated_at: now,
            undo_task_id: None,
            blocked_reason: None,
            payload_expires_at: None,
            affected_roots: Vec::new(),
        }
    }

    fn restore_payload(trash_path: PathBuf, original_path: PathBuf) -> UndoPayload {
        UndoPayload {
            actions: vec![UndoAction::RestoreTrash {
                trash_path,
                original_path,
            }],
        }
    }

    fn insert_history_payload(
        store: &mut OperationStore,
        record_id: &str,
        status: OperationHistoryStatus,
        payload: UndoPayload,
    ) {
        store
            .history
            .push(history_record(record_id, record_id, status));
        store.undo_payloads.insert(record_id.into(), payload);
    }

    #[cfg(windows)]
    #[test]
    fn cleanup_path_identity_is_case_exact_and_lossless() {
        use std::{ffi::OsString, os::windows::ffi::OsStringExt};

        let root = unique_temp_path("cleanup-path-identity");
        assert_ne!(
            normalized_components(&root.join("OperationTrash")),
            normalized_components(&root.join("operationtrash"))
        );
        assert_ne!(
            normalized_components(&root.join(OsString::from_wide(&[0xd800]))),
            normalized_components(&root.join(OsString::from_wide(&[0xd801])))
        );

        let trash_root = root.join("OperationTrash");
        let payload = trash_root.join("payload.txt");
        fs::create_dir_all(&trash_root).expect("create exact-case root");
        fs::write(&payload, "keep").expect("write payload");
        let case_variant = root.join("operationtrash").join("payload.txt");
        assert!(cleanup_candidate(&trash_root, &case_variant).is_err());
        assert!(payload.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn clear_records_removes_only_eligible_scope_and_preserves_active_tasks() {
        let root = unique_temp_path("clear-scopes");
        let source = root.join("source");
        let destination = root.join("destination");
        fs::create_dir_all(&source).expect("create source");
        fs::create_dir_all(&destination).expect("create destination");
        fs::write(source.join("ok.txt"), "hello").expect("write source");

        let mut store = OperationStore::default();
        let succeeded = store.start_operation(
            copy_intent(&source.join("ok.txt"), &destination),
            Some(root.clone()),
        );
        let failed = store.start_operation(
            OperationIntent {
                request_id: "request-failed".into(),
                ..copy_intent(&source.join("missing.txt"), &destination)
            },
            Some(root.clone()),
        );
        let (queued, should_execute) = store.queue_operation(OperationIntent {
            request_id: "request-active".into(),
            ..copy_intent(&source.join("ok.txt"), &destination)
        });
        assert!(should_execute);

        let problems = store
            .clear_records(
                OperationClearRequest {
                    scope: OperationClearScope::Problems,
                    confirm_undo_loss: false,
                },
                Some(&root.join("operation-trash")),
            )
            .expect("clear problems");
        assert_eq!(problems.status, OperationClearStatus::Cleared);
        assert_eq!(problems.removed_task_ids, vec![failed.snapshot.task_id]);
        assert!(store
            .list_tasks()
            .tasks
            .iter()
            .any(|task| task.task_id == queued.snapshot.task_id));
        assert!(store
            .list_tasks()
            .tasks
            .iter()
            .any(|task| task.task_id == succeeded.snapshot.task_id));

        let completed = store
            .clear_records(
                OperationClearRequest {
                    scope: OperationClearScope::Completed,
                    confirm_undo_loss: false,
                },
                Some(&root.join("operation-trash")),
            )
            .expect("clear completed");
        assert_eq!(completed.removed_task_ids, vec![succeeded.snapshot.task_id]);
        assert_eq!(store.list_tasks().tasks.len(), 1);
        assert_eq!(store.list_tasks().tasks[0].task_id, queued.snapshot.task_id);
        assert_eq!(store.list_history().records.len(), 1);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn completed_clear_does_not_report_unrelated_protected_history() {
        let mut store = OperationStore::default();
        store.history.push(history_record(
            "pending-history",
            "pending-task",
            OperationHistoryStatus::PendingConfirmation,
        ));

        let outcome = store
            .clear_records(
                OperationClearRequest {
                    scope: OperationClearScope::Completed,
                    confirm_undo_loss: false,
                },
                None,
            )
            .expect("clear completed tasks");

        assert!(outcome.protected_record_ids.is_empty());
        assert_eq!(store.history.len(), 1);
    }

    #[test]
    fn clear_all_preserves_every_protected_history_state_and_linked_active_undo_task() {
        let root = unique_temp_path("clear-all-protected");
        let source = root.join("source.txt");
        let destination = root.join("destination");
        fs::create_dir_all(&destination).expect("create destination");
        fs::write(&source, "hello").expect("write source");

        let mut store = OperationStore::load_from(root.join("operation-journal.json"))
            .expect("load operation store");
        let terminal =
            store.start_operation(copy_intent(&source, &destination), Some(root.clone()));
        let (active_undo_task, should_execute) = store.queue_operation(OperationIntent {
            request_id: "active-undo-request".into(),
            undo_record_id: Some("linked-source".into()),
            ..copy_intent(&source, &destination)
        });
        assert!(should_execute);

        store.history.push(history_record(
            "undoing-source",
            "undoing-task",
            OperationHistoryStatus::Undoing,
        ));
        store.history.push(history_record(
            "pending-source",
            "pending-task",
            OperationHistoryStatus::PendingConfirmation,
        ));
        let mut linked = history_record(
            "linked-source",
            "linked-task",
            OperationHistoryStatus::Failed,
        );
        linked.undo_task_id = Some(active_undo_task.snapshot.task_id.clone());
        store.history.push(linked);
        store.history.push(history_record(
            "removable-failure",
            "failed-task",
            OperationHistoryStatus::Failed,
        ));

        let outcome = store
            .clear_records(
                OperationClearRequest {
                    scope: OperationClearScope::All,
                    confirm_undo_loss: true,
                },
                Some(&root.join("operation-trash")),
            )
            .expect("clear all records");

        assert!(outcome
            .removed_task_ids
            .contains(&terminal.snapshot.task_id));
        assert!(!outcome
            .removed_task_ids
            .contains(&active_undo_task.snapshot.task_id));
        assert!(outcome
            .removed_record_ids
            .contains(&"removable-failure".to_string()));
        assert_eq!(
            outcome.protected_record_ids,
            vec![
                "linked-source".to_string(),
                "pending-source".to_string(),
                "undoing-source".to_string()
            ]
        );
        assert_eq!(
            store
                .list_history()
                .records
                .iter()
                .map(|record| record.record_id.as_str())
                .collect::<HashSet<_>>(),
            HashSet::from(["linked-source", "pending-source", "undoing-source"])
        );
        assert!(store
            .list_tasks()
            .tasks
            .iter()
            .any(|task| task.task_id == active_undo_task.snapshot.task_id));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn clear_history_requires_backend_confirmation_and_persists_the_clear() {
        let root = unique_temp_path("clear-confirm");
        let source = root.join("source");
        let destination = root.join("destination");
        let journal_path = root.join("operation-journal.json");
        fs::create_dir_all(&source).expect("create source");
        fs::create_dir_all(&destination).expect("create destination");
        fs::write(source.join("ok.txt"), "hello").expect("write source");
        let mut store = OperationStore::load_from(journal_path.clone()).expect("load store");
        store.start_operation(
            copy_intent(&source.join("ok.txt"), &destination),
            Some(root.clone()),
        );
        let history_before = store.list_history();

        let preflight = store
            .clear_records(
                OperationClearRequest {
                    scope: OperationClearScope::History,
                    confirm_undo_loss: false,
                },
                Some(&root.join("operation-trash")),
            )
            .expect("clear preflight");
        assert_eq!(preflight.status, OperationClearStatus::ConfirmationRequired);
        assert_eq!(preflight.eligible_undoable_count, 1);
        assert_eq!(store.list_history(), history_before);

        let cleared = store
            .clear_records(
                OperationClearRequest {
                    scope: OperationClearScope::History,
                    confirm_undo_loss: true,
                },
                Some(&root.join("operation-trash")),
            )
            .expect("confirmed clear");
        assert_eq!(cleared.status, OperationClearStatus::Cleared);
        assert_eq!(cleared.removed_record_ids.len(), 1);
        assert!(cleared.history_clear_watermark > history_before.history_sequence);
        assert!(store.list_history().records.is_empty());
        let reloaded = OperationStore::load_from(journal_path).expect("reload cleared journal");
        assert!(reloaded.list_history().records.is_empty());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn clear_protects_restore_trash_paths_owned_by_an_in_flight_undo() {
        let root = unique_temp_path("clear-in-flight-undo");
        let trash_root = root.join("operation-trash");
        let ancestor_path = trash_root.join("active-parent");
        let trash_path = ancestor_path.join("active");
        let descendant_path = trash_path.join("nested.txt");
        let restore_path = root.join("restored");
        fs::create_dir_all(&trash_path).expect("create trash");
        fs::create_dir_all(restore_path.parent().expect("restore parent")).expect("create restore");
        fs::write(&descendant_path, "recover me").expect("write trash payload");

        let mut store = OperationStore::load_from(root.join("operation-journal.json"))
            .expect("load operation store");
        store.history.push(history_record(
            "active-record",
            "source-task",
            OperationHistoryStatus::Undoable,
        ));
        store.undo_payloads.insert(
            "active-record".into(),
            UndoPayload {
                actions: vec![UndoAction::RestoreTrash {
                    trash_path: trash_path.clone(),
                    original_path: restore_path.clone(),
                }],
            },
        );
        for (id, candidate) in [
            ("failed-exact", trash_path.clone()),
            ("failed-ancestor", ancestor_path.clone()),
            ("failed-descendant", descendant_path.clone()),
        ] {
            insert_history_payload(
                &mut store,
                id,
                OperationHistoryStatus::Failed,
                restore_payload(candidate, root.join(format!("unused-{id}"))),
            );
        }

        let (_prepared, execution) = store
            .prepare_undo_record("active-record".into(), "undo-request".into())
            .expect("prepare undo");
        let cleared = store
            .clear_records(
                OperationClearRequest {
                    scope: OperationClearScope::Problems,
                    confirm_undo_loss: false,
                },
                Some(&trash_root),
            )
            .expect("clear overlapping failed history");
        assert_eq!(cleared.removed_record_ids.len(), 3);
        assert_eq!(cleared.cleanup_warnings.len(), 3);
        assert!(ancestor_path.exists());
        assert!(trash_path.exists());

        let undo_result = execute_undo_task(execution);
        store
            .finish_undo_operation(undo_result)
            .expect("finish protected undo");
        assert_eq!(
            fs::read_to_string(restore_path.join("nested.txt")).expect("restored payload"),
            "recover me"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_clear_journal_commit_leaves_live_state_and_sequences_unchanged() {
        let root = unique_temp_path("clear-rollback");
        let source = root.join("source");
        let destination = root.join("destination");
        fs::create_dir_all(&source).expect("create source");
        fs::create_dir_all(&destination).expect("create destination");
        fs::write(source.join("ok.txt"), "hello").expect("write source");
        let journal_path = root.join("operation-journal.json");
        let mut store = OperationStore::load_from(journal_path.clone()).expect("load store");
        store.start_operation(
            copy_intent(&source.join("ok.txt"), &destination),
            Some(root.clone()),
        );
        store.in_flight_undo_paths.insert(
            "unrelated-undo-task".into(),
            vec![root.join("operation-trash").join("protected.txt")],
        );
        let tasks_before = store.list_tasks();
        let history_before = store.list_history();
        let request_to_task_before = store.request_to_task.clone();
        let undo_payload_ids_before = store.undo_payloads.keys().cloned().collect::<HashSet<_>>();
        let in_flight_before = store.in_flight_undo_paths.clone();
        let task_sequence_before = store.task_sequence;
        let history_sequence_before = store.history_sequence;
        for failure in [
            super::super::JournalPersistStep::TempWrite,
            super::super::JournalPersistStep::BackupCopy,
            super::super::JournalPersistStep::CommitReplace,
        ] {
            store.journal_persist_failure_for_test = Some(failure);
            let error = store.clear_records(
                OperationClearRequest {
                    scope: OperationClearScope::All,
                    confirm_undo_loss: true,
                },
                Some(&root.join("operation-trash")),
            );
            assert!(error.is_err(), "{failure:?} must fail the clear");
            assert_eq!(store.list_tasks(), tasks_before);
            assert_eq!(store.list_history(), history_before);
            assert_eq!(store.request_to_task, request_to_task_before);
            assert_eq!(
                store.undo_payloads.keys().cloned().collect::<HashSet<_>>(),
                undo_payload_ids_before
            );
            assert_eq!(store.in_flight_undo_paths, in_flight_before);
            assert_eq!(store.task_sequence, task_sequence_before);
            assert_eq!(store.history_sequence, history_sequence_before);
            let reloaded = OperationStore::load_from(journal_path.clone())
                .expect("reload journal after failed clear");
            assert_eq!(reloaded.list_history(), history_before);
            assert_eq!(
                reloaded
                    .undo_payloads
                    .keys()
                    .cloned()
                    .collect::<HashSet<_>>(),
                undo_payload_ids_before
            );
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cleanup_accepts_only_strict_owned_descendants_and_is_idempotent_for_missing_paths() {
        let root = unique_temp_path("clear-path-boundaries");
        let trash_root = root.join("operation-trash");
        let valid = trash_root.join("owned").join("report.txt");
        let missing = trash_root.join("already-missing.txt");
        let sibling = root.join("operation-trash-sibling").join("keep.txt");
        let outside = root.join("outside.txt");
        fs::create_dir_all(valid.parent().expect("valid parent")).expect("create valid parent");
        fs::create_dir_all(sibling.parent().expect("sibling parent"))
            .expect("create sibling parent");
        fs::write(&valid, "remove").expect("write valid");
        fs::write(&sibling, "keep sibling").expect("write sibling");
        fs::write(&outside, "keep outside").expect("write outside");

        let mut store = OperationStore::load_from(root.join("operation-journal.json"))
            .expect("load operation store");
        for (id, candidate) in [
            ("valid", valid.clone()),
            ("missing", missing),
            ("exact-root", trash_root.clone()),
            ("sibling", sibling.clone()),
            (
                "parent-escape",
                trash_root
                    .join("owned")
                    .join("..")
                    .join("..")
                    .join("outside.txt"),
            ),
            ("outside", outside.clone()),
        ] {
            insert_history_payload(
                &mut store,
                id,
                OperationHistoryStatus::Failed,
                restore_payload(candidate, root.join(format!("unused-{id}"))),
            );
        }

        let outcome = store
            .clear_records(
                OperationClearRequest {
                    scope: OperationClearScope::Problems,
                    confirm_undo_loss: false,
                },
                Some(&trash_root),
            )
            .expect("clear invalid paths");

        assert!(!valid.exists());
        assert!(trash_root.exists());
        assert_eq!(
            fs::read_to_string(sibling).expect("read sibling"),
            "keep sibling"
        );
        assert_eq!(
            fs::read_to_string(outside).expect("read outside"),
            "keep outside"
        );
        assert!(outcome.cleanup_warnings.len() >= 4);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cleanup_rejects_type_and_identity_changes_after_authorization() {
        #[derive(Clone, Copy)]
        enum Replacement {
            DirectoryToFile,
            FileToDirectory,
            FileToFile,
        }

        for (label, replacement) in [
            ("dir-to-file", Replacement::DirectoryToFile),
            ("file-to-dir", Replacement::FileToDirectory),
            ("file-to-file", Replacement::FileToFile),
        ] {
            let root = unique_temp_path(label);
            let trash_root = root.join("operation-trash");
            let candidate = trash_root.join("candidate");
            let displaced = trash_root.join("displaced");
            fs::create_dir_all(&trash_root).expect("create trash root");
            match replacement {
                Replacement::DirectoryToFile => {
                    fs::create_dir(&candidate).expect("create original directory")
                }
                Replacement::FileToDirectory | Replacement::FileToFile => {
                    fs::write(&candidate, "original").expect("create original file")
                }
            }

            let result = cleanup_candidate_with_hook(&trash_root, &candidate, || {
                fs::rename(&candidate, &displaced).expect("displace authorized entry");
                match replacement {
                    Replacement::DirectoryToFile | Replacement::FileToFile => {
                        fs::write(&candidate, "replacement").expect("create replacement file")
                    }
                    Replacement::FileToDirectory => {
                        fs::create_dir(&candidate).expect("create replacement directory")
                    }
                }
            });

            assert!(result.is_err(), "{label} replacement must be rejected");
            assert!(candidate.exists(), "{label} replacement must survive");
            assert!(displaced.exists(), "{label} original must remain displaced");
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn cleanup_rejects_bidirectional_overlap_with_retained_restore_paths() {
        let root = unique_temp_path("clear-retained-overlap");
        let trash_root = root.join("operation-trash");
        let ancestor = trash_root.join("ancestor");
        let descendant = ancestor.join("child").join("payload.txt");
        fs::create_dir_all(descendant.parent().expect("descendant parent"))
            .expect("create descendant parent");
        fs::write(&descendant, "keep").expect("write descendant");

        let mut store = OperationStore::load_from(root.join("operation-journal.json"))
            .expect("load operation store");
        insert_history_payload(
            &mut store,
            "retained-child",
            OperationHistoryStatus::Undoable,
            restore_payload(descendant.clone(), root.join("restore-child.txt")),
        );
        insert_history_payload(
            &mut store,
            "removed-parent",
            OperationHistoryStatus::Failed,
            restore_payload(ancestor.clone(), root.join("unused-parent")),
        );
        insert_history_payload(
            &mut store,
            "retained-parent",
            OperationHistoryStatus::Undoable,
            restore_payload(ancestor.clone(), root.join("restore-parent")),
        );
        insert_history_payload(
            &mut store,
            "removed-child",
            OperationHistoryStatus::Failed,
            restore_payload(descendant.clone(), root.join("unused-child")),
        );

        let outcome = store
            .clear_records(
                OperationClearRequest {
                    scope: OperationClearScope::Problems,
                    confirm_undo_loss: false,
                },
                Some(&trash_root),
            )
            .expect("clear overlapping payloads");

        assert!(ancestor.exists());
        assert!(descendant.exists());
        assert_eq!(outcome.cleanup_warnings.len(), 2);
        assert_eq!(store.undo_payloads.len(), 2);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn in_flight_undo_protection_unregisters_after_success_and_finish_failure() {
        let root = unique_temp_path("clear-undo-unregister");
        let trash_root = root.join("operation-trash");
        let successful_trash = trash_root.join("success.txt");
        let failed_trash = trash_root.join("failure.txt");
        fs::create_dir_all(&trash_root).expect("create trash root");
        fs::write(&successful_trash, "success").expect("write success payload");
        fs::write(&failed_trash, "failure").expect("write failure payload");

        let mut store = OperationStore::load_from(root.join("operation-journal.json"))
            .expect("load operation store");
        insert_history_payload(
            &mut store,
            "success-record",
            OperationHistoryStatus::Undoable,
            restore_payload(successful_trash, root.join("restored-success.txt")),
        );
        let (_, success_execution) = store
            .prepare_undo_record("success-record".into(), "success-request".into())
            .expect("prepare successful undo");
        let success_task_id = success_execution.task_id.clone();
        assert!(store.in_flight_undo_paths.contains_key(&success_task_id));
        store
            .finish_undo_operation(execute_undo_task(success_execution))
            .expect("finish successful undo");
        assert!(!store.in_flight_undo_paths.contains_key(&success_task_id));

        insert_history_payload(
            &mut store,
            "failure-record",
            OperationHistoryStatus::Undoable,
            restore_payload(failed_trash, root.join("restored-failure.txt")),
        );
        let (_, failure_execution) = store
            .prepare_undo_record("failure-record".into(), "failure-request".into())
            .expect("prepare failing finish");
        let failure_task_id = failure_execution.task_id.clone();
        store.tasks.retain(|task| task.task_id != failure_task_id);
        assert!(store
            .finish_undo_operation(execute_undo_task(failure_execution))
            .is_err());
        assert!(!store.in_flight_undo_paths.contains_key(&failure_task_id));

        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn cleanup_unlinks_leaf_links_but_rejects_intermediate_links() {
        use std::os::windows::fs::{symlink_dir, symlink_file};

        let root = unique_temp_path("clear-links");
        let trash_root = root.join("operation-trash");
        let outside = root.join("outside");
        let outside_file = outside.join("keep.txt");
        let leaf_link = trash_root.join("leaf-link.txt");
        let directory_link = trash_root.join("directory-link");
        fs::create_dir_all(&trash_root).expect("create trash root");
        fs::create_dir_all(&outside).expect("create outside root");
        fs::write(&outside_file, "keep").expect("write outside file");
        if symlink_file(&outside_file, &leaf_link).is_err()
            || symlink_dir(&outside, &directory_link).is_err()
        {
            let _ = fs::remove_dir_all(root);
            return;
        }

        let mut store = OperationStore::load_from(root.join("operation-journal.json"))
            .expect("load operation store");
        insert_history_payload(
            &mut store,
            "leaf-link",
            OperationHistoryStatus::Failed,
            restore_payload(leaf_link.clone(), root.join("unused-leaf")),
        );
        insert_history_payload(
            &mut store,
            "intermediate-link",
            OperationHistoryStatus::Failed,
            restore_payload(
                directory_link.join("keep.txt"),
                root.join("unused-intermediate"),
            ),
        );

        let outcome = store
            .clear_records(
                OperationClearRequest {
                    scope: OperationClearScope::Problems,
                    confirm_undo_loss: false,
                },
                Some(&trash_root),
            )
            .expect("clear linked paths");

        assert!(!leaf_link.exists());
        assert_eq!(
            fs::read_to_string(&outside_file).expect("outside survives"),
            "keep"
        );
        assert_eq!(outcome.cleanup_warnings.len(), 1);

        let _ = fs::remove_dir_all(root);
    }
}

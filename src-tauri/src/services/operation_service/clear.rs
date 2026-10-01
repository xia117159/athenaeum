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
mod confirmation;
mod template_recovery;
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
    #[cfg(test)]
    pub fn clear_records(
        &mut self,
        request: OperationClearRequest,
        operation_trash_root: Option<&Path>,
    ) -> Result<OperationClearOutcome> {
        self.clear_records_with_sizes(request, operation_trash_root, None)
    }

    pub fn clear_records_with_sizes(
        &mut self,
        request: OperationClearRequest,
        operation_trash_root: Option<&Path>,
        sizes: Option<&crate::services::directory_size::DirectorySizeService>,
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
        let mut removed_history = self
            .history
            .iter()
            .filter(remove_history)
            .cloned()
            .collect::<Vec<_>>();
        let undoable_count = removed_history
            .iter()
            .filter(|record| matches!(record.status, OperationHistoryStatus::Undoable))
            .count();
        let recovery_count = self.template_recovery_count(&removed_history);
        let recovery_confirmation =
            self.template_recovery_confirmation(&removed_history, &request.scope)?;
        let changed_recovery =
            recovery_count > 0 && request.recovery_confirmation != recovery_confirmation;
        if ((undoable_count > 0 || recovery_count > 0) && !request.confirm_undo_loss) || changed_recovery
        {
            return Ok(self.confirmation_required(
                undoable_count,
                recovery_count,
                recovery_confirmation,
                protected,
            ));
        }

        // Template recovery mappings remain durable until physical cleanup succeeds.
        // A failed cleanup or final journal write can be retried without losing ownership.
        let mut template_warnings = self.cleanup_template_records(&mut removed_history, sizes);

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

        template_warnings.extend(self.cleanup_removed_payloads(removed_payloads, operation_trash_root, sizes));
        let mut protected_record_ids = protected.into_iter().collect::<Vec<_>>();
        protected_record_ids.sort();
        Ok(OperationClearOutcome {
            status: OperationClearStatus::Cleared,
            eligible_undoable_count: undoable_count,
            eligible_recovery_count: recovery_count,
            recovery_confirmation: None,
            removed_task_ids,
            removed_record_ids,
            task_clear_watermark: task_watermark,
            history_clear_watermark: history_watermark,
            protected_record_ids,
            cleanup_warnings: template_warnings,
        })
    }

    fn protected_history_record_ids(&self) -> HashSet<String> {
        self.history
            .iter()
            .filter(|record| {
                self.batch_record_protected(&record.record_id) || matches!(
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

    fn cleanup_removed_payloads(
        &self,
        payloads: Vec<UndoPayload>,
        root: Option<&Path>,
        sizes: Option<&crate::services::directory_size::DirectorySizeService>,
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
            let _size_change = sizes.map(|sizes| sizes.namespace_change(std::slice::from_ref(&candidate)));
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
#[path = "clear/tests.rs"]
mod tests;

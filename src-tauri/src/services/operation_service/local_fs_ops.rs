use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

use anyhow::{bail, Context, Result};

use crate::{domain::models::OperationEntryKindSnapshot, services::fs_service};

use super::journal::UndoAction;

pub(super) fn entry_kind_snapshot(path: &Path) -> OperationEntryKindSnapshot {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => OperationEntryKindSnapshot::Directory,
        Ok(metadata) if metadata.is_file() => OperationEntryKindSnapshot::File,
        _ => OperationEntryKindSnapshot::Unknown,
    }
}

pub(super) fn remove_path(path: &Path) -> Result<()> {
    let metadata =
        fs::symlink_metadata(path).with_context(|| format!("failed to stat {}", path.display()))?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(path)
            .with_context(|| format!("failed to remove directory {}", path.display()))?;
    } else {
        fs::remove_file(path)
            .with_context(|| format!("failed to remove file {}", path.display()))?;
    }
    Ok(())
}

pub(super) fn check_cancelled(cancellation: &AtomicBool) -> Result<()> {
    if cancellation.load(Ordering::SeqCst) {
        bail!("operation cancelled");
    }
    Ok(())
}

pub(super) fn copy_recursively_exact(
    source: &Path,
    destination: &Path,
    cancellation: &AtomicBool,
) -> Result<PathBuf> {
    check_cancelled(cancellation)?;
    let metadata = fs::symlink_metadata(source)
        .with_context(|| format!("failed to stat {}", source.display()))?;
    if destination.exists() {
        bail!("destination already exists: {}", destination.display());
    }

    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::create_dir_all(destination)
            .with_context(|| format!("failed to create directory {}", destination.display()))?;
        for entry in
            fs::read_dir(source).with_context(|| format!("failed to read {}", source.display()))?
        {
            check_cancelled(cancellation)?;
            let entry = entry.context("failed to read recursive directory entry")?;
            copy_recursively_exact(
                &entry.path(),
                &destination.join(entry.file_name()),
                cancellation,
            )?;
        }
    } else {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
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

pub(super) fn merge_directory_exact(
    source: &Path,
    destination: &Path,
    move_source: bool,
    cancellation: &AtomicBool,
) -> Result<Vec<UndoAction>> {
    check_cancelled(cancellation)?;
    let source_metadata = fs::symlink_metadata(source)
        .with_context(|| format!("failed to stat {}", source.display()))?;
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
    for entry in
        fs::read_dir(source).with_context(|| format!("failed to read {}", source.display()))?
    {
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
                    cancellation,
                )?);
                continue;
            }
            bail!(
                "merge conflict requires another decision for {}",
                destination_child.display()
            );
        }

        if move_source {
            let moved = move_entry_exact(&source_child, &destination_child, cancellation)?;
            undo_actions.push(UndoAction::MoveBack {
                from: moved,
                to: source_child,
            });
        } else {
            let copied = copy_recursively_exact(&source_child, &destination_child, cancellation)?;
            undo_actions.push(UndoAction::DeleteCreated { path: copied });
        }
    }

    if move_source {
        fs::remove_dir(source).with_context(|| {
            format!(
                "failed to remove merged source directory {}",
                source.display()
            )
        })?;
        undo_actions.push(UndoAction::RecreateDirectory {
            path: source.to_path_buf(),
        });
    }

    Ok(undo_actions)
}

pub(super) fn move_entry_exact(
    source: &Path,
    destination: &Path,
    cancellation: &AtomicBool,
) -> Result<PathBuf> {
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

pub(super) fn trash_destination(
    task_id: &str,
    app_data_dir: Option<&PathBuf>,
    source: &Path,
) -> Result<PathBuf> {
    let root = app_data_dir
        .cloned()
        .unwrap_or_else(|| std::env::temp_dir().join("SimpleFileManager"))
        .join("operation-trash")
        .join(task_id);
    fs::create_dir_all(&root)
        .with_context(|| format!("failed to create trash root {}", root.display()))?;
    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("entry");
    Ok(fs_service::available_conflict_path(&root.join(file_name)))
}

pub(super) fn ensure_not_descendant(source: &Path, destination_root: &Path) -> Result<()> {
    let source = source
        .canonicalize()
        .unwrap_or_else(|_| source.to_path_buf());
    let destination = destination_root
        .canonicalize()
        .unwrap_or_else(|_| destination_root.to_path_buf());
    if destination == source || destination.starts_with(&source) {
        bail!("cannot copy or move a directory into itself or its descendants");
    }
    Ok(())
}

use super::*;

pub(super) fn move_entry_with_sizes(from: &Path, to: &Path, cancellation: &AtomicBool,
    sizes: Option<&crate::services::directory_size::DirectorySizeService>) -> Result<PathBuf> {
    if let Some(sizes) = sizes {
        sizes.rename_with(from, to, false, || move_entry_exact(from, to, cancellation).map(|_| ()))?;
        Ok(to.to_path_buf())
    } else { move_entry_exact(from, to, cancellation) }
}

pub(super) fn execute_rename(
    task_id: &str,
    intent: &OperationIntent,
    app_data_dir: Option<PathBuf>,
    cancellation: &AtomicBool,
    resolution: Option<&OperationConflictResolution>,
    sizes: Option<&crate::services::directory_size::DirectorySizeService>,
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
        bail!("destination already exists: {}", destination.display());
    }

    let decision = resolve_destination(&destination, resolution)?;
    if decision.skip {
        return Ok(success_execution(
            intent,
            vec![OperationEntryResult {
                entry_result_id: format!("{task_id}-0"),
                source: Some(source_ref.clone()),
                destination: Some(OperationPathRef::Local {
                    path: destination.to_string_lossy().into_owned(),
                }),
                kind: OperationEntryResultKind::Skipped,
                error: None,
            }],
            Vec::new(),
        ));
    }

    let mut undo_actions = Vec::new();
    let mut restore_backup = None;
    if decision.replace && decision.destination.exists() {
        let backup = trash_destination(task_id, app_data_dir.as_ref(), &decision.destination)?;
        let backup = move_entry_with_sizes(&decision.destination, &backup, cancellation, sizes)?;
        restore_backup = Some((backup, decision.destination.clone()));
    }

    check_cancelled(cancellation)?;
    let action = || {
        // Preparation can wait for native I/O; cancellation must still win
        // until the actual filesystem operation starts.
        check_cancelled(cancellation)?;
        Ok(fs::rename(&source, &decision.destination)?)
    };
    let renamed = match sizes {
        Some(sizes) => sizes.rename_with(&source, &decision.destination, !decision.replace, action),
        None => action(),
    };
    renamed.with_context(|| {
        format!(
            "failed to rename {} to {}",
            source.display(),
            decision.destination.display()
        )
    })?;
    undo_actions.push(UndoAction::MoveBack {
        from: decision.destination.clone(),
        to: source.clone(),
    });
    if let Some((trash_path, original_path)) = restore_backup {
        undo_actions.push(UndoAction::RestoreTrash {
            trash_path,
            original_path,
        });
    }

    Ok(success_execution(
        intent,
        vec![OperationEntryResult {
            entry_result_id: format!("{task_id}-0"),
            source: Some(source_ref.clone()),
            destination: Some(OperationPathRef::Local {
                path: decision.destination.to_string_lossy().into_owned(),
            }),
            kind: OperationEntryResultKind::Renamed,
            error: None,
        }],
        undo_actions,
    ))
}


use super::*;

pub(super) fn apply_undo_action(action: &UndoAction) -> Result<OperationEntryResult> {
    match action {
        UndoAction::BatchRename { .. } => bail!("批量重命名必须通过批次撤销执行器处理"),
        UndoAction::DeleteCreated { path } => {
            remove_path(path)?;
            Ok(OperationEntryResult {
                entry_result_id: Uuid::new_v4().to_string(),
                source: Some(OperationPathRef::Local {
                    path: path.to_string_lossy().into_owned(),
                }),
                destination: None,
                kind: OperationEntryResultKind::Deleted,
                error: None,
            })
        }
        UndoAction::RecreateDirectory { path } => {
            fs::create_dir_all(path)
                .with_context(|| format!("failed to recreate directory {}", path.display()))?;
            Ok(OperationEntryResult {
                entry_result_id: Uuid::new_v4().to_string(),
                source: None,
                destination: Some(OperationPathRef::Local {
                    path: path.to_string_lossy().into_owned(),
                }),
                kind: OperationEntryResultKind::Created,
                error: None,
            })
        }
        UndoAction::MoveBack { from, to } => {
            if to.exists() {
                bail!(
                    "cannot restore {}, destination already exists",
                    to.display()
                );
            }
            let cancellation = AtomicBool::new(false);
            move_entry_exact(from, to, &cancellation)?;
            Ok(OperationEntryResult {
                entry_result_id: Uuid::new_v4().to_string(),
                source: Some(OperationPathRef::Local {
                    path: from.to_string_lossy().into_owned(),
                }),
                destination: Some(OperationPathRef::Local {
                    path: to.to_string_lossy().into_owned(),
                }),
                kind: OperationEntryResultKind::Moved,
                error: None,
            })
        }
        UndoAction::RestoreTrash {
            trash_path,
            original_path,
        } => {
            if original_path.exists() {
                bail!(
                    "cannot restore {}, destination already exists",
                    original_path.display()
                );
            }
            let cancellation = AtomicBool::new(false);
            move_entry_exact(trash_path, original_path, &cancellation)?;
            Ok(OperationEntryResult {
                entry_result_id: Uuid::new_v4().to_string(),
                source: Some(OperationPathRef::Local {
                    path: trash_path.to_string_lossy().into_owned(),
                }),
                destination: Some(OperationPathRef::Local {
                    path: original_path.to_string_lossy().into_owned(),
                }),
                kind: OperationEntryResultKind::Moved,
                error: None,
            })
        }
    }
}

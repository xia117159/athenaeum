use super::*;
use crate::services::AppState;

pub(crate) fn execute_workspace_undo(
    state: &AppState,
    execution: OperationUndoExecution,
    emit: &dyn Fn(&OperationServiceResult),
) -> Result<()> {
    if execution.already_started() {
        return Ok(());
    }
    if let Some(payload) = execution.batch_payload() {
        batch::execute_batch(state, payload, emit)?;
        return Ok(());
    }
    let result = execute_undo_task(execution);
    let finished = state
        .operations
        .lock()
        .expect("operation store poisoned")
        .finish_undo_operation(result)?;
    emit(&finished);
    Ok(())
}

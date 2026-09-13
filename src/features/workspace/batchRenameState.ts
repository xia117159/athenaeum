import type { BatchRenamePreview, BatchRenameSession } from "../../app/batchRename";
import type { OperationIntent, OperationTaskSnapshot } from "../../app/types";
import type { EntryViewModel, PanelId, WorkspaceState } from "./types";
import type { WorkspaceAction } from "./workspaceReducer";
import { captureRenameTarget } from "./renameTarget";
import { restorePendingFolderSelection } from "./folderSelectionRestore";
import { getPathComparisonKey, pathsEqual } from "./workspacePathRelations";

export interface RenameTarget {
  panelId: PanelId;
  tabId: string;
  rootPath: string;
  selectionRevision: number;
  source: OperationIntent["source"];
  entries: Pick<EntryViewModel, "id" | "name" | "path" | "parentPath" | "kind">[];
}
export interface BatchRenameDialogState {
  id: string;
  target: RenameTarget;
  expression: string;
  revision: number;
  history: string[];
  phase: "loading" | "previewing" | "editing" | "submitting" | "running" | "cancelling" | "finished" | "error";
  session?: BatchRenameSession;
  preview?: BatchRenamePreview;
  requestId?: string;
  task?: OperationTaskSnapshot;
  error?: string;
}
export type BatchRenameAction =
  | { type: "batchRenameOpened"; payload: { id: string; target: RenameTarget; history: string[] } }
  | { type: "batchRenameSessionLoaded"; payload: { id: string; session: BatchRenameSession } }
  | { type: "batchRenameExpressionChanged"; payload: { id: string; expression: string; revision: number } }
  | { type: "batchRenamePreviewReceived"; payload: { id: string; preview: BatchRenamePreview } }
  | { type: "batchRenameFailed"; payload: { id: string; message: string; revision?: number } }
  | { type: "batchRenameApplyStarted"; payload: { id: string; requestId: string } }
  | { type: "batchRenameTaskReceived"; payload: { id: string; task: OperationTaskSnapshot } }
  | { type: "batchRenameCancelling"; payload: { id: string } }
  | { type: "batchRenameCancelFailed"; payload: { id: string; message: string } }
  | { type: "batchRenameSelectionQueued"; payload: { id: string; paths: string[] } }
  | { type: "batchRenameClosed"; payload: { id: string } };

export function canConfirmBatchRename(dialog: BatchRenameDialogState) {
  return dialog.phase === "editing" && dialog.preview?.canApply === true && Boolean(dialog.preview.previewId)
    && dialog.preview.revision === dialog.revision && dialog.preview.expression === dialog.expression;
}
export function reduceBatchRename(_state: WorkspaceState, _action: WorkspaceAction): WorkspaceState | undefined {
  // A row's selection and its custom menu are dispatched in the same DOM event.
  // Capture here, after the selection reducer has run, rather than in a stale closure.
  if (_action.type === "contextMenuSet" && _action.payload?.mode === "custom" && _action.payload.scope === "selection") {
    const menu = _action.payload;
    const renameTarget = captureRenameTarget(_state, menu.panelId, "contextMenu", menu.tabId);
    return { ..._state, contextMenu: { ...menu, ...(renameTarget ? { renameTarget } : {}) } };
  }
  if (!_action.type.startsWith("batchRename")) return undefined;
  const state = _state, action = _action as BatchRenameAction;
  if (action.type === "batchRenameOpened") {
    return state.batchRename ? state : { ...state, contextMenu: undefined, openWithMenu: undefined,
      batchRename: { ...action.payload, expression: "*", revision: 1, phase: "loading" } };
  }
  const dialog = state.batchRename;
  if (!dialog || dialog.id !== action.payload.id) return state;
  const update = (patch: Partial<BatchRenameDialogState>): WorkspaceState => ({ ...state, batchRename: { ...dialog, ...patch } });
  const editable = dialog.phase === "editing" || dialog.phase === "previewing";
  switch (action.type) {
    case "batchRenameSelectionQueued": {
      const { panelId, tabId, rootPath, selectionRevision } = dialog.target;
      const panel = state.panels[panelId], tab = panel.tabs.find(tab => tab.id === tabId);
      if (!tab || !pathsEqual(tab.snapshot.location.path, rootPath) || (tab.selectionRevision ?? 0) !== selectionRevision) return state;
      const paths = [...new Map(action.payload.paths.map(path => [getPathComparisonKey(path), path])).values()];
      const next = restorePendingFolderSelection({ ...tab, selectionRestore: { rootPath, paths } });
      return { ...state, panels: { ...state.panels, [panelId]: { ...panel, tabs: panel.tabs.map(item => item === tab ? next : item) } } };
    }
    case "batchRenameClosed":
      return { ...state, batchRename: undefined };
    case "batchRenameSessionLoaded":
      return dialog.phase === "loading" ? update({ session: action.payload.session, phase: "previewing" }) : state;
    case "batchRenameExpressionChanged":
      return editable && action.payload.revision > dialog.revision ? update({ expression: action.payload.expression,
        revision: action.payload.revision, preview: undefined, error: undefined, phase: "previewing" }) : state;
    case "batchRenamePreviewReceived": {
      const preview = action.payload.preview;
      return editable && preview.sessionId === dialog.session?.sessionId && preview.revision === dialog.revision
        && preview.expression === dialog.expression ? update({ preview, phase: "editing", error: undefined }) : state;
    }
    case "batchRenameFailed":
      if (action.payload.revision !== undefined && (!editable || action.payload.revision !== dialog.revision)) return state;
      return update({ error: action.payload.message, preview: undefined,
        phase: action.payload.revision === undefined ? "error" : "editing" });
    case "batchRenameApplyStarted":
      return canConfirmBatchRename(dialog) ? update({ phase: "submitting", requestId: action.payload.requestId }) : state;
    case "batchRenameTaskReceived": {
      const task = action.payload.task;
      if (task.requestId !== dialog.requestId || (dialog.task && (task.taskId !== dialog.task.taskId || task.sequence <= dialog.task.sequence))) return state;
      const terminal = ["succeeded", "failed", "partialSucceeded", "cancelled"].includes(task.status);
      const cancelling = task.status === "cancelling" || dialog.phase === "cancelling";
      return update({ task, phase: terminal ? "finished" : (cancelling ? "cancelling" : "running"),
        error: terminal || cancelling ? undefined : dialog.error });
    }
    case "batchRenameCancelling":
      return ["running", "submitting"].includes(dialog.phase) ? update({ phase: "cancelling", error: undefined }) : state;
    case "batchRenameCancelFailed":
      return dialog.phase === "cancelling" ? update({ phase: "running", error: action.payload.message }) : state;
  }
}

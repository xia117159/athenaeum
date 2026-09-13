import { useEffect, useEffectEvent, useRef, type Dispatch } from "react";
import type { BatchRenamePreview } from "../../app/batchRename";
import type { OperationTaskSnapshot } from "../../app/types";
import type { WorkspaceGateway } from "./workspaceGateway";
import type { WorkspaceAction } from "./workspaceReducer";
import type { WorkspaceState } from "./types";
import { canConfirmBatchRename, type RenameTarget } from "./batchRenameState";
import { readBatchRenameHistory, rememberBatchRenameExpression } from "./batchRenameHistory";
import { getErrorMessage } from "./workspaceControllerUtils";
import { isRemotePath, isTerminalOperationTask } from "./workspaceRefreshPlanner";
import { openBatchRenameHelpWindow } from "./batchRenameHelpWindow";

interface Options {
  state: WorkspaceState;
  dispatch: Dispatch<WorkspaceAction>;
  gateway: WorkspaceGateway;
  enabled: boolean;
  notify: (intent: WorkspaceState["notifications"][number]["intent"], message: string) => void;
  projectTask: (task: OperationTaskSnapshot) => Promise<void>;
  openHelp?: () => Promise<void>;
}
interface ActiveSession {
  id: string;
  target: RenameTarget;
  sessionId?: string;
  expression: string;
  revision: number;
  preview?: BatchRenamePreview;
  previewing: boolean;
  previewReady: boolean;
  previewTimer?: ReturnType<typeof setTimeout>;
  pollTimer?: ReturnType<typeof setTimeout>;
  requestId?: string;
  taskId?: string;
  taskSequence: number;
  cancelRequested: boolean;
  cancelSent: boolean;
  finished: boolean;
  applyError?: string;
  selectionQueued?: boolean;
}

export function useBatchRenameController({ state, dispatch, gateway, enabled, notify, projectTask, openHelp }: Options) {
  const active = useRef<ActiveSession | undefined>(undefined);
  const release = (session: ActiveSession) => {
    clearTimeout(session.previewTimer); clearTimeout(session.pollTimer);
    if (session.sessionId) void gateway.batchRename.close(session.sessionId).catch(() => {});
  };
  useEffect(() => () => {
    const session = active.current; active.current = undefined;
    if (session) release(session);
  }, [gateway]);
  const current = (session: ActiveSession) => active.current === session;
  const closeEditor = (session: ActiveSession) => {
    if (!current(session)) return;
    active.current = undefined; release(session);
    dispatch({ type: "batchRenameClosed", payload: { id: session.id } });
  };

  const observe = useEffectEvent((session: ActiveSession, task: OperationTaskSnapshot) => {
    if (!current(session) || session.finished || task.requestId !== session.requestId || task.sequence <= session.taskSequence) return;
    if (session.taskId && session.taskId !== task.taskId) return;
    session.taskId = task.taskId; session.taskSequence = task.sequence;
    dispatch({ type: "batchRenameTaskReceived", payload: { id: session.id, task } });
    if (!isTerminalOperationTask(task)) return;
    session.finished = true; clearTimeout(session.pollTimer);
    if (task.status === "succeeded") {
      rememberBatchRenameExpression(session.expression);
      notify("success", task.message ?? `已重命名 ${task.completedEntries} 个项目。`);
      closeEditor(session);
    }
  });
  useEffect(() => {
    const session = active.current;
    if (!session?.requestId || session.finished) return;
    const task = state.operations.tasks.find(task => task.requestId === session.requestId);
    if (task) observe(session, task);
  }, [state.operations.tasks]);

  const poll = useEffectEvent((session: ActiveSession) => {
    if (!current(session) || session.finished || !session.requestId) return;
    clearTimeout(session.pollTimer);
    session.pollTimer = setTimeout(async () => {
      if (!current(session) || session.finished) return;
      try {
        const snapshot = await gateway.listOperationTasks();
        if (!current(session) || session.finished) return;
        const task = snapshot.tasks.find(task => task.requestId === session.requestId);
        if (task) { await projectTask(task); observe(session, task); }
        else if (session.applyError) {
          session.finished = true;
          dispatch({ type: "batchRenameFailed", payload: { id: session.id, message: session.applyError } });
        }
      } catch { /* Task events remain authoritative; a later poll can recover a missed event. */ }
      if (session.cancelRequested) void sendCancel(session);
      poll(session);
    }, 1200);
  });

  const sendCancel = useEffectEvent(async (session: ActiveSession) => {
    if (!current(session) || session.finished || !session.taskId || session.cancelSent) return;
    session.cancelSent = true;
    try {
      const task = await gateway.cancelOperation(session.taskId);
      if (!current(session)) return;
      await projectTask(task); observe(session, task);
    } catch (error) {
      if (!current(session) || session.finished) return;
      session.cancelSent = false; session.cancelRequested = false;
      dispatch({ type: "batchRenameCancelFailed", payload: { id: session.id, message: getErrorMessage(error, "取消请求未送达，请重试。") } });
    }
  });

  const drainPreview = useEffectEvent(async (session: ActiveSession) => {
    if (!current(session) || !session.sessionId || session.requestId || session.previewing || !session.previewReady) return;
    session.previewReady = false; session.previewing = true;
    const revision = session.revision, expression = session.expression;
    try {
      const preview = await gateway.batchRename.preview({ sessionId: session.sessionId, revision, expression });
      if (!current(session) || session.requestId || revision !== session.revision || preview.sessionId !== session.sessionId
        || preview.revision !== revision || preview.expression !== expression) return;
      session.preview = preview;
      dispatch({ type: "batchRenamePreviewReceived", payload: { id: session.id, preview } });
    } catch (error) {
      if (current(session) && !session.requestId && revision === session.revision) {
        dispatch({ type: "batchRenameFailed", payload: { id: session.id, revision, message: getErrorMessage(error, "无法预览名称。") } });
      }
    } finally {
      session.previewing = false;
      if (current(session) && session.previewReady) void drainPreview(session);
    }
  });

  const open = useEffectEvent(async (target: RenameTarget) => {
    if (!enabled || state.status !== "ready" || active.current || state.batchRename || !target.entries.length) return;
    if (target.entries.some(entry => isRemotePath(entry.path))) {
      notify("warning", "批量重命名目前支持本地文件和文件夹。"); return;
    }
    const session: ActiveSession = { id: crypto.randomUUID(), target, expression: "*", revision: 1,
      previewing: false, previewReady: false, taskSequence: -1, cancelRequested: false, cancelSent: false, finished: false };
    active.current = session;
    dispatch({ type: "batchRenameOpened", payload: { id: session.id, target, history: readBatchRenameHistory() } });
    try {
      const snapshot = await gateway.batchRename.create(target.entries.map(entry => entry.path));
      session.sessionId = snapshot.sessionId;
      if (!current(session)) { release(session); return; }
      dispatch({ type: "batchRenameSessionLoaded", payload: { id: session.id, session: snapshot } });
      session.previewReady = true; void drainPreview(session);
    } catch (error) {
      if (current(session)) dispatch({ type: "batchRenameFailed", payload: { id: session.id, message: getErrorMessage(error, "无法读取重命名项目。") } });
    }
  });

  const rename = useEffectEvent((target: RenameTarget | undefined, forceBatch = false) => {
    if (!target || !enabled || active.current || state.batchRename || state.status !== "ready") return;
    const tab = state.panels[target.panelId].tabs.find(tab => tab.id === target.tabId);
    if (tab?.kind !== "directory" || tab.inlineEdit) return;
    if (forceBatch || target.entries.length > 1) { void open(target); return; }
    const entry = target.entries[0];
    if (!entry) return;
    dispatch({ type: "contextMenuSet", payload: undefined });
    dispatch({ type: "inlineEditStarted", payload: { panelId: target.panelId, tabId: target.tabId,
      edit: { mode: "rename", value: entry.name, kind: entry.kind, parentPath: entry.parentPath,
        entryId: entry.id, originalName: entry.name, originalPath: entry.path } } });
  });
  const change = useEffectEvent((id: string, expression: string) => {
    const session = active.current;
    if (!session || session.id !== id || !session.sessionId || session.requestId || session.expression === expression) return;
    session.expression = expression; session.revision++; session.preview = undefined; session.previewReady = false;
    dispatch({ type: "batchRenameExpressionChanged", payload: { id, expression, revision: session.revision } });
    const revision = session.revision;
    void gateway.batchRename.invalidate({ sessionId: session.sessionId, revision }).catch(error => {
      if (current(session) && !session.requestId && !session.preview && session.revision === revision) {
        dispatch({ type: "batchRenameFailed", payload: { id, revision,
          message: getErrorMessage(error, "旧预览暂时无法取消，请等待最新预览。") } });
      }
    });
    clearTimeout(session.previewTimer);
    session.previewTimer = setTimeout(() => { session.previewReady = true; void drainPreview(session); }, 120);
  });
  const confirm = useEffectEvent(async (id: string) => {
    const session = active.current, dialog = state.batchRename;
    if (!session || session.id !== id || session.requestId || !dialog || dialog.id !== id || !canConfirmBatchRename(dialog)
      || !session.preview?.canApply || !session.preview.previewId || session.preview.revision !== session.revision
      || session.preview.expression !== session.expression || !session.sessionId) return;
    session.requestId = crypto.randomUUID();
    dispatch({ type: "batchRenameApplyStarted", payload: { id, requestId: session.requestId } });
    poll(session);
    try {
      const task = await gateway.batchRename.apply({ sessionId: session.sessionId, previewId: session.preview.previewId,
        requestId: session.requestId, source: session.target.source, panelId: session.target.panelId, tabId: session.target.tabId });
      if (!current(session)) return;
      session.taskId = task.taskId;
      await projectTask(task); observe(session, task);
      if (session.cancelRequested) void sendCancel(session);
    } catch (error) {
      if (!current(session) || session.finished) return;
      // The queued task may have reached the backend even if its reply was lost.
      // Reconcile the request ID with the task store before permitting a close.
      session.applyError = getErrorMessage(error, "重命名未能开始。请关闭后重新预览。");
      poll(session);
    }
  });
  const close = useEffectEvent((id: string) => {
    const session = active.current;
    if (!session || session.id !== id) return;
    if (session.requestId && !session.finished) {
      session.cancelRequested = true;
      dispatch({ type: "batchRenameCancelling", payload: { id } });
      void sendCancel(session);
    } else closeEditor(session);
  });
  const help = useEffectEvent(async () => {
    try { await (openHelp ? openHelp() : openBatchRenameHelpWindow()); }
    catch (error) { notify("danger", getErrorMessage(error, "无法打开批量重命名帮助。")); }
  });
  const prepareSelectionRestore = useEffectEvent((task: OperationTaskSnapshot) => {
    const session = active.current;
    if (!session || session.selectionQueued || session.requestId !== task.requestId || !isTerminalOperationTask(task)) return;
    session.selectionQueued = true;
    const paths = task.entryResults.flatMap(result => result.source?.kind === "local" && result.destination?.kind === "local"
      && result.error?.retryable !== false ? [result.destination.path] : []);
    if (paths.length) dispatch({ type: "batchRenameSelectionQueued", payload: { id: session.id, paths } });
  });
  return { rename, prepareSelectionRestore, actions: { changeBatchRename: change, confirmBatchRename: confirm,
    closeBatchRename: close, openBatchRenameHelp: help } };
}

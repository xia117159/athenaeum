import assert from "node:assert/strict";
import React, { act, useCallback, useState } from "react";
import { useBatchRenameController } from "./useBatchRenameController";
import { createWorkspaceState, workspaceReducer, type WorkspaceAction } from "./workspaceReducer";
import { createMockWorkspaceBootstrap } from "./mockData";
import { createEntry, createTestGateway, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import { expansionInteractions } from "./folderExpansionTestSupport";
import type { BatchRenameSession, BatchRenamePreview, PreviewBatchRenameRequest, ApplyBatchRenameRequest } from "../../app/batchRename";
import type { OperationTaskSnapshot } from "../../app/types";
import type { RenameTarget } from "./batchRenameState";
import { readBatchRenameHistory } from "./batchRenameHistory";
import { BatchRenameDialog } from "./BatchRenameDialog";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
export const completion = (async () => {
  installDomEnvironment();
  const ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  const initial = createWorkspaceState(createMockWorkspaceBootstrap("tauri"));
  const tab = initial.panels["panel-1"].tabs[0];
  const entry = createEntry(tab.snapshot.location.path, "Test.txt");
  tab.snapshot.entries = [entry]; tab.selectedEntryIds = [entry.id];
  const target: RenameTarget = { panelId: "panel-1", tabId: tab.id, rootPath: tab.snapshot.location.path, selectionRevision: 0, entries: [entry], source: "shortcut" };
  const gateway = createTestGateway(() => {}, expansionInteractions());
  const creates: ReturnType<typeof deferred<BatchRenameSession>>[] = [];
  const previews: Array<{ request: PreviewBatchRenameRequest; result: ReturnType<typeof deferred<BatchRenamePreview>> }> = [];
  const applies: Array<{ request: ApplyBatchRenameRequest; result: ReturnType<typeof deferred<OperationTaskSnapshot>> }> = [];
  const closed: string[] = [], cancels: string[] = [], notices: string[] = [];
  const invalidations: Array<{ sessionId: string; revision: number }> = [];
  gateway.batchRename.invalidate = async request => { invalidations.push(request); };
  gateway.batchRename.create = () => { const pending = deferred<BatchRenameSession>(); creates.push(pending); return pending.promise; };
  gateway.batchRename.preview = request => { const result = deferred<BatchRenamePreview>(); previews.push({ request, result }); return result.promise; };
  gateway.batchRename.apply = request => { const result = deferred<OperationTaskSnapshot>(); applies.push({ request, result }); return result.promise; };
  gateway.batchRename.close = async id => { closed.push(id); };
  const task = (index: number, status: OperationTaskSnapshot["status"], sequence: number): OperationTaskSnapshot => ({
    taskId: `task-${index}`, requestId: applies[index].request.requestId, kind: "rename", label: "批量重命名", status,
    createdAt: "2026-09-12", updatedAt: "2026-09-12", totalEntries: 1, completedEntries: status === "succeeded" ? 1 : 0,
    failedEntries: 0, completedBytes: 0, affectedRoots: [], entryResults: [], cancelable: status === "running", undoable: false, sequence
  });
  gateway.cancelOperation = async id => {
    cancels.push(id);
    if (cancels.length === 1) throw new Error("取消请求未送达，请重试");
    return task(0, "cancelling", 2);
  };
  let state = initial;
  let dispatch!: (action: WorkspaceAction) => void;
  let api!: ReturnType<typeof useBatchRenameController>;
  function Harness() {
    const [value, set] = useState(initial); state = value;
    dispatch = useCallback(action => set(previous => workspaceReducer(previous, action)), []);
    api = useBatchRenameController({ state: value, dispatch, gateway, enabled: true,
      projectTask: async task => { dispatch({ type: "operationTaskEventReceived", payload: task }); },
      notify: (_intent, message) => notices.push(message) });
    return value.batchRename ? React.createElement(BatchRenameDialog, { dialog: value.batchRename,
      onChange: api.actions.changeBatchRename, onConfirm: api.actions.confirmBatchRename,
      onClose: api.actions.closeBatchRename, onHelp: api.actions.openBatchRenameHelp }) : null;
  }
  const root = ReactDOM.createRoot(document.getElementById("root")!);
  const tick = async (fn: () => void, delay = 0) => act(async () => { fn(); await flushEffects(); if (delay) await new Promise(done => setTimeout(done, delay)); });
  const dialog = () => state.batchRename!;
  const session = (id: string): BatchRenameSession => ({ sessionId: id, frozenAt: "2026-09-12", items: [] });
  const resolvePreview = (index: number, canApply = true) => previews[index].result.resolve({ ...previews[index].request,
    previewId: canApply ? `preview-${index}` : null, canApply, changedCount: canApply ? 1 : 0, diagnostics: [], items: [] });
  try {
    await tick(() => root.render(React.createElement(Harness)));
    await tick(() => { api.rename(target, true); api.rename(target, true); });
    assert.equal(creates.length, 1, "double opening is fenced synchronously");
    await tick(() => api.actions.closeBatchRename(dialog().id));
    await tick(() => api.rename(target, true));
    const currentId = dialog().id;
    await tick(() => creates[0].resolve(session("stale")));
    assert.deepEqual(closed, ["stale"]); assert.equal(dialog().id, currentId);
    await tick(() => creates[1].resolve(session("current")));
    await tick(() => resolvePreview(0, false));
    await tick(() => api.actions.changeBatchRename(currentId, "First"), 140);
    assert.equal(previews.length, 2);
    await tick(() => { api.actions.changeBatchRename(currentId, "Final"); void api.actions.confirmBatchRename(currentId); }, 140);
    assert.equal(applies.length, 0);
    assert.equal(previews.length, 2, "only one calculation is in flight");
    assert.deepEqual(invalidations.at(-1), { sessionId: "current", revision: dialog().revision },
      "new input reaches the server before the old preview settles");
    await tick(() => resolvePreview(1));
    assert.equal(dialog().preview, undefined, "late preview cannot enable confirmation");
    assert.equal(previews.length, 3); assert.equal(previews[2].request.expression, "Final");
    await tick(() => resolvePreview(2));
    await tick(() => { void api.actions.confirmBatchRename(currentId); void api.actions.confirmBatchRename(currentId); });
    assert.equal(applies.length, 1); assert.equal(applies[0].request.previewId, "preview-2");
    await tick(() => api.actions.changeBatchRename(currentId, "Too late")); assert.equal(dialog().expression, "Final");
    await tick(() => api.actions.closeBatchRename(currentId)); assert.equal(dialog().phase, "cancelling");
    assert.equal(cancels.length, 0);
    await tick(() => applies[0].result.resolve(task(0, "running", 1)));
    assert.deepEqual(cancels, ["task-0"]); assert.equal(dialog().phase, "running");
    assert.match(document.querySelector(".batch-rename__message")?.textContent ?? "", /取消请求未送达，请重试/);
    assert.equal(document.querySelector<HTMLButtonElement>('[data-action="cancel-rename"]')!.disabled, false);
    await tick(() => api.actions.closeBatchRename(currentId));
    assert.deepEqual(cancels, ["task-0", "task-0"]); assert.equal(dialog().phase, "cancelling");
    assert.equal(dialog().error, undefined, "a retry clears the previous cancellation failure");
    assert.doesNotMatch(document.querySelector(".batch-rename__message")?.textContent ?? "", /未送达/);
    await tick(() => dispatch({ type: "operationTaskEventReceived", payload: task(0, "cancelled", 3) }));
    assert.equal(dialog().phase, "finished"); assert.deepEqual(readBatchRenameHistory(), []);
    await tick(() => api.actions.closeBatchRename(currentId));
    await tick(() => api.rename(target, true));
    await tick(() => creates[2].resolve(session("success")));
    await tick(() => resolvePreview(3, false));
    await tick(() => api.actions.changeBatchRename(dialog().id, "Success"), 140);
    await tick(() => resolvePreview(4));
    await tick(() => { void api.actions.confirmBatchRename(dialog().id); });
    const success = task(1, "succeeded", 10);
    await tick(() => dispatch({ type: "operationTaskEventReceived", payload: success }));
    assert.equal(state.batchRename, undefined);
    await tick(() => applies[1].result.resolve(task(1, "running", 1)));
    assert.equal(state.batchRename, undefined, "a late apply response cannot reopen a completed dialog");
    assert.deepEqual(readBatchRenameHistory(), ["Success"]); assert.equal(notices.length, 1);
    console.log("ok - batch controller coalesces previews, fences late work, waits for cancellation and stores success once");
  } finally { await tick(() => root.unmount()); }
})();

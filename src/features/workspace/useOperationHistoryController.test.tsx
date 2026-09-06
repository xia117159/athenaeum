import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import type { OperationClearOutcome, OperationHistoryEventEnvelope, OperationTaskEventEnvelope } from "../../app/types";
import { useOperationHistoryController } from "./useOperationHistoryController";
import type { WorkspaceGateway } from "./workspaceGateway";
import { createTestGateway, installDomEnvironment } from "./workspaceControllerTestHarness";

function emptyInteractions() {
  return {
    resolvedPaths: [], copyCalls: [], moveCalls: [], deleteCalls: [], renameCalls: [], createDirectoryCalls: [],
    createFileCalls: [], treeLoadPaths: [], savedDetailsRowHeights: [], nativeContextMenus: []
  };
}

export const completion = (async () => {
  const dom = installDomEnvironment();
  const container = document.getElementById("root")!;
  const root = ReactDOM.createRoot(container);
  const calls: string[] = [];
  let taskHandler: ((event: OperationTaskEventEnvelope) => void) | undefined;
  let historyHandler: ((event: OperationHistoryEventEnvelope) => void) | undefined;
  let clearHandler: ((event: OperationClearOutcome) => void) | undefined;
  let protectedIds = ["protected-1", "protected-2"];
  let removedRecordIds: string[] = [];
  const base = createTestGateway(() => undefined, emptyInteractions());
  const gateway: WorkspaceGateway = {
    ...base,
    async listenOperationTasks(handler) { calls.push("listen-task"); taskHandler = handler; return () => calls.push("dispose-task"); },
    async listenOperationHistory(handler) { calls.push("listen-history"); historyHandler = handler; return () => calls.push("dispose-history"); },
    async listenOperationRecordsCleared(handler) { calls.push("listen-clear"); clearHandler = handler; return () => calls.push("dispose-clear"); },
    async listOperationTasks() { calls.push("list-task"); return { tasks: [], taskSequence: 0 }; },
    async listOperationHistory() { calls.push("list-history"); return { records: [], historySequence: 0 }; },
    async clearOperationRecords() {
      return {
        status: "cleared", eligibleUndoableCount: 0, removedTaskIds: [], removedRecordIds,
        taskClearWatermark: 0, historyClearWatermark: 0,
        protectedRecordIds: protectedIds, cleanupWarnings: []
      };
    }
  };
  let controller: ReturnType<typeof useOperationHistoryController> | undefined;
  function Probe() {
    controller = useOperationHistoryController(gateway);
    return null;
  }

  try {
    await act(async () => {
      root.render(<Probe />);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(calls.slice(0, 5), ["listen-task", "listen-history", "listen-clear", "list-task", "list-history"]);
    assert.equal(controller?.loading, false);
    assert.ok(taskHandler && historyHandler && clearHandler);
    await act(async () => {
      await controller?.clear("all");
    });
    assert.equal(controller?.clearNotice, "\u5df2\u4fdd\u7559 2 \u6761\u6b63\u5728\u5904\u7406\u7684\u8bb0\u5f55");
    protectedIds = ["protected-partial"];
    removedRecordIds = ["removed-record"];
    await act(async () => {
      await controller?.clear("all");
    });
    assert.equal(controller?.clearNotice, "\u5df2\u4fdd\u7559 1 \u6761\u6b63\u5728\u5904\u7406\u7684\u8bb0\u5f55");
    protectedIds = [];
    removedRecordIds = [];
    await act(async () => {
      await controller?.clear("all");
    });
    assert.equal(controller?.clearNotice, "\u6ca1\u6709\u53ef\u6e05\u7406\u7684\u8bb0\u5f55");
  } finally {
    await act(async () => root.unmount());
    assert.equal(calls.includes("dispose-task"), true);
    assert.equal(calls.includes("dispose-history"), true);
    assert.equal(calls.includes("dispose-clear"), true);
  }

  const delayedContainer = document.createElement("div");
  document.body.appendChild(delayedContainer);
  const delayedRoot = ReactDOM.createRoot(delayedContainer);
  let resolveTaskListener: ((dispose: () => void) => void) | undefined;
  let delayedDisposeCount = 0;
  let delayedListCount = 0;
  const delayedGateway: WorkspaceGateway = {
    ...base,
    listenOperationTasks() {
      return new Promise((resolve) => { resolveTaskListener = resolve; });
    },
    async listenOperationHistory() { return () => undefined; },
    async listenOperationRecordsCleared() { return () => undefined; },
    async listOperationTasks() { delayedListCount += 1; return { tasks: [], taskSequence: 0 }; },
    async listOperationHistory() { delayedListCount += 1; return { records: [], historySequence: 0 }; }
  };
  function DelayedProbe() {
    useOperationHistoryController(delayedGateway);
    return null;
  }
  await act(async () => {
    delayedRoot.render(<DelayedProbe />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => delayedRoot.unmount());
  await act(async () => {
    resolveTaskListener?.(() => { delayedDisposeCount += 1; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(delayedDisposeCount, 1);
  assert.equal(delayedListCount, 0);
  delayedContainer.remove();
  dom.window.close();
  console.log("ok - operation history controller subscribes before snapshots and disposes all listeners");
})();

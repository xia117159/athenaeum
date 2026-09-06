import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import type { OperationClearRequest, OperationTaskSnapshot } from "../../app/types";
import { createEmptyOperationHistoryReadState, OPERATION_HISTORY_READ_STORAGE_KEY } from "./operationHistoryReadStore";
import { OperationHistoryWindowView } from "./OperationHistoryWindowView";
import type { OperationHistoryReadEnvironment } from "./useOperationHistoryReadState";
import type { WorkspaceGateway } from "./workspaceGateway";
import { createTestGateway, installDomEnvironment } from "./workspaceControllerTestHarness";

function task(taskId: string, status: OperationTaskSnapshot["status"], sequence: number): OperationTaskSnapshot {
  const now = "2026-01-01T00:00:00Z";
  return {
    taskId, requestId: taskId, kind: "copy", label: taskId, status, createdAt: now, startedAt: now,
    finishedAt: null, totalEntries: 1, completedEntries: 0, failedEntries: 0, totalBytes: null,
    completedBytes: null, currentPath: null, message: null, cancelable: true, undoable: false,
    affectedRoots: [], entryResults: [], sequence, updatedAt: now
  };
}

export const completion = (async () => {
  const dom = installDomEnvironment();
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.Element = dom.window.Element;
  const container = document.getElementById("root")!;
  const root = ReactDOM.createRoot(container);
  let stored = JSON.stringify(createEmptyOperationHistoryReadState("active-only"));
  const readEnvironment: OperationHistoryReadEnvironment = {
    storage: {
      getItem(key) { return key === OPERATION_HISTORY_READ_STORAGE_KEY ? stored : null; },
      setItem(_key, value) { stored = value; }
    },
    createEpoch: () => "active-only",
    isForeground: () => true,
    async subscribe() { return () => undefined; },
    async notify() {},
    subscribeForeground() { return () => undefined; }
  };
  const requests: OperationClearRequest[] = [];
  const base = createTestGateway(() => undefined, {
    resolvedPaths: [], copyCalls: [], moveCalls: [], deleteCalls: [], renameCalls: [], createDirectoryCalls: [],
    createFileCalls: [], treeLoadPaths: [], savedDetailsRowHeights: [], nativeContextMenus: []
  });
  const activeTasks = [task("running", "running", 1), task("waiting", "waitingConflict", 2)];
  const gateway: WorkspaceGateway = {
    ...base,
    async listOperationTasks() { return { tasks: activeTasks, taskSequence: 2 }; },
    async listOperationHistory() { return { records: [], historySequence: 0 }; },
    async clearOperationRecords(request) {
      requests.push(request);
      return {
        status: "cleared", eligibleUndoableCount: 0, removedTaskIds: [], removedRecordIds: [],
        taskClearWatermark: 2, historyClearWatermark: 0, protectedRecordIds: [], cleanupWarnings: []
      };
    }
  };

  try {
    await act(async () => {
      root.render(<OperationHistoryWindowView gateway={gateway} readEnvironment={readEnvironment} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const clearButton = container.querySelector<HTMLButtonElement>("[aria-haspopup=menu]")!;
    assert.equal(clearButton.disabled, false);
    await act(async () => {
      clearButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const items = Array.from(container.querySelectorAll<HTMLButtonElement>("[role=menuitem]"));
    assert.equal(items[0].disabled, true);
    assert.equal(items[1].disabled, false);
    await act(async () => {
      items[1].click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(requests, [{ scope: "all", confirmUndoLoss: false }]);
    assert.equal(container.textContent?.includes("\u6ca1\u6709\u53ef\u6e05\u7406\u7684\u8bb0\u5f55"), true);
    assert.equal(container.textContent?.includes("2 \u4e2a\u4efb\u52a1"), true);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
  console.log("ok - active-only operation history keeps Clear All available without removing active rows");
})();

import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import type { OperationClearOutcome, OperationClearRequest, OperationHistoryRecord, OperationTaskSnapshot } from "../../app/types";
import { createEmptyOperationHistoryReadState, OPERATION_HISTORY_READ_STORAGE_KEY } from "./operationHistoryReadStore";
import { OperationHistoryWindowView } from "./OperationHistoryWindowView";
import type { OperationHistoryReadEnvironment } from "./useOperationHistoryReadState";
import type { WorkspaceGateway } from "./workspaceGateway";
import { createTestGateway, installDomEnvironment } from "./workspaceControllerTestHarness";

function task(taskId: string, status: OperationTaskSnapshot["status"], sequence: number): OperationTaskSnapshot {
  const now = `2026-01-0${sequence}T00:00:00Z`;
  return {
    taskId, requestId: taskId, kind: "copy", label: taskId, status, createdAt: now, startedAt: now,
    finishedAt: ["succeeded", "failed", "partialSucceeded", "cancelled"].includes(status) ? now : null,
    totalEntries: 1, completedEntries: 1, failedEntries: status === "failed" ? 1 : 0, totalBytes: null,
    completedBytes: null, currentPath: null, message: null, cancelable: status === "running", undoable: status === "succeeded",
    affectedRoots: [], entryResults: [], sequence, updatedAt: now
  };
}

function history(): OperationHistoryRecord {
  const now = "2026-01-04T00:00:00Z";
  return {
    recordId: "history-undoable", taskId: "done", kind: "copy", label: "Undoable copy", status: "undoable",
    createdAt: now, updatedAt: now, undoTaskId: null, blockedReason: null, payloadExpiresAt: null, affectedRoots: []
  };
}

export const completion = (async () => {
  const dom = installDomEnvironment();
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.Element = dom.window.Element;
  globalThis.Event = dom.window.Event;
  const container = document.getElementById("root")!;
  const root = ReactDOM.createRoot(container);
  let stored = JSON.stringify(createEmptyOperationHistoryReadState("test-epoch"));
  const readEnvironment: OperationHistoryReadEnvironment = {
    storage: {
      getItem(key) { return key === OPERATION_HISTORY_READ_STORAGE_KEY ? stored : null; },
      setItem(_key, value) { stored = value; }
    },
    createEpoch: () => "test-epoch",
    isForeground: () => true,
    async subscribe() { return () => undefined; },
    async notify() {},
    subscribeForeground() { return () => undefined; }
  };
  const clearRequests: OperationClearRequest[] = [];
  let resolveConfirmedClear: ((outcome: OperationClearOutcome) => void) | undefined;
  const base = createTestGateway(() => undefined, {
    resolvedPaths: [], copyCalls: [], moveCalls: [], deleteCalls: [], renameCalls: [], createDirectoryCalls: [],
    createFileCalls: [], treeLoadPaths: [], savedDetailsRowHeights: [], nativeContextMenus: []
  });
  const tasks = [task("running", "running", 1), task("waiting", "waitingConflict", 2), task("problem", "failed", 3), task("done", "succeeded", 4)];
  const gateway: WorkspaceGateway = {
    ...base,
    async listOperationTasks() { return { tasks, taskSequence: 4 }; },
    async listOperationHistory() { return { records: [history()], historySequence: 1 }; },
    async clearOperationRecords(request) {
      clearRequests.push(request);
      if (request.scope === "problems") {
        return {
          status: "cleared", eligibleUndoableCount: 0, removedTaskIds: [], removedRecordIds: ["failed-history"],
          taskClearWatermark: 4, historyClearWatermark: 2,
          protectedRecordIds: ["protected-partial"], cleanupWarnings: []
        };
      }
      if (!request.confirmUndoLoss) {
        return {
          status: "confirmationRequired", eligibleUndoableCount: 1, removedTaskIds: [], removedRecordIds: [],
          taskClearWatermark: 4, historyClearWatermark: 1, protectedRecordIds: [], cleanupWarnings: []
        };
      }
      return new Promise<OperationClearOutcome>((resolve) => {
        resolveConfirmedClear = resolve;
      });
    }
  };

  try {
    await act(async () => {
      root.render(<OperationHistoryWindowView gateway={gateway} readEnvironment={readEnvironment} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>("[role=tab]"));
    assert.equal(tabs.length, 5);
    assert.equal(container.querySelectorAll("[role=tabpanel]").length, 1);
    assert.equal(tabs[0].querySelector(".status-badge"), null);
    assert.equal(tabs[2].querySelector(".status-badge")?.textContent, "1");

    await act(async () => {
      tabs[2].click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(tabs[2].getAttribute("aria-selected"), "true");
    assert.equal(tabs[2].querySelector(".status-badge"), null);
    assert.ok(tabs[3].querySelector(".status-badge"));

    const clearButton = container.querySelector<HTMLButtonElement>("[aria-haspopup=menu]")!;
    await act(async () => {
      clearButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    let clearItems = Array.from(container.querySelectorAll<HTMLButtonElement>("[role=menuitem]"));
    await act(async () => {
      clearItems[0].click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(clearRequests[0], { scope: "problems", confirmUndoLoss: false });
    assert.equal(container.querySelector("[role=menu]"), null);
    assert.equal(document.activeElement === clearButton, true);
    assert.equal(container.textContent?.includes("\u5df2\u4fdd\u7559 1 \u6761\u6b63\u5728\u5904\u7406\u7684\u8bb0\u5f55"), true);

    await act(async () => {
      tabs[2].dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(tabs[4].getAttribute("aria-selected"), "true");

    await act(async () => {
      clearButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    clearItems = Array.from(container.querySelectorAll<HTMLButtonElement>("[role=menuitem]"));
    assert.equal(document.activeElement === clearItems[0], true);
    await act(async () => {
      clearItems[0].dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    assert.equal(document.activeElement === clearItems[1], true);
    await act(async () => {
      clearItems[1].dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    assert.equal(document.activeElement === clearItems[0], true);
    await act(async () => {
      clearItems[0].dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.equal(container.querySelector("[role=menu]"), null);
    assert.equal(document.activeElement === clearButton, true);

    await act(async () => {
      clearButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    clearItems = Array.from(container.querySelectorAll<HTMLButtonElement>("[role=menuitem]"));
    const clearCurrent = clearItems[0];
    await act(async () => {
      clearCurrent.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const dialog = container.querySelector<HTMLElement>("[role=alertdialog]");
    assert.ok(dialog);
    assert.equal(document.activeElement?.textContent, "\u53d6\u6d88");
    assert.deepEqual(clearRequests[1], { scope: "history", confirmUndoLoss: false });
    await act(async () => {
      dialog.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    });
    assert.equal(document.activeElement?.textContent?.includes("\u6c38\u4e45\u6e05\u7406"), true);
    await act(async () => {
      document.activeElement?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    assert.equal(document.activeElement?.textContent, "\u53d6\u6d88");
    await act(async () => {
      window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(container.querySelector("[role=alertdialog]"), null);
    assert.equal(document.activeElement === clearCurrent, true);

    await act(async () => {
      clearCurrent.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const confirmedDialog = container.querySelector<HTMLElement>("[role=alertdialog]")!;
    await act(async () => {
      const confirmButton = confirmedDialog.querySelectorAll<HTMLButtonElement>("button")[1];
      confirmButton.click();
      confirmButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(clearRequests[2], { scope: "history", confirmUndoLoss: false });
    assert.deepEqual(clearRequests[3], { scope: "history", confirmUndoLoss: true });
    assert.equal(clearRequests.length, 4);
    assert.equal(confirmedDialog.getAttribute("aria-busy"), "true");
    assert.equal(document.activeElement === confirmedDialog, true);
    await act(async () => {
      resolveConfirmedClear?.({
        status: "cleared", eligibleUndoableCount: 1, removedTaskIds: ["done"],
        removedRecordIds: ["history-undoable"], taskClearWatermark: 5, historyClearWatermark: 2,
        protectedRecordIds: [], cleanupWarnings: []
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(container.querySelector("[role=alertdialog]"), null);
    assert.equal(document.activeElement === clearButton, true);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
  console.log("ok - operation history native view provides tabs, unread badges, keyboard navigation, and confirmed clearing");
})();

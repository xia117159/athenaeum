import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { OperationHistoryRow, OperationSummaryButton, OperationTaskRow } from "./OperationTaskCenter";
import { installLegacyInputEventPatch } from "./testDom";
import type { OperationHistoryRecord, OperationTaskSnapshot, OperationWorkspaceState } from "./types";

const { JSDOM } = require("jsdom") as { JSDOM: new (html?: string, options?: { url?: string }) => { window: Window & typeof globalThis } };

function task(status: OperationTaskSnapshot["status"], overrides: Partial<OperationTaskSnapshot> = {}): OperationTaskSnapshot {
  const now = "2026-06-10T08:00:00.000Z";
  return {
    taskId: `task-${status}`,
    requestId: `request-${status}`,
    kind: "copy",
    label: "Report copy",
    status,
    createdAt: now,
    startedAt: now,
    finishedAt: status === "running" ? null : now,
    totalEntries: 3,
    completedEntries: 1,
    failedEntries: 0,
    totalBytes: null,
    completedBytes: null,
    currentPath: null,
    message: null,
    cancelable: true,
    undoable: status === "succeeded",
    affectedRoots: [],
    entryResults: [],
    sequence: 1,
    updatedAt: now,
    ...overrides
  };
}

function history(status: OperationHistoryRecord["status"]): OperationHistoryRecord {
  const now = "2026-06-10T08:00:00.000Z";
  return {
    recordId: `record-${status}`,
    taskId: "task-succeeded",
    kind: "copy",
    label: "Report copy",
    status,
    createdAt: now,
    updatedAt: now,
    undoTaskId: null,
    blockedReason: null,
    payloadExpiresAt: null,
    affectedRoots: []
  };
}

function operations(tasks: OperationTaskSnapshot[], historyRecords: OperationHistoryRecord[] = []): OperationWorkspaceState {
  return {
    tasks,
    taskSequence: Math.max(0, ...tasks.map((item) => item.sequence)),
    taskSnapshotSequence: Math.max(0, ...tasks.map((item) => item.sequence)),
    history: historyRecords,
    historySequence: historyRecords.length,
    historySnapshotSequence: historyRecords.length,
    historyRecordSequences: {},
    taskClearTombstones: {},
    historyClearTombstones: {}
  };
}

export const completion = (async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://localhost" });
  globalThis.window = dom.window as typeof globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Element = dom.window.Element;
  globalThis.Node = dom.window.Node;
  globalThis.Event = dom.window.Event;
  globalThis.CustomEvent = dom.window.CustomEvent;
  installLegacyInputEventPatch(dom);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.getElementById("root")!;
  const root = ReactDOM.createRoot(container);

  try {
    let opened = 0;
    await act(async () => {
      root.render(<OperationSummaryButton operations={operations([task("failed")])} onOpen={() => { opened += 1; }} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const button = container.querySelector<HTMLButtonElement>(".operation-summary-button")!;
    assert.equal(button.querySelector(".status-badge")?.textContent, "1");
    assert.equal((button.querySelector<HTMLElement>(".status-badge")?.style as CSSStyleDeclaration).getPropertyValue("--status-badge-background"), "#c42b1c");
    assert.match(button.getAttribute("aria-label") ?? "", /1/u);
    button.click();
    assert.equal(opened, 1);

    const failed = task("failed", {
      message: "Copy failed",
      currentPath: "C:\\target\\broken.txt",
      affectedRoots: [{ kind: "local", path: "C:\\target" }],
      entryResults: [{
        entryResultId: "entry-error",
        source: { kind: "local", path: "C:\\broken.txt" },
        destination: null,
        kind: "failed",
        error: { code: "permissionDenied", message: "Permission denied", path: null, retryable: false, source: "localFs" }
      }]
    });
    await act(async () => {
      root.render(<OperationTaskRow task={failed} onCancelTask={() => undefined} />);
    });
    assert.match(container.textContent ?? "", /Copy failed/u);
    assert.match(container.textContent ?? "", /Permission denied/u);
    assert.match(container.textContent ?? "", /C:\\target\\broken\.txt/u);

    let undoRecordId = "";
    await act(async () => {
      root.render(<OperationHistoryRow record={history("undoable")} onUndoRecord={(id) => { undoRecordId = id; }} />);
    });
    container.querySelector<HTMLButtonElement>("button")?.click();
    assert.equal(undoRecordId, "record-undoable");

    assert.equal(document.querySelector(".operation-dialog-backdrop"), null);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
  console.log("ok - operation summary badge and reusable operation rows render without an in-app modal");
})();

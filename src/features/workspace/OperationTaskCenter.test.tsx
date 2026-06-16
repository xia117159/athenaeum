import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { OperationHistoryPanelContent, OperationSummaryButton } from "./OperationTaskCenter";
import { installLegacyInputEventPatch } from "./testDom";
import type { OperationHistoryRecord, OperationTaskSnapshot, OperationWorkspaceState } from "./types";

const { JSDOM } = require("jsdom") as {
  JSDOM: new (
    html?: string,
    options?: {
      url?: string;
    }
  ) => {
    window: Window & typeof globalThis;
  };
};

function assertTest(name: string, fn: () => Promise<void>) {
  return fn()
    .then(() => {
      console.log(`ok - ${name}`);
    })
    .catch((error) => {
      console.error(`not ok - ${name}`);
      throw error;
    });
}

function installDomEnvironment() {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost"
  });

  globalThis.window = dom.window as typeof globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLInputElement = dom.window.HTMLInputElement;
  globalThis.Element = dom.window.Element;
  globalThis.Node = dom.window.Node;
  globalThis.Event = dom.window.Event;
  installLegacyInputEventPatch(dom);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  return dom;
}

async function flushEffects() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createTask(status: OperationTaskSnapshot["status"]): OperationTaskSnapshot {
  const now = "2026-06-10T08:00:00.000Z";
  return {
    taskId: `task-${status}`,
    requestId: `request-${status}`,
    kind: "copy",
    label: "澶嶅埗椤圭洰",
    status,
    createdAt: now,
    startedAt: now,
    finishedAt: status === "running" ? null : now,
    totalEntries: 3,
    completedEntries: 1,
    failedEntries: 0,
    totalBytes: null,
    completedBytes: null,
    currentPath: "C:\\宸ヤ綔\\鎶ュ憡.docx",
    message: null,
    cancelable: true,
    undoable: status === "succeeded",
    affectedRoots: [{ kind: "local", path: "C:\\宸ヤ綔" }],
    entryResults: [],
    sequence: 1,
    updatedAt: now
  };
}

function createHistory(status: OperationHistoryRecord["status"]): OperationHistoryRecord {
  const now = "2026-06-10T08:00:00.000Z";
  return {
    recordId: `record-${status}`,
    taskId: "task-succeeded",
    kind: "copy",
    label: "澶嶅埗椤圭洰",
    status,
    createdAt: now,
    updatedAt: now,
    undoTaskId: null,
    blockedReason: null,
    payloadExpiresAt: null,
    affectedRoots: [{ kind: "local", path: "C:\\宸ヤ綔" }]
  };
}

function createOperations(): OperationWorkspaceState {
  return {
    tasksOpen: true,
    tasks: [createTask("running")],
    taskSequence: 1,
    history: [createHistory("undoable")],
    historySequence: 1
  };
}

export const completion = (async () => {
  const dom = installDomEnvironment();
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("test root container is missing");
  }

  const root = ReactDOM.createRoot(container);

  try {
    await assertTest("OperationHistoryPanelContent renders file operation history inside the information panel tab", async () => {
      await act(async () => {
        root.render(
          React.createElement(OperationHistoryPanelContent, {
            operations: createOperations(),
            onCancelTask: () => undefined,
            onUndoLatest: () => undefined,
            onUndoRecord: () => undefined
          })
        );
        await flushEffects();
      });

      const panel = container.querySelector(".operation-history-panel");
      assert.ok(panel);
      assert.equal(panel.querySelectorAll("button").length >= 3, true);
      assert.doesNotMatch(panel.textContent ?? "", /File Operations|Running|History|Undoable|items/u);
    });

    await assertTest("OperationSummaryButton is a fixed-size operation history icon button", async () => {
      let openCount = 0;
      await act(async () => {
        root.render(
          React.createElement(OperationSummaryButton, {
            operations: createOperations(),
            onOpen: () => {
              openCount += 1;
            }
          })
        );
        await flushEffects();
      });

      const button = container.querySelector<HTMLButtonElement>(".operation-summary-button");
      assert.ok(button);
      assert.equal(button.getAttribute("title"), "打开操作历史");
      assert.equal(button.getAttribute("aria-label"), "打开操作历史");
      assert.equal(button.textContent?.trim(), "1");
      assert.equal(button.querySelector("span"), null);
      button.click();
      assert.equal(openCount, 1);
      assert.doesNotMatch(button.textContent ?? "", /Operations/u);
    });
  } finally {
    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    dom.window.close();
  }
})();

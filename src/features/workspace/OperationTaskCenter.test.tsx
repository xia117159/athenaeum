import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { OperationConflictDialog, OperationHistoryPanelContent, OperationSummaryButton } from "./OperationTaskCenter";
import type { OperationConflictDialogState, OperationHistoryRecord, OperationTaskSnapshot, OperationWorkspaceState } from "./types";

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
  globalThis.Element = dom.window.Element;
  globalThis.Node = dom.window.Node;
  globalThis.Event = dom.window.Event;
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
    label: "复制项目",
    status,
    createdAt: now,
    startedAt: now,
    finishedAt: status === "running" ? null : now,
    totalEntries: 3,
    completedEntries: 1,
    failedEntries: 0,
    totalBytes: null,
    completedBytes: null,
    currentPath: "C:\\工作\\报告.docx",
    message: null,
    cancelable: true,
    undoable: status === "succeeded",
    affectedRoots: [{ kind: "local", path: "C:\\工作" }],
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
    label: "复制项目",
    status,
    createdAt: now,
    updatedAt: now,
    undoTaskId: null,
    blockedReason: null,
    payloadExpiresAt: null,
    affectedRoots: [{ kind: "local", path: "C:\\工作" }]
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

function createConflictDialog(): OperationConflictDialogState {
  return {
    request: {
      conflictId: "conflict-1",
      taskId: "task-running",
      createdAt: "2026-06-10T08:00:00.000Z",
      source: { kind: "local", path: "C:\\来源\\报告.docx" },
      destination: { kind: "local", path: "C:\\目标\\报告.docx" },
      existingKind: "file",
      incomingKind: "file",
      suggestedName: "报告 (2).docx",
      allowedResolutions: ["replace", "skip", "keepBoth", "rename", "mergeDirectory"],
      message: "目标位置已存在同名项目。"
    },
    renameValue: "报告 (2).docx",
    selectedResolution: "rename",
    applyToAll: false,
    resolving: false
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
      assert.equal(panel.getAttribute("aria-label"), "操作历史");
      assert.match(panel.textContent ?? "", /文件操作/u);
      assert.match(panel.textContent ?? "", /1 个任务，1 条历史记录/u);
      assert.match(panel.textContent ?? "", /进行中/u);
      assert.match(panel.textContent ?? "", /正在运行/u);
      assert.match(panel.textContent ?? "", /1\/3 项/u);
      assert.match(panel.textContent ?? "", /操作历史/u);
      assert.match(panel.textContent ?? "", /可撤销/u);
      assert.doesNotMatch(panel.textContent ?? "", /File Operations|Running|History|Undoable|items/u);
      assert.equal(container.querySelector("[title='撤销最近操作']")?.getAttribute("aria-label"), "撤销最近操作");
      assert.equal(container.querySelector("[title='取消任务']")?.getAttribute("aria-label"), "取消任务");
      assert.equal(container.querySelector("[title='撤销操作']")?.getAttribute("aria-label"), "撤销操作");
    });

    await assertTest("OperationConflictDialog renders conflict workflow controls in Chinese", async () => {
      await act(async () => {
        root.render(
          React.createElement(OperationConflictDialog, {
            dialog: createConflictDialog(),
            onUpdate: () => undefined,
            onResolve: () => undefined,
            onCancelTask: () => undefined
          })
        );
        await flushEffects();
      });

      const dialog = container.querySelector(".operation-conflict-dialog");
      assert.ok(dialog);
      assert.match(dialog.textContent ?? "", /名称冲突/u);
      assert.match(dialog.textContent ?? "", /来源/u);
      assert.match(dialog.textContent ?? "", /目标/u);
      assert.match(dialog.textContent ?? "", /替换/u);
      assert.match(dialog.textContent ?? "", /跳过/u);
      assert.match(dialog.textContent ?? "", /保留两者/u);
      assert.match(dialog.textContent ?? "", /重命名/u);
      assert.match(dialog.textContent ?? "", /合并文件夹/u);
      assert.match(dialog.textContent ?? "", /新名称/u);
      assert.match(dialog.textContent ?? "", /对本次任务中剩余冲突应用相同决定/u);
      assert.match(dialog.textContent ?? "", /取消任务/u);
      assert.match(dialog.textContent ?? "", /处理/u);
      assert.equal(container.querySelector(".operation-conflict-dialog__choices")?.getAttribute("aria-label"), "冲突处理方式");
      assert.doesNotMatch(dialog.textContent ?? "", /Name conflict|Source|Destination|Replace|Skip|Keep both|Rename|Merge folder|Resolve/u);
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

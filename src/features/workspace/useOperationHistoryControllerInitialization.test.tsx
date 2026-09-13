import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import type {
  OperationHistoryEventEnvelope,
  OperationHistoryListSnapshot,
  OperationHistoryRecord,
  OperationTaskEventEnvelope,
  OperationTaskListSnapshot,
  OperationTaskSnapshot
} from "../../app/types";
import { useOperationHistoryController } from "./useOperationHistoryController";
import type { WorkspaceGateway } from "./workspaceGateway";
import { createTestGateway, installDomEnvironment } from "./workspaceControllerTestHarness";

function task(taskId: string, sequence: number): OperationTaskSnapshot {
  const now = "2026-01-01T00:00:00Z";
  return {
    taskId, requestId: taskId, kind: "copy", label: taskId, status: "failed", createdAt: now,
    startedAt: now, finishedAt: now, totalEntries: 1, completedEntries: 0, failedEntries: 1,
    totalBytes: null, completedBytes: null, currentPath: null, message: null, cancelable: false,
    undoable: false, affectedRoots: [], entryResults: [], sequence, updatedAt: now
  };
}

function history(recordId: string): OperationHistoryRecord {
  const now = "2026-01-01T00:00:00Z";
  return {
    recordId, taskId: recordId, kind: "copy", label: recordId, status: "failed", createdAt: now,
    updatedAt: now, undoTaskId: null, blockedReason: null, payloadExpiresAt: null, affectedRoots: []
  };
}

export const completion = (async () => {
  const dom = installDomEnvironment();
  const container = document.getElementById("root")!;
  const root = ReactDOM.createRoot(container);
  let taskHandler: ((event: OperationTaskEventEnvelope) => void) | undefined;
  let historyHandler: ((event: OperationHistoryEventEnvelope) => void) | undefined;
  let resolveTasks: ((snapshot: OperationTaskListSnapshot) => void) | undefined;
  let resolveHistory: ((snapshot: OperationHistoryListSnapshot) => void) | undefined;
  const base = createTestGateway(() => undefined, {
    resolvedPaths: [], copyCalls: [], moveCalls: [], deleteCalls: [], renameCalls: [], createDirectoryCalls: [],
    createFileCalls: [], treeLoadPaths: [], savedDetailsRowHeights: [], nativeContextMenus: []
  });
  const gateway: WorkspaceGateway = {
    ...base,
    async listenOperationTasks(handler) { taskHandler = handler; return () => undefined; },
    async listenOperationHistory(handler) { historyHandler = handler; return () => undefined; },
    async listenOperationRecordsCleared() { return () => undefined; },
    listOperationTasks() { return new Promise((resolve) => { resolveTasks = resolve; }); },
    listOperationHistory() { return new Promise((resolve) => { resolveHistory = resolve; }); }
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
    assert.ok(taskHandler && historyHandler && resolveTasks && resolveHistory);
    await act(async () => {
      taskHandler?.({ taskId: "event-task", sequence: 11, updatedAt: "2026-01-01T00:00:00Z", snapshot: task("event-task", 11) });
      historyHandler?.({ record: history("event-record"), historySequence: 11 });
      resolveTasks?.({ tasks: [task("snapshot-task", 7)], taskSequence: 10 });
      resolveHistory?.({ records: [history("snapshot-record")], historySequence: 10 });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(
      new Set(controller?.operations.tasks.map((item) => item.taskId)),
      new Set(["snapshot-task", "event-task"])
    );
    assert.deepEqual(
      new Set(controller?.operations.history.map((item) => item.recordId)),
      new Set(["snapshot-record", "event-record"])
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
  console.log("ok - operation history controller merges events received before initial snapshots");
})();

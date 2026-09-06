import assert from "node:assert/strict";
import type { OperationHistoryRecord, OperationTaskSnapshot, OperationWorkspaceState } from "./types";
import { formatOperationBadgeCount, projectOperationHistoryTabs } from "./operationHistoryModel";

function task(taskId: string, status: OperationTaskSnapshot["status"], sequence: number, updatedAt: string): OperationTaskSnapshot {
  return {
    taskId,
    requestId: `request-${taskId}`,
    kind: "copy",
    label: taskId,
    status,
    createdAt: updatedAt,
    startedAt: updatedAt,
    finishedAt: ["succeeded", "failed", "partialSucceeded", "cancelled"].includes(status) ? updatedAt : null,
    totalEntries: 1,
    completedEntries: 0,
    failedEntries: 0,
    totalBytes: null,
    completedBytes: null,
    currentPath: null,
    message: null,
    cancelable: true,
    undoable: false,
    affectedRoots: [],
    entryResults: [],
    sequence,
    updatedAt
  };
}

function history(recordId: string, taskId: string, status: OperationHistoryRecord["status"], updatedAt: string): OperationHistoryRecord {
  return {
    recordId,
    taskId,
    kind: "copy",
    label: recordId,
    status,
    createdAt: updatedAt,
    updatedAt,
    undoTaskId: null,
    blockedReason: null,
    payloadExpiresAt: null,
    affectedRoots: []
  };
}

const operations: OperationWorkspaceState = {
  tasks: [
    task("running", "running", 1, "2026-01-01T00:00:00Z"),
    task("waiting", "waitingConflict", 2, "2026-01-02T00:00:00Z"),
    task("failed", "failed", 3, "2026-01-03T00:00:00Z"),
    task("done", "succeeded", 4, "2026-01-04T00:00:00Z")
  ],
  taskSequence: 4,
  taskSnapshotSequence: 4,
  history: [
    history("duplicate-failure", "failed", "failed", "2026-01-03T01:00:00Z"),
    history("older-failure", "history-only", "failed", "2026-01-02T00:00:00Z"),
    history("newer-failure", "history-only", "failed", "2026-01-05T00:00:00Z"),
    history("undoable", "done", "undoable", "2026-01-04T00:00:00Z")
  ],
  historySequence: 4,
  historySnapshotSequence: 4,
  historyRecordSequences: {},
  taskClearTombstones: {},
  historyClearTombstones: {}
};

const tabs = projectOperationHistoryTabs(operations);
assert.deepEqual(tabs.running.map((item) => item.id), ["running"]);
assert.deepEqual(tabs.waiting.map((item) => item.id), ["waiting"]);
assert.deepEqual(tabs.problems.map((item) => item.id), ["history-only", "failed"]);
assert.equal(tabs.problems.filter((item) => item.id === "failed").length, 1);
assert.deepEqual(tabs.completed.map((item) => item.id), ["done", "failed"]);
assert.deepEqual(tabs.history.map((item) => item.id), ["newer-failure", "undoable", "duplicate-failure", "older-failure"]);
assert.equal(formatOperationBadgeCount(0), "0");
assert.equal(formatOperationBadgeCount(99), "99");
assert.equal(formatOperationBadgeCount(100), "99+");

console.log("ok - operation history categories are deterministic and deduplicate problems");

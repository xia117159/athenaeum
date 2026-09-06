import assert from "node:assert/strict";
import type { OperationClearOutcome } from "../../app/types";
import type { OperationHistoryRecord, OperationTaskSnapshot } from "./types";
import { createOperationWorkspaceState, reduceOperationWorkspaceState } from "./operationState";

function task(taskId: string, sequence: number): OperationTaskSnapshot {
  const now = "2026-01-01T00:00:00Z";
  return {
    taskId,
    requestId: taskId,
    kind: "copy",
    label: taskId,
    status: "failed",
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    totalEntries: 1,
    completedEntries: 0,
    failedEntries: 1,
    totalBytes: null,
    completedBytes: null,
    currentPath: null,
    message: null,
    cancelable: false,
    undoable: false,
    affectedRoots: [],
    entryResults: [],
    sequence,
    updatedAt: now
  };
}

function history(recordId: string): OperationHistoryRecord {
  const now = "2026-01-01T00:00:00Z";
  return {
    recordId,
    taskId: recordId,
    kind: "copy",
    label: recordId,
    status: "failed",
    createdAt: now,
    updatedAt: now,
    undoTaskId: null,
    blockedReason: null,
    payloadExpiresAt: null,
    affectedRoots: []
  };
}

const cleared: OperationClearOutcome = {
  status: "cleared",
  eligibleUndoableCount: 0,
  removedTaskIds: ["removed-task"],
  removedRecordIds: ["removed-record"],
  taskClearWatermark: 11,
  historyClearWatermark: 21,
  protectedRecordIds: [],
  cleanupWarnings: []
};

let state = createOperationWorkspaceState();
state = reduceOperationWorkspaceState(state, {
  type: "tasksSnapshot",
  payload: { tasks: [task("removed-task", 10), task("unrelated", 12)], taskSequence: 12 }
});
state = reduceOperationWorkspaceState(state, {
  type: "historySnapshot",
  payload: { records: [history("removed-record"), history("unrelated-record")], historySequence: 22 }
});
state = reduceOperationWorkspaceState(state, { type: "recordsCleared", payload: cleared });
assert.deepEqual(state.tasks.map((item) => item.taskId), ["unrelated"]);
assert.deepEqual(state.history.map((item) => item.recordId), ["unrelated-record"]);
assert.equal(state.taskSequence, 12);
assert.equal(state.historySequence, 22);

const afterDuplicate = reduceOperationWorkspaceState(state, { type: "recordsCleared", payload: cleared });
assert.deepEqual(afterDuplicate, state);

const afterStaleTask = reduceOperationWorkspaceState(state, { type: "taskEvent", payload: task("removed-task", 11) });
assert.deepEqual(afterStaleTask, state);
const afterNewTask = reduceOperationWorkspaceState(state, { type: "taskEvent", payload: task("removed-task", 13) });
assert.equal(afterNewTask.tasks.some((item) => item.taskId === "removed-task"), true);
assert.equal(afterNewTask.taskClearTombstones["removed-task"], undefined);

const afterStaleHistory = reduceOperationWorkspaceState(state, {
  type: "historyEvent",
  payload: { record: history("removed-record"), historySequence: 21 }
});
assert.deepEqual(afterStaleHistory, state);
const afterNewHistory = reduceOperationWorkspaceState(state, {
  type: "historyEvent",
  payload: { record: history("removed-record"), historySequence: 23 }
});
assert.equal(afterNewHistory.history.some((item) => item.recordId === "removed-record"), true);
assert.equal(afterNewHistory.historyClearTombstones["removed-record"], undefined);

let reordered = createOperationWorkspaceState();
reordered = reduceOperationWorkspaceState(reordered, {
  type: "historySnapshot",
  payload: { records: [], historySequence: 9 }
});
reordered = reduceOperationWorkspaceState(reordered, {
  type: "historyEvent",
  payload: { record: history("record-11"), historySequence: 11 }
});
reordered = reduceOperationWorkspaceState(reordered, {
  type: "historyEvent",
  payload: { record: history("record-10"), historySequence: 10 }
});
assert.deepEqual(
  new Set(reordered.history.map((item) => item.recordId)),
  new Set(["record-10", "record-11"])
);

const staleSameRecord = reduceOperationWorkspaceState(reordered, {
  type: "historyEvent",
  payload: {
    record: { ...history("record-10"), status: "undone" },
    historySequence: 8
  }
});
assert.deepEqual(staleSameRecord, reordered);

const clearedDuringReordering = reduceOperationWorkspaceState(reordered, {
  type: "recordsCleared",
  payload: {
    ...cleared,
    removedTaskIds: [],
    removedRecordIds: ["record-10"],
    taskClearWatermark: 0,
    historyClearWatermark: 12
  }
});
const delayedRemovedRecord = reduceOperationWorkspaceState(clearedDuringReordering, {
  type: "historyEvent",
  payload: { record: history("record-10"), historySequence: 10 }
});
assert.deepEqual(delayedRemovedRecord, clearedDuringReordering);
const delayedUnrelatedRecord = reduceOperationWorkspaceState(clearedDuringReordering, {
  type: "historyEvent",
  payload: { record: history("record-unrelated"), historySequence: 11 }
});
assert.equal(delayedUnrelatedRecord.history.some((item) => item.recordId === "record-unrelated"), true);

let taskEventBeforeSnapshot = createOperationWorkspaceState();
taskEventBeforeSnapshot = reduceOperationWorkspaceState(taskEventBeforeSnapshot, {
  type: "taskEvent",
  payload: task("event-task", 11)
});
taskEventBeforeSnapshot = reduceOperationWorkspaceState(taskEventBeforeSnapshot, {
  type: "tasksSnapshot",
  payload: { tasks: [task("snapshot-task", 7)], taskSequence: 10 }
});
assert.deepEqual(
  new Set(taskEventBeforeSnapshot.tasks.map((item) => item.taskId)),
  new Set(["snapshot-task", "event-task"])
);

let historyEventBeforeSnapshot = createOperationWorkspaceState();
historyEventBeforeSnapshot = reduceOperationWorkspaceState(historyEventBeforeSnapshot, {
  type: "historyEvent",
  payload: { record: history("event-record"), historySequence: 11 }
});
historyEventBeforeSnapshot = reduceOperationWorkspaceState(historyEventBeforeSnapshot, {
  type: "historySnapshot",
  payload: { records: [history("snapshot-record")], historySequence: 10 }
});
assert.deepEqual(
  new Set(historyEventBeforeSnapshot.history.map((item) => item.recordId)),
  new Set(["snapshot-record", "event-record"])
);

let clearBeforeSnapshot = createOperationWorkspaceState();
clearBeforeSnapshot = reduceOperationWorkspaceState(clearBeforeSnapshot, {
  type: "recordsCleared",
  payload: {
    ...cleared,
    removedTaskIds: ["removed-before-snapshot"],
    removedRecordIds: ["removed-before-snapshot"],
    taskClearWatermark: 12,
    historyClearWatermark: 12
  }
});
clearBeforeSnapshot = reduceOperationWorkspaceState(clearBeforeSnapshot, {
  type: "tasksSnapshot",
  payload: {
    tasks: [task("removed-before-snapshot", 8), task("task-survivor", 8)],
    taskSequence: 10
  }
});
clearBeforeSnapshot = reduceOperationWorkspaceState(clearBeforeSnapshot, {
  type: "historySnapshot",
  payload: {
    records: [history("removed-before-snapshot"), history("history-survivor")],
    historySequence: 10
  }
});
assert.deepEqual(clearBeforeSnapshot.tasks.map((item) => item.taskId), ["task-survivor"]);
assert.deepEqual(clearBeforeSnapshot.history.map((item) => item.recordId), ["history-survivor"]);

console.log("ok - operation clear tombstones reject delayed records and preserve unrelated newer events");

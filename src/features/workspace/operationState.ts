import type {
  OperationClearOutcome,
  OperationHistoryEventEnvelope,
  OperationHistoryListSnapshot,
  OperationHistoryRecord,
  OperationTaskListSnapshot,
  OperationTaskSnapshot
} from "../../app/types";
import type { OperationWorkspaceState } from "./types";

export type OperationStateAction =
  | { type: "tasksSnapshot"; payload: OperationTaskListSnapshot }
  | { type: "taskEvent"; payload: OperationTaskSnapshot }
  | { type: "historySnapshot"; payload: OperationHistoryListSnapshot }
  | { type: "historyEvent"; payload: OperationHistoryEventEnvelope }
  | { type: "recordsCleared"; payload: OperationClearOutcome };

export function createOperationWorkspaceState(): OperationWorkspaceState {
  return {
    tasks: [],
    taskSequence: 0,
    taskSnapshotSequence: 0,
    history: [],
    historySequence: 0,
    historySnapshotSequence: 0,
    historyRecordSequences: {},
    taskClearTombstones: {},
    historyClearTombstones: {}
  };
}

function taskTimestamp(task: OperationTaskSnapshot) {
  return task.finishedAt ?? task.startedAt ?? task.createdAt;
}

export function sortOperationTasks(tasks: OperationTaskSnapshot[]) {
  return [...tasks].sort(
    (left, right) =>
      taskTimestamp(right).localeCompare(taskTimestamp(left)) ||
      right.sequence - left.sequence ||
      right.taskId.localeCompare(left.taskId)
  );
}

export function sortOperationHistory<T extends { createdAt: string; updatedAt: string; recordId: string }>(records: T[]) {
  return [...records].sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.recordId.localeCompare(left.recordId)
  );
}

function sameTaskSnapshot(current: OperationTaskSnapshot[], incoming: OperationTaskSnapshot[]) {
  return current.length === incoming.length && current.every((task, index) => {
    const candidate = incoming[index];
    return candidate?.taskId === task.taskId && candidate.sequence === task.sequence;
  });
}

function sameHistorySnapshot(
  current: OperationWorkspaceState["history"],
  incoming: OperationWorkspaceState["history"]
) {
  return current.length === incoming.length && current.every((record, index) => {
    const candidate = incoming[index];
    return candidate?.recordId === record.recordId && candidate.updatedAt === record.updatedAt && candidate.status === record.status;
  });
}

function withoutKey(values: Record<string, number>, key: string) {
  if (!(key in values)) return values;
  const next = { ...values };
  delete next[key];
  return next;
}

function withTombstones(values: Record<string, number>, ids: string[], watermark: number) {
  let changed = false;
  const next = { ...values };
  for (const id of ids) {
    if (next[id] !== watermark) {
      next[id] = watermark;
      changed = true;
    }
  }
  return changed ? next : values;
}

export function reduceOperationWorkspaceState(
  state: OperationWorkspaceState,
  action: OperationStateAction
): OperationWorkspaceState {
  switch (action.type) {
    case "tasksSnapshot": {
      if (action.payload.taskSequence < state.taskSnapshotSequence) return state;
      let tombstones = state.taskClearTombstones;
      const tasksById = new Map<string, OperationTaskSnapshot>();
      for (const task of action.payload.tasks) {
        const watermark = tombstones[task.taskId];
        if (watermark !== undefined) {
          if (task.sequence <= watermark) continue;
          tombstones = withoutKey(tombstones, task.taskId);
        }
        tasksById.set(task.taskId, task);
      }
      for (const task of state.tasks) {
        if (task.sequence > action.payload.taskSequence) tasksById.set(task.taskId, task);
      }
      const tasks = sortOperationTasks(Array.from(tasksById.values()));
      const taskSequence = Math.max(state.taskSequence, action.payload.taskSequence);
      if (
        taskSequence === state.taskSequence &&
        action.payload.taskSequence === state.taskSnapshotSequence &&
        tombstones === state.taskClearTombstones &&
        sameTaskSnapshot(state.tasks, tasks)
      ) return state;
      return {
        ...state,
        tasks,
        taskSequence,
        taskSnapshotSequence: action.payload.taskSequence,
        taskClearTombstones: tombstones
      };
    }
    case "taskEvent": {
      const watermark = state.taskClearTombstones[action.payload.taskId];
      if (watermark !== undefined && action.payload.sequence <= watermark) return state;
      const current = state.tasks.find((task) => task.taskId === action.payload.taskId);
      if (!current && action.payload.sequence <= state.taskSnapshotSequence) return state;
      if (current && current.sequence >= action.payload.sequence) return state;
      return {
        ...state,
        tasks: sortOperationTasks([...state.tasks.filter((task) => task.taskId !== action.payload.taskId), action.payload]),
        taskSequence: Math.max(state.taskSequence, action.payload.sequence),
        taskClearTombstones: withoutKey(state.taskClearTombstones, action.payload.taskId)
      };
    }
    case "historySnapshot": {
      if (action.payload.historySequence < state.historySnapshotSequence) return state;
      let tombstones = state.historyClearTombstones;
      const historyById = new Map<string, OperationHistoryRecord>();
      const historyRecordSequences: Record<string, number> = {};
      for (const record of action.payload.records) {
        const watermark = tombstones[record.recordId];
        if (watermark !== undefined) {
          if (action.payload.historySequence <= watermark) continue;
          tombstones = withoutKey(tombstones, record.recordId);
        }
        historyById.set(record.recordId, record);
        historyRecordSequences[record.recordId] = action.payload.historySequence;
      }
      for (const record of state.history) {
        const recordSequence = state.historyRecordSequences[record.recordId] ?? state.historySnapshotSequence;
        if (recordSequence > action.payload.historySequence) {
          historyById.set(record.recordId, record);
          historyRecordSequences[record.recordId] = recordSequence;
        }
      }
      const history = sortOperationHistory(Array.from(historyById.values()));
      const historySequence = Math.max(state.historySequence, action.payload.historySequence);
      if (
        historySequence === state.historySequence &&
        action.payload.historySequence === state.historySnapshotSequence &&
        tombstones === state.historyClearTombstones &&
        sameHistorySnapshot(state.history, history)
      ) return state;
      return {
        ...state,
        history,
        historySequence,
        historySnapshotSequence: action.payload.historySequence,
        historyRecordSequences,
        historyClearTombstones: tombstones
      };
    }
    case "historyEvent": {
      const watermark = state.historyClearTombstones[action.payload.record.recordId];
      if (watermark !== undefined && action.payload.historySequence <= watermark) return state;
      const recordSequence = state.historyRecordSequences[action.payload.record.recordId]
        ?? state.historySnapshotSequence;
      if (action.payload.historySequence <= recordSequence) return state;
      return {
        ...state,
        history: sortOperationHistory([
          ...state.history.filter((record) => record.recordId !== action.payload.record.recordId),
          action.payload.record
        ]),
        historySequence: Math.max(state.historySequence, action.payload.historySequence),
        historyRecordSequences: {
          ...state.historyRecordSequences,
          [action.payload.record.recordId]: action.payload.historySequence
        },
        historyClearTombstones: withoutKey(state.historyClearTombstones, action.payload.record.recordId)
      };
    }
    case "recordsCleared": {
      if (action.payload.status !== "cleared") return state;
      const removedTasks = new Set(action.payload.removedTaskIds);
      const removedHistory = new Set(action.payload.removedRecordIds);
      const tasks = state.tasks.filter((task) => !removedTasks.has(task.taskId));
      const history = state.history.filter((record) => !removedHistory.has(record.recordId));
      const taskClearTombstones = withTombstones(
        state.taskClearTombstones,
        action.payload.removedTaskIds,
        action.payload.taskClearWatermark
      );
      const historyClearTombstones = withTombstones(
        state.historyClearTombstones,
        action.payload.removedRecordIds,
        action.payload.historyClearWatermark
      );
      const historyRecordSequences = withTombstones(
        state.historyRecordSequences,
        action.payload.removedRecordIds,
        action.payload.historyClearWatermark
      );
      const taskSequence = Math.max(state.taskSequence, action.payload.taskClearWatermark);
      const historySequence = Math.max(state.historySequence, action.payload.historyClearWatermark);
      if (
        tasks.length === state.tasks.length &&
        history.length === state.history.length &&
        taskClearTombstones === state.taskClearTombstones &&
        historyClearTombstones === state.historyClearTombstones &&
        historyRecordSequences === state.historyRecordSequences &&
        taskSequence === state.taskSequence &&
        historySequence === state.historySequence
      ) return state;
      return {
        ...state,
        tasks,
        history,
        taskSequence,
        historySequence,
        historyRecordSequences,
        taskClearTombstones,
        historyClearTombstones
      };
    }
  }
}

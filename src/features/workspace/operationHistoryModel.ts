import type { OperationHistoryRecord, OperationTaskSnapshot, OperationWorkspaceState } from "./types";
import { sortOperationHistory, sortOperationTasks } from "./operationState";

export type OperationHistoryTab = "running" | "waiting" | "problems" | "completed" | "history";
export type OperationHistoryItem =
  | { id: string; kind: "task"; task: OperationTaskSnapshot }
  | { id: string; kind: "history"; record: OperationHistoryRecord };
export type OperationHistoryTabItems = Record<OperationHistoryTab, OperationHistoryItem[]>;

export const OPERATION_HISTORY_TABS: Array<{
  id: OperationHistoryTab;
  label: string;
  emptyText: string;
  badgeColor: string;
}> = [
  { id: "running", label: "\u8fdb\u884c\u4e2d", emptyText: "\u6ca1\u6709\u6b63\u5728\u6267\u884c\u7684\u6587\u4ef6\u64cd\u4f5c", badgeColor: "#8a5a00" },
  { id: "waiting", label: "\u7b49\u5f85\u5904\u7406", emptyText: "\u6ca1\u6709\u7b49\u5f85\u5904\u7406\u7684\u51b2\u7a81", badgeColor: "#a24600" },
  { id: "problems", label: "\u95ee\u9898", emptyText: "\u6ca1\u6709\u9700\u8981\u5904\u7406\u7684\u95ee\u9898", badgeColor: "#c42b1c" },
  { id: "completed", label: "\u6700\u8fd1\u5b8c\u6210", emptyText: "\u6682\u65e0\u5df2\u5b8c\u6210\u7684\u64cd\u4f5c", badgeColor: "#0f6b3d" },
  { id: "history", label: "\u64cd\u4f5c\u5386\u53f2", emptyText: "\u6682\u65e0\u64cd\u4f5c\u5386\u53f2", badgeColor: "#5c5c5c" }
];

const RUNNING = new Set<OperationTaskSnapshot["status"]>(["queued", "scanning", "running", "cancelling"]);
const TERMINAL = new Set<OperationTaskSnapshot["status"]>(["succeeded", "failed", "partialSucceeded", "cancelled"]);

function problemTimestamp(item: OperationHistoryItem) {
  if (item.kind === "task") return item.task.finishedAt ?? item.task.updatedAt ?? item.task.createdAt;
  return item.record.updatedAt ?? item.record.createdAt;
}

function newestFailedHistory(records: OperationHistoryRecord[]) {
  return [...records].sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.createdAt.localeCompare(left.createdAt) ||
      right.recordId.localeCompare(left.recordId)
  )[0];
}

export function projectOperationHistoryTabs(operations: OperationWorkspaceState): OperationHistoryTabItems {
  const running = sortOperationTasks(operations.tasks.filter((task) => RUNNING.has(task.status)))
    .map((task) => ({ id: task.taskId, kind: "task" as const, task }));
  const waiting = sortOperationTasks(operations.tasks.filter((task) => task.status === "waitingConflict"))
    .map((task) => ({ id: task.taskId, kind: "task" as const, task }));
  const problemTasks = operations.tasks.filter((task) => task.status === "failed" || task.status === "partialSucceeded");
  const problemTaskIds = new Set(problemTasks.map((task) => task.taskId));
  const historyByTask = new Map<string, OperationHistoryRecord[]>();
  for (const record of operations.history) {
    if (record.status !== "failed" || problemTaskIds.has(record.taskId)) continue;
    const records = historyByTask.get(record.taskId) ?? [];
    records.push(record);
    historyByTask.set(record.taskId, records);
  }
  const problems: OperationHistoryItem[] = [
    ...problemTasks.map((task) => ({ id: task.taskId, kind: "task" as const, task })),
    ...Array.from(historyByTask.entries()).map(([taskId, records]) => ({
      id: taskId,
      kind: "history" as const,
      record: newestFailedHistory(records)
    }))
  ];
  problems.sort(
    (left, right) => problemTimestamp(right).localeCompare(problemTimestamp(left)) || right.id.localeCompare(left.id)
  );
  const completed = sortOperationTasks(operations.tasks.filter((task) => TERMINAL.has(task.status)))
    .map((task) => ({ id: task.taskId, kind: "task" as const, task }));
  const history = sortOperationHistory(operations.history)
    .map((record) => ({ id: record.recordId, kind: "history" as const, record }));
  return { running, waiting, problems, completed, history };
}

export function getOperationHistoryIds(items: OperationHistoryTabItems) {
  return Object.fromEntries(
    OPERATION_HISTORY_TABS.map((tab) => [tab.id, items[tab.id].map((item) => item.id)])
  ) as Record<OperationHistoryTab, string[]>;
}

export function formatOperationBadgeCount(count: number) {
  return count > 99 ? "99+" : String(Math.max(0, count));
}

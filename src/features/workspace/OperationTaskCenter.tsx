import { AlertTriangle, CheckCircle2, Clock3, History, Loader2, Play, RotateCcw, Square } from "lucide-react";
import { StatusBadge } from "../../components/StatusBadge";
import type { OperationHistoryRecord, OperationPathRef, OperationTaskSnapshot, OperationWorkspaceState } from "./types";
import { formatOperationBadgeCount } from "./operationHistoryModel";
import { useOperationHistoryProblemUnread } from "./useOperationHistoryReadState";

const RUNNING_STATUSES = new Set<OperationTaskSnapshot["status"]>(["queued", "scanning", "running", "cancelling"]);
const TERMINAL_STATUSES = new Set<OperationTaskSnapshot["status"]>(["succeeded", "failed", "partialSucceeded", "cancelled"]);

function pathRefLabel(pathRef?: OperationPathRef | null) {
  if (!pathRef) return "";
  return pathRef.kind === "local" ? pathRef.path : `${pathRef.protocol}://${pathRef.profileId}${pathRef.remotePath}`;
}

function taskDetails(task: OperationTaskSnapshot) {
  const location = task.currentPath ?? pathRefLabel(task.affectedRoots[0]);
  const entryError = task.entryResults.find((result) => result.error?.message)?.error?.message ?? null;
  const error = entryError ?? (
    task.status === "failed" || task.status === "partialSucceeded" ? task.message : null
  );
  const message = task.message !== error && task.message !== location ? task.message : null;
  return { location, error, message };
}

function taskStatusLabel(task: OperationTaskSnapshot) {
  switch (task.status) {
    case "queued": return "\u6392\u961f\u4e2d";
    case "scanning": return "\u6b63\u5728\u626b\u63cf";
    case "running": return task.totalEntries ? `\u6b63\u5728\u8fd0\u884c ${task.completedEntries}/${task.totalEntries} \u9879` : "\u6b63\u5728\u8fd0\u884c";
    case "waitingConflict": return "\u7b49\u5f85\u51b2\u7a81\u5904\u7406";
    case "cancelling": return "\u6b63\u5728\u53d6\u6d88";
    case "cancelled": return "\u5df2\u53d6\u6d88";
    case "succeeded": return "\u5df2\u5b8c\u6210";
    case "partialSucceeded": return "\u90e8\u5206\u5b8c\u6210";
    case "failed": return "\u5931\u8d25";
  }
}

function historyStatusLabel(record: OperationHistoryRecord) {
  switch (record.status) {
    case "undoable": return "\u53ef\u64a4\u9500";
    case "undoing": return "\u6b63\u5728\u64a4\u9500";
    case "undone": return "\u5df2\u64a4\u9500";
    case "expired": return "\u5df2\u8fc7\u671f";
    case "blocked": return "\u5df2\u963b\u6b62";
    case "failed": return "\u64a4\u9500\u5931\u8d25";
    case "notUndoable": return "\u4e0d\u53ef\u64a4\u9500";
    case "pendingConfirmation": return "\u9700\u8981\u786e\u8ba4";
  }
}

function taskIcon(task: OperationTaskSnapshot) {
  if (task.status === "failed" || task.status === "partialSucceeded") return <AlertTriangle size={16} aria-hidden="true" />;
  if (task.status === "succeeded") return <CheckCircle2 size={16} aria-hidden="true" />;
  if (RUNNING_STATUSES.has(task.status)) return <Loader2 size={16} aria-hidden="true" />;
  return <Clock3 size={16} aria-hidden="true" />;
}

function progressValue(task: OperationTaskSnapshot) {
  if (task.totalBytes && task.completedBytes !== null && task.completedBytes !== undefined) {
    return Math.min(100, Math.round((task.completedBytes / task.totalBytes) * 100));
  }
  if (task.totalEntries && task.totalEntries > 0) {
    return Math.min(100, Math.round((task.completedEntries / task.totalEntries) * 100));
  }
  return null;
}

export function OperationTaskRow({ task, pending, disabled, onCancelTask }: {
  task: OperationTaskSnapshot;
  pending?: boolean;
  disabled?: boolean;
  onCancelTask: (taskId: string) => void;
}) {
  const progress = progressValue(task);
  const details = taskDetails(task);
  return (
    <article className={`operation-row operation-row--${task.status}`}>
      <div className="operation-row__icon">{taskIcon(task)}</div>
      <div className="operation-row__main">
        <div className="operation-row__title">
          <strong title={task.label}>{task.label}</strong>
          <span>{taskStatusLabel(task)}</span>
        </div>
        {details.location ? <div className="operation-row__meta" title={details.location}>{details.location}</div> : null}
        {details.message ? <div className="operation-row__meta" title={details.message}>{details.message}</div> : null}
        {details.error ? <div className="operation-row__meta operation-row__meta--error" title={details.error}>{details.error}</div> : null}
        {RUNNING_STATUSES.has(task.status) ? (
          <progress className="operation-row__progress" max={100} value={progress ?? undefined} />
        ) : null}
      </div>
      <div className="operation-row__actions">
        {task.cancelable && !TERMINAL_STATUSES.has(task.status) ? (
          <button type="button" className="toolbar-button toolbar-button--icon" title="\u53d6\u6d88\u4efb\u52a1"
            aria-label="\u53d6\u6d88\u4efb\u52a1" disabled={disabled || pending} onClick={() => onCancelTask(task.taskId)}>
            {pending ? <Loader2 size={14} aria-hidden="true" /> : <Square size={14} aria-hidden="true" />}
          </button>
        ) : null}
      </div>
    </article>
  );
}

export function OperationHistoryRow({ record, pending, disabled, onUndoRecord }: {
  record: OperationHistoryRecord;
  pending?: boolean;
  disabled?: boolean;
  onUndoRecord: (recordId: string) => void;
}) {
  const location = pathRefLabel(record.affectedRoots[0]);
  return (
    <article className={`operation-history-row operation-history-row--${record.status}`}>
      <div className="operation-history-row__main">
        <div className="operation-history-row__title">
          <strong title={record.label}>{record.label}</strong>
          <span>{historyStatusLabel(record)}</span>
        </div>
        {record.blockedReason || location ? <small title={record.blockedReason ?? location}>{record.blockedReason ?? location}</small> : null}
      </div>
      <button type="button" className="toolbar-button toolbar-button--icon" title="\u64a4\u9500\u64cd\u4f5c"
        aria-label="\u64a4\u9500\u64cd\u4f5c" disabled={disabled || pending || record.status !== "undoable"}
        onClick={() => onUndoRecord(record.recordId)}>
        {pending ? <Loader2 size={14} aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}
      </button>
    </article>
  );
}

export function OperationSummaryButton({ operations, onOpen }: { operations: OperationWorkspaceState; onOpen: () => void }) {
  const problemRead = useOperationHistoryProblemUnread(operations);
  const problemUnreadCount = problemRead.count;
  const runningCount = operations.tasks.filter((task) => RUNNING_STATUSES.has(task.status)).length;
  const waitingCount = operations.tasks.filter((task) => task.status === "waitingConflict").length;
  const label = problemUnreadCount > 0
    ? `\u6253\u5f00\u64cd\u4f5c\u5386\u53f2\uff0c${problemUnreadCount} \u4e2a\u672a\u67e5\u770b\u95ee\u9898`
    : "\u6253\u5f00\u64cd\u4f5c\u5386\u53f2";
  return (
    <button type="button" className="toolbar-button operation-summary-button" title={label} aria-label={label} onClick={() => {
      if (problemRead.warning) problemRead.retry();
      onOpen();
    }}>
      {runningCount > 0 ? <Play size={14} aria-hidden="true" /> : waitingCount > 0 ? <AlertTriangle size={14} aria-hidden="true" /> : <History size={14} aria-hidden="true" />}
      {problemUnreadCount > 0 ? (
        <StatusBadge className="operation-summary-button__badge" content={formatOperationBadgeCount(problemUnreadCount)}
          backgroundColor="#c42b1c" color="#ffffff" size={14}
          ariaLabel={`${problemUnreadCount} \u4e2a\u672a\u67e5\u770b\u95ee\u9898`} />
      ) : null}
    </button>
  );
}

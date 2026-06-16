import { AlertTriangle, CheckCircle2, Clock3, History, Loader2, Play, RotateCcw, Square, X } from "lucide-react";
import { type ReactNode } from "react";
import type {
  OperationHistoryRecord,
  OperationPathRef,
  OperationTaskSnapshot,
  OperationWorkspaceState
} from "./types";

type OperationTaskCenterProps = {
  operations: OperationWorkspaceState;
  onOpenChange: (open: boolean) => void;
  onCancelTask: (taskId: string) => void;
  onUndoLatest: () => void;
  onUndoRecord: (recordId: string) => void;
};

type OperationHistoryPanelContentProps = Pick<
  OperationTaskCenterProps,
  "operations" | "onCancelTask" | "onUndoLatest" | "onUndoRecord"
>;

const RUNNING_STATUSES = new Set<OperationTaskSnapshot["status"]>(["queued", "scanning", "running", "cancelling"]);
const TERMINAL_STATUSES = new Set<OperationTaskSnapshot["status"]>(["succeeded", "failed", "partialSucceeded", "cancelled"]);

function pathRefLabel(pathRef?: OperationPathRef | null) {
  if (!pathRef) {
    return "";
  }
  if (pathRef.kind === "local") {
    return pathRef.path;
  }
  return `${pathRef.protocol}://${pathRef.profileId}${pathRef.remotePath}`;
}

const OPERATION_TEXT = {
  title: "\u6587\u4ef6\u64cd\u4f5c",
  centerLabel: "\u6587\u4ef6\u64cd\u4f5c\u4efb\u52a1\u4e2d\u5fc3",
  historyLabel: "\u64cd\u4f5c\u5386\u53f2",
  tasksUnit: "\u4e2a\u4efb\u52a1",
  historyUnit: "\u6761\u5386\u53f2\u8bb0\u5f55",
  separator: "\uff0c",
  undoLatest: "\u64a4\u9500\u6700\u8fd1\u64cd\u4f5c",
  closeCenter: "\u5173\u95ed\u64cd\u4f5c\u4e2d\u5fc3",
  runningTitle: "\u8fdb\u884c\u4e2d",
  runningEmpty: "\u6ca1\u6709\u6b63\u5728\u6267\u884c\u7684\u6587\u4ef6\u64cd\u4f5c\u3002",
  waitingTitle: "\u7b49\u5f85\u5904\u7406",
  waitingEmpty: "\u6ca1\u6709\u7b49\u5f85\u5904\u7406\u7684\u51b2\u7a81\u3002",
  problemsTitle: "\u95ee\u9898",
  problemsEmpty: "\u6ca1\u6709\u5931\u8d25\u7684\u6587\u4ef6\u64cd\u4f5c\u3002",
  completedTitle: "\u6700\u8fd1\u5b8c\u6210",
  completedEmpty: "\u6ca1\u6709\u5df2\u5b8c\u6210\u7684\u6587\u4ef6\u64cd\u4f5c\u3002",
  historyTitle: "\u64cd\u4f5c\u5386\u53f2",
  historyEmpty: "\u6682\u65e0\u64cd\u4f5c\u5386\u53f2\u3002",
  openHistory: "\u6253\u5f00\u64cd\u4f5c\u5386\u53f2"
};

function taskStatusLabel(task: OperationTaskSnapshot) {
  switch (task.status) {
    case "queued":
      return "\u6392\u961f\u4e2d";
    case "scanning":
      return "\u6b63\u5728\u626b\u63cf";
    case "running":
      return task.totalEntries
        ? `\u6b63\u5728\u8fd0\u884c ${task.completedEntries}/${task.totalEntries} \u9879`
        : "\u6b63\u5728\u8fd0\u884c";
    case "waitingConflict":
      return "\u7b49\u5f85\u51b2\u7a81\u5904\u7406";
    case "cancelling":
      return "\u6b63\u5728\u53d6\u6d88";
    case "cancelled":
      return "\u5df2\u53d6\u6d88";
    case "succeeded":
      return "\u5df2\u5b8c\u6210";
    case "partialSucceeded":
      return "\u90e8\u5206\u5b8c\u6210";
    case "failed":
      return "\u5931\u8d25";
    default:
      return task.status;
  }
}

function historyStatusLabel(record: OperationHistoryRecord) {
  switch (record.status) {
    case "undoable":
      return "\u53ef\u64a4\u9500";
    case "undoing":
      return "\u6b63\u5728\u64a4\u9500";
    case "undone":
      return "\u5df2\u64a4\u9500";
    case "expired":
      return "\u5df2\u8fc7\u671f";
    case "blocked":
      return "\u5df2\u963b\u6b62";
    case "failed":
      return "\u64a4\u9500\u5931\u8d25";
    case "notUndoable":
      return "\u4e0d\u53ef\u64a4\u9500";
    case "pendingConfirmation":
      return "\u9700\u8981\u786e\u8ba4";
    default:
      return record.status;
  }
}

function taskIcon(task: OperationTaskSnapshot) {
  if (task.status === "failed" || task.status === "partialSucceeded") {
    return <AlertTriangle size={14} aria-hidden="true" />;
  }
  if (task.status === "succeeded") {
    return <CheckCircle2 size={14} aria-hidden="true" />;
  }
  if (RUNNING_STATUSES.has(task.status)) {
    return <Loader2 size={14} aria-hidden="true" />;
  }
  return <Clock3 size={14} aria-hidden="true" />;
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

function OperationTaskRow({
  task,
  onCancelTask
}: {
  task: OperationTaskSnapshot;
  onCancelTask: (taskId: string) => void;
}) {
  const progress = progressValue(task);

  return (
    <div className={`operation-row operation-row--${task.status}`}>
      <div className="operation-row__icon">{taskIcon(task)}</div>
      <div className="operation-row__main">
        <div className="operation-row__title">
          <strong title={task.label}>{task.label}</strong>
          <span>{taskStatusLabel(task)}</span>
        </div>
        <div className="operation-row__meta" title={task.currentPath ?? task.message ?? ""}>
          {task.currentPath ?? task.message ?? pathRefLabel(task.affectedRoots[0])}
        </div>
        <progress className="operation-row__progress" max={100} value={progress ?? undefined} />
      </div>
      <div className="operation-row__actions">
        {task.cancelable && !TERMINAL_STATUSES.has(task.status) ? (
          <button
            type="button"
            className="toolbar-button toolbar-button--icon"
            title="\u53d6\u6d88\u4efb\u52a1"
            aria-label="\u53d6\u6d88\u4efb\u52a1"
            onClick={() => onCancelTask(task.taskId)}
          >
            <Square size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function OperationHistoryRow({
  record,
  onUndoRecord
}: {
  record: OperationHistoryRecord;
  onUndoRecord: (recordId: string) => void;
}) {
  return (
    <div className={`operation-history-row operation-history-row--${record.status}`}>
      <div className="operation-history-row__main">
        <strong title={record.label}>{record.label}</strong>
        <span>{historyStatusLabel(record)}</span>
        {record.blockedReason ? <small title={record.blockedReason}>{record.blockedReason}</small> : null}
      </div>
      <button
        type="button"
        className="toolbar-button toolbar-button--icon"
        title="\u64a4\u9500\u64cd\u4f5c"
        aria-label="\u64a4\u9500\u64cd\u4f5c"
        disabled={record.status !== "undoable"}
        onClick={() => onUndoRecord(record.recordId)}
      >
        <RotateCcw size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

function OperationSection({
  title,
  emptyText,
  children
}: {
  title: string;
  emptyText: string;
  children: ReactNode;
}) {
  return (
    <section className="operation-section">
      <header>{title}</header>
      <div className="operation-section__body">{children || <div className="operation-section__empty">{emptyText}</div>}</div>
    </section>
  );
}

export function OperationTaskCenter({
  operations,
  onOpenChange,
  onCancelTask,
  onUndoLatest,
  onUndoRecord
}: OperationTaskCenterProps) {
  if (!operations.tasksOpen) {
    return null;
  }

  return (
    <aside className="operation-center" aria-label={OPERATION_TEXT.centerLabel}>
      <header className="operation-center__header">
        <div>
          <strong>{OPERATION_TEXT.title}</strong>
          <span>
            {operations.tasks.length} {OPERATION_TEXT.tasksUnit}
            {OPERATION_TEXT.separator}
            {operations.history.length} {OPERATION_TEXT.historyUnit}
          </span>
        </div>
        <div className="operation-center__actions">
          <button
            type="button"
            className="toolbar-button toolbar-button--icon"
            title={OPERATION_TEXT.undoLatest}
            aria-label={OPERATION_TEXT.undoLatest}
            onClick={onUndoLatest}
          >
            <RotateCcw size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="toolbar-button toolbar-button--icon"
            title={OPERATION_TEXT.closeCenter}
            aria-label={OPERATION_TEXT.closeCenter}
            onClick={() => onOpenChange(false)}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </header>

      <OperationHistoryPanelContent
        operations={operations}
        onCancelTask={onCancelTask}
        onUndoLatest={onUndoLatest}
        onUndoRecord={onUndoRecord}
      />
    </aside>
  );
}

export function OperationHistoryPanelContent({
  operations,
  onCancelTask,
  onUndoLatest,
  onUndoRecord
}: OperationHistoryPanelContentProps) {
  const runningTasks = operations.tasks.filter((task) => RUNNING_STATUSES.has(task.status));
  const waitingTasks = operations.tasks.filter((task) => task.status === "waitingConflict");
  const failedTasks = operations.tasks.filter((task) => task.status === "failed" || task.status === "partialSucceeded");
  const completedTasks = operations.tasks.filter((task) => TERMINAL_STATUSES.has(task.status)).slice(0, 8);
  const historyRecords = operations.history.slice(0, 10);

  return (
    <div className="operation-history-panel" aria-label={OPERATION_TEXT.historyLabel}>
      <header className="operation-history-panel__header">
        <div>
          <strong>{OPERATION_TEXT.title}</strong>
          <span>
            {operations.tasks.length} {OPERATION_TEXT.tasksUnit}
            {OPERATION_TEXT.separator}
            {operations.history.length} {OPERATION_TEXT.historyUnit}
          </span>
        </div>
        <div className="operation-history-panel__actions">
          <button
            type="button"
            className="toolbar-button toolbar-button--icon"
            title={OPERATION_TEXT.undoLatest}
            aria-label={OPERATION_TEXT.undoLatest}
            onClick={onUndoLatest}
          >
            <RotateCcw size={14} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="operation-center__grid">
        <OperationSection title={OPERATION_TEXT.runningTitle} emptyText={OPERATION_TEXT.runningEmpty}>
          {runningTasks.map((task) => (
            <OperationTaskRow key={task.taskId} task={task} onCancelTask={onCancelTask} />
          ))}
        </OperationSection>
        <OperationSection title={OPERATION_TEXT.waitingTitle} emptyText={OPERATION_TEXT.waitingEmpty}>
          {waitingTasks.map((task) => (
            <OperationTaskRow key={task.taskId} task={task} onCancelTask={onCancelTask} />
          ))}
        </OperationSection>
        <OperationSection title={OPERATION_TEXT.problemsTitle} emptyText={OPERATION_TEXT.problemsEmpty}>
          {failedTasks.map((task) => (
            <OperationTaskRow key={task.taskId} task={task} onCancelTask={onCancelTask} />
          ))}
        </OperationSection>
        <OperationSection title={OPERATION_TEXT.completedTitle} emptyText={OPERATION_TEXT.completedEmpty}>
          {completedTasks.map((task) => (
            <OperationTaskRow key={task.taskId} task={task} onCancelTask={onCancelTask} />
          ))}
        </OperationSection>
        <OperationSection title={OPERATION_TEXT.historyTitle} emptyText={OPERATION_TEXT.historyEmpty}>
          {historyRecords.map((record) => (
            <OperationHistoryRow key={record.recordId} record={record} onUndoRecord={onUndoRecord} />
          ))}
        </OperationSection>
      </div>
    </div>
  );
}

export function OperationSummaryButton({
  operations,
  onOpen
}: {
  operations: OperationWorkspaceState;
  onOpen: () => void;
}) {
  const runningCount = operations.tasks.filter((task) => RUNNING_STATUSES.has(task.status)).length;
  const waitingCount = operations.tasks.filter((task) => task.status === "waitingConflict").length;
  const failedCount = operations.tasks.filter((task) => task.status === "failed" || task.status === "partialSucceeded").length;
  return (
    <button
      type="button"
      className={`toolbar-button operation-summary-button${failedCount > 0 ? " has-errors" : ""}${waitingCount > 0 ? " has-waiting" : ""}`}
      title={OPERATION_TEXT.openHistory}
      aria-label={OPERATION_TEXT.openHistory}
      onClick={onOpen}
    >
      {runningCount > 0 ? <Play size={14} aria-hidden="true" /> : waitingCount > 0 ? <AlertTriangle size={14} aria-hidden="true" /> : <History size={14} aria-hidden="true" />}
      {runningCount + waitingCount + failedCount > 0 ? <strong>{runningCount + waitingCount + failedCount}</strong> : null}
    </button>
  );
}

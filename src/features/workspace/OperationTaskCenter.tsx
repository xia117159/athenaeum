import { AlertTriangle, CheckCircle2, Clock3, History, Loader2, Play, RotateCcw, Square, X } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import type {
  ConflictResolutionKind,
  OperationConflictDialogState,
  OperationHistoryRecord,
  OperationPathRef,
  OperationTaskSnapshot,
  OperationWorkspaceState
} from "./types";

type ConflictDialogUpdate = Partial<
  Pick<OperationConflictDialogState, "selectedResolution" | "renameValue" | "applyToAll" | "resolving">
>;

type OperationTaskCenterProps = {
  operations: OperationWorkspaceState;
  onOpenChange: (open: boolean) => void;
  onCancelTask: (taskId: string) => void;
  onUndoLatest: () => void;
  onUndoRecord: (recordId: string) => void;
};

type OperationConflictDialogProps = {
  dialog?: OperationConflictDialogState;
  onUpdate: (payload: ConflictDialogUpdate) => void;
  onResolve: () => void;
  onCancelTask: (taskId: string) => void;
};

type OperationHistoryPanelContentProps = Pick<
  OperationTaskCenterProps,
  "operations" | "onCancelTask" | "onUndoLatest" | "onUndoRecord"
>;

const RUNNING_STATUSES = new Set<OperationTaskSnapshot["status"]>(["queued", "scanning", "running", "cancelling"]);
const TERMINAL_STATUSES = new Set<OperationTaskSnapshot["status"]>(["succeeded", "failed", "partialSucceeded", "cancelled"]);
const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

function pathRefLabel(pathRef?: OperationPathRef | null) {
  if (!pathRef) {
    return "";
  }
  if (pathRef.kind === "local") {
    return pathRef.path;
  }
  return `${pathRef.protocol}://${pathRef.profileId}${pathRef.remotePath}`;
}

function taskStatusLabel(task: OperationTaskSnapshot) {
  switch (task.status) {
    case "queued":
      return "排队中";
    case "scanning":
      return "正在扫描";
    case "running":
      return task.totalEntries ? `正在运行 ${task.completedEntries}/${task.totalEntries} 项` : "正在运行";
    case "waitingConflict":
      return "等待冲突处理";
    case "cancelling":
      return "正在取消";
    case "cancelled":
      return "已取消";
    case "succeeded":
      return "已完成";
    case "partialSucceeded":
      return "部分完成";
    case "failed":
      return "失败";
    default:
      return task.status;
  }
}

function historyStatusLabel(record: OperationHistoryRecord) {
  switch (record.status) {
    case "undoable":
      return "可撤销";
    case "undoing":
      return "正在撤销";
    case "undone":
      return "已撤销";
    case "expired":
      return "已过期";
    case "blocked":
      return "已阻止";
    case "failed":
      return "撤销失败";
    case "notUndoable":
      return "不可撤销";
    case "pendingConfirmation":
      return "需要确认";
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
          <button type="button" className="toolbar-button toolbar-button--icon" title="取消任务" aria-label="取消任务" onClick={() => onCancelTask(task.taskId)}>
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
        title="撤销操作"
        aria-label="撤销操作"
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
    <aside className="operation-center" aria-label="文件操作任务中心">
      <header className="operation-center__header">
        <div>
          <strong>文件操作</strong>
          <span>{operations.tasks.length} 个任务，{operations.history.length} 条历史记录</span>
        </div>
        <div className="operation-center__actions">
          <button type="button" className="toolbar-button toolbar-button--icon" title="撤销最近操作" aria-label="撤销最近操作" onClick={onUndoLatest}>
            <RotateCcw size={14} aria-hidden="true" />
          </button>
          <button type="button" className="toolbar-button toolbar-button--icon" title="关闭操作中心" aria-label="关闭操作中心" onClick={() => onOpenChange(false)}>
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
    <div className="operation-history-panel" aria-label="操作历史">
      <header className="operation-history-panel__header">
        <div>
          <strong>文件操作</strong>
          <span>{operations.tasks.length} 个任务，{operations.history.length} 条历史记录</span>
        </div>
        <div className="operation-history-panel__actions">
          <button type="button" className="toolbar-button toolbar-button--icon" title="撤销最近操作" aria-label="撤销最近操作" onClick={onUndoLatest}>
            <RotateCcw size={14} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="operation-center__grid">
        <OperationSection title="进行中" emptyText="没有正在执行的文件操作。">
          {runningTasks.map((task) => (
            <OperationTaskRow key={task.taskId} task={task} onCancelTask={onCancelTask} />
          ))}
        </OperationSection>
        <OperationSection title="等待处理" emptyText="没有等待处理的冲突。">
          {waitingTasks.map((task) => (
            <OperationTaskRow key={task.taskId} task={task} onCancelTask={onCancelTask} />
          ))}
        </OperationSection>
        <OperationSection title="问题" emptyText="没有失败的文件操作。">
          {failedTasks.map((task) => (
            <OperationTaskRow key={task.taskId} task={task} onCancelTask={onCancelTask} />
          ))}
        </OperationSection>
        <OperationSection title="最近完成" emptyText="没有已完成的文件操作。">
          {completedTasks.map((task) => (
            <OperationTaskRow key={task.taskId} task={task} onCancelTask={onCancelTask} />
          ))}
        </OperationSection>
        <OperationSection title="操作历史" emptyText="暂无操作历史。">
          {historyRecords.map((record) => (
            <OperationHistoryRow key={record.recordId} record={record} onUndoRecord={onUndoRecord} />
          ))}
        </OperationSection>
      </div>
    </div>
  );
}

function resolutionLabel(resolution: ConflictResolutionKind) {
  switch (resolution) {
    case "replace":
      return "替换";
    case "skip":
      return "跳过";
    case "keepBoth":
      return "保留两者";
    case "rename":
      return "重命名";
    case "mergeDirectory":
      return "合并文件夹";
    default:
      return resolution;
  }
}

function focusableElements(container: HTMLElement | null) {
  if (!container) {
    return [];
  }
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute("disabled") && element.tabIndex !== -1
  );
}

export function OperationConflictDialog({
  dialog,
  onUpdate,
  onResolve,
  onCancelTask
}: OperationConflictDialogProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!dialog) {
      return;
    }

    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    window.setTimeout(() => {
      const container = dialogRef.current;
      const initialFocus =
        container?.querySelector<HTMLElement>("[data-conflict-initial-focus='true']") ??
        focusableElements(container)[0];
      initialFocus?.focus();
    }, 0);

    return () => {
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [dialog?.request.conflictId]);

  if (!dialog) {
    return null;
  }

  const renameRequired = dialog.selectedResolution === "rename";
  const renameInvalid = renameRequired && !dialog.renameValue.trim();
  const applyToAllDisabled = renameRequired || dialog.request.allowedResolutions.length <= 1;

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.key === "Enter" && !event.shiftKey && !dialog.resolving && !renameInvalid) {
      event.preventDefault();
      onResolve();
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const focusable = focusableElements(dialogRef.current);
    if (focusable.length === 0) {
      return;
    }
    const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.shiftKey
      ? activeIndex <= 0
        ? focusable.length - 1
        : activeIndex - 1
      : activeIndex === focusable.length - 1
        ? 0
        : activeIndex + 1;
    event.preventDefault();
    focusable[nextIndex]?.focus();
  };

  return (
    <div className="operation-conflict-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="operation-conflict-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="operation-conflict-title"
        onKeyDown={handleKeyDown}
      >
        <header>
          <AlertTriangle size={16} aria-hidden="true" />
          <div>
            <strong id="operation-conflict-title">名称冲突</strong>
            <span>{dialog.request.message}</span>
          </div>
        </header>

        <div className="operation-conflict-dialog__paths">
          <label>
            <span>来源</span>
            <input type="text" readOnly value={pathRefLabel(dialog.request.source)} />
          </label>
          <label>
            <span>目标</span>
            <input type="text" readOnly value={pathRefLabel(dialog.request.destination)} />
          </label>
        </div>

        <div className="operation-conflict-dialog__choices" role="radiogroup" aria-label="冲突处理方式">
          {dialog.request.allowedResolutions.map((resolution) => (
            <label key={resolution} className="operation-conflict-dialog__choice">
              <input
                type="radio"
                name="operation-conflict-resolution"
                checked={dialog.selectedResolution === resolution}
                data-conflict-initial-focus={dialog.selectedResolution === resolution && !renameRequired ? "true" : undefined}
                onChange={() =>
                  onUpdate({
                    selectedResolution: resolution,
                    applyToAll: resolution === "rename" ? false : dialog.applyToAll
                  })
                }
              />
              <span>{resolutionLabel(resolution)}</span>
            </label>
          ))}
        </div>

        {renameRequired ? (
          <label className="operation-conflict-dialog__rename">
            <span>新名称</span>
            <input
              type="text"
              value={dialog.renameValue}
              aria-invalid={renameInvalid}
              data-conflict-initial-focus="true"
              onChange={(event) => onUpdate({ renameValue: event.currentTarget.value })}
            />
          </label>
        ) : null}

        <label className="operation-conflict-dialog__apply-all">
          <input
            type="checkbox"
            checked={!applyToAllDisabled && dialog.applyToAll}
            disabled={applyToAllDisabled}
            onChange={(event) => onUpdate({ applyToAll: event.currentTarget.checked })}
          />
          <span>对本次任务中剩余冲突应用相同决定</span>
        </label>

        <footer>
          <button type="button" className="toolbar-button" disabled={dialog.resolving} onClick={() => onCancelTask(dialog.request.taskId)}>
            取消任务
          </button>
          <button type="button" className="toolbar-button" disabled={dialog.resolving || renameInvalid} onClick={onResolve}>
            {dialog.resolving ? "正在处理..." : "处理"}
          </button>
        </footer>
      </section>
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
      title="打开操作历史"
      aria-label="打开操作历史"
      onClick={onOpen}
    >
      {runningCount > 0 ? <Play size={14} aria-hidden="true" /> : waitingCount > 0 ? <AlertTriangle size={14} aria-hidden="true" /> : <History size={14} aria-hidden="true" />}
      {runningCount + waitingCount + failedCount > 0 ? <strong>{runningCount + waitingCount + failedCount}</strong> : null}
    </button>
  );
}

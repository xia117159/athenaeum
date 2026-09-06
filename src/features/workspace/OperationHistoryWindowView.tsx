import { AlertTriangle, ChevronDown, History, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { OperationClearScope } from "../../app/types";
import { StatusBadge } from "../../components/StatusBadge";
import { OperationHistoryRow, OperationTaskRow } from "./OperationTaskCenter";
import {
  formatOperationBadgeCount,
  getOperationHistoryIds,
  OPERATION_HISTORY_TABS,
  projectOperationHistoryTabs,
  type OperationHistoryTab
} from "./operationHistoryModel";
import type { OperationHistoryReadEnvironment } from "./useOperationHistoryReadState";
import { useOperationHistoryReadState } from "./useOperationHistoryReadState";
import { useOperationHistoryController } from "./useOperationHistoryController";
import type { WorkspaceGateway } from "./workspaceGateway";
import "./workspace.css";
import "./operation-history-window.css";

const TAB_CLEAR_SCOPE: Record<OperationHistoryTab, OperationClearScope | null> = {
  running: null,
  waiting: null,
  problems: "problems",
  completed: "completed",
  history: "history"
};

export function getOperationClearScopeForTab(tab: OperationHistoryTab) {
  return TAB_CLEAR_SCOPE[tab];
}

export type OperationHistoryWindowViewProps = {
  gateway?: WorkspaceGateway;
  readEnvironment?: OperationHistoryReadEnvironment;
};

export function OperationHistoryWindowView({ gateway, readEnvironment }: OperationHistoryWindowViewProps = {}) {
  const controller = useOperationHistoryController(gateway);
  const tabs = useMemo(() => projectOperationHistoryTabs(controller.operations), [controller.operations]);
  const idsByTab = useMemo(() => getOperationHistoryIds(tabs), [tabs]);
  const read = useOperationHistoryReadState(idsByTab, true, readEnvironment);
  const selectedTab = read.readState.selectedTab;
  const currentItems = tabs[selectedTab];
  const [clearMenuOpen, setClearMenuOpen] = useState(false);
  const clearButtonRef = useRef<HTMLButtonElement | null>(null);
  const clearMenuRef = useRef<HTMLDivElement | null>(null);
  const clearItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const confirmationInvokerIndexRef = useRef(0);
  const cancelConfirmationRef = useRef<HTMLButtonElement | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const confirmationDialogRef = useRef<HTMLElement | null>(null);
  const previousConfirmationRef = useRef(controller.confirmation);
  const focusClearAfterCloseRef = useRef(false);
  const mountedRef = useRef(true);

  const mutationDisabled = controller.loading || controller.mutationPending;
  const currentScope = getOperationClearScopeForTab(selectedTab);
  const canClearCurrent = currentScope !== null && currentItems.length > 0;
  const canClearAll = controller.operations.history.length > 0 || controller.operations.tasks.length > 0;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!clearMenuOpen) return;
    clearItemRefs.current.find((item) => item && !item.disabled)?.focus();
    if (controller.confirmation) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!clearMenuRef.current?.contains(target) && !clearButtonRef.current?.contains(target)) setClearMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [clearMenuOpen, controller.confirmation]);

  useEffect(() => {
    if (controller.confirmation) {
      if (controller.clearPending) confirmationDialogRef.current?.focus();
      else cancelConfirmationRef.current?.focus();
    } else if (previousConfirmationRef.current) {
      const invoker = clearItemRefs.current[confirmationInvokerIndexRef.current];
      if (invoker?.isConnected && !invoker.disabled) invoker.focus();
      else clearButtonRef.current?.focus();
    }
    previousConfirmationRef.current = controller.confirmation;
  }, [controller.clearPending, controller.confirmation]);

  useEffect(() => {
    if (!clearMenuOpen && focusClearAfterCloseRef.current) {
      focusClearAfterCloseRef.current = false;
      clearButtonRef.current?.focus();
    }
  }, [clearMenuOpen]);

  useEffect(() => {
    if (!controller.confirmation) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (controller.clearPending) {
        if (event.key === "Tab") {
          event.preventDefault();
          confirmationDialogRef.current?.focus();
        }
        return;
      }
      if (event.key === "Escape" && !controller.clearPending) {
        event.preventDefault();
        controller.dismissConfirmation();
        return;
      }
      if (event.key !== "Tab") return;
      const first = cancelConfirmationRef.current;
      const last = confirmButtonRef.current;
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [controller.clearPending, controller.confirmation, controller.dismissConfirmation]);

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let target = index;
    if (event.key === "ArrowRight") target = (index + 1) % OPERATION_HISTORY_TABS.length;
    else if (event.key === "ArrowLeft") target = (index - 1 + OPERATION_HISTORY_TABS.length) % OPERATION_HISTORY_TABS.length;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = OPERATION_HISTORY_TABS.length - 1;
    else return;
    event.preventDefault();
    const tab = OPERATION_HISTORY_TABS[target];
    read.selectTab(tab.id);
    document.getElementById(`operation-history-tab-${tab.id}`)?.focus();
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const enabled = clearItemRefs.current.filter((item): item is HTMLButtonElement => Boolean(item && !item.disabled));
    if (event.key === "Escape") {
      event.preventDefault();
      setClearMenuOpen(false);
      clearButtonRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || enabled.length === 0) return;
    event.preventDefault();
    const current = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const target = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1 :
      event.key === "ArrowDown" ? (current + 1 + enabled.length) % enabled.length : (current - 1 + enabled.length) % enabled.length;
    enabled[target].focus();
  };

  const requestClear = (scope: OperationClearScope, invokerIndex: number) => {
    confirmationInvokerIndexRef.current = invokerIndex;
    void controller.clear(scope).then((outcome) => {
      if (mountedRef.current && outcome?.status !== "confirmationRequired") {
        focusClearAfterCloseRef.current = true;
        setClearMenuOpen(false);
      }
    });
  };

  const confirmClear = () => {
    const scope = controller.confirmation?.scope;
    if (!scope) return;
    void controller.clear(scope, true).then(() => {
      if (mountedRef.current) {
        focusClearAfterCloseRef.current = true;
        setClearMenuOpen(false);
      }
    });
  };

  const summary = `${controller.operations.tasks.length} \u4e2a\u4efb\u52a1\uff0c${controller.operations.history.length} \u6761\u5386\u53f2\u8bb0\u5f55`;
  return (
    <main className="operation-history-window" aria-label="\u64cd\u4f5c\u5386\u53f2">
      <header className="operation-history-window__header">
        <div className="operation-history-window__heading">
          <History size={20} aria-hidden="true" />
          <div>
            <h1>{"\u64cd\u4f5c\u5386\u53f2"}</h1>
            <span>{summary}</span>
          </div>
        </div>
        <div className="operation-history-window__commands">
          <button type="button" className="toolbar-button" disabled={mutationDisabled || controller.undoLatestPending || !controller.hasUndoable}
            onClick={() => void controller.undoLatest()}>
            {controller.undoLatestPending ? <Loader2 size={14} aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}
            <span>{"\u64a4\u9500\u6700\u8fd1\u64cd\u4f5c"}</span>
          </button>
          <div className="operation-history-window__clear">
            <button ref={clearButtonRef} type="button" className="toolbar-button" aria-haspopup="menu"
              aria-expanded={clearMenuOpen} disabled={mutationDisabled || !canClearAll}
              onClick={() => setClearMenuOpen((open) => !open)}>
              <Trash2 size={14} aria-hidden="true" /><span>{"\u6e05\u7406"}</span><ChevronDown size={12} aria-hidden="true" />
            </button>
            {clearMenuOpen ? (
              <div ref={clearMenuRef} className="operation-history-window__clear-menu" role="menu" onKeyDown={handleMenuKeyDown}>
                <button ref={(node) => { clearItemRefs.current[0] = node; }} type="button" role="menuitem"
                  disabled={!canClearCurrent || mutationDisabled} onClick={() => currentScope && requestClear(currentScope, 0)}>
                  {"\u6e05\u7406\u5f53\u524d Tab"}
                </button>
                <button ref={(node) => { clearItemRefs.current[1] = node; }} type="button" role="menuitem"
                  disabled={!canClearAll || mutationDisabled} onClick={() => requestClear("all", 1)}>
                  {"\u6e05\u7406\u6240\u6709 Tab"}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <section className="operation-history-window__messages" aria-live="polite">
        {controller.loadError ? <div className="operation-history-message is-error"><AlertTriangle size={14} aria-hidden="true" /><span>{controller.loadError}</span><button type="button" onClick={controller.retry}>{"\u91cd\u8bd5"}</button></div> : null}
        {controller.actionError ? <div className="operation-history-message is-error"><AlertTriangle size={14} aria-hidden="true" /><span>{controller.actionError}</span></div> : null}
        {controller.clearNotice ? <div className="operation-history-message is-info"><span>{controller.clearNotice}</span></div> : null}
        {read.warning ? <div className="operation-history-message is-warning"><AlertTriangle size={14} aria-hidden="true" /><span>{read.warning}</span><button type="button" onClick={read.retry}>{"\u91cd\u8bd5"}</button></div> : null}
        {controller.cleanupWarnings.map((warning) => <div className="operation-history-message is-warning" key={warning}><AlertTriangle size={14} aria-hidden="true" /><span>{warning}</span></div>)}
      </section>

      <nav className="operation-history-window__tabs" role="tablist" aria-label="\u64cd\u4f5c\u5386\u53f2\u5206\u7c7b">
        {OPERATION_HISTORY_TABS.map((tab, index) => {
          const selected = tab.id === selectedTab;
          const unread = read.unreadCounts[tab.id];
          return (
            <button id={`operation-history-tab-${tab.id}`} key={tab.id} type="button" role="tab"
              aria-selected={selected} aria-controls={`operation-history-panel-${tab.id}`} tabIndex={selected ? 0 : -1}
              className={selected ? "is-active" : ""} onClick={() => read.selectTab(tab.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}>
              <span className="operation-history-window__tab-label">{tab.label}</span>
              <span className="operation-history-window__badge-slot">
                {unread > 0 ? <StatusBadge content={formatOperationBadgeCount(unread)} backgroundColor={tab.badgeColor}
                  color="#ffffff" size={16} ariaLabel={`${tab.label}${unread} \u6761\u672a\u67e5\u770b`} /> : null}
              </span>
            </button>
          );
        })}
      </nav>

      <section id={`operation-history-panel-${selectedTab}`} className="operation-history-window__panel"
        role="tabpanel" aria-labelledby={`operation-history-tab-${selectedTab}`} tabIndex={0}>
        {controller.loading ? <div className="operation-history-window__empty"><Loader2 size={18} aria-hidden="true" /><span>{"\u6b63\u5728\u52a0\u8f7d"}</span></div> :
          currentItems.length === 0 ? <div className="operation-history-window__empty">{OPERATION_HISTORY_TABS.find((tab) => tab.id === selectedTab)?.emptyText}</div> :
            <div className="operation-history-window__list">
              {currentItems.map((item) => item.kind === "task" ? (
                <OperationTaskRow key={`task-${item.task.taskId}`} task={item.task}
                  pending={controller.pendingTaskIds.has(item.task.taskId)} disabled={mutationDisabled}
                  onCancelTask={(taskId) => void controller.cancelTask(taskId)} />
              ) : (
                <OperationHistoryRow key={`history-${item.record.recordId}`} record={item.record}
                  pending={controller.pendingRecordIds.has(item.record.recordId)} disabled={mutationDisabled}
                  onUndoRecord={(recordId) => void controller.undoRecord(recordId)} />
              ))}
            </div>}
      </section>

      {controller.confirmation ? (
        <div className="operation-history-confirmation__backdrop">
          <section ref={confirmationDialogRef} className="operation-history-confirmation" role="alertdialog" aria-modal="true"
            aria-busy={controller.clearPending} tabIndex={-1}
            aria-labelledby="operation-history-confirmation-title" aria-describedby="operation-history-confirmation-description">
            <header><AlertTriangle size={18} aria-hidden="true" /><h2 id="operation-history-confirmation-title">{"\u6c38\u4e45\u6e05\u7406\u64cd\u4f5c\u5386\u53f2\uff1f"}</h2></header>
            <p id="operation-history-confirmation-description">
              {"\u6b64\u64cd\u4f5c\u4f1a\u6c38\u4e45\u79fb\u9664\u53ef\u64a4\u9500\u8bb0\u5f55\u53ca\u5176\u64a4\u9500\u80fd\u529b\u3002\u786e\u8ba4\u65f6\u5c06\u6e05\u7406\u5f53\u65f6\u6240\u6709\u7b26\u5408\u6761\u4ef6\u7684\u8bb0\u5f55\u3002"}
            </p>
            <div className="operation-history-confirmation__actions">
              <button ref={cancelConfirmationRef} type="button" className="toolbar-button" disabled={controller.clearPending}
                onClick={controller.dismissConfirmation}>{"\u53d6\u6d88"}</button>
              <button ref={confirmButtonRef} type="button" className="toolbar-button is-danger" disabled={controller.clearPending}
                onClick={confirmClear}>
                {controller.clearPending ? <Loader2 size={14} aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}
                <span>{"\u6c38\u4e45\u6e05\u7406"}</span>
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

import { useEffect, useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronRight, Lock, Plus, X } from "lucide-react";
import { clearEntryDrag, hasEntryDragPayload, readEntryDragPayload } from "./entryDrag";
import { getPathLabel, normalizeLocationPath } from "./mockData";
import type { BreadcrumbItem, PanelId, TabState } from "./types";
import { modifiersMatchShortcutBinding } from "./workspaceShortcuts";

const PANEL_IDS: PanelId[] = ["panel-1", "panel-2", "panel-3", "panel-4"];
const TAB_POINTER_DRAG_THRESHOLD_PX = 4;

type ActiveTabPointerDrag = {
  sourcePanelId: PanelId;
  tabId: string;
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
};

type TabDropTarget = {
  targetPanelId: PanelId;
  targetIndex: number;
};

type DropOperation = "copy" | "move";

type BreadcrumbRenderItem = BreadcrumbItem & {
  future?: boolean;
};

// 拖动跟随元素的状态
type DragFollower = {
  visible: boolean;
  x: number;
  y: number;
  tabTitle: string;
  tabIcon: "lock" | "none";
};

function isRemotePath(path: string) {
  return path.startsWith("ftp://") || path.startsWith("sftp://");
}

function getPathSeparator(path: string) {
  return isRemotePath(path) ? "/" : "\\";
}

function appendPathSegment(basePath: string, segment: string) {
  const separator = getPathSeparator(basePath);
  return basePath.endsWith(separator) ? `${basePath}${segment}` : `${basePath}${separator}${segment}`;
}

function getComparablePath(path: string) {
  const normalized = normalizeLocationPath(path);
  return isRemotePath(normalized) ? normalized : normalized.toLowerCase();
}

function getDeepestForwardPath(currentPath: string, history: string[] | undefined, historyIndex: number | undefined) {
  if (typeof historyIndex !== "number" || !history) {
    return null;
  }

  const normalizedCurrentPath = normalizeLocationPath(currentPath);
  const separator = getPathSeparator(normalizedCurrentPath);
  const currentComparablePath = getComparablePath(normalizedCurrentPath);
  const currentComparablePrefix = currentComparablePath.endsWith(separator)
    ? currentComparablePath
    : `${currentComparablePath}${separator}`;

  return history.slice(historyIndex + 1).reduce<string | null>((deepestPath, historyPath) => {
    const normalizedHistoryPath = normalizeLocationPath(historyPath);
    if (separator !== getPathSeparator(normalizedHistoryPath)) {
      return deepestPath;
    }

    const historyComparablePath = getComparablePath(normalizedHistoryPath);
    if (historyComparablePath === currentComparablePath || !historyComparablePath.startsWith(currentComparablePrefix)) {
      return deepestPath;
    }

    return !deepestPath || historyComparablePath.length > getComparablePath(deepestPath).length
      ? normalizedHistoryPath
      : deepestPath;
  }, null);
}

function getForwardBreadcrumbs(breadcrumbs: BreadcrumbItem[], history: string[] | undefined, historyIndex: number | undefined) {
  const currentPath = breadcrumbs[breadcrumbs.length - 1]?.path;
  if (!currentPath) {
    return [];
  }

  const deepestForwardPath = getDeepestForwardPath(currentPath, history, historyIndex);
  if (!deepestForwardPath) {
    return [];
  }

  const normalizedCurrentPath = normalizeLocationPath(currentPath);
  const normalizedNextPath = normalizeLocationPath(deepestForwardPath);
  const separator = getPathSeparator(normalizedCurrentPath);
  if (separator !== getPathSeparator(normalizedNextPath)) {
    return [];
  }

  const currentComparablePath = getComparablePath(normalizedCurrentPath);
  const nextComparablePath = getComparablePath(normalizedNextPath);
  const currentComparablePrefix = currentComparablePath.endsWith(separator)
    ? currentComparablePath
    : `${currentComparablePath}${separator}`;
  if (nextComparablePath === currentComparablePath || !nextComparablePath.startsWith(currentComparablePrefix)) {
    return [];
  }

  const currentPrefix = normalizedCurrentPath.endsWith(separator) ? normalizedCurrentPath : `${normalizedCurrentPath}${separator}`;
  const futureSegments = normalizedNextPath.slice(currentPrefix.length).split(separator).filter(Boolean);
  let segmentPath = normalizedCurrentPath;
  return futureSegments.map((segment) => {
    segmentPath = appendPathSegment(segmentPath, segment);
    return {
      id: `future-${segmentPath}`,
      label: getPathLabel(segmentPath),
      path: segmentPath,
      future: true
    } satisfies BreadcrumbRenderItem;
  });
}

function parsePanelId(value: string | undefined) {
  return PANEL_IDS.includes(value as PanelId) ? (value as PanelId) : null;
}

function readPositiveInteger(value: string | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function getTabPointerDropTarget(element: Element | null, clientX: number): TabDropTarget | null {
  const tabElement = element?.closest("[data-tab-drop-role='tab']") as HTMLElement | null;
  if (tabElement) {
    const targetPanelId = parsePanelId(tabElement.dataset.panelId);
    const tabIndex = readPositiveInteger(tabElement.dataset.tabIndex);
    if (!targetPanelId || tabIndex === null) {
      return null;
    }

    const rect = tabElement.getBoundingClientRect();
    return {
      targetPanelId,
      targetIndex: rect.width > 0 && clientX > rect.left + rect.width / 2 ? tabIndex + 1 : tabIndex
    };
  }

  const stripElement = element?.closest("[data-tab-drop-role='strip']") as HTMLElement | null;
  const targetPanelId = parsePanelId(stripElement?.dataset.panelId);
  const tabCount = readPositiveInteger(stripElement?.dataset.tabCount);
  if (!targetPanelId || tabCount === null) {
    return null;
  }

  return {
    targetPanelId,
    targetIndex: tabCount
  };
}

export function WorkspacePanelChrome({
  panelId,
  tabs,
  activeTabId,
  breadcrumbs,
  history,
  historyIndex,
  onActivateTab,
  onCloseTab,
  onMoveTab,
  onOpenTabContextMenu,
  onOpenNewTab,
  onNavigateToPath,
  onDropEntries,
  entryDropMoveBinding = "Shift"
}: {
  panelId: PanelId;
  tabs: TabState[];
  activeTabId: string;
  breadcrumbs: BreadcrumbItem[];
  history?: string[];
  historyIndex?: number;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onMoveTab: (sourcePanelId: PanelId, targetPanelId: PanelId, tabId: string, targetIndex: number) => void;
  onOpenTabContextMenu: (tabId: string, x: number, y: number) => void;
  onOpenNewTab: () => void;
  onNavigateToPath: (path: string) => void;
  onDropEntries?: (paths: string[], destination: string, operation: DropOperation) => void;
  entryDropMoveBinding?: string;
}) {
  const activePointerDragRef = useRef<ActiveTabPointerDrag | null>(null);
  const cleanupPointerDragRef = useRef<(() => void) | null>(null);
  const suppressNextClickTabIdRef = useRef<string | null>(null);
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const [entryDropTargetTabId, setEntryDropTargetTabId] = useState<string | null>(null);
  const [dragFollower, setDragFollower] = useState<DragFollower>({
    visible: false,
    x: 0,
    y: 0,
    tabTitle: "",
    tabIcon: "none"
  });
  const [dropIndicator, setDropIndicator] = useState<TabDropTarget | null>(null);

  const breadcrumbItems: BreadcrumbRenderItem[] = [
    ...breadcrumbs,
    ...getForwardBreadcrumbs(breadcrumbs, history, historyIndex)
  ];
  const currentBreadcrumbIndex = breadcrumbs.length - 1;

  useEffect(
    () => () => {
      cleanupPointerDragRef.current?.();
    },
    []
  );

  const startTabPointerDrag = (event: ReactPointerEvent<HTMLButtonElement>, tabId: string) => {
    if (event.button !== 0 || tabs.length <= 1) {
      return;
    }
    if (event.target instanceof HTMLElement && event.target.closest(".tab-strip__close")) {
      return;
    }

    cleanupPointerDragRef.current?.();
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) {
      return;
    }

    const pointerDrag: ActiveTabPointerDrag = {
      sourcePanelId: panelId,
      tabId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false
    };
    activePointerDragRef.current = pointerDrag;

    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      cleanupPointerDragRef.current = null;
      // 清除拖动跟随效果和插入指示器
      setDragFollower({ visible: false, x: 0, y: 0, tabTitle: "", tabIcon: "none" });
      setDropIndicator(null);
    };

    const finishDrag = (finishEvent: PointerEvent) => {
      const activeDrag = activePointerDragRef.current;
      cleanup();
      activePointerDragRef.current = null;

      if (!activeDrag || finishEvent.pointerId !== activeDrag.pointerId || !activeDrag.dragging) {
        return;
      }

      finishEvent.preventDefault();
      suppressNextClickTabIdRef.current = activeDrag.tabId;
      window.setTimeout(() => {
        if (suppressNextClickTabIdRef.current === activeDrag.tabId) {
          suppressNextClickTabIdRef.current = null;
        }
      }, 0);

      const dropTarget = getTabPointerDropTarget(
        document.elementFromPoint(finishEvent.clientX, finishEvent.clientY),
        finishEvent.clientX
      );
      if (!dropTarget) {
        return;
      }

      onMoveTab(activeDrag.sourcePanelId, dropTarget.targetPanelId, activeDrag.tabId, dropTarget.targetIndex);
    };

    function handlePointerMove(moveEvent: PointerEvent) {
      const activeDrag = activePointerDragRef.current;
      if (!activeDrag || moveEvent.pointerId !== activeDrag.pointerId) {
        return;
      }

      const deltaX = moveEvent.clientX - activeDrag.startX;
      const deltaY = moveEvent.clientY - activeDrag.startY;
      if (!activeDrag.dragging && Math.hypot(deltaX, deltaY) < TAB_POINTER_DRAG_THRESHOLD_PX) {
        return;
      }

      if (!activeDrag.dragging) {
        activeDrag.dragging = true;
        // 显示拖动跟随效果（使用非空断言，因为在外层已验证 tab 存在）
        setDragFollower({
          visible: true,
          x: moveEvent.clientX,
          y: moveEvent.clientY,
          tabTitle: tab!.title,
          tabIcon: tab!.locked ? "lock" : "none"
        });
      }

      moveEvent.preventDefault();

      // 更新跟随元素位置
      setDragFollower((prev) => ({
        ...prev,
        x: moveEvent.clientX,
        y: moveEvent.clientY
      }));

      // 更新插入指示器
      const target = getTabPointerDropTarget(
        document.elementFromPoint(moveEvent.clientX, moveEvent.clientY),
        moveEvent.clientX
      );
      setDropIndicator(target);
    }

    function handlePointerUp(upEvent: PointerEvent) {
      finishDrag(upEvent);
    }

    function handlePointerCancel(cancelEvent: PointerEvent) {
      if (cancelEvent.pointerId !== pointerDrag.pointerId) {
        return;
      }
      cleanup();
      activePointerDragRef.current = null;
    }

    cleanupPointerDragRef.current = cleanup;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const canDropEntriesOnTab = (tab: TabState) => Boolean(onDropEntries && tab.kind === "directory" && tab.status === "ready");

  const getTabEntryDropOperation = (event: ReactDragEvent<HTMLElement>): DropOperation =>
    modifiersMatchShortcutBinding(event, entryDropMoveBinding) ? "move" : "copy";

  const clearEntryDropTarget = (tabId?: string) => {
    setEntryDropTargetTabId((current) => (!tabId || current === tabId ? null : current));
  };

  const getEntryDropTabFromElement = (element: Element | null) => {
    const tabElement = element?.closest("[data-tab-drop-role='tab']") as HTMLElement | null;
    const targetPanelId = parsePanelId(tabElement?.dataset.panelId);
    const tabId = tabElement?.dataset.tabId;
    if (!tabElement || targetPanelId !== panelId || !tabId) {
      return null;
    }

    return tabs.find((item) => item.id === tabId) ?? null;
  };

  const getEntryDropTabFromEvent = (event: ReactDragEvent<HTMLElement>) => {
    const directTarget = event.target instanceof Element ? getEntryDropTabFromElement(event.target) : null;
    if (directTarget) {
      return directTarget;
    }

    if (typeof document.elementFromPoint !== "function") {
      return null;
    }
    return getEntryDropTabFromElement(document.elementFromPoint(event.clientX, event.clientY));
  };

  const handleEntryDragOverTab = (event: ReactDragEvent<HTMLElement>, tab: TabState) => {
    if (!canDropEntriesOnTab(tab)) {
      return false;
    }

    const payload = readEntryDragPayload(event.dataTransfer, panelId, tab.id);
    if (!payload && !hasEntryDragPayload(event.dataTransfer)) {
      return false;
    }

    event.preventDefault();
    event.stopPropagation();
    const operation = getTabEntryDropOperation(event);
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = operation;
    }
    setEntryDropTargetTabId(tab.id);
    return true;
  };

  const handleEntryDropOnTab = (event: ReactDragEvent<HTMLElement>, tab: TabState) => {
    if (!canDropEntriesOnTab(tab)) {
      return false;
    }

    const payload = readEntryDragPayload(event.dataTransfer, panelId, tab.id);
    if (!payload) {
      return false;
    }

    event.preventDefault();
    event.stopPropagation();
    onDropEntries?.(payload.paths, tab.snapshot.location.path, getTabEntryDropOperation(event));
    clearEntryDrag();
    clearEntryDropTarget(tab.id);
    return true;
  };

  const buildTabEntryDropHandlers = (tab: TabState) => {
    if (!canDropEntriesOnTab(tab)) {
      return {};
    }

    return {
      onDragOver: (event: ReactDragEvent<HTMLButtonElement>) => {
        handleEntryDragOverTab(event, tab);
      },
      onDragLeave: (event: ReactDragEvent<HTMLButtonElement>) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
          return;
        }
        clearEntryDropTarget(tab.id);
      },
      onDrop: (event: ReactDragEvent<HTMLButtonElement>) => {
        handleEntryDropOnTab(event, tab);
      }
    };
  };

  const handleStripEntryDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    const tab = getEntryDropTabFromEvent(event);
    if (tab) {
      handleEntryDragOverTab(event, tab);
    }
  };

  const handleStripEntryDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    clearEntryDropTarget();
  };

  const handleStripEntryDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    const tab = getEntryDropTabFromEvent(event);
    if (tab) {
      handleEntryDropOnTab(event, tab);
    }
  };

  return (
    <div className="panel-chrome">
      <div
        className="tab-strip"
        data-panel-id={panelId}
        data-tab-count={tabs.length}
        data-tab-drop-role="strip"
        onDragOver={handleStripEntryDragOver}
        onDragLeave={handleStripEntryDragLeave}
        onDrop={handleStripEntryDrop}
      >
        <div ref={tabStripRef} className="tab-strip__tabs">
          {tabs.map((tab, index) => (
            <button
              key={tab.id}
              type="button"
              className={`tab-strip__tab${tab.id === activeTabId ? " is-active" : ""}${
                entryDropTargetTabId === tab.id ? " is-entry-drop-target" : ""
              }`}
              title={tab.snapshot.location.path}
              data-panel-id={panelId}
              data-tab-id={tab.id}
              data-tab-drop-role="tab"
              data-tab-index={index}
              data-entry-drop-kind={canDropEntriesOnTab(tab) ? "tab" : undefined}
              data-entry-drop-path={canDropEntriesOnTab(tab) ? tab.snapshot.location.path : undefined}
              draggable={false}
              onClick={(event) => {
                if (suppressNextClickTabIdRef.current === tab.id) {
                  suppressNextClickTabIdRef.current = null;
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                onActivateTab(tab.id);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                onOpenTabContextMenu(tab.id, event.clientX, event.clientY);
              }}
              onDragStart={(event) => event.preventDefault()}
              onPointerDown={(event) => startTabPointerDrag(event, tab.id)}
              {...buildTabEntryDropHandlers(tab)}
            >
              {tab.locked ? <Lock className="tab-strip__lock" size={10} strokeWidth={2} aria-hidden="true" /> : null}
              <span className="tab-strip__title">{tab.title}</span>
              {tab.id === activeTabId && !tab.locked ? (
                <span
                  className="tab-strip__close"
                  role="button"
                  aria-label={`关闭 ${tab.title}`}
                  title={`关闭 ${tab.title}`}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                >
                  <X className="tab-strip__close-icon" size={8} strokeWidth={2} aria-hidden="true" />
                </span>
              ) : null}
            </button>
          ))}
          <button
            type="button"
            className="tab-strip__add"
            title={`open new tab in ${panelId}`}
            aria-label={`open new tab in ${panelId}`}
            data-panel-id={panelId}
            data-tab-count={tabs.length}
            data-tab-drop-role="strip"
            onClick={onOpenNewTab}
          >
            <Plus className="tab-strip__add-icon" size={10} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        {/* 插入指示器 - 使用绝对定位，动态计算位置 */}
        {dropIndicator && dropIndicator.targetPanelId === panelId && (
          <div
            className="tab-strip__drop-indicator"
            style={{
              left: (() => {
                const targetIndex = dropIndicator.targetIndex;
                const tabElement = tabStripRef.current?.querySelector(
                  `[data-tab-index="${targetIndex}"]`
                ) as HTMLElement;

                if (tabElement) {
                  const stripRect = tabStripRef.current?.getBoundingClientRect();
                  const tabRect = tabElement.getBoundingClientRect();
                  return `${tabRect.left - (stripRect?.left || 0)}px`;
                }

                // 如果找不到目标 Tab（末尾插入），使用最后一个 Tab 的右边缘
                if (targetIndex >= tabs.length && tabs.length > 0) {
                  const lastTabElement = tabStripRef.current?.querySelector(
                    `[data-tab-index="${tabs.length - 1}"]`
                  ) as HTMLElement;
                  if (lastTabElement) {
                    const stripRect = tabStripRef.current?.getBoundingClientRect();
                    const lastTabRect = lastTabElement.getBoundingClientRect();
                    return `${lastTabRect.right - (stripRect?.left || 0)}px`;
                  }
                }

                return '0px';
              })()
            }}
          />
        )}

        {/* 拖动跟随元素 */}
        {dragFollower.visible && (
          <div
            className="tab-drag-follower"
            style={{
              left: dragFollower.x,
              top: dragFollower.y
            }}
          >
            <div className="tab-drag-follower__content">
              {dragFollower.tabIcon === "lock" && (
                <Lock className="tab-drag-follower__lock" size={10} strokeWidth={2} aria-hidden="true" />
              )}
              <span className="tab-drag-follower__title">{dragFollower.tabTitle}</span>
            </div>
          </div>
        )}
      </div>

      <div className="panel-breadcrumbs" aria-label="current folder path">
        {breadcrumbItems.map((breadcrumb, index) => (
          <div
            key={breadcrumb.id}
            className={`panel-breadcrumbs__item${breadcrumb.future ? " panel-breadcrumbs__item--future" : ""}`}
          >
            {index > 0 ? (
              <span className="panel-breadcrumbs__separator" aria-hidden="true">
                <ChevronRight className="panel-breadcrumbs__separator-icon" size={12} strokeWidth={2} />
              </span>
            ) : null}
            <button
              type="button"
              className={`panel-breadcrumbs__segment${breadcrumb.future ? " panel-breadcrumbs__segment--future" : ""}`}
              onClick={() => onNavigateToPath(breadcrumb.path)}
              aria-current={!breadcrumb.future && index === currentBreadcrumbIndex ? "page" : undefined}
            >
              {breadcrumb.label}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

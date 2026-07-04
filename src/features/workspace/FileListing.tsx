import {
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useEffect,
  useRef,
  useState
} from "react";
import {
  clearEntryDrag,
  hasEntryDragPayload,
  readEntryDragPayload
} from "./entryDrag";
import { DetailsListBase } from "./DetailsListBase";
import { getDetailsAutoFitColumnWidth } from "./detailsColumnAutoFit";
import { FileSystemIcon } from "./FileSystemIcon";
import { WORKSPACE_VIEW_MODE_MENU_ITEMS } from "./workspaceSharedMenus";
import { modifiersMatchShortcutBinding } from "./workspaceShortcuts";
import { devLog, devWarn } from "./devLog";
import {
  getColumnHeaderMinWidth,
  getColumnPixelWidth,
  getDetailsCellText,
  getDetailsGridMetrics,
  getEntryTypeLabel,
  getInlineIconSpec,
  getLocalizedColumnLabel,
  getLocationLabel,
  getViewBodyClassName,
  ICON_VIEW_MODES,
  type ListingEntry,
  renderDetailsCell,
  renderNameCell,
  renderTagStack,
  sortEntries
} from "./fileListingPresentation";
import { EntryTooltip, useEntryTooltip } from "./fileListingTooltip";
import type {
  ColumnDefinition,
  ColumnId,
  ClipboardState,
  ContextMenuDefault,
  ContextMenuState,
  EntryViewModel,
  GitFileStatus,
  InlineEditState,
  NativeContextMenuRequest,
  PanelId,
  SortState,
  TabViewMode
} from "./types";
import { formatDriveSize } from "./workspaceDirectoryGateway";

type DropOperation = "copy" | "move";

/** Backend normalizes HashMap keys to lowercase on Windows; try both cases.
 * Only paths explicitly in the map get a badge — untracked/ignored files
 * are not included by the backend and will get no overlay. */
function lookupGitStatus(gitStatus: Record<string, GitFileStatus> | undefined, path: string): GitFileStatus | undefined {
  if (!gitStatus) return undefined;
  return gitStatus[path] ?? gitStatus[path.toLowerCase()];
}

const ENTRY_POINTER_DRAG_THRESHOLD_PX = 4;
const ENTRY_DRAG_FOLLOWER_OFFSET_PX = 12;
const PANEL_IDS: PanelId[] = ["panel-1", "panel-2", "panel-3", "panel-4"];

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function clampClientPointToRect(clientX: number, clientY: number, rect: DOMRect) {
  return {
    x: clamp(clientX, rect.left, rect.right),
    y: clamp(clientY, rect.top, rect.bottom)
  };
}

function isPointOutsideViewport(clientX: number, clientY: number) {
  if (typeof window === "undefined") {
    return false;
  }

  const width = window.innerWidth || document.documentElement.clientWidth || 0;
  const height = window.innerHeight || document.documentElement.clientHeight || 0;
  return clientX < 0 || clientY < 0 || (width > 0 && clientX > width) || (height > 0 && clientY > height);
}

function isExternalFileDrag(dataTransfer: DataTransfer | null) {
  return Array.from(dataTransfer?.types ?? []).includes("Files");
}

function getElementFromClientPoint(clientX: number, clientY: number) {
  if (typeof document.elementFromPoint !== "function") {
    return null;
  }
  return document.elementFromPoint(clientX, clientY);
}

function shouldStartSystemFileDragFromPointer(clientX: number, clientY: number) {
  return isPointOutsideViewport(clientX, clientY) || getElementFromClientPoint(clientX, clientY) === null;
}

type DropModifierState = {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

type ActiveEntryPointerDrag = {
  sourcePanelId: PanelId;
  sourceTabId: string;
  sourceEntryId: string;
  pointerId: number;
  startX: number;
  startY: number;
  paths: string[];
  previewEntry: Pick<EntryViewModel, "kind" | "path" | "extension" | "name">;
  previewCount: number;
  dragging: boolean;
};

type EntryDragFollower = {
  visible: boolean;
  x: number;
  y: number;
  entry: Pick<EntryViewModel, "kind" | "path" | "extension" | "name"> | null;
  count: number;
};

type MarqueeSelection = {
  active: boolean;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

type EntryPointerDropTarget = {
  kind: "tab" | "folder" | "listing";
  path: string;
  operation: DropOperation;
  element: HTMLElement;
} | {
  kind: "navigation";
  operation: "copy";
  element: HTMLElement;
};

const POINTER_DROP_CLASS_BY_KIND: Record<EntryPointerDropTarget["kind"], string> = {
  tab: "is-entry-drop-target",
  folder: "is-drop-target",
  listing: "is-drop-target",
  navigation: "is-entry-drop-target"
};

let highlightedPointerDropElement: HTMLElement | null = null;
let highlightedPointerDropClass: string | null = null;

function clearPointerEntryDropHighlight() {
  if (highlightedPointerDropElement && highlightedPointerDropClass) {
    highlightedPointerDropElement.classList.remove(highlightedPointerDropClass);
  }
  if (highlightedPointerDropElement) {
    delete highlightedPointerDropElement.dataset.dropOperation;
  }
  highlightedPointerDropElement = null;
  highlightedPointerDropClass = null;
}

function applyPointerEntryDropHighlight(target: EntryPointerDropTarget) {
  const className = POINTER_DROP_CLASS_BY_KIND[target.kind] ?? "is-drop-target";
  if (highlightedPointerDropElement !== target.element || highlightedPointerDropClass !== className) {
    clearPointerEntryDropHighlight();
    target.element.classList.add(className);
    highlightedPointerDropElement = target.element;
    highlightedPointerDropClass = className;
  }
  target.element.dataset.dropOperation = target.operation;
}

export const TAB_VIEW_MODE_OPTIONS: Array<{ id: TabViewMode; label: string }> = WORKSPACE_VIEW_MODE_MENU_ITEMS;

export function getTabViewModeLabel(mode: TabViewMode) {
  return TAB_VIEW_MODE_OPTIONS.find((option) => option.id === mode)?.label ?? mode;
}

function getDropOperation(
  event: ReactDragEvent<HTMLElement>,
  payload: { sourcePanelId: PanelId },
  targetPanelId: PanelId,
  moveBinding: string
): DropOperation {
  return getEntryDropOperationFromModifiers(event, payload.sourcePanelId, targetPanelId, moveBinding);
}

function getEntryDropOperationFromModifiers(
  modifiers: DropModifierState,
  sourcePanelId: PanelId,
  targetPanelId: PanelId,
  moveBinding: string
): DropOperation {
  if (modifiersMatchShortcutBinding(modifiers, moveBinding)) {
    return "move";
  }
  if (modifiers.ctrlKey || sourcePanelId !== targetPanelId) {
    return "copy";
  }
  return "move";
}

function getDropOperationFromModifiers(event: ReactDragEvent<HTMLElement>, moveBinding: string): DropOperation {
  if (modifiersMatchShortcutBinding(event, moveBinding)) {
    return "move";
  }
  return event.ctrlKey ? "copy" : "move";
}

function getTabDropOperationFromModifiers(modifiers: DropModifierState, moveBinding: string): DropOperation {
  return modifiersMatchShortcutBinding(modifiers, moveBinding) ? "move" : "copy";
}

function parsePanelId(value: string | undefined, fallback: PanelId) {
  return PANEL_IDS.includes(value as PanelId) ? (value as PanelId) : fallback;
}

function getPointerEntryDropTarget(
  element: Element | null,
  activeDrag: Pick<ActiveEntryPointerDrag, "sourcePanelId">,
  fallbackPanelId: PanelId,
  modifiers: DropModifierState,
  moveBinding: string
): EntryPointerDropTarget | null {
  const entryElement = element?.closest("[data-entry-path]") as HTMLElement | null;
  if (entryElement && !entryElement.dataset.entryDropKind) {
    const listingElement = entryElement.closest("[data-entry-drop-kind='listing'][data-entry-drop-path]") as HTMLElement | null;
    const listingPath = listingElement?.dataset.entryDropPath;
    if (!listingElement || !listingPath) {
      return null;
    }
    const targetPanelId = parsePanelId(listingElement.dataset.panelId, fallbackPanelId);
    return {
      kind: "listing",
      path: listingPath,
      operation: getEntryDropOperationFromModifiers(modifiers, activeDrag.sourcePanelId, targetPanelId, moveBinding),
      element: listingElement
    };
  }

  const dropElement = element?.closest("[data-entry-drop-kind]") as HTMLElement | null;
  const path = dropElement?.dataset.entryDropPath;
  const kind = dropElement?.dataset.entryDropKind;
  if (!dropElement) {
    return null;
  }

  if (kind === "tab" && path) {
    return {
      kind,
      path,
      operation: getTabDropOperationFromModifiers(modifiers, moveBinding),
      element: dropElement
    };
  }

  if (kind === "navigation") {
    return {
      kind,
      operation: "copy",
      element: dropElement
    };
  }

  if ((kind === "folder" || kind === "listing") && path) {
    const targetPanelId = parsePanelId(dropElement.dataset.panelId, fallbackPanelId);
    return {
      kind,
      path,
      operation: getEntryDropOperationFromModifiers(modifiers, activeDrag.sourcePanelId, targetPanelId, moveBinding),
      element: dropElement
    };
  }

  return null;
}

export function FileListingShell({
  panelId,
  tabId,
  entries,
  columns,
  sort,
  currentPath,
  selectedEntryIds,
  viewMode,
  inlineEdit,
  clipboard,
  keyboardNavToken,
  onSort,
  onSelect,
  onSelectMultiple,
  onSelectAll,
  onSelectRange,
  onClearSelection,
  onOpen,
  detailsRowHeight,
  tooltipHoverDelayMs = 200,
  onOpenContextMenu,
  onOpenNativeContextMenu,
  onResizeColumn,
  onSetColumnVisibility,
  onMoveColumn,
  onShowAllColumns,
  onDropEntries,
  onAddEntriesToNavigation,
  onStartSystemFileDrag,
  entryDropMoveBinding = "Shift",
  contextMenuDefault = "native",
  contextMenuToggleBinding = "Shift",
  syncScrollEnabled = false,
  onSyncScroll,
  onInlineEditChange,
  onInlineEditCommit,
  onInlineEditCancel,
  gitStatus,
  selectionCursorId
}: {
  panelId: PanelId;
  tabId: string;
  entries: EntryViewModel[];
  columns: ColumnDefinition[];
  sort: SortState;
  currentPath: string;
  selectedEntryIds: string[];
  viewMode: TabViewMode;
  inlineEdit?: InlineEditState;
  clipboard?: ClipboardState;
  keyboardNavToken?: symbol;
  onSort: (columnId: ColumnId) => void;
  onSelect: (entry: EntryViewModel, multi: boolean) => void;
  onSelectMultiple?: (entryIds: string[]) => void;
  onSelectAll?: () => void;
  onSelectRange?: (fromEntryId: string, toEntryId: string, orderedEntryIds: string[]) => void;
  onClearSelection?: () => void;
  onOpen: (entry: EntryViewModel) => void;
  detailsRowHeight: number;
  tooltipHoverDelayMs?: number;
  onOpenContextMenu: (payload: ContextMenuState) => void;
  onOpenNativeContextMenu: (payload: NativeContextMenuRequest) => void;
  onResizeColumn: (columnId: ColumnId, width: string) => void;
  onSetColumnVisibility?: (columnId: ColumnId, visible: boolean) => void;
  onMoveColumn?: (sourceId: ColumnId, targetId: ColumnId, placement: "before" | "after") => void;
  onShowAllColumns?: (columnIds: ColumnId[]) => void;
  onDropEntries: (paths: string[], destination: string, operation: DropOperation) => void;
  onAddEntriesToNavigation?: (paths: string[]) => void;
  onStartSystemFileDrag?: (paths: string[]) => void;
  entryDropMoveBinding?: string;
  contextMenuDefault?: ContextMenuDefault;
  contextMenuToggleBinding?: string;
  syncScrollEnabled?: boolean;
  onSyncScroll?: (panelId: PanelId, deltaX: number, deltaY: number) => void;
  onInlineEditChange: (value: string) => void;
  onInlineEditCommit: (value?: string) => void;
  onInlineEditCancel: () => void;
  gitStatus?: Record<string, GitFileStatus>;
  selectionCursorId?: string | null;
}) {
  const visibleColumns = columns.filter((column) => column.visible);
  const inlineCreateEntry: ListingEntry | undefined =
    inlineEdit?.mode === "create-folder" || inlineEdit?.mode === "create-file"
      ? {
          id: inlineEdit.mode === "create-folder" ? "__inline-create-folder__" : "__inline-create-file__",
          name: inlineEdit.value,
          kind: inlineEdit.kind,
          path: `${inlineEdit.parentPath}${inlineEdit.mode === "create-folder" ? "__inline_create_folder__" : "__inline_create_file__"}`,
          parentPath: inlineEdit.parentPath,
          sizeLabel: "--",
          modifiedLabel: "",
          extension: inlineEdit.mode === "create-file" && inlineEdit.value.includes(".") ? `.${inlineEdit.value.split(".").pop()}` : "",
          attributes: inlineEdit.kind === "folder" ? ["D"] : ["A"],
          accentColor: "#0f6cbd",
          tags: [],
          comment: "",
          description: inlineEdit.mode === "create-folder" ? "New folder" : "New file",
          inlineCreate: true
        }
      : undefined;
  const sortedEntries: ListingEntry[] = inlineCreateEntry
    ? [inlineCreateEntry, ...sortEntries(entries, sort, currentPath)]
    : sortEntries(entries, sort, currentPath);

  const prevKeyboardNavTokenRef = useRef<symbol | undefined>(undefined);

  // 键盘令牌变化时滚动到焦点项
  // 直接从 selectedEntryIds 计算焦点，避免 focusEntryId state 的异步更新时序问题
  useEffect(() => {
    if (!keyboardNavToken || keyboardNavToken === prevKeyboardNavTokenRef.current) {
      return;
    }
    prevKeyboardNavTokenRef.current = keyboardNavToken;
    const focusId = selectionCursorId ?? selectedEntryIds[selectedEntryIds.length - 1] ?? null;
    if (!focusId) {
      return;
    }
    const element = document.getElementById(`entry-${focusId}`) as HTMLElement | null;
    const scrollContainer = scrollContainerRef.current;
    if (!element || !scrollContainer) {
      return;
    }
    // 手动计算滚动位置以考虑 sticky header 的遮挡
    const containerRect = scrollContainer.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const stickyHeader = scrollContainer.querySelector(".file-listing__header") as HTMLElement | null;
    const headerHeight = stickyHeader ? stickyHeader.getBoundingClientRect().height : 0;
    const marginTop = headerHeight + 2;
    const marginBottom = 2;
    const elementTop = elementRect.top - containerRect.top;
    const elementBottom = elementRect.bottom - containerRect.top;
    if (elementTop < marginTop) {
      scrollContainer.scrollTop -= marginTop - elementTop;
    } else if (elementBottom > containerRect.height - marginBottom) {
      scrollContainer.scrollTop += elementBottom - (containerRect.height - marginBottom);
    }
  }, [keyboardNavToken, selectedEntryIds]);
  const selectedPaths = entries.filter((entry) => selectedEntryIds.includes(entry.id)).map((entry) => entry.path);
  const cutPathSet = new Set(clipboard?.mode === "cut" ? clipboard.paths.map((path) => path.toLowerCase()) : []);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [dropOperation, setDropOperation] = useState<DropOperation>("move");
  const [isListingDropTarget, setIsListingDropTarget] = useState(false);
  const inlineInputRef = useRef<HTMLInputElement | null>(null);
  const suppressNextInlineBlurRef = useRef(false);
  const activeEntryPointerDragRef = useRef<ActiveEntryPointerDrag | null>(null);
  const cleanupEntryPointerDragRef = useRef<(() => void) | null>(null);
  const suppressNextEntryClickRef = useRef<string | null>(null);
  const inlineIconSpec = getInlineIconSpec(viewMode);
  const compactIconSpec = getInlineIconSpec("list");
  const [marqueeSelection, setMarqueeSelection] = useState<MarqueeSelection>({
    active: false,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0
  });
  const [entryDragFollower, setEntryDragFollower] = useState<EntryDragFollower>({
    visible: false,
    x: 0,
    y: 0,
    entry: null,
    count: 0
  });
  const lastClickedEntryIdRef = useRef<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    suppressNextInlineBlurRef.current = false;
    const input = inlineInputRef.current;
    if (!input) {
      return;
    }

    input.focus();
    input.select();
  }, [inlineEdit?.mode, inlineEdit?.entryId]);

  useEffect(
    () => () => {
      cleanupEntryPointerDragRef.current?.();
      clearPointerEntryDropHighlight();
    },
    []
  );

  // 列表键盘快捷键（Ctrl+A 全选等）已统一上提到 useWorkspaceController 的全局 window
  // keydown 监听器，并按 state.activePanelId 路由到激活面板的激活标签页，避免每个面板实例各挂
  // 一个 window 监听器导致“多面板下 Ctrl+A 对所有面板同时生效”的 BUG。

  const visibleOrderedEntryIds = sortedEntries.filter((entry) => !entry.inlineCreate).map((entry) => entry.id);
  const detailsGridMetrics = getDetailsGridMetrics(visibleColumns);
  const gridStyle = {
    gridTemplateColumns: detailsGridMetrics.gridTemplateColumns,
    width: `${detailsGridMetrics.width}px`
  } as CSSProperties;
  const listingStyle = {
    "--details-row-height": `${detailsRowHeight}px`
  } as CSSProperties;

  const clearDropState = () => {
    clearPointerEntryDropHighlight();
    setDropTargetPath(null);
    setDropOperation("move");
    setIsListingDropTarget(false);
  };

  const applyPointerDropTarget = (target: EntryPointerDropTarget | null) => {
    if (!target) {
      clearDropState();
      return;
    }

    clearDropState();
    applyPointerEntryDropHighlight(target);
    if (target.kind === "tab") {
      setDropTargetPath(null);
      setIsListingDropTarget(false);
      return;
    }

    setDropTargetPath(null);
    setIsListingDropTarget(false);
  };

  const getDragPaths = (entry: EntryViewModel) => {
    if (selectedEntryIds.includes(entry.id) && selectedPaths.length > 0) {
      return Array.from(new Set(selectedPaths));
    }
    return [entry.path];
  };

  const getContextMenuPaths = (entry: EntryViewModel) => {
    if (selectedEntryIds.includes(entry.id) && selectedPaths.length > 0) {
      return Array.from(new Set(selectedPaths));
    }
    return [entry.path];
  };

  const isInlineEditingEntry = (entry: ListingEntry) =>
    Boolean(
      inlineEdit &&
        (((inlineEdit.mode === "create-folder" || inlineEdit.mode === "create-file") && entry.inlineCreate) ||
          (inlineEdit.mode === "rename" && inlineEdit.entryId === entry.id))
    );

  const isCutEntry = (entry: ListingEntry) => !entry.inlineCreate && cutPathSet.has(entry.path.toLowerCase());

  const entryClipboardAttrs = (entry: ListingEntry) => ({
    "data-clipboard-mode": isCutEntry(entry) ? "cut" : undefined
  });

  const handleInlineEditKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      suppressNextInlineBlurRef.current = true;
      onInlineEditCommit(event.currentTarget.value);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      suppressNextInlineBlurRef.current = true;
      onInlineEditCancel();
    }
  };

  const handleInlineEditBlur = () => {
    if (suppressNextInlineBlurRef.current) {
      suppressNextInlineBlurRef.current = false;
      return;
    }
    onInlineEditCommit(inlineInputRef.current?.value);
  };

  const commitInlineEditFromOutsidePointer = (target: HTMLElement) => {
    if (!inlineEdit || target.closest(".inline-edit-input")) {
      return false;
    }

    suppressNextInlineBlurRef.current = true;
    window.setTimeout(() => {
      suppressNextInlineBlurRef.current = false;
    }, 0);
    onInlineEditCommit(inlineInputRef.current?.value);
    return true;
  };

  const renderInlineEditInput = () => (
    <input
      ref={inlineInputRef}
      type="text"
      className="inline-edit-input"
      value={inlineEdit?.value ?? ""}
      aria-label={inlineEdit?.mode === "create-folder" ? "New folder name" : inlineEdit?.mode === "create-file" ? "New file name" : "Rename item"}
      onChange={(event) => onInlineEditChange(event.currentTarget.value)}
      onKeyDown={handleInlineEditKeyDown}
      onBlur={handleInlineEditBlur}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    />
  );

  const renderEntryNameContent = (entry: ListingEntry) =>
    isInlineEditingEntry(entry) ? renderInlineEditInput() : <span>{entry.name}</span>;

  const {
    entryTooltip,
    entryTooltipPosition,
    entryTooltipRef,
    hideEntryTooltip,
    buildEntryTooltipHandlers
  } = useEntryTooltip({
    tooltipHoverDelayMs,
    isDisabled: isInlineEditingEntry
  });

  const getRequestedContextMenu = (event: ReactMouseEvent<HTMLElement>): ContextMenuDefault => {
    const shouldToggle = modifiersMatchShortcutBinding(event, contextMenuToggleBinding);
    if (!shouldToggle) {
      return contextMenuDefault;
    }
    return contextMenuDefault === "native" ? "custom" : "native";
  };

  const openCustomContextMenu = (event: ReactMouseEvent<HTMLElement>, scope: ContextMenuState["scope"]) => {
    event.preventDefault();
    event.stopPropagation();
    onOpenContextMenu({
      x: event.clientX,
      y: event.clientY,
      panelId,
      tabId,
      mode: "custom",
      scope
    });
  };

  const openCommentContextMenu = (event: ReactMouseEvent<HTMLElement>, entry: ListingEntry) => {
    if (entry.inlineCreate) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    hideEntryTooltip();
    if (!selectedEntryIds.includes(entry.id)) {
      onSelect(entry, false);
    }
    onOpenContextMenu({
      x: event.clientX,
      y: event.clientY,
      panelId,
      tabId,
      mode: "custom",
      scope: "comment",
      columnId: "comment",
      entryPath: entry.path
    });
  };

  const startEntryPointerDrag = (event: ReactPointerEvent<HTMLElement>, entry: ListingEntry) => {
    if (event.button !== 0 || isInlineEditingEntry(entry)) {
      return;
    }
    if (event.target instanceof HTMLElement && event.target.closest(".inline-edit-input")) {
      return;
    }
    hideEntryTooltip();

    cleanupEntryPointerDragRef.current?.();
    const previewEntries = selectedEntryIds.includes(entry.id)
      ? sortedEntries.filter((candidate) => !candidate.inlineCreate && selectedEntryIds.includes(candidate.id))
      : [entry];
    const previewEntry = previewEntries.find((candidate) => candidate.id === entry.id) ?? previewEntries[0] ?? entry;
    const pointerDrag: ActiveEntryPointerDrag = {
      sourcePanelId: panelId,
      sourceTabId: tabId,
      sourceEntryId: entry.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      paths: getDragPaths(entry),
      previewEntry,
      previewCount: previewEntries.length,
      dragging: false
    };
    activeEntryPointerDragRef.current = pointerDrag;

    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      document.body.classList.remove("is-entry-pointer-dragging");
      setEntryDragFollower({
        visible: false,
        x: 0,
        y: 0,
        entry: null,
        count: 0
      });
      cleanupEntryPointerDragRef.current = null;
    };

    const finishDrag = (finishEvent: PointerEvent) => {
      const activeDrag = activeEntryPointerDragRef.current;
      cleanup();
      activeEntryPointerDragRef.current = null;

      if (!activeDrag || finishEvent.pointerId !== activeDrag.pointerId) {
        clearDropState();
        return;
      }

      if (!activeDrag.dragging) {
        clearDropState();
        return;
      }

      finishEvent.preventDefault();
      suppressNextEntryClickRef.current = activeDrag.sourceEntryId;
      window.setTimeout(() => {
        if (suppressNextEntryClickRef.current === activeDrag.sourceEntryId) {
          suppressNextEntryClickRef.current = null;
        }
      }, 0);

      const dropTarget = getPointerEntryDropTarget(
        getElementFromClientPoint(finishEvent.clientX, finishEvent.clientY),
        activeDrag,
        panelId,
        finishEvent,
        entryDropMoveBinding
      );
      if (dropTarget) {
        if (dropTarget.kind === "navigation") {
          onAddEntriesToNavigation?.(activeDrag.paths);
        } else {
          onDropEntries(activeDrag.paths, dropTarget.path, dropTarget.operation);
        }
      }
      clearEntryDrag();
      clearDropState();
    };

    function handlePointerMove(moveEvent: PointerEvent) {
      const activeDrag = activeEntryPointerDragRef.current;
      if (!activeDrag || moveEvent.pointerId !== activeDrag.pointerId) {
        return;
      }

      const deltaX = moveEvent.clientX - activeDrag.startX;
      const deltaY = moveEvent.clientY - activeDrag.startY;
      if (!activeDrag.dragging && Math.hypot(deltaX, deltaY) < ENTRY_POINTER_DRAG_THRESHOLD_PX) {
        return;
      }

      activeDrag.dragging = true;
      moveEvent.preventDefault();
      if (shouldStartSystemFileDragFromPointer(moveEvent.clientX, moveEvent.clientY)) {
        cleanup();
        activeEntryPointerDragRef.current = null;
        suppressNextEntryClickRef.current = activeDrag.sourceEntryId;
        window.setTimeout(() => {
          if (suppressNextEntryClickRef.current === activeDrag.sourceEntryId) {
            suppressNextEntryClickRef.current = null;
          }
        }, 0);
        clearEntryDrag();
        clearDropState();
        if (moveEvent.target instanceof HTMLElement && typeof moveEvent.target.releasePointerCapture === "function") {
          try {
            moveEvent.target.releasePointerCapture(moveEvent.pointerId);
          } catch {
            // Pointer capture may already be released by the WebView boundary transition.
          }
        }
        onStartSystemFileDrag?.(activeDrag.paths);
        return;
      }

      document.body.classList.add("is-entry-pointer-dragging");
      setEntryDragFollower({
        visible: true,
        x: moveEvent.clientX + ENTRY_DRAG_FOLLOWER_OFFSET_PX,
        y: moveEvent.clientY + ENTRY_DRAG_FOLLOWER_OFFSET_PX,
        entry: activeDrag.previewEntry,
        count: activeDrag.previewCount
      });
      applyPointerDropTarget(
        getPointerEntryDropTarget(
          getElementFromClientPoint(moveEvent.clientX, moveEvent.clientY),
          activeDrag,
          panelId,
          moveEvent,
          entryDropMoveBinding
        )
      );
    }

    function handlePointerUp(upEvent: PointerEvent) {
      finishDrag(upEvent);
    }

    function handlePointerCancel(cancelEvent: PointerEvent) {
      if (cancelEvent.pointerId !== pointerDrag.pointerId) {
        return;
      }
      cleanup();
      activeEntryPointerDragRef.current = null;
      clearEntryDrag();
      clearDropState();
    }

    cleanupEntryPointerDragRef.current = cleanup;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const buildEntryHandlers = (entry: ListingEntry) => {
    if (entry.inlineCreate) {
      return {
        ...buildEntryTooltipHandlers(entry),
        draggable: false,
        onClick: (event: ReactMouseEvent<HTMLElement>) => event.stopPropagation(),
        onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => event.stopPropagation(),
        onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
          event.preventDefault();
          event.stopPropagation();
        }
      };
    }

    return {
      ...buildEntryTooltipHandlers(entry),
      draggable: false,
      onClick: (event: ReactMouseEvent<HTMLElement>) => {
        if (suppressNextEntryClickRef.current === entry.id) {
          suppressNextEntryClickRef.current = null;
          event.preventDefault();
          event.stopPropagation();
          return;
        }

        // Shift + Click: 范围选择
        if (event.shiftKey && lastClickedEntryIdRef.current) {
          devLog("[FileListing] Shift+Click detected, from:", lastClickedEntryIdRef.current, "to:", entry.id, "onSelectRange:", onSelectRange);
          event.preventDefault();
          event.stopPropagation();
          const anchorIsVisible = visibleOrderedEntryIds.includes(lastClickedEntryIdRef.current);
          const targetIsVisible = visibleOrderedEntryIds.includes(entry.id);
          if (onSelectRange && anchorIsVisible && targetIsVisible) {
            devLog("[FileListing] Calling onSelectRange");
            onSelectRange(lastClickedEntryIdRef.current, entry.id, visibleOrderedEntryIds);
            return;
          }
          if (!onSelectRange) {
            devWarn("[FileListing] onSelectRange is undefined");
          }
        }

        lastClickedEntryIdRef.current = entry.id;
        onSelect(entry, event.ctrlKey || event.metaKey);
      },
      onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => {
        if (suppressNextEntryClickRef.current === entry.id) {
          suppressNextEntryClickRef.current = null;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onOpen(entry);
      },
      onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
        if (ICON_VIEW_MODES.includes(viewMode) && event.target === event.currentTarget) {
          openBlankContextMenu(event);
          return;
        }
        hideEntryTooltip();
        event.preventDefault();
        event.stopPropagation();
        const requestedMenu = getRequestedContextMenu(event);
        if (!selectedEntryIds.includes(entry.id)) {
          onSelect(entry, false);
        }
        if (requestedMenu === "custom") {
          onOpenContextMenu({
            x: event.clientX,
            y: event.clientY,
            panelId,
            tabId,
            mode: "custom",
            scope: "selection"
          });
          return;
        }
        const nativeRequest: NativeContextMenuRequest = {
          panelId,
          tabId,
          target: "selection",
          paths: getContextMenuPaths(entry),
          clientX: event.clientX,
          clientY: event.clientY,
          screenX: event.screenX,
          screenY: event.screenY
        };
        window.setTimeout(() => {
          onOpenNativeContextMenu(nativeRequest);
        }, 0);
      },
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => startEntryPointerDrag(event, entry),
      onDragStart: (event: ReactDragEvent<HTMLElement>) => event.preventDefault(),
      onDragEnd: () => {
        clearEntryDrag();
        clearDropState();
      },
      onDragOver: entry.kind === "folder"
        ? (event: ReactDragEvent<HTMLElement>) => {
            if (isExternalFileDrag(event.dataTransfer)) {
              event.preventDefault();
              event.stopPropagation();
              if (event.dataTransfer) {
                event.dataTransfer.dropEffect = "copy";
              }
              setDropTargetPath(entry.path);
              setDropOperation("copy");
              return;
            }

            const payload = readEntryDragPayload(event.dataTransfer, panelId, tabId);
            if (!payload && !hasEntryDragPayload(event.dataTransfer)) {
              return;
            }

            event.preventDefault();
            event.stopPropagation();
            const nextOperation = payload
              ? getDropOperation(event, payload, panelId, entryDropMoveBinding)
              : getDropOperationFromModifiers(event, entryDropMoveBinding);
            if (event.dataTransfer) {
              event.dataTransfer.dropEffect = nextOperation;
            }
            setDropTargetPath(entry.path);
            setDropOperation(nextOperation);
          }
        : undefined,
      onDragLeave: entry.kind === "folder"
        ? (event: ReactDragEvent<HTMLElement>) => {
            const nextTarget = event.relatedTarget;
            if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
              return;
            }
            if (dropTargetPath === entry.path) {
              clearDropState();
            }
          }
        : undefined,
      onDrop: entry.kind === "folder"
        ? (event: ReactDragEvent<HTMLElement>) => {
            if (isExternalFileDrag(event.dataTransfer)) {
              event.preventDefault();
              event.stopPropagation();
              clearDropState();
              return;
            }

            const payload = readEntryDragPayload(event.dataTransfer, panelId, tabId);
            if (!payload) {
              return;
            }

            event.preventDefault();
            event.stopPropagation();
            const nextOperation = getDropOperation(event, payload, panelId, entryDropMoveBinding);
            onDropEntries(payload.paths, entry.path, nextOperation);
            clearEntryDrag();
            clearDropState();
          }
        : undefined
    };
  };

  const renderDriveInfo = (di: NonNullable<EntryViewModel["driveInfo"]>) => {
    if (di.totalBytes == null) return null;
    const pct = Math.min(100, Math.round(((di.totalBytes - (di.availableBytes ?? 0)) / di.totalBytes) * 100));
    return (
      <div className="drive-info">
        <div className="drive-usage-bar"><div className={`drive-usage-bar__fill${pct >= 90 ? " drive-usage-bar__fill--critical" : ""}`} style={{ width: `${pct}%` }} /></div>
        <span className="drive-info__text">可用: {formatDriveSize(di.availableBytes)} / 总计: {formatDriveSize(di.totalBytes)}</span>
      </div>
    );
  };

  const renderEmptyState = () => <div className="file-listing__empty">当前目录为空</div>;

  const renderDetailsRows = () =>
    sortedEntries.map((entry) => {
      const isSelected = selectedEntryIds.includes(entry.id);
      const isDropTarget = entry.kind === "folder" && dropTargetPath === entry.path;
      const isEditing = isInlineEditingEntry(entry);
      const isCut = isCutEntry(entry);
      return (
        <div
          key={`entry-${entry.id}`}
          className={`file-row${isSelected ? " is-selected" : ""}${isDropTarget ? " is-drop-target" : ""}${isEditing ? " is-inline-editing" : ""}${isCut ? " is-cut" : ""}`}
          style={{ "--row-accent": entry.accentColor } as CSSProperties}
          id={`entry-${entry.id}`}
          data-panel-id={panelId}
          data-entry-path={entry.path}
          data-entry-drop-kind={entry.kind === "folder" ? "folder" : undefined}
          data-entry-drop-path={entry.kind === "folder" ? entry.path : undefined}
          data-inline-edit={isEditing ? "true" : undefined}
          data-drop-operation={isDropTarget ? dropOperation : undefined}
          {...entryClipboardAttrs(entry)}
          {...buildEntryHandlers(entry)}
        >
          <div className="file-row__grid" style={gridStyle}>
            {visibleColumns.map((column) => (
              <div
                key={column.id}
                className={`file-cell file-cell--${column.align}`}
                data-cell-column-id={column.id}
                onContextMenu={column.id === "comment" ? (event) => openCommentContextMenu(event, entry) : undefined}
              >
                {renderDetailsCell(entry, column.id, currentPath, renderEntryNameContent(entry), lookupGitStatus(gitStatus, entry.path))}
              </div>
            ))}
          </div>
          {entry.driveInfo && renderDriveInfo(entry.driveInfo)}
        </div>
      );
    });

  const renderIconCards = () =>
    sortedEntries.map((entry) => {
      const isSelected = selectedEntryIds.includes(entry.id);
      const isDropTarget = entry.kind === "folder" && dropTargetPath === entry.path;
      const isEditing = isInlineEditingEntry(entry);
      const isCut = isCutEntry(entry);
      return (
        <div
          key={entry.id}
          id={`entry-${entry.id}`}
          className={`file-card file-card--icon${isSelected ? " is-selected" : ""}${isDropTarget ? " is-drop-target" : ""}${isEditing ? " is-inline-editing" : ""}${isCut ? " is-cut" : ""}`}
          style={{ "--row-accent": entry.accentColor } as CSSProperties}
          data-panel-id={panelId}
          data-entry-path={entry.path}
          data-entry-drop-kind={entry.kind === "folder" ? "folder" : undefined}
          data-entry-drop-path={entry.kind === "folder" ? entry.path : undefined}
          data-inline-edit={isEditing ? "true" : undefined}
          data-drop-operation={isDropTarget ? dropOperation : undefined}
          {...entryClipboardAttrs(entry)}
          {...buildEntryHandlers(entry)}
        >
          <div className="file-card__hero">
            <FileSystemIcon
              kind={entry.kind}
              path={entry.path}
              extension={entry.extension}
              size={inlineIconSpec.displaySize}
              imageList={inlineIconSpec.imageList}
              hidden={entry.isHidden}
              gitStatus={lookupGitStatus(gitStatus, entry.path)}
            />
          </div>
          <div className="file-card__title file-card__title--multiline" title={entry.name}>
            {renderEntryNameContent(entry)}
          </div>
        </div>
      );
    });

  const renderListRows = () =>
    sortedEntries.map((entry) => {
      const isSelected = selectedEntryIds.includes(entry.id);
      const isDropTarget = entry.kind === "folder" && dropTargetPath === entry.path;
      const isEditing = isInlineEditingEntry(entry);
      const isCut = isCutEntry(entry);
      return (
        <div
          key={entry.id}
          id={`entry-${entry.id}`}
          className={`file-list-item${isSelected ? " is-selected" : ""}${isDropTarget ? " is-drop-target" : ""}${isEditing ? " is-inline-editing" : ""}${isCut ? " is-cut" : ""}`}
          style={{ "--row-accent": entry.accentColor } as CSSProperties}
          data-panel-id={panelId}
          data-entry-path={entry.path}
          data-entry-drop-kind={entry.kind === "folder" ? "folder" : undefined}
          data-entry-drop-path={entry.kind === "folder" ? entry.path : undefined}
          data-inline-edit={isEditing ? "true" : undefined}
          data-drop-operation={isDropTarget ? dropOperation : undefined}
          {...entryClipboardAttrs(entry)}
          {...buildEntryHandlers(entry)}
        >
          {renderNameCell(entry, compactIconSpec, "entry-name--compact", renderEntryNameContent(entry), lookupGitStatus(gitStatus, entry.path))}
        </div>
      );
    });

  const renderTileCards = () => {
    const tileIcon = inlineIconSpec;
    return sortedEntries.map((entry) => {
      const isSelected = selectedEntryIds.includes(entry.id);
      const isDropTarget = entry.kind === "folder" && dropTargetPath === entry.path;
      const isEditing = isInlineEditingEntry(entry);
      const isCut = isCutEntry(entry);
      const di = entry.driveInfo;
      const drivePct = di?.totalBytes != null ? Math.min(100, Math.round(((di.totalBytes - (di.availableBytes ?? 0)) / di.totalBytes) * 100)) : null;
      return (
        <div
          key={entry.id}
          id={`entry-${entry.id}`}
          className={`file-card file-card--tile${isSelected ? " is-selected" : ""}${isDropTarget ? " is-drop-target" : ""}${isEditing ? " is-inline-editing" : ""}${isCut ? " is-cut" : ""}`}
          style={{ "--row-accent": entry.accentColor } as CSSProperties}
          data-panel-id={panelId}
          data-entry-path={entry.path}
          data-entry-drop-kind={entry.kind === "folder" ? "folder" : undefined}
          data-entry-drop-path={entry.kind === "folder" ? entry.path : undefined}
          data-inline-edit={isEditing ? "true" : undefined}
          data-drop-operation={isDropTarget ? dropOperation : undefined}
          {...entryClipboardAttrs(entry)}
          {...buildEntryHandlers(entry)}
        >
          <div className="file-card__tile-icon">
            <FileSystemIcon kind={entry.kind} path={entry.path} extension={entry.extension}
              size={tileIcon.displaySize} imageList={tileIcon.imageList} hidden={entry.isHidden}
              gitStatus={lookupGitStatus(gitStatus, entry.path)} />
          </div>
          <div className="file-card__tile-info">
            <span className="file-card__tile-name" title={entry.name}>{renderEntryNameContent(entry)}</span>
            {drivePct != null && di ? (
              <>
                <div className="drive-usage-bar"><div className={`drive-usage-bar__fill${drivePct >= 90 ? " drive-usage-bar__fill--critical" : ""}`} style={{ width: `${drivePct}%` }} /></div>
                <span className="file-card__tile-detail">可用空间: {formatDriveSize(di.availableBytes)}</span>
                <span className="file-card__tile-detail">总大小: {formatDriveSize(di.totalBytes)}</span>
              </>
            ) : entry.kind === "folder" ? (
              <span className="file-card__tile-type">{getEntryTypeLabel(entry)}</span>
            ) : (
              <>
                <span className="file-card__tile-detail">{entry.sizeLabel}</span>
                <span className="file-card__tile-detail">{entry.modifiedLabel}</span>
              </>
            )}
          </div>
        </div>
      );
    });
  };

  const renderContentRows = () =>
    sortedEntries.map((entry) => {
      const isSelected = selectedEntryIds.includes(entry.id);
      const isDropTarget = entry.kind === "folder" && dropTargetPath === entry.path;
      const isEditing = isInlineEditingEntry(entry);
      const isCut = isCutEntry(entry);
      return (
        <div
          key={entry.id}
          id={`entry-${entry.id}`}
          className={`file-content-item${isSelected ? " is-selected" : ""}${isDropTarget ? " is-drop-target" : ""}${isEditing ? " is-inline-editing" : ""}${isCut ? " is-cut" : ""}`}
          style={{ "--row-accent": entry.accentColor } as CSSProperties}
          data-panel-id={panelId}
          data-entry-path={entry.path}
          data-entry-drop-kind={entry.kind === "folder" ? "folder" : undefined}
          data-entry-drop-path={entry.kind === "folder" ? entry.path : undefined}
          data-inline-edit={isEditing ? "true" : undefined}
          data-drop-operation={isDropTarget ? dropOperation : undefined}
          {...entryClipboardAttrs(entry)}
          {...buildEntryHandlers(entry)}
        >
          <div className="file-content-item__main">
            {renderNameCell(entry, compactIconSpec, undefined, renderEntryNameContent(entry), lookupGitStatus(gitStatus, entry.path))}
            <p>{entry.description}</p>
            {entry.contentText ? <p className="file-content-item__snippet">{entry.contentText}</p> : null}
            {renderTagStack(entry)}
          </div>
          <div className="file-content-item__meta">
            <span>{getEntryTypeLabel(entry)}</span>
            <span>{entry.sizeLabel}</span>
            <span>{entry.modifiedLabel}</span>
            <span>{getLocationLabel(entry, currentPath)}</span>
          </div>
        </div>
      );
    });

  const renderBody = () => {
    if (sortedEntries.length === 0) {
      return renderEmptyState();
    }

    if (ICON_VIEW_MODES.includes(viewMode)) {
      return renderIconCards();
    }

    switch (viewMode) {
      case "list":
        return renderListRows();
      case "details":
        return renderDetailsRows();
      case "tiles":
        return renderTileCards();
      case "content":
        return renderContentRows();
      default:
        return renderDetailsRows();
    }
  };

  const openBlankContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    if (getRequestedContextMenu(event) === "custom") {
      openCustomContextMenu(event, "panel");
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onOpenNativeContextMenu({
      panelId,
      tabId,
      target: "background",
      paths: [],
      directoryPath: currentPath,
      clientX: event.clientX,
      clientY: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY
    });
  };

  const handleBlankContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement && event.target.closest("[data-entry-path]")) {
      return;
    }

    openBlankContextMenu(event);
  };

  const handleListingDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (isExternalFileDrag(event.dataTransfer)) {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
      setDropTargetPath(null);
      setIsListingDropTarget(true);
      setDropOperation("copy");
      return;
    }

    if (event.target instanceof HTMLElement && event.target.closest("[data-entry-path]")) {
      return;
    }

    const payload = readEntryDragPayload(event.dataTransfer, panelId, tabId);
    if (!payload && !hasEntryDragPayload(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    const nextOperation = payload
      ? getDropOperation(event, payload, panelId, entryDropMoveBinding)
      : getDropOperationFromModifiers(event, entryDropMoveBinding);
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = nextOperation;
    }
    setDropTargetPath(null);
    setIsListingDropTarget(true);
    setDropOperation(nextOperation);
  };

  const handleListingDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    clearDropState();
  };

  const handleListingDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (isExternalFileDrag(event.dataTransfer)) {
      event.preventDefault();
      clearDropState();
      return;
    }

    if (event.target instanceof HTMLElement && event.target.closest("[data-entry-path]")) {
      return;
    }

    const payload = readEntryDragPayload(event.dataTransfer, panelId, tabId);
    if (!payload) {
      return;
    }

    event.preventDefault();
    const nextOperation = getDropOperation(event, payload, panelId, entryDropMoveBinding);
    onDropEntries(payload.paths, currentPath, nextOperation);
    clearEntryDrag();
    clearDropState();
  };

  const handleListingWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!syncScrollEnabled) {
      return;
    }
    onSyncScroll?.(panelId, event.deltaX, event.deltaY);
  };

  const handleListingMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const isBlankListingTarget = () => {
      if (target.closest(".file-listing__header")) {
        return false;
      }
      if (target.closest("[data-entry-path]") || target.closest(".inline-edit-input")) {
        return false;
      }

      return (
        target.classList.contains("file-listing__scroll") ||
        target.classList.contains("file-listing__body") ||
        target.closest(".file-listing__scroll") !== null
      );
    };

    devLog("[FileListing] handleListingMouseDown triggered", {
      button: event.button,
      targetTagName: target.tagName,
      targetClassName: target.className,
      closestEntryPath: target.closest("[data-entry-path]"),
      closestInlineEdit: target.closest(".inline-edit-input"),
      isScrollContainer: target.classList.contains("file-listing__scroll"),
      isBodyContainer: target.classList.contains("file-listing__body")
    });

    if (event.button === 2 && isBlankListingTarget()) {
      event.preventDefault();
      return;
    }

    // 只处理左键，并且不是在列表项上
    if (event.button !== 0) {
      devLog("[FileListing] Ignoring non-left button");
      return;
    }

    if (commitInlineEditFromOutsidePointer(target)) {
      return;
    }

    // 排除点击在具体文件项或输入框上的情况
    if (target.closest("[data-entry-path]") || target.closest(".inline-edit-input")) {
      devLog("[FileListing] Ignoring click on entry or input");
      return;
    }

    // 允许点击在 scroll 容器、body 容器或空白区域
    // 不排除 file-listing__body，让它的空白区域也能触发框选
    if (!isBlankListingTarget()) {
      devLog("[FileListing] Target is not valid for marquee selection");
      return;
    }

    devLog("[FileListing] Mouse down on blank area, onClearSelection:", onClearSelection, "selectedEntryIds:", selectedEntryIds);

    // 清除选择
    if (onClearSelection && selectedEntryIds.length > 0) {
      devLog("[FileListing] Calling onClearSelection");
      onClearSelection();
    }

    // 开始框选
    devLog("[FileListing] Starting marquee selection, onSelectMultiple:", onSelectMultiple);
    event.preventDefault();
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      devWarn("[FileListing] scrollContainer is null");
      return;
    }

    const rect = scrollContainer.getBoundingClientRect();
    const startPoint = clampClientPointToRect(event.clientX, event.clientY, rect);
    const startX = startPoint.x;
    const startY = startPoint.y;

    setMarqueeSelection({
      active: true,
      startX,
      startY,
      currentX: startX,
      currentY: startY
    });

    const handleMouseMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      const movePoint = clampClientPointToRect(
        moveEvent.clientX,
        moveEvent.clientY,
        scrollContainer.getBoundingClientRect()
      );
      const currentX = movePoint.x;
      const currentY = movePoint.y;
      setMarqueeSelection({
        active: true,
        startX,
        startY,
        currentX,
        currentY
      });

      // 计算框选矩形
      const marqueeRect = {
        left: Math.min(startX, currentX),
        top: Math.min(startY, currentY),
        right: Math.max(startX, currentX),
        bottom: Math.max(startY, currentY)
      };

      // 找出与框选区域相交的条目
      const selectedIds: string[] = [];
      const entryElements = scrollContainer.querySelectorAll("[data-entry-path]");

      entryElements.forEach((element) => {
        const entryRect = element.getBoundingClientRect();
        const intersects =
          marqueeRect.left < entryRect.right &&
          marqueeRect.right > entryRect.left &&
          marqueeRect.top < entryRect.bottom &&
          marqueeRect.bottom > entryRect.top;

        if (intersects) {
          const entryPath = (element as HTMLElement).dataset.entryPath;
          const entry = sortedEntries.find((e) => e.path === entryPath);
          if (entry && !entry.inlineCreate) {
            selectedIds.push(entry.id);
          }
        }
      });

      // 更新选择
      if (selectedIds.length > 0) {
        devLog("[FileListing] Marquee selected IDs:", selectedIds);
        if (onSelectMultiple) {
          devLog("[FileListing] Calling onSelectMultiple with", selectedIds.length, "items");
          onSelectMultiple(selectedIds);
        } else {
          devWarn("[FileListing] onSelectMultiple is undefined");
        }
      }
    };

    const handleMouseUp = () => {
      setMarqueeSelection({
        active: false,
        startX: 0,
        startY: 0,
        currentX: 0,
        currentY: 0
      });
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  return (
    <div
      className={`file-listing file-listing--${viewMode}`}
      data-view-mode={viewMode}
      style={listingStyle}
      onContextMenu={handleBlankContextMenu}
    >
      <div
        ref={scrollContainerRef}
        className={`file-listing__scroll${isListingDropTarget ? " is-drop-target" : ""}`}
        data-panel-id={panelId}
        data-entry-drop-kind="listing"
        data-entry-drop-path={currentPath}
        data-drop-operation={isListingDropTarget ? dropOperation : undefined}
        onContextMenu={handleBlankContextMenu}
        onDragOver={handleListingDragOver}
        onDragLeave={handleListingDragLeave}
        onDrop={handleListingDrop}
        onMouseDown={handleListingMouseDown}
        onWheel={handleListingWheel}
      >
        {viewMode === "details" ? (
          <DetailsListBase<ColumnId, ColumnDefinition>
            columns={columns}
            sort={sort}
            gap={4}
            getColumnLabel={getLocalizedColumnLabel}
            getColumnMinWidth={getColumnHeaderMinWidth}
            getColumnPixelWidth={getColumnPixelWidth}
            onSort={onSort}
            onResizeColumn={onResizeColumn}
            onMoveColumn={onMoveColumn}
            onSetColumnVisibility={onSetColumnVisibility}
            onShowAllColumns={onShowAllColumns}
            onAutoFitColumn={(column) =>
              onResizeColumn(
                column.id,
                getDetailsAutoFitColumnWidth({
                  root: scrollContainerRef.current,
                  column,
                  items: entries,
                  cellDataAttribute: "data-cell-column-id",
                  getHeaderText: getLocalizedColumnLabel,
                  getCellText: (entry, candidate) => getDetailsCellText(entry, candidate.id, currentPath),
                  getMinWidth: getColumnHeaderMinWidth,
                  getIconAllowance: (candidate) => (candidate.id === "name" ? 22 : 0)
                })
              )
            }
            headerDataAttributes={{ "data-details-scroll-header": "true" }}
            headerClassName="file-listing__header"
            cellClassName="file-header-cell"
            buttonClassName="file-header-button file-cell file-cell--header"
            indicatorClassName="file-header-button__indicator"
            resizerClassName="file-header-resizer"
            resizerSelector=".file-header-resizer"
            headerCellSelector=".file-header-cell"
          >
            {() => <div className={getViewBodyClassName(viewMode, sortedEntries.length === 0)}>{renderBody()}</div>}
          </DetailsListBase>
        ) : (
          <div className={getViewBodyClassName(viewMode, sortedEntries.length === 0)}>{renderBody()}</div>
        )}

        {/* 框选矩形 */}
        {marqueeSelection.active && (
          <div
            className="file-listing__marquee"
            style={{
              position: "fixed",
              left: Math.min(marqueeSelection.startX, marqueeSelection.currentX),
              top: Math.min(marqueeSelection.startY, marqueeSelection.currentY),
              width: Math.abs(marqueeSelection.currentX - marqueeSelection.startX),
              height: Math.abs(marqueeSelection.currentY - marqueeSelection.startY),
              border: "1px solid #0078d4",
              backgroundColor: "rgba(0, 120, 212, 0.1)",
              boxSizing: "border-box",
              pointerEvents: "none",
              zIndex: 1000
            }}
          />
        )}
      </div>
      <EntryTooltip tooltip={entryTooltip} tooltipRef={entryTooltipRef} position={entryTooltipPosition} />
      {entryDragFollower.visible && entryDragFollower.entry ? (
        <div
          className="entry-drag-follower"
          style={{
            left: entryDragFollower.x,
            top: entryDragFollower.y
          }}
        >
          <div className="entry-drag-follower__content">
            <FileSystemIcon
              kind={entryDragFollower.entry.kind}
              path={entryDragFollower.entry.path}
              extension={entryDragFollower.entry.extension}
              size={20}
              imageList="sys-small"
            />
            <span className="entry-drag-follower__name">{entryDragFollower.entry.name}</span>
            {entryDragFollower.count > 1 ? <span className="entry-drag-follower__count">{entryDragFollower.count}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

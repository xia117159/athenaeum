import {
  type CSSProperties,
  type ReactNode,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useFileListingVirtualizer } from "./useFileListingVirtualizer";
import { isScrollbarPointer, useListingMarquee } from "./fileListingMarquee";
import { FileDetailsRow, FileIconCard, type RowRenderState } from "./fileListingRows";
import { clearEntryDrag, hasEntryDragPayload, readEntryDragPayload } from "./entryDrag";
import { DetailsListBase } from "./DetailsListBase";
import { getDetailsAutoFitColumnWidth } from "./detailsColumnAutoFit";
import { FolderExpansionNameCell, FOLDER_INDENT_PX, FOLDER_TOGGLE_PX, releaseFolderExpansionControlFocus } from "./FolderExpansionNameCell";
import type { FolderListingRow } from "./folderExpansion";
import { FileSystemIcon } from "./FileSystemIcon";
import { WORKSPACE_VIEW_MODE_MENU_ITEMS } from "./workspaceSharedMenus";
import { modifiersMatchShortcutBinding } from "./workspaceShortcuts";
import { devLog, devWarn } from "./devLog";
import {
  createInlineCreateEntry,
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
  renderDriveInfo,
  renderNameCell,
  renderTagStack,
  sortEntries
} from "./fileListingPresentation";
import { EntryTooltipLayer, useEntryTooltip } from "./fileListingTooltip";
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
import { getFileColorRowAttributes, getFileColorLabelAttributes } from "./fileColorStyle";
import { renderEntryNameText } from "./entryNameHighlight";
import type { QuickFilterProgram } from "./quickFilterTypes";
import type { DirectorySizeMenuAction } from "./directorySizeMenu";

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
  folderRows,
  folderExpansionOnRowClick = false,
  sizeHeaderAccessory,
  directorySizeAction,
  onToggleFolderExpansion,
  onRetryFolderExpansion,
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
  sizeBarLow,
  sizeBarHigh,
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
  selectionCursorId,
  quickFilter,
  colorFilterEnabled = true,
  entriesAreProjected = false,
  onRowRender,
  initialScrollTop = 0,
  onScrollTopChange
}: {
  panelId: PanelId;
  tabId: string;
  entries: EntryViewModel[];
  folderRows?: FolderListingRow[];
  folderExpansionOnRowClick?: boolean;
  sizeHeaderAccessory?: ReactNode;
  /** Directory tabs only; navigation lists never pass it. */
  directorySizeAction?: DirectorySizeMenuAction;
  onToggleFolderExpansion?: (path: string) => void;
  onRetryFolderExpansion?: (path: string) => void;
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
  sizeBarLow?: string;
  sizeBarHigh?: string;
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
  /** 快速过滤程序；仅 `highlight` 模式会产生局部高亮（§6.7 / D7 / B21）。 */
  quickFilter?: QuickFilterProgram | null;
  colorFilterEnabled?: boolean;
  entriesAreProjected?: boolean;
  /** Test-only render probe for visible row isolation. */
  onRowRender?: (entryId: string) => void;
  initialScrollTop?: number;
  onScrollTopChange?: (top: number) => void;
}) {
  const visibleColumns = useMemo(() => columns.filter((column) => column.visible), [columns]);
  const inlineCreateEntry = useMemo(() => createInlineCreateEntry(inlineEdit), [inlineEdit]);
  const hasSizeAccessory = viewMode === "details" && Boolean(sizeHeaderAccessory);
  const headerMinWidth = (column: ColumnDefinition) => getColumnHeaderMinWidth(column, hasSizeAccessory);
  const headerPixelWidth = (column: ColumnDefinition) => getColumnPixelWidth(column, hasSizeAccessory);
  const treeRows = viewMode === "details" ? folderRows : undefined;
  const rowsById = useMemo(() => new Map(treeRows?.map((row) => [row.entry.id, row])), [treeRows]);
  const orderedEntries = useMemo(() => treeRows ? treeRows.map((row) => row.entry) :
    entriesAreProjected ? entries : sortEntries(entries, sort, currentPath),
  [treeRows, entriesAreProjected, entries, sort, currentPath]);
  const sortedEntries: ListingEntry[] = useMemo(() => inlineCreateEntry ? [inlineCreateEntry, ...orderedEntries] : orderedEntries,
    [inlineCreateEntry, orderedEntries]);
  const treeNameAllowance = useMemo(() => treeRows?.reduce((max, row) => Math.max(max, row.depth * FOLDER_INDENT_PX + FOLDER_TOGGLE_PX), 0) ?? 0,
    [treeRows]);
  const editingEntryIndex = useMemo(() => sortedEntries.findIndex((entry) => Boolean(inlineEdit && (
    ((inlineEdit.mode === "create-folder" || inlineEdit.mode === "create-file") && entry.inlineCreate) ||
    (inlineEdit.mode === "rename" && inlineEdit.entryId === entry.id)
  ))), [sortedEntries, inlineEdit]);
  const shouldVirtualize = sortedEntries.length > 100;
  const itemKeys = useMemo(() => sortedEntries.map((entry) => entry.id), [sortedEntries]);
  const { scrollContainerRef, virtualizer, cardColumns, cardGap, isGridView, virtualRowCount } = useFileListingVirtualizer({
    viewMode, count: sortedEntries.length, detailsRowHeight, iconSize: getInlineIconSpec(viewMode).displaySize, editingEntryIndex,
    itemKeys, initialScrollTop
  });
  const { overlayRef: marqueeOverlayRef, begin: beginMarquee } = useListingMarquee();
  useLayoutEffect(() => {
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = initialScrollTop;
  }, []);
  useLayoutEffect(() => {
    if (editingEntryIndex < 0) return;
    const scroll = scrollContainerRef.current;
    if (!scroll || !scroll.ownerDocument.defaultView?.requestAnimationFrame) return;
    virtualizer.getVirtualItems();
    virtualizer.scrollToIndex(isGridView ? Math.floor(editingEntryIndex / cardColumns) : editingEntryIndex, { align: "auto" });
  }, [editingEntryIndex, cardColumns, viewMode]);

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
    const scrollContainer = scrollContainerRef.current;
    const index = sortedEntries.findIndex((entry) => entry.id === focusId);
    if (index < 0 || !scrollContainer) {
      return;
    }
    releaseFolderExpansionControlFocus(scrollContainer);
    // 手动计算滚动位置以考虑 sticky header 的遮挡
    const targetIndex = isGridView ? Math.floor(index / cardColumns) : index;
    const runtimeWindow = scrollContainer.ownerDocument.defaultView;
    if (runtimeWindow && typeof runtimeWindow.requestAnimationFrame === "function") {
      virtualizer.getVirtualItems();
      virtualizer.scrollToIndex(targetIndex, { align: "auto" });
    } else {
      const rowSize = viewMode === "details" ? detailsRowHeight : viewMode === "list" ? 42 : 76;
      scrollContainer.scrollTop = Math.max(0, targetIndex * rowSize);
    }
  }, [keyboardNavToken, selectedEntryIds]);
  // 选择命中用 Set：点击选择的重绘路径避免 O(n) 数组扫描（V2 选择延迟修复）。
  const selectedIdSet = useMemo(() => new Set(selectedEntryIds), [selectedEntryIds]);
  const entryPositionsById = useMemo(() => {
    const positions = new Map<string, Array<{ index: number; path: string }>>();
    entries.forEach((entry, index) => {
      const matches = positions.get(entry.id);
      if (matches) matches.push({ index, path: entry.path });
      else positions.set(entry.id, [{ index, path: entry.path }]);
    });
    return positions;
  }, [entries]);
  const selectedPaths = useMemo(() => Array.from(selectedIdSet)
    .flatMap((id) => entryPositionsById.get(id) ?? [])
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.path), [selectedIdSet, entryPositionsById]);
  const cutPathSet = useMemo(() => new Set(clipboard?.mode === "cut" ? clipboard.paths.map((path) => path.toLowerCase()) : []),
    [clipboard]);
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
  const [entryDragFollower, setEntryDragFollower] = useState<EntryDragFollower>({
    visible: false,
    x: 0,
    y: 0,
    entry: null,
    count: 0
  });
  const lastClickedEntryIdRef = useRef<string | null>(null);
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

  const visibleOrderedEntryIds = useMemo(() => sortedEntries.filter((entry) => !entry.inlineCreate).map((entry) => entry.id), [sortedEntries]);
  const detailsGridMetrics = useMemo(() => getDetailsGridMetrics(visibleColumns, hasSizeAccessory), [visibleColumns, hasSizeAccessory]);
  const gridStyle = useMemo(() => ({
    gridTemplateColumns: detailsGridMetrics.gridTemplateColumns,
    width: `${detailsGridMetrics.width}px`
  } as CSSProperties), [detailsGridMetrics]);
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
    if (selectedIdSet.has(entry.id) && selectedPaths.length > 0) {
      return Array.from(new Set(selectedPaths));
    }
    return [entry.path];
  };

  const getContextMenuPaths = (entry: EntryViewModel) => {
    if (selectedIdSet.has(entry.id) && selectedPaths.length > 0) {
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

  // 名称标签：规则背景只涂在这个元素后面（宽度=名称内容渲染宽度），
  // 选中/拖放背景只作用于周围行/卡片表面，标签配色保持在表面之上。
  const renderEntryNameContent = (entry: ListingEntry) => {
    if (isInlineEditingEntry(entry)) {
      return renderInlineEditInput();
    }
    const label = getFileColorLabelAttributes(entry, colorFilterEnabled);
    return (
      <span className={label.className || undefined} style={label.style}>
        {renderEntryNameText(entry.name, quickFilter ?? null)}
      </span>
    );
  };

  const { layerRef, hideEntryTooltip, buildEntryTooltipHandlers } = useEntryTooltip({
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
    if (!selectedIdSet.has(entry.id)) {
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
    const previewEntries = selectedIdSet.has(entry.id)
      ? sortedEntries.filter((candidate) => !candidate.inlineCreate && selectedIdSet.has(candidate.id))
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
        if (folderExpansionOnRowClick && !event.ctrlKey && !event.metaKey && !event.shiftKey && viewMode === "details" && folderRows !== undefined && entry.kind === "folder" && !entry.driveInfo) {
          onToggleFolderExpansion?.(entry.path);
        }
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
        if (!selectedIdSet.has(entry.id)) {
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
  const latestHandlersRef = useRef(buildEntryHandlers);
  latestHandlersRef.current = buildEntryHandlers;
  const latestToggleRef = useRef(onToggleFolderExpansion);
  latestToggleRef.current = onToggleFolderExpansion;
  const latestRetryRef = useRef(onRetryFolderExpansion);
  latestRetryRef.current = onRetryFolderExpansion;
  const stableToggleExpansion = useMemo(() => (path: string) => latestToggleRef.current?.(path), []);
  const stableRetryExpansion = useMemo(() => (path: string) => latestRetryRef.current?.(path), []);
  const stableEntryHandlers = useMemo(() => (entry: ListingEntry) => {
    const invoke = (name: string, event?: unknown) => {
      const handler = (latestHandlersRef.current(entry) as unknown as Record<string, unknown>)[name];
      if (typeof handler === "function") (handler as (event?: unknown) => void)(event);
    };
    return {
      draggable: false,
      onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => invoke("onMouseEnter", event),
      onMouseMove: (event: ReactMouseEvent<HTMLElement>) => invoke("onMouseMove", event),
      onMouseLeave: (event: ReactMouseEvent<HTMLElement>) => invoke("onMouseLeave", event),
      onClick: (event: ReactMouseEvent<HTMLElement>) => invoke("onClick", event),
      onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => invoke("onDoubleClick", event),
      onContextMenu: (event: ReactMouseEvent<HTMLElement>) => invoke("onContextMenu", event),
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => invoke("onPointerDown", event),
      onDragStart: (event: ReactDragEvent<HTMLElement>) => invoke("onDragStart", event),
      onDragEnd: (event: ReactDragEvent<HTMLElement>) => invoke("onDragEnd", event),
      onDragOver: (event: ReactDragEvent<HTMLElement>) => invoke("onDragOver", event),
      onDragLeave: (event: ReactDragEvent<HTMLElement>) => invoke("onDragLeave", event),
      onDrop: (event: ReactDragEvent<HTMLElement>) => invoke("onDrop", event)
    };
  }, []);
  const createRowState = (entry: ListingEntry, render: RowRenderState["render"]): RowRenderState => {
    const editing = isInlineEditingEntry(entry);
    const dropTarget = entry.kind === "folder" && dropTargetPath === entry.path;
    return {
      entry,
      selected: selectedIdSet.has(entry.id),
      dropTarget,
      dropOperation: dropTarget ? dropOperation : undefined,
      editing,
      editValue: editing ? inlineEdit?.value : undefined,
      cut: isCutEntry(entry),
      gitStatus: lookupGitStatus(gitStatus, entry.path),
      folderRow: rowsById.get(entry.id),
      columns: visibleColumns,
      gridStyle,
      quickFilter,
      colorFilterEnabled,
      sizeBarLow,
      sizeBarHigh,
      currentPath,
      viewMode,
      render,
      onRender: onRowRender
    };
  };
  const renderEmptyState = () => <div className="file-listing__empty">当前目录为空</div>;
  const renderDetailsEntry = ({ entry, selected: isSelected, dropTarget: isDropTarget, dropOperation: rowDropOperation,
    editing: isEditing, cut: isCut, gitStatus: rowGitStatus, folderRow }: RowRenderState) => {
      const color = getFileColorRowAttributes(entry, colorFilterEnabled);
      return (
        <div
          key={`entry-${entry.id}`}
          className={`file-row${color.classNameSuffix}${isSelected ? " is-selected" : ""}${isDropTarget ? " is-drop-target" : ""}${isEditing ? " is-inline-editing" : ""}${isCut ? " is-cut" : ""}`}
          style={color.style}
          id={`entry-${entry.id}`}
          data-panel-id={panelId}
          data-entry-path={entry.path}
          data-entry-drop-kind={entry.kind === "folder" ? "folder" : undefined}
          data-entry-drop-path={entry.kind === "folder" ? entry.path : undefined}
          data-inline-edit={isEditing ? "true" : undefined}
          data-drop-operation={rowDropOperation}
          {...entryClipboardAttrs(entry)}
          {...stableEntryHandlers(entry)}
        >
          <div className="file-row__grid" style={gridStyle}>
            {visibleColumns.map((column) => (
              <div
                key={column.id}
                className={`file-cell file-cell--${column.align}`}
                data-cell-column-id={column.id}
                onContextMenu={column.id === "comment" ? (event) => openCommentContextMenu(event, entry) : undefined}
              >
                <FolderExpansionNameCell row={column.id === "name" ? folderRow : undefined}
                  onToggle={stableToggleExpansion} onRetry={stableRetryExpansion}>
                  {renderDetailsCell(entry, column.id, currentPath,
                    column.id === "name" ? renderEntryNameContent(entry) : null, rowGitStatus, sizeBarLow, sizeBarHigh)}
                </FolderExpansionNameCell>
              </div>
            ))}
          </div>
          {entry.driveInfo && renderDriveInfo(entry.driveInfo)}
        </div>
      );
  };
  const detailsRendererRef = useRef(renderDetailsEntry);
  detailsRendererRef.current = renderDetailsEntry;
  const stableDetailsRenderer = useMemo(() => (state: RowRenderState) => detailsRendererRef.current(state), []);
  const renderDetailsRows = (source = sortedEntries) => source.map((entry) =>
    <FileDetailsRow key={`entry-${entry.id}`} {...createRowState(entry, stableDetailsRenderer)} />);
  const renderIconEntry = ({ entry, selected: isSelected, dropTarget: isDropTarget, dropOperation: rowDropOperation,
    editing: isEditing, cut: isCut, gitStatus: rowGitStatus }: RowRenderState) => {
      const color = getFileColorRowAttributes(entry, colorFilterEnabled);
      return (
        <div
          key={entry.id}
          id={`entry-${entry.id}`}
          className={`file-card file-card--icon${color.classNameSuffix}${isSelected ? " is-selected" : ""}${isDropTarget ? " is-drop-target" : ""}${isEditing ? " is-inline-editing" : ""}${isCut ? " is-cut" : ""}`}
          style={color.style}
          data-panel-id={panelId}
          data-entry-path={entry.path}
          data-entry-drop-kind={entry.kind === "folder" ? "folder" : undefined}
          data-entry-drop-path={entry.kind === "folder" ? entry.path : undefined}
          data-inline-edit={isEditing ? "true" : undefined}
          data-drop-operation={rowDropOperation}
          {...entryClipboardAttrs(entry)}
          {...stableEntryHandlers(entry)}
        >
          <div className="file-card__hero">
            <FileSystemIcon
              kind={entry.kind}
              path={entry.path}
              extension={entry.extension}
              modifiedAt={entry.modifiedAt}
              size={inlineIconSpec.displaySize}
              imageList={inlineIconSpec.imageList}
              hidden={entry.isHidden}
              gitStatus={rowGitStatus}
            />
          </div>
          <div className="file-card__title file-card__title--multiline" title={entry.name}>
            {renderEntryNameContent(entry)}
          </div>
        </div>
      );
  };
  const iconRendererRef = useRef(renderIconEntry);
  iconRendererRef.current = renderIconEntry;
  const stableIconRenderer = useMemo(() => (state: RowRenderState) => iconRendererRef.current(state), []);
  const renderIconCards = (source = sortedEntries) => source.map((entry) =>
    <FileIconCard key={entry.id} {...createRowState(entry, stableIconRenderer)} />);
  const renderListEntry = ({ entry, selected: isSelected, dropTarget: isDropTarget, dropOperation: rowDropOperation,
    editing: isEditing, cut: isCut, gitStatus: rowGitStatus }: RowRenderState) => {
      const color = getFileColorRowAttributes(entry, colorFilterEnabled);
      return (
        <div
          key={entry.id}
          id={`entry-${entry.id}`}
          className={`file-list-item${color.classNameSuffix}${isSelected ? " is-selected" : ""}${isDropTarget ? " is-drop-target" : ""}${isEditing ? " is-inline-editing" : ""}${isCut ? " is-cut" : ""}`}
          style={color.style}
          data-panel-id={panelId}
          data-entry-path={entry.path}
          data-entry-drop-kind={entry.kind === "folder" ? "folder" : undefined}
          data-entry-drop-path={entry.kind === "folder" ? entry.path : undefined}
          data-inline-edit={isEditing ? "true" : undefined}
          data-drop-operation={rowDropOperation}
          {...entryClipboardAttrs(entry)}
          {...stableEntryHandlers(entry)}
        >
          {renderNameCell(entry, compactIconSpec, "entry-name--compact", renderEntryNameContent(entry), rowGitStatus)}
        </div>
      );
  };
  const listRendererRef = useRef(renderListEntry);
  listRendererRef.current = renderListEntry;
  const stableListRenderer = useMemo(() => (state: RowRenderState) => listRendererRef.current(state), []);
  const renderListRows = (source = sortedEntries) => source.map((entry) =>
    <FileIconCard key={entry.id} {...createRowState(entry, stableListRenderer)} />);
  const renderTileEntry = ({ entry, selected: isSelected, dropTarget: isDropTarget, dropOperation: rowDropOperation,
    editing: isEditing, cut: isCut, gitStatus: rowGitStatus }: RowRenderState) => {
    const tileIcon = inlineIconSpec;
      const di = entry.driveInfo;
      const color = getFileColorRowAttributes(entry, colorFilterEnabled);
      const drivePct = di?.totalBytes != null ? Math.min(100, Math.round(((di.totalBytes - (di.availableBytes ?? 0)) / di.totalBytes) * 100)) : null;
      return (
        <div
          key={entry.id}
          id={`entry-${entry.id}`}
          className={`file-card file-card--tile${color.classNameSuffix}${isSelected ? " is-selected" : ""}${isDropTarget ? " is-drop-target" : ""}${isEditing ? " is-inline-editing" : ""}${isCut ? " is-cut" : ""}`}
          style={color.style}
          data-panel-id={panelId}
          data-entry-path={entry.path}
          data-entry-drop-kind={entry.kind === "folder" ? "folder" : undefined}
          data-entry-drop-path={entry.kind === "folder" ? entry.path : undefined}
          data-inline-edit={isEditing ? "true" : undefined}
          data-drop-operation={rowDropOperation}
          {...entryClipboardAttrs(entry)}
          {...stableEntryHandlers(entry)}
        >
          <div className="file-card__tile-icon">
            <FileSystemIcon kind={entry.kind} path={entry.path} extension={entry.extension} modifiedAt={entry.modifiedAt}
              size={tileIcon.displaySize} imageList={tileIcon.imageList} hidden={entry.isHidden}
              gitStatus={rowGitStatus} />
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
  };
  const tileRendererRef = useRef(renderTileEntry);
  tileRendererRef.current = renderTileEntry;
  const stableTileRenderer = useMemo(() => (state: RowRenderState) => tileRendererRef.current(state), []);
  const renderTileCards = (source = sortedEntries) => source.map((entry) =>
    <FileIconCard key={entry.id} {...createRowState(entry, stableTileRenderer)} />);
  const renderContentEntry = ({ entry, selected: isSelected, dropTarget: isDropTarget, dropOperation: rowDropOperation,
    editing: isEditing, cut: isCut, gitStatus: rowGitStatus }: RowRenderState) => {
      const color = getFileColorRowAttributes(entry, colorFilterEnabled);
      return (
        <div
          key={entry.id}
          id={`entry-${entry.id}`}
          className={`file-content-item${color.classNameSuffix}${isSelected ? " is-selected" : ""}${isDropTarget ? " is-drop-target" : ""}${isEditing ? " is-inline-editing" : ""}${isCut ? " is-cut" : ""}`}
          style={color.style}
          data-panel-id={panelId}
          data-entry-path={entry.path}
          data-entry-drop-kind={entry.kind === "folder" ? "folder" : undefined}
          data-entry-drop-path={entry.kind === "folder" ? entry.path : undefined}
          data-inline-edit={isEditing ? "true" : undefined}
          data-drop-operation={rowDropOperation}
          {...entryClipboardAttrs(entry)}
          {...stableEntryHandlers(entry)}
        >
          <div className="file-content-item__main">
            {renderNameCell(entry, compactIconSpec, undefined, renderEntryNameContent(entry), rowGitStatus)}
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
  };
  const contentRendererRef = useRef(renderContentEntry);
  contentRendererRef.current = renderContentEntry;
  const stableContentRenderer = useMemo(() => (state: RowRenderState) => contentRendererRef.current(state), []);
  const renderContentRows = (source = sortedEntries) => source.map((entry) =>
    <FileIconCard key={entry.id} {...createRowState(entry, stableContentRenderer)} />);

  const renderBody = () => {
    if (sortedEntries.length === 0) {
      return renderEmptyState();
    }
    if (!shouldVirtualize) {
      if (viewMode === "details") return renderDetailsRows();
      if (viewMode === "content") return renderContentRows();
      if (viewMode === "list") return renderListRows();
      return ICON_VIEW_MODES.includes(viewMode) ? renderIconCards() : renderTileCards();
    }
    const measuredVirtualItems = virtualizer.getVirtualItems();
    const virtualItems: Array<{ key: string | number | bigint; index: number; start: number; size: number }> = measuredVirtualItems.length > 0
      ? measuredVirtualItems
      : Array.from({ length: Math.min(virtualRowCount, 24) }, (_, index) => ({
          key: index,
          index,
          start: index * virtualizer.options.estimateSize(index),
          size: virtualizer.options.estimateSize(index)
        }));
    const renderRow = (index: number) => {
      if (viewMode === "details") return renderDetailsRows(sortedEntries.slice(index, index + 1));
      if (viewMode === "content") return renderContentRows(sortedEntries.slice(index, index + 1));
      if (viewMode === "list") return renderListRows(sortedEntries.slice(index, index + 1));
      const start = index * cardColumns;
      const rowEntries = sortedEntries.slice(start, start + cardColumns);
      return ICON_VIEW_MODES.includes(viewMode) ? renderIconCards(rowEntries) : renderTileCards(rowEntries);
    };
    return (
      <div className="file-listing__virtual-content" style={{ height: virtualizer.getTotalSize(), position: "relative", width: viewMode === "details" ? `${detailsGridMetrics.width}px` : undefined }}>
        {virtualItems.map((item) => (
          <div
            key={item.key}
            ref={virtualizer.measureElement}
            data-index={item.index}
            className="file-listing__virtual-row"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`,
              ...(isGridView ? { display: "grid", gridTemplateColumns: `repeat(${cardColumns}, minmax(0, 1fr))`, gap: `${cardGap}px` } : {})
            }}
          >
            {renderRow(item.index)}
          </div>
        ))}
      </div>
    );
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

    // 拖动滚动条时目标就是滚动容器本身，不能当作空白区域开始框选或清空选择。
    if (target === scrollContainerRef.current && isScrollbarPointer(target, event.clientX, event.clientY)) {
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

    beginMarquee({
      scrollElement: scrollContainer, clientX: event.clientX, clientY: event.clientY,
      entries: sortedEntries, virtualizer, virtualized: shouldVirtualize,
      columns: isGridView ? cardColumns : 1, gap: cardGap, details: viewMode === "details",
      onSelect: (ids) => onSelectMultiple?.(ids)
    });
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
        onScroll={(event) => onScrollTopChange?.(event.currentTarget.scrollTop)}
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
            getColumnMinWidth={headerMinWidth}
            getColumnPixelWidth={headerPixelWidth}
            renderHeaderAccessory={(column) => column.id === "size" ? sizeHeaderAccessory : null}
            columnMenuAction={directorySizeAction}
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
                  getMinWidth: headerMinWidth,
                  getIconAllowance: (candidate) => (candidate.id === "name" ? 22 + treeNameAllowance : 0)
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

        <div ref={marqueeOverlayRef} className="file-listing__marquee" style={{ display: "none" }} />
      </div>
      <EntryTooltipLayer ref={layerRef} />
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

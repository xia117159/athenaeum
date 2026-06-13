import {
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState
} from "react";
import {
  clearEntryDrag,
  hasEntryDragPayload,
  readEntryDragPayload,
  startEntryDrag
} from "./entryDrag";
import { FileSystemIcon } from "./FileSystemIcon";
import type { SystemIconImageList } from "./systemIconGateway";
import { modifiersMatchShortcutBinding } from "./workspaceShortcuts";
import { devLog, devWarn } from "./devLog";
import type {
  ColumnDefinition,
  ColumnId,
  ContextMenuState,
  EntryViewModel,
  InlineEditState,
  NativeContextMenuRequest,
  PanelId,
  SortState,
  TabViewMode
} from "./types";

type DropOperation = "copy" | "move";

const ICON_VIEW_MODES: TabViewMode[] = ["extra-large-icons", "large-icons", "medium-icons", "small-icons"];
const ENTRY_POINTER_DRAG_THRESHOLD_PX = 4;
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
  dragging: boolean;
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
};

export const TAB_VIEW_MODE_OPTIONS: Array<{ id: TabViewMode; label: string }> = [
  { id: "extra-large-icons", label: "超大图标" },
  { id: "large-icons", label: "大图标" },
  { id: "medium-icons", label: "中等图标" },
  { id: "small-icons", label: "小图标" },
  { id: "list", label: "列表" },
  { id: "details", label: "详细信息列表" },
  { id: "tiles", label: "平铺" },
  { id: "content", label: "内容" }
];

export function getTabViewModeLabel(mode: TabViewMode) {
  return TAB_VIEW_MODE_OPTIONS.find((option) => option.id === mode)?.label ?? mode;
}

function getLocalizedColumnLabel(column: ColumnDefinition) {
  switch (column.id) {
    case "name":
      return "名称";
    case "type":
      return "类型";
    case "size":
      return "大小";
    case "modified":
      return "修改时间";
    case "tags":
      return "标签";
    case "location":
      return "位置";
    default:
      return column.label;
  }
}

function getEntryTypeLabel(entry: EntryViewModel) {
  return entry.kind === "folder" ? "文件夹" : entry.extension.replace(".", "").toUpperCase() || "文件";
}

function getLocationLabel(entry: EntryViewModel, currentPath: string) {
  return entry.parentPath === currentPath ? "当前目录" : entry.parentPath;
}

function parseSizeLabel(sizeLabel: string) {
  if (!sizeLabel || sizeLabel === "--") {
    return -1;
  }

  const match = sizeLabel.trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
  if (!match) {
    return Number.NaN;
  }

  const value = Number(match[1]);
  const unit = match[2].toUpperCase();
  const multiplierMap: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4
  };
  return value * (multiplierMap[unit] ?? 1);
}

function parseModifiedLabel(label: string) {
  const timestamp = Date.parse(label.replace(" ", "T"));
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function compareEntryByColumn(left: EntryViewModel, right: EntryViewModel, columnId: ColumnId, currentPath: string) {
  switch (columnId) {
    case "name":
      return left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" });
    case "type":
      return getEntryTypeLabel(left).localeCompare(getEntryTypeLabel(right), "zh-CN", {
        numeric: true,
        sensitivity: "base"
      });
    case "size":
      return parseSizeLabel(left.sizeLabel) - parseSizeLabel(right.sizeLabel);
    case "modified":
      return parseModifiedLabel(left.modifiedLabel) - parseModifiedLabel(right.modifiedLabel);
    case "tags":
      return left.tags.join(",").localeCompare(right.tags.join(","), "zh-CN", { sensitivity: "base" });
    case "location":
      return getLocationLabel(left, currentPath).localeCompare(getLocationLabel(right, currentPath), "zh-CN", {
        numeric: true,
        sensitivity: "base"
      });
    default:
      return 0;
  }
}

function sortEntries(entries: EntryViewModel[], sort: SortState, currentPath: string) {
  const direction = sort.direction === "asc" ? 1 : -1;
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "folder" ? -1 : 1;
    }

    const columnResult = compareEntryByColumn(left, right, sort.columnId, currentPath);
    if (columnResult !== 0) {
      return columnResult * direction;
    }

    return left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" });
  });
}

function getSortIndicator(sort: SortState, columnId: ColumnId) {
  if (sort.columnId !== columnId) {
    return "";
  }
  return sort.direction === "asc" ? "▲" : "▼";
}

function getViewBodyClassName(viewMode: TabViewMode, isEmpty: boolean) {
  const classes = ["file-listing__body", `file-listing__body--${viewMode}`];
  if (isEmpty) {
    classes.push("is-empty");
  }
  return classes.join(" ");
}

type InlineIconSpec = {
  displaySize: number;
  imageList: SystemIconImageList;
};

type ListingEntry = EntryViewModel & {
  inlineCreate?: boolean;
};

function getInlineIconSpec(viewMode: TabViewMode): InlineIconSpec {
  switch (viewMode) {
    case "extra-large-icons":
      return { displaySize: 72, imageList: "jumbo" };
    case "large-icons":
      return { displaySize: 48, imageList: "extra-large" };
    case "medium-icons":
      return { displaySize: 32, imageList: "large" };
    case "small-icons":
      return { displaySize: 16, imageList: "small" };
    case "details":
      return { displaySize: 16, imageList: "sys-small" };
    case "list":
    case "tiles":
    case "content":
    default:
      return { displaySize: 16, imageList: "sys-small" };
  }
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
    return null;
  }

  const dropElement = element?.closest("[data-entry-drop-kind][data-entry-drop-path]") as HTMLElement | null;
  const path = dropElement?.dataset.entryDropPath;
  const kind = dropElement?.dataset.entryDropKind;
  if (!dropElement || !path) {
    return null;
  }

  if (kind === "tab") {
    return {
      kind,
      path,
      operation: getTabDropOperationFromModifiers(modifiers, moveBinding),
      element: dropElement
    };
  }

  if (kind === "folder" || kind === "listing") {
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

function renderNameCell(
  entry: EntryViewModel,
  iconSpec: InlineIconSpec,
  iconClassName?: string,
  nameContent?: ReactNode
) {
  return (
    <div className={`entry-name${iconClassName ? ` ${iconClassName}` : ""}`}>
      <FileSystemIcon
        kind={entry.kind}
        path={entry.path}
        extension={entry.extension}
        size={iconSpec.displaySize}
        imageList={iconSpec.imageList}
      />
      {nameContent ?? <span>{entry.name}</span>}
    </div>
  );
}

function renderTagStack(entry: EntryViewModel) {
  return (
    <div className="tag-stack">
      {entry.tags.length > 0 ? entry.tags.map((tag) => <span key={tag}>{tag}</span>) : <span>--</span>}
    </div>
  );
}

function renderDetailsCell(
  entry: ListingEntry,
  columnId: ColumnDefinition["id"],
  currentPath: string,
  nameContent?: ReactNode
) {
  const detailIconSpec = getInlineIconSpec("details");
  switch (columnId) {
    case "name":
      return renderNameCell(entry, detailIconSpec, undefined, nameContent);
    case "type":
      return getEntryTypeLabel(entry);
    case "size":
      return entry.sizeLabel;
    case "modified":
      return entry.modifiedLabel;
    case "tags":
      return renderTagStack(entry);
    case "location":
      return getLocationLabel(entry, currentPath);
    default:
      return "";
  }
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
  onSort,
  onSelect,
  onSelectMultiple,
  onSelectAll,
  onSelectRange,
  onClearSelection,
  onOpen,
  detailsRowHeight,
  onOpenContextMenu,
  onOpenNativeContextMenu,
  onResizeColumn,
  onDropEntries,
  entryDropMoveBinding = "Shift",
  onInlineEditChange,
  onInlineEditCommit,
  onInlineEditCancel
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
  onSort: (columnId: ColumnId) => void;
  onSelect: (entry: EntryViewModel, multi: boolean) => void;
  onSelectMultiple?: (entryIds: string[]) => void;
  onSelectAll?: () => void;
  onSelectRange?: (fromEntryId: string, toEntryId: string) => void;
  onClearSelection?: () => void;
  onOpen: (entry: EntryViewModel) => void;
  detailsRowHeight: number;
  onOpenContextMenu: (payload: ContextMenuState) => void;
  onOpenNativeContextMenu: (payload: NativeContextMenuRequest) => void;
  onResizeColumn: (columnId: ColumnId, width: string) => void;
  onDropEntries: (paths: string[], destination: string, operation: DropOperation) => void;
  entryDropMoveBinding?: string;
  onInlineEditChange: (value: string) => void;
  onInlineEditCommit: (value?: string) => void;
  onInlineEditCancel: () => void;
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
          description: inlineEdit.mode === "create-folder" ? "New folder" : "New file",
          inlineCreate: true
        }
      : undefined;
  const sortedEntries: ListingEntry[] = inlineCreateEntry
    ? [inlineCreateEntry, ...sortEntries(entries, sort, currentPath)]
    : sortEntries(entries, sort, currentPath);
  const selectedPaths = entries.filter((entry) => selectedEntryIds.includes(entry.id)).map((entry) => entry.path);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [dropOperation, setDropOperation] = useState<DropOperation>("move");
  const [isListingDropTarget, setIsListingDropTarget] = useState(false);
  const inlineInputRef = useRef<HTMLInputElement | null>(null);
  const suppressNextInlineBlurRef = useRef(false);
  const activeEntryPointerDragRef = useRef<ActiveEntryPointerDrag | null>(null);
  const cleanupEntryPointerDragRef = useRef<(() => void) | null>(null);
  const pointerTabDropElementRef = useRef<HTMLElement | null>(null);
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
      if (pointerTabDropElementRef.current) {
        pointerTabDropElementRef.current.classList.remove("is-entry-drop-target");
        pointerTabDropElementRef.current = null;
      }
    },
    []
  );

  // 键盘快捷键处理
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // 检查焦点是否在可编辑元素上
      const target = event.target;
      const isEditable =
        target instanceof HTMLElement &&
        (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");

      // Ctrl+A / Cmd+A: 全选（仅在非可编辑元素时生效）
      if ((event.ctrlKey || event.metaKey) && event.key === "a" && !isEditable) {
        devLog("[FileListing] Ctrl+A detected, onSelectAll:", onSelectAll);
        event.preventDefault();
        if (onSelectAll) {
          devLog("[FileListing] Calling onSelectAll");
          onSelectAll();
        } else {
          devWarn("[FileListing] onSelectAll is undefined");
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onSelectAll]);

  const gridStyle = {
    gridTemplateColumns: visibleColumns.map((column) => column.width).join(" "),
    minWidth: "100%"
  } as CSSProperties;
  const listingStyle = {
    "--details-row-height": `${detailsRowHeight}px`
  } as CSSProperties;

  const clearDropState = () => {
    if (pointerTabDropElementRef.current) {
      pointerTabDropElementRef.current.classList.remove("is-entry-drop-target");
      pointerTabDropElementRef.current = null;
    }
    setDropTargetPath(null);
    setDropOperation("move");
    setIsListingDropTarget(false);
  };

  const setPointerTabDropElement = (element: HTMLElement | null) => {
    if (pointerTabDropElementRef.current === element) {
      return;
    }

    if (pointerTabDropElementRef.current) {
      pointerTabDropElementRef.current.classList.remove("is-entry-drop-target");
    }
    pointerTabDropElementRef.current = element;
    if (element) {
      element.classList.add("is-entry-drop-target");
    }
  };

  const applyPointerDropTarget = (target: EntryPointerDropTarget | null) => {
    if (!target) {
      clearDropState();
      return;
    }

    setDropOperation(target.operation);
    if (target.kind === "tab") {
      setPointerTabDropElement(target.element);
      setDropTargetPath(null);
      setIsListingDropTarget(false);
      return;
    }

    setPointerTabDropElement(null);
    setDropTargetPath(target.kind === "folder" ? target.path : null);
    setIsListingDropTarget(target.kind === "listing");
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

  const startEntryPointerDrag = (event: ReactPointerEvent<HTMLElement>, entry: ListingEntry) => {
    if (event.button !== 0 || isInlineEditingEntry(entry)) {
      return;
    }
    if (event.target instanceof HTMLElement && event.target.closest(".inline-edit-input")) {
      return;
    }

    cleanupEntryPointerDragRef.current?.();
    const pointerDrag: ActiveEntryPointerDrag = {
      sourcePanelId: panelId,
      sourceTabId: tabId,
      sourceEntryId: entry.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      paths: getDragPaths(entry),
      dragging: false
    };
    activeEntryPointerDragRef.current = pointerDrag;

    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      document.body.classList.remove("is-entry-pointer-dragging");
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
        document.elementFromPoint(finishEvent.clientX, finishEvent.clientY),
        activeDrag,
        panelId,
        finishEvent,
        entryDropMoveBinding
      );
      if (dropTarget) {
        onDropEntries(activeDrag.paths, dropTarget.path, dropTarget.operation);
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
      document.body.classList.add("is-entry-pointer-dragging");
      applyPointerDropTarget(
        getPointerEntryDropTarget(
          document.elementFromPoint(moveEvent.clientX, moveEvent.clientY),
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
          if (onSelectRange) {
            devLog("[FileListing] Calling onSelectRange");
            onSelectRange(lastClickedEntryIdRef.current, entry.id);
          } else {
            devWarn("[FileListing] onSelectRange is undefined");
          }
          return;
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
        event.preventDefault();
        event.stopPropagation();
        const nativeRequest: NativeContextMenuRequest = {
          panelId,
          tabId,
          paths: getContextMenuPaths(entry),
          clientX: event.clientX,
          clientY: event.clientY,
          screenX: event.screenX,
          screenY: event.screenY
        };
        if (!selectedEntryIds.includes(entry.id)) {
          onSelect(entry, false);
        }
        window.setTimeout(() => {
          onOpenNativeContextMenu(nativeRequest);
        }, 0);
      },
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => startEntryPointerDrag(event, entry),
      onDragStart: (event: ReactDragEvent<HTMLElement>) => {
        const dragPaths = getDragPaths(entry);
        if (!event.dataTransfer) {
          return;
        }

        startEntryDrag(event.dataTransfer, { sourcePanelId: panelId, sourceTabId: tabId, paths: dragPaths });
        event.dataTransfer.dropEffect = event.ctrlKey ? "copy" : "move";
      },
      onDragEnd: () => {
        clearEntryDrag();
        clearDropState();
      },
      onDragOver: entry.kind === "folder"
        ? (event: ReactDragEvent<HTMLElement>) => {
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

  const renderEmptyState = () => <div className="file-listing__empty">当前目录为空</div>;

  const renderDetailsRows = () =>
    sortedEntries.map((entry) => {
      const isSelected = selectedEntryIds.includes(entry.id);
      const isDropTarget = entry.kind === "folder" && dropTargetPath === entry.path;
      const isEditing = isInlineEditingEntry(entry);
      return (
        <div
          key={entry.id}
          className={`file-row${isSelected ? " is-selected" : ""}${isDropTarget ? " is-drop-target" : ""}${isEditing ? " is-inline-editing" : ""}`}
          style={{ "--row-accent": entry.accentColor } as CSSProperties}
          data-panel-id={panelId}
          data-entry-path={entry.path}
          data-entry-drop-kind={entry.kind === "folder" ? "folder" : undefined}
          data-entry-drop-path={entry.kind === "folder" ? entry.path : undefined}
          data-inline-edit={isEditing ? "true" : undefined}
          data-drop-operation={isDropTarget ? dropOperation : undefined}
          {...buildEntryHandlers(entry)}
        >
          <div className="file-row__grid" style={gridStyle}>
            {visibleColumns.map((column) => (
              <div key={column.id} className={`file-cell file-cell--${column.align}`}>
                {renderDetailsCell(entry, column.id, currentPath, renderEntryNameContent(entry))}
              </div>
            ))}
          </div>
        </div>
      );
    });

  const renderIconCards = () =>
    sortedEntries.map((entry) => {
      const isSelected = selectedEntryIds.includes(entry.id);
      const isDropTarget = entry.kind === "folder" && dropTargetPath === entry.path;
      const isEditing = isInlineEditingEntry(entry);
      return (
        <div
          key={entry.id}
          className={`file-card file-card--icon${isSelected ? " is-selected" : ""}${isDropTarget ? " is-drop-target" : ""}${isEditing ? " is-inline-editing" : ""}`}
          style={{ "--row-accent": entry.accentColor } as CSSProperties}
          data-panel-id={panelId}
          data-entry-path={entry.path}
          data-entry-drop-kind={entry.kind === "folder" ? "folder" : undefined}
          data-entry-drop-path={entry.kind === "folder" ? entry.path : undefined}
          data-inline-edit={isEditing ? "true" : undefined}
          data-drop-operation={isDropTarget ? dropOperation : undefined}
          {...buildEntryHandlers(entry)}
        >
          <div className="file-card__hero">
            <FileSystemIcon
              kind={entry.kind}
              path={entry.path}
              extension={entry.extension}
              size={inlineIconSpec.displaySize}
              imageList={inlineIconSpec.imageList}
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
      return (
        <div
          key={entry.id}
          className={`file-list-item${isSelected ? " is-selected" : ""}${isDropTarget ? " is-drop-target" : ""}${isEditing ? " is-inline-editing" : ""}`}
          style={{ "--row-accent": entry.accentColor } as CSSProperties}
          data-panel-id={panelId}
          data-entry-path={entry.path}
          data-entry-drop-kind={entry.kind === "folder" ? "folder" : undefined}
          data-entry-drop-path={entry.kind === "folder" ? entry.path : undefined}
          data-inline-edit={isEditing ? "true" : undefined}
          data-drop-operation={isDropTarget ? dropOperation : undefined}
          {...buildEntryHandlers(entry)}
        >
          {renderNameCell(entry, compactIconSpec, "entry-name--compact", renderEntryNameContent(entry))}
        </div>
      );
    });

  const renderTileCards = () =>
    sortedEntries.map((entry) => {
      const isSelected = selectedEntryIds.includes(entry.id);
      const isDropTarget = entry.kind === "folder" && dropTargetPath === entry.path;
      const isEditing = isInlineEditingEntry(entry);
      return (
        <div
          key={entry.id}
          className={`file-card file-card--tile${isSelected ? " is-selected" : ""}${isDropTarget ? " is-drop-target" : ""}${isEditing ? " is-inline-editing" : ""}`}
          style={{ "--row-accent": entry.accentColor } as CSSProperties}
          data-panel-id={panelId}
          data-entry-path={entry.path}
          data-entry-drop-kind={entry.kind === "folder" ? "folder" : undefined}
          data-entry-drop-path={entry.kind === "folder" ? entry.path : undefined}
          data-inline-edit={isEditing ? "true" : undefined}
          data-drop-operation={isDropTarget ? dropOperation : undefined}
          {...buildEntryHandlers(entry)}
        >
          <div className="file-card__leading">{renderNameCell(entry, compactIconSpec, undefined, renderEntryNameContent(entry))}</div>
          <div className="file-card__meta">
            <span>类型: {getEntryTypeLabel(entry)}</span>
            <span>大小: {entry.sizeLabel}</span>
            <span>修改: {entry.modifiedLabel}</span>
          </div>
        </div>
      );
    });

  const renderContentRows = () =>
    sortedEntries.map((entry) => {
      const isSelected = selectedEntryIds.includes(entry.id);
      const isDropTarget = entry.kind === "folder" && dropTargetPath === entry.path;
      const isEditing = isInlineEditingEntry(entry);
      return (
        <div
          key={entry.id}
          className={`file-content-item${isSelected ? " is-selected" : ""}${isDropTarget ? " is-drop-target" : ""}${isEditing ? " is-inline-editing" : ""}`}
          style={{ "--row-accent": entry.accentColor } as CSSProperties}
          data-panel-id={panelId}
          data-entry-path={entry.path}
          data-entry-drop-kind={entry.kind === "folder" ? "folder" : undefined}
          data-entry-drop-path={entry.kind === "folder" ? entry.path : undefined}
          data-inline-edit={isEditing ? "true" : undefined}
          data-drop-operation={isDropTarget ? dropOperation : undefined}
          {...buildEntryHandlers(entry)}
        >
          <div className="file-content-item__main">
            {renderNameCell(entry, compactIconSpec, undefined, renderEntryNameContent(entry))}
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
    event.preventDefault();
    event.stopPropagation();
    onOpenContextMenu({
      x: event.clientX,
      y: event.clientY,
      panelId,
      tabId,
      mode: "custom",
      scope: "panel"
    });
  };

  const handleBlankContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement && event.target.closest("[data-entry-path]")) {
      return;
    }

    openBlankContextMenu(event);
  };

  const handleListingDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
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

  const handleListingMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;

    devLog("[FileListing] handleListingMouseDown triggered", {
      button: event.button,
      targetTagName: target.tagName,
      targetClassName: target.className,
      closestEntryPath: target.closest("[data-entry-path]"),
      closestInlineEdit: target.closest(".inline-edit-input"),
      isScrollContainer: target.classList.contains("file-listing__scroll"),
      isBodyContainer: target.classList.contains("file-listing__body")
    });

    // 只处理左键，并且不是在列表项上
    if (event.button !== 0) {
      devLog("[FileListing] Ignoring non-left button");
      return;
    }

    // 排除点击在具体文件项或输入框上的情况
    if (target.closest("[data-entry-path]") || target.closest(".inline-edit-input")) {
      devLog("[FileListing] Ignoring click on entry or input");
      return;
    }

    // 允许点击在 scroll 容器、body 容器或空白区域
    // 不排除 file-listing__body，让它的空白区域也能触发框选
    const isScrollContainer = target.classList.contains("file-listing__scroll");
    const isBodyContainer = target.classList.contains("file-listing__body");
    const isValidTarget = isScrollContainer || isBodyContainer ||
                          target.closest(".file-listing__scroll") !== null;

    if (!isValidTarget) {
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

  const handleColumnResizeStart = (column: ColumnDefinition, event: ReactMouseEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const headerCell = event.currentTarget.closest(".file-header-cell");
    const measuredWidth = headerCell instanceof HTMLElement ? headerCell.getBoundingClientRect().width : 0;
    const pixelWidth = Number.parseFloat(column.width);
    const startWidth = measuredWidth > 0 ? measuredWidth : Number.isFinite(pixelWidth) ? pixelWidth : 160;
    const startX = event.clientX;

    const handleMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      const nextWidth = Math.max(48, Math.round(startWidth + moveEvent.clientX - startX));
      onResizeColumn(column.id, `${nextWidth}px`);
    };

    const handleStop = () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleStop);
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleStop);
  };

  return (
    <div
      className={`file-listing file-listing--${viewMode}`}
      data-view-mode={viewMode}
      style={listingStyle}
      onContextMenu={handleBlankContextMenu}
    >
      {viewMode === "details" ? (
        <div className="file-listing__header" style={gridStyle}>
          {visibleColumns.map((column) => (
            <div key={column.id} className={`file-header-cell file-cell--${column.align}`}>
              <button
                type="button"
                className={`file-header-button file-cell file-cell--header file-cell--${column.align}`}
                onClick={() => onSort(column.id)}
              >
                <span>{getLocalizedColumnLabel(column)}</span>
                <span className="file-header-button__indicator">{getSortIndicator(sort, column.id)}</span>
              </button>
              <span
                className="file-header-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label={`resize ${getLocalizedColumnLabel(column)} column`}
                onMouseDown={(event) => handleColumnResizeStart(column, event)}
              />
            </div>
          ))}
        </div>
      ) : null}

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
      >
        <div className={getViewBodyClassName(viewMode, sortedEntries.length === 0)}>{renderBody()}</div>

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
    </div>
  );
}

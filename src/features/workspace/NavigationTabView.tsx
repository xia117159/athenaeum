import {
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Edit3,
  ExternalLink,
  FilePlus2,
  FolderOpen,
  Plus,
  RefreshCw,
  Search,
  Trash2
} from "lucide-react";
import { hasEntryDragPayload, readEntryDragPayload } from "./entryDrag";
import { FileSystemIcon } from "./FileSystemIcon";
import { NavigationColumnHeaderMenu } from "./NavigationColumnHeaderMenu";
import type { EntryViewModel, NavigationItem, NavigationItemUpsertRequest, NavigationState, PanelId } from "./types";
import type { useWorkspaceController } from "./useWorkspaceController";
import { NAVIGATION_TAB_ID } from "./workspaceTabs";

type WorkspaceActions = ReturnType<typeof useWorkspaceController>["actions"];

type MenuState = {
  x: number;
  y: number;
  screenX: number;
  screenY: number;
  itemId?: string;
};

type MenuPosition = Omit<MenuState, "itemId">;

type CurrentFolderContext = {
  displayName?: string;
  path: string;
};

type NavigationColumnId = "name" | "kind" | "path" | "comment" | "status" | "lastOpened";

const NAVIGATION_GRID_COLUMN_GAP_PX = 6;
const NAVIGATION_COLUMNS: Array<{
  id: NavigationColumnId;
  label: string;
  width: number;
  minWidth: number;
}> = [
  { id: "name", label: "\u540d\u79f0", width: 240, minWidth: 96 },
  { id: "kind", label: "\u7c7b\u578b", width: 112, minWidth: 72 },
  { id: "path", label: "\u8def\u5f84", width: 220, minWidth: 120 },
  { id: "comment", label: "\u6ce8\u91ca", width: 148, minWidth: 88 },
  { id: "status", label: "\u72b6\u6001", width: 120, minWidth: 72 },
  { id: "lastOpened", label: "\u6700\u8fd1\u6253\u5f00", width: 148, minWidth: 112 }
];

function createDefaultNavigationColumnWidths() {
  return Object.fromEntries(NAVIGATION_COLUMNS.map((column) => [column.id, column.width])) as Record<NavigationColumnId, number>;
}

function createDefaultNavigationColumnVisibility() {
  return Object.fromEntries(NAVIGATION_COLUMNS.map((column) => [column.id, true])) as Record<NavigationColumnId, boolean>;
}

const STATUS_LABELS: Record<NavigationItem["targetStatus"], string> = {
  ok: "正常",
  missing: "缺失",
  permissionDenied: "无权限",
  unsupportedRemote: "远程暂不支持",
  invalidPath: "路径无效",
  unknownError: "未知错误"
};

const KIND_LABELS: Record<NavigationItem["targetKind"], string> = {
  file: "文件",
  folder: "文件夹",
  missing: "缺失",
  unknown: "未知",
  remoteUnsupported: "远程暂不支持"
};

function formatTime(value?: string | null) {
  if (!value) {
    return "--";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function createDraft(item?: NavigationItem | null): NavigationItemUpsertRequest {
  return {
    id: item?.id,
    displayName: item?.displayName ?? "",
    description: item?.description ?? "",
    path: item?.path ?? ""
  };
}

function isEditableKeyboardTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

function getDroppedPaths(event: ReactDragEvent<HTMLElement>) {
  const text = event.dataTransfer?.getData("text/plain") ?? "";
  return text
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean);
}

function filterItems(items: NavigationItem[], filterText: string) {
  const query = filterText.trim().toLowerCase();
  if (!query) {
    return items;
  }
  return items.filter((item) =>
    [item.displayName, item.description, item.path, STATUS_LABELS[item.targetStatus], KIND_LABELS[item.targetKind]]
      .join(" ")
      .toLowerCase()
      .includes(query)
  );
}

function getNavigationCellText(item: NavigationItem, columnId: NavigationColumnId) {
  switch (columnId) {
    case "name":
      return item.displayName;
    case "kind":
      return KIND_LABELS[item.targetKind];
    case "path":
      return item.path;
    case "comment":
      return item.description || "--";
    case "status":
      return STATUS_LABELS[item.targetStatus];
    case "lastOpened":
      return formatTime(item.lastOpenedAt);
    default:
      return "";
  }
}

function estimateNavigationColumnWidth(column: (typeof NAVIGATION_COLUMNS)[number], items: NavigationItem[]) {
  const values = [column.label, ...items.map((item) => getNavigationCellText(item, column.id))];
  const maxLength = values.reduce((max, value) => Math.max(max, Array.from(value).length), 0);
  const iconAllowance = column.id === "name" ? 30 : 0;
  return Math.max(column.minWidth, Math.min(520, maxLength * 8 + iconAllowance + 28));
}

export function NavigationTabView({
  panelId,
  navigation,
  currentFolder,
  selectedEntries,
  actions
}: {
  panelId: PanelId;
  navigation: NavigationState;
  currentFolder?: CurrentFolderContext;
  selectedEntries: EntryViewModel[];
  actions: WorkspaceActions;
}) {
  const [draft, setDraft] = useState<NavigationItemUpsertRequest | null>(null);
  const [nameDraft, setNameDraft] = useState<{ id: string; displayName: string } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [navigationColumnWidths, setNavigationColumnWidths] = useState<Record<NavigationColumnId, number>>(createDefaultNavigationColumnWidths);
  const [navigationColumnVisibility, setNavigationColumnVisibility] = useState<Record<NavigationColumnId, boolean>>(createDefaultNavigationColumnVisibility);
  const [columnMenuPosition, setColumnMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const columnMenuRef = useRef<HTMLDivElement | null>(null);
  const visibleItems = useMemo(() => filterItems(navigation.items, navigation.filterText), [navigation.items, navigation.filterText]);
  const selectedItems = navigation.items.filter((item) => navigation.selectedItemIds.includes(item.id));
  const primarySelected = selectedItems[0];
  const menuSelectedItems = menu?.itemId
    ? navigation.selectedItemIds.includes(menu.itemId)
      ? selectedItems
      : navigation.items.filter((item) => item.id === menu.itemId)
    : [];
  const menuPrimarySelected = menuSelectedItems[0];
  const menuSelectedItemIds = menuSelectedItems.map((item) => item.id);
  const canMoveUp = primarySelected ? navigation.items.findIndex((item) => item.id === primarySelected.id) > 0 : false;
  const canMoveDown = primarySelected
    ? navigation.items.findIndex((item) => item.id === primarySelected.id) < navigation.items.length - 1
    : false;
  const visibleNavigationColumns = NAVIGATION_COLUMNS.filter((column) => navigationColumnVisibility[column.id]);
  const navigationGridTemplateColumns = visibleNavigationColumns.map((column) => `${navigationColumnWidths[column.id]}px`).join(" ");
  const navigationGridWidth =
    visibleNavigationColumns.reduce((sum, column) => sum + navigationColumnWidths[column.id], 0) +
    Math.max(0, visibleNavigationColumns.length - 1) * NAVIGATION_GRID_COLUMN_GAP_PX;
  const navigationGridStyle = {
    gridTemplateColumns: navigationGridTemplateColumns,
    width: `${navigationGridWidth}px`
  } as CSSProperties;

  useEffect(() => {
    if (!menu) {
      return;
    }

    let armed = false;
    const timer = window.setTimeout(() => {
      armed = true;
    }, 0);

    const handlePointerDown = (event: PointerEvent) => {
      if (!armed || !(event.target instanceof Node)) {
        return;
      }
      if (menuRef.current?.contains(event.target)) {
        return;
      }
      setMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenu(null);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [menu]);

  useEffect(() => {
    if (!columnMenuPosition) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && columnMenuRef.current?.contains(event.target)) {
        return;
      }
      setColumnMenuPosition(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setColumnMenuPosition(null);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [columnMenuPosition]);

  const submitDraft = () => {
    if (!draft?.path.trim()) {
      return;
    }
    actions.saveNavigationItem(draft);
    setDraft(null);
  };

  const submitNameDraft = () => {
    if (!nameDraft) {
      return;
    }
    const item = navigation.items.find((candidate) => candidate.id === nameDraft.id);
    if (!item) {
      setNameDraft(null);
      return;
    }
    actions.saveNavigationItem({
      id: item.id,
      displayName: nameDraft.displayName,
      description: item.description,
      path: item.path
    });
    setNameDraft(null);
  };

  const openPrimary = (inBackground = false) => {
    if (primarySelected) {
      actions.openNavigationItem(panelId, primarySelected.id, inBackground);
    }
  };

  const openDraft = (item?: NavigationItem | null) => {
    setNameDraft(null);
    setDraft(createDraft(item));
  };

  const openNameDraft = (item: NavigationItem) => {
    setDraft(null);
    setNameDraft({ id: item.id, displayName: item.displayName });
  };

  const consumeKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isEditableKeyboardTarget(event.target)) {
      return;
    }

    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && visibleItems.length > 0) {
      consumeKey(event);
      const currentIndex = primarySelected ? visibleItems.findIndex((item) => item.id === primarySelected.id) : -1;
      const nextIndex =
        event.key === "ArrowDown"
          ? Math.min(visibleItems.length - 1, currentIndex + 1)
          : Math.max(0, currentIndex === -1 ? visibleItems.length - 1 : currentIndex - 1);
      const nextItem = visibleItems[nextIndex];
      if (nextItem) {
        if (event.shiftKey && primarySelected) {
          const start = Math.min(currentIndex, nextIndex);
          const end = Math.max(currentIndex, nextIndex);
          actions.setNavigationSelection(visibleItems.slice(start, end + 1).map((item) => item.id));
        } else {
          actions.setNavigationSelection([nextItem.id]);
        }
      }
      return;
    }
    if (event.key === " " && primarySelected) {
      consumeKey(event);
      actions.selectNavigationItem(primarySelected.id, true);
      return;
    }
    if (event.altKey && event.key === "Enter" && primarySelected) {
      consumeKey(event);
      openDraft(primarySelected);
      return;
    }
    if (event.key === "Enter" && primarySelected) {
      consumeKey(event);
      actions.openNavigationItem(panelId, primarySelected.id, event.ctrlKey || event.metaKey);
      return;
    }
    if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
      consumeKey(event);
      setMenu({
        x: 24,
        y: 120,
        screenX: window.screenX + 24,
        screenY: window.screenY + 120,
        itemId: primarySelected?.id
      });
      return;
    }
    if (event.key === "Delete" && navigation.selectedItemIds.length > 0) {
      consumeKey(event);
      actions.deleteNavigationItems(navigation.selectedItemIds);
      return;
    }
    if (event.key === "F2" && primarySelected) {
      consumeKey(event);
      openNameDraft(primarySelected);
      return;
    }
    if (event.key === "F5") {
      consumeKey(event);
      actions.refreshNavigationTargets();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      consumeKey(event);
      actions.setNavigationSelection(visibleItems.map((item) => item.id));
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && selectedItems.length > 0) {
      consumeKey(event);
      void navigator.clipboard?.writeText(selectedItems.map((item) => item.path).join("\n")).catch(() => undefined);
      return;
    }
    if (event.key === "Escape" && navigation.filterText) {
      consumeKey(event);
      actions.setNavigationFilter("");
    }
  };

  const getDroppedNavigationPaths = (event: ReactDragEvent<HTMLElement>) => {
    const payload = readEntryDragPayload(event.dataTransfer, panelId, NAVIGATION_TAB_ID);
    if (payload?.paths.length) {
      return payload.paths;
    }
    return getDroppedPaths(event);
  };

  const handleDrop = (event: ReactDragEvent<HTMLElement>) => {
    const paths = getDroppedNavigationPaths(event);
    if (paths.length === 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    actions.addPathsToNavigation(paths);
  };

  const getContextMenuItemIds = (item?: NavigationItem) => {
    if (!item) {
      return [];
    }
    return navigation.selectedItemIds.includes(item.id) ? navigation.selectedItemIds : [item.id];
  };

  const canOpenNativeContextMenu = (item: NavigationItem | undefined, itemIds: string[]) =>
    Boolean(item) &&
    itemIds.length === 1 &&
    item?.targetStatus === "ok" &&
    (item.targetKind === "file" || item.targetKind === "folder");

  const openAppMenuAt = (position: MenuPosition, item?: NavigationItem) => {
    if (item && !navigation.selectedItemIds.includes(item.id)) {
      actions.setNavigationSelection([item.id]);
    }
    setMenu({
      x: position.x,
      y: position.y,
      screenX: position.screenX,
      screenY: position.screenY,
      itemId: item?.id
    });
  };

  const openAppMenu = (event: ReactMouseEvent<HTMLElement>, item?: NavigationItem) => {
    openAppMenuAt(
      {
        x: event.clientX,
        y: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY
      },
      item
    );
  };

  const openMenu = (event: ReactMouseEvent<HTMLElement>, item?: NavigationItem) => {
    event.preventDefault();
    event.stopPropagation();

    const position = {
      x: event.clientX,
      y: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY
    };
    const itemIds = getContextMenuItemIds(item);
    if (!event.shiftKey && canOpenNativeContextMenu(item, itemIds)) {
      if (item && !navigation.selectedItemIds.includes(item.id)) {
        actions.setNavigationSelection([item.id]);
      }
      setMenu(null);
      void actions
        .openNavigationNativeContextMenu(itemIds, event.clientX, event.clientY, event.screenX, event.screenY)
        .then((opened) => {
          if (!opened) {
            openAppMenuAt(position, item);
          }
        });
      return;
    }

    openAppMenu(event, item);
  };

  const handleWindowsFileOperations = () => {
    if (menuSelectedItemIds.length !== 1) {
      return;
    }
    void actions
      .openNavigationNativeContextMenu(menuSelectedItemIds, menu?.x ?? 0, menu?.y ?? 0, menu?.screenX ?? 0, menu?.screenY ?? 0)
      .then((opened) => {
        if (opened) {
          setMenu(null);
        }
      });
  };

  const handleNavigationColumnResizeStart = (columnId: NavigationColumnId, event: ReactMouseEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const column = NAVIGATION_COLUMNS.find((candidate) => candidate.id === columnId);
    const headerCell = event.currentTarget.closest(".navigation-header-cell");
    const measuredWidth = headerCell instanceof HTMLElement ? headerCell.getBoundingClientRect().width : 0;
    const startWidth = measuredWidth > 0 ? measuredWidth : navigationColumnWidths[columnId];
    const startX = event.clientX;
    const minWidth = column?.minWidth ?? 72;

    const handleMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      const nextWidth = Math.max(minWidth, Math.round(startWidth + moveEvent.clientX - startX));
      setNavigationColumnWidths((current) => ({
        ...current,
        [columnId]: nextWidth
      }));
    };

    const handleStop = () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleStop);
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleStop);
  };

  const openColumnHeaderMenu = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setColumnMenuPosition({ x: event.clientX, y: event.clientY });
  };

  const selectColumnMenuItem = (callback: () => void) => {
    callback();
    setColumnMenuPosition(null);
  };

  const setNavigationColumnVisible = (columnId: NavigationColumnId, visible: boolean) => {
    setNavigationColumnVisibility((current) => ({
      ...current,
      [columnId]: visible
    }));
  };

  const showAllNavigationColumns = () => {
    setNavigationColumnVisibility(createDefaultNavigationColumnVisibility());
  };

  const autoFitVisibleNavigationColumns = () => {
    setNavigationColumnWidths((current) => {
      const next = { ...current };
      for (const column of visibleNavigationColumns) {
        next[column.id] = estimateNavigationColumnWidth(column, visibleItems);
      }
      return next;
    });
  };

  const renderNavigationCell = (item: NavigationItem, columnId: NavigationColumnId) => {
    if (columnId === "name") {
      return (
        <span role="cell" className="navigation-table__name" data-navigation-cell-id={columnId}>
          <FileSystemIcon kind={item.targetKind === "folder" ? "folder" : "file"} path={item.path} extension="" size={16} imageList="sys-small" />
          <span>{item.displayName}</span>
        </span>
      );
    }

    if (columnId === "path") {
      return <span role="cell" className="navigation-table__path" data-navigation-cell-id={columnId}>{item.path}</span>;
    }

    if (columnId === "status") {
      return <span role="cell" data-status={item.targetStatus} data-navigation-cell-id={columnId}>{STATUS_LABELS[item.targetStatus]}</span>;
    }

    return <span role="cell" data-navigation-cell-id={columnId}>{getNavigationCellText(item, columnId)}</span>;
  };

  return (
    <div
      className={`navigation-tab${dragActive ? " is-entry-drop-target" : ""}`}
      data-entry-drop-kind="navigation"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onContextMenu={(event) => openMenu(event)}
      onDragOver={(event) => {
        if (hasEntryDragPayload(event.dataTransfer) || event.dataTransfer?.types.includes("text/plain")) {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "copy";
          setDragActive(true);
        }
      }}
      onDragLeave={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
          return;
        }
        setDragActive(false);
      }}
      onDrop={handleDrop}
    >
      {columnMenuPosition ? (
        <NavigationColumnHeaderMenu
          menuRef={columnMenuRef}
          x={columnMenuPosition.x}
          y={columnMenuPosition.y}
          columns={NAVIGATION_COLUMNS}
          visibility={navigationColumnVisibility}
          onToggleColumn={(columnId) =>
            selectColumnMenuItem(() => setNavigationColumnVisible(columnId, !navigationColumnVisibility[columnId]))
          }
          onShowAll={() => selectColumnMenuItem(showAllNavigationColumns)}
          onAutoFit={() => selectColumnMenuItem(autoFitVisibleNavigationColumns)}
        />
      ) : null}

      <div className="navigation-tab__toolbar">
        <div className="navigation-tab__group">
          <button type="button" className="toolbar-button toolbar-button--icon" title="添加导航项" aria-label="添加导航项" onClick={() => openDraft()}>
            <Plus size={16} aria-hidden="true" />
          </button>
          <button type="button" className="toolbar-button toolbar-button--icon" title="添加当前文件夹" aria-label="添加当前文件夹" disabled={!currentFolder} onClick={() => currentFolder && actions.addCurrentFolderToNavigation(currentFolder)}>
            <FolderOpen size={16} aria-hidden="true" />
          </button>
          <button type="button" className="toolbar-button toolbar-button--icon" title="从选中项添加" aria-label="从选中项添加" disabled={selectedEntries.length === 0} onClick={() => actions.addSelectedEntriesToNavigation(panelId, selectedEntries)}>
            <FilePlus2 size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="navigation-tab__group">
          <button type="button" className="toolbar-button toolbar-button--icon" title="打开" aria-label="打开" disabled={!primarySelected} onClick={() => openPrimary(false)}>
            <ExternalLink size={16} aria-hidden="true" />
          </button>
          <button type="button" className="toolbar-button toolbar-button--icon" title="打开所在文件夹" aria-label="打开所在文件夹" disabled={!primarySelected} onClick={() => primarySelected && actions.openNavigationItemParent(panelId, primarySelected.id)}>
            <FolderOpen size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="navigation-tab__group">
          <button type="button" className="toolbar-button toolbar-button--icon" title="编辑导航项" aria-label="编辑导航项" disabled={!primarySelected} onClick={() => openDraft(primarySelected)}>
            <Edit3 size={16} aria-hidden="true" />
          </button>
          <button type="button" className="toolbar-button toolbar-button--icon" title="从导航页移除" aria-label="从导航页移除" disabled={selectedItems.length === 0} onClick={() => actions.deleteNavigationItems(navigation.selectedItemIds)}>
            <Trash2 size={16} aria-hidden="true" />
          </button>
          <button type="button" className="toolbar-button toolbar-button--icon" title="上移" aria-label="上移" disabled={!canMoveUp || !primarySelected} onClick={() => primarySelected && actions.reorderNavigationItem(primarySelected.id, -1)}>
            <ArrowUp size={16} aria-hidden="true" />
          </button>
          <button type="button" className="toolbar-button toolbar-button--icon" title="下移" aria-label="下移" disabled={!canMoveDown || !primarySelected} onClick={() => primarySelected && actions.reorderNavigationItem(primarySelected.id, 1)}>
            <ArrowDown size={16} aria-hidden="true" />
          </button>
        </div>
        <label className="navigation-tab__filter">
          <Search size={14} aria-hidden="true" />
          <input value={navigation.filterText} onChange={(event) => actions.setNavigationFilter(event.currentTarget.value)} placeholder="过滤导航项" />
        </label>
        <button type="button" className="toolbar-button toolbar-button--icon" title="刷新状态" aria-label="刷新状态" onClick={() => actions.refreshNavigationTargets()}>
          <RefreshCw size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="navigation-tab__content">
      <div className="navigation-tab__editor-slot">
        {draft ? (
          <div className="navigation-editor" role="dialog" aria-label="编辑导航项">
            <label>
              <span>名称</span>
              <input value={draft.displayName ?? ""} onChange={(event) => setDraft({ ...draft, displayName: event.currentTarget.value })} />
            </label>
            <label>
              <span>{"\u6ce8\u91ca"}</span>
              <input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.currentTarget.value })} />
            </label>
            <label className="navigation-editor__path">
              <span>完整路径</span>
              <input value={draft.path} onChange={(event) => setDraft({ ...draft, path: event.currentTarget.value })} autoFocus />
            </label>
            <div className="navigation-editor__actions">
              <button type="button" className="toolbar-button" onClick={submitDraft} disabled={!draft.path.trim()}>
                保存
              </button>
              <button type="button" className="toolbar-button toolbar-button--flat" onClick={() => setDraft(null)}>
                取消
              </button>
            </div>
          </div>
        ) : nameDraft ? (
          <div className="navigation-editor navigation-editor--name" role="dialog" aria-label="编辑导航项名称">
            <label>
              <span>名称</span>
              <input value={nameDraft.displayName} onChange={(event) => setNameDraft({ ...nameDraft, displayName: event.currentTarget.value })} autoFocus />
            </label>
            <div className="navigation-editor__actions">
              <button type="button" className="toolbar-button" onClick={submitNameDraft}>
                保存
              </button>
              <button type="button" className="toolbar-button toolbar-button--flat" onClick={() => setNameDraft(null)}>
                取消
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="navigation-table" role="table" aria-label="导航页快捷入口">
        <div className="navigation-table__row navigation-table__row--header" role="row" style={navigationGridStyle} onContextMenu={openColumnHeaderMenu}>
          {visibleNavigationColumns.map((column) => (
            <div
              key={column.id}
              className="navigation-header-cell"
              role="columnheader"
              data-navigation-column-id={column.id}
              onContextMenu={openColumnHeaderMenu}
            >
              <span className="navigation-header-cell__label">{column.label}</span>
              <span
                className="navigation-header-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label={`resize ${column.id} column`}
                onMouseDown={(event) => handleNavigationColumnResizeStart(column.id, event)}
              />
            </div>
          ))}
        </div>
        <div className="navigation-table__body">
          {visibleItems.length === 0 ? (
            <div className="navigation-tab__empty">
              <button type="button" className="toolbar-button" onClick={() => openDraft()}>
                添加导航项
              </button>
              <button type="button" className="toolbar-button toolbar-button--flat" disabled={!currentFolder} onClick={() => currentFolder && actions.addCurrentFolderToNavigation(currentFolder)}>
                添加当前文件夹
              </button>
              <button type="button" className="toolbar-button toolbar-button--flat" disabled={selectedEntries.length === 0} onClick={() => actions.addSelectedEntriesToNavigation(panelId, selectedEntries)}>
                从当前选中项添加
              </button>
            </div>
          ) : (
            visibleItems.map((item) => {
              const selected = navigation.selectedItemIds.includes(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`navigation-table__row navigation-table__item${selected ? " is-selected" : ""}`}
                  role="row"
                  style={navigationGridStyle}
                  title={item.path}
                  onClick={(event) => actions.selectNavigationItem(item.id, event.ctrlKey || event.metaKey)}
                  onDoubleClick={() => actions.openNavigationItem(panelId, item.id)}
                  onContextMenu={(event) => openMenu(event, item)}
                >
                  {visibleNavigationColumns.map((column) => (
                    <Fragment key={column.id}>{renderNavigationCell(item, column.id)}</Fragment>
                  ))}
                </button>
              );
            })
          )}
        </div>
      </div>
      </div>

      {menu ? (
        <div ref={menuRef} className="navigation-menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" onClick={() => { openDraft(); setMenu(null); }}>
            添加导航项
          </button>
          <button type="button" disabled={!menuPrimarySelected} onClick={() => { if (menuPrimarySelected) actions.openNavigationItem(panelId, menuPrimarySelected.id); setMenu(null); }}>
            打开
          </button>
          <button type="button" disabled={!menuPrimarySelected} onClick={() => { if (menuPrimarySelected) actions.openNavigationItemParent(panelId, menuPrimarySelected.id); setMenu(null); }}>
            打开所在文件夹
          </button>
          <button type="button" disabled={!menuPrimarySelected} onClick={() => { if (menuPrimarySelected) openDraft(menuPrimarySelected); setMenu(null); }}>
            编辑导航项
          </button>
          <button type="button" disabled={menuSelectedItemIds.length === 0} onClick={() => { actions.deleteNavigationItems(menuSelectedItemIds); setMenu(null); }}>
            从导航页移除
          </button>
          <button type="button" disabled={menuSelectedItems.length === 0} onClick={() => { void navigator.clipboard?.writeText(menuSelectedItems.map((item) => item.path).join("\n")).catch(() => undefined); setMenu(null); }}>
            复制路径
          </button>
          <button type="button" onClick={() => { actions.refreshNavigationTargets(); setMenu(null); }}>
            刷新状态
          </button>
          <button type="button" disabled={menuSelectedItemIds.length !== 1} onClick={handleWindowsFileOperations}>
            Windows 文件操作...
          </button>
        </div>
      ) : null}
    </div>
  );
}

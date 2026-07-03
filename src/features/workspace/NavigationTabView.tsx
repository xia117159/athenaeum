import {
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
import { DetailsListBase } from "./DetailsListBase";
import { getDetailsAutoFitColumnWidth } from "./detailsColumnAutoFit";
import { hasEntryDragPayload, readEntryDragPayload } from "./entryDrag";
import { FileSystemIcon } from "./FileSystemIcon";
import {
  getNavigationCellText,
  getNavigationColumnHeaderMinWidth,
  getNavigationColumnPixelWidth,
  NAVIGATION_COLUMNS,
  NAVIGATION_COLUMN_MIN_WIDTHS,
  NAVIGATION_GRID_COLUMN_GAP_PX,
  type NavigationSortState,
  sortNavigationItemsForColumn
} from "./NavigationTabColumns";
import type { EntryViewModel, GitFileStatus, NavigationColumnDefinition, NavigationColumnId, NavigationItem, NavigationItemUpsertRequest, NavigationState, PanelId } from "./types";
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

function getFileExtension(path: string): string {
  const lastDot = path.lastIndexOf(".");
  const lastSlash = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (lastDot > lastSlash && lastDot !== -1) {
    return path.slice(lastDot);
  }
  return "";
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
  return items.filter((item) => {
    return (
      item.displayName.toLowerCase().includes(query) ||
      item.path.toLowerCase().includes(query) ||
      item.description.toLowerCase().includes(query)
    );
  });
}

function extractParentDirectory(path: string): string | null {
  if (!path || path.length === 0) {
    return null;
  }
  const normalized = path.replace(/\//g, "\\");
  const lastSeparator = normalized.lastIndexOf("\\");
  if (lastSeparator === -1) {
    return null;
  }
  return normalized.substring(0, lastSeparator);
}

function lookupNavigationGitStatus(
  gitStatusCache: Record<string, Record<string, GitFileStatus>> | undefined,
  itemPath: string
): GitFileStatus | undefined {
  if (!gitStatusCache) {
    return undefined;
  }
  const parentDir = extractParentDirectory(itemPath);
  if (!parentDir) {
    return undefined;
  }
  const dirCache = gitStatusCache[parentDir] ?? gitStatusCache[parentDir.toLowerCase()];
  if (!dirCache) {
    return undefined;
  }
  return dirCache[itemPath] ?? dirCache[itemPath.toLowerCase()];
}

export function NavigationTabView({
  panelId,
  navigation,
  navigationColumns = NAVIGATION_COLUMNS,
  currentFolder,
  selectedEntries,
  actions
}: {
  panelId: PanelId;
  navigation: NavigationState;
  navigationColumns?: NavigationColumnDefinition[];
  currentFolder?: CurrentFolderContext;
  selectedEntries: EntryViewModel[];
  actions: WorkspaceActions;
}) {
  const [draft, setDraft] = useState<NavigationItemUpsertRequest | null>(null);
  const [nameDraft, setNameDraft] = useState<{ id: string; displayName: string } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [navigationSort, setNavigationSort] = useState<NavigationSortState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const navigationTableRef = useRef<HTMLDivElement | null>(null);
  const visibleItems = useMemo(
    () => sortNavigationItemsForColumn(filterItems(navigation.items, navigation.filterText), navigationSort),
    [navigation.items, navigation.filterText, navigationSort]
  );
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

    // 列表导航：Shift 期间锚点固定、只动光标；纯方向键先塌缩到区间近端外侧一格再按 move 走，
    // 单项选择按 move 走一格/到端点/翻页。
    if (
      (event.key === "ArrowDown" || event.key === "ArrowUp" ||
        event.key === "Home" || event.key === "End" ||
        event.key === "PageUp" || event.key === "PageDown") &&
      visibleItems.length > 0
    ) {
      consumeKey(event);
      const ids = visibleItems.map((item) => item.id);
      const count = ids.length;
      const withShift = event.shiftKey;

      // 解析当前锚点 / 光标 id（首次 Shift 时确立锚点）。
      const anchorId = navigation.selectionAnchorId ?? primarySelected?.id ?? null;
      const anchorIndex = ids.indexOf(anchorId ?? "");
      const cursorId = navigation.selectionCursorId;
      const cursorStoredIndex = cursorId ? ids.indexOf(cursorId) : -1;

      const focusIndex = primarySelected ? ids.indexOf(primarySelected.id) : -1;

      // 计算"光标端起点" + 目标 index：
      // - 多选区间 + 纯方向键：从区间近端（朝移动方向的可见端）再按 move 走一格 → 塌缩为单项。
      // - Shift：锚点固定，从"上一次光标"按 move 走一格/到端点/翻页。
      // - 单项：从焦点按 move 走。
      const isUp =
        event.key === "ArrowUp" || event.key === "Home" || event.key === "PageUp";
      const isAbsolute = event.key === "Home" || event.key === "End";
      const isPage = event.key === "PageUp" || event.key === "PageDown";
      const step = isPage ? 10 : 1; // TODO: PageUp/Down 改为按视口可见行数动态计算。

      // 区间近端（用于纯方向键多选塌缩）。
      const selectedIndices = navigation.selectedItemIds
        .map((id) => ids.indexOf(id))
        .filter((index) => index >= 0);
      const rangeMin = selectedIndices.length ? Math.min(...selectedIndices) : -1;
      const rangeMax = selectedIndices.length ? Math.max(...selectedIndices) : -1;
      const inMultiRange = rangeMin >= 0 && rangeMax > rangeMin && !(withShift || cursorStoredIndex !== -1);

      let cursorStart: number;
      if (inMultiRange) {
        // 纯方向键从多选区间出发：起点取近端（↑/Home/PageUp→min；↓/End/PageDown→max），再按 move 走。
        cursorStart = isUp ? rangeMin : rangeMax;
      } else if (withShift) {
        cursorStart = cursorStoredIndex !== -1 ? cursorStoredIndex : (focusIndex === -1 ? (anchorIndex === -1 ? 0 : anchorIndex) : focusIndex);
      } else {
        cursorStart = focusIndex === -1 ? (isUp ? count : -1) : focusIndex;
      }

      let targetIndex: number;
      if (isAbsolute) {
        targetIndex = isUp ? 0 : count - 1;
      } else {
        targetIndex = Math.min(Math.max(cursorStart + (isUp ? -step : step), 0), count - 1);
        if (cursorStart === -1 && !withShift) {
          // 无选中时方向键的端点直觉：↓ 落到首项，↑ 落到末项。
          targetIndex = isUp ? count - 1 : 0;
        }
      }

      const targetId = ids[targetIndex];
      if (targetId) {
        if (withShift) {
          const effectiveAnchor = anchorIndex === -1 ? (focusIndex === -1 ? 0 : focusIndex) : anchorIndex;
          const from = Math.min(effectiveAnchor, targetIndex);
          const to = Math.max(effectiveAnchor, targetIndex);
          actions.setNavigationSelection(ids.slice(from, to + 1), { anchorId: ids[effectiveAnchor] ?? null, cursorId: targetId });
        } else {
          // 纯方向键塌缩为单项并重置锚点为目标项。
          actions.setNavigationSelection([targetId], { anchorId: targetId, cursorId: null });
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
      actions.setNavigationSelection(visibleItems.map((item) => item.id), { anchorId: null, cursorId: null });
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && selectedItems.length > 0) {
      consumeKey(event);
      void navigator.clipboard?.writeText(selectedItems.map((item) => item.path).join("\n")).catch(() => undefined);
      return;
    }
    if (event.key === "Escape") {
      consumeKey(event);
      if (navigation.filterText) {
        actions.setNavigationFilter("");
        return;
      }
      // 没有 filterText 时，Esc 清空导航页当前选择（与文件列表 Esc 行为一致）。
      actions.setNavigationSelection([], { anchorId: null, cursorId: null });
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
      actions.setNavigationSelection([item.id], { anchorId: item.id, cursorId: null });
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
        actions.setNavigationSelection([item.id], { anchorId: item.id, cursorId: null });
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

  const toggleNavigationSort = (columnId: NavigationColumnId) => {
    setNavigationSort((current) =>
      current?.columnId === columnId
        ? { columnId, direction: current.direction === "asc" ? "desc" : "asc" }
        : { columnId, direction: "asc" }
    );
  };

  const renderNavigationCell = (item: NavigationItem, columnId: NavigationColumnId) => {
    if (columnId === "name") {
      const gitStatus = lookupNavigationGitStatus(navigation.gitStatusCache, item.path);
      const extension = item.targetKind === "file" ? getFileExtension(item.path) : "";
      return (
        <span role="cell" className="navigation-table__cell navigation-table__name" data-navigation-cell-id={columnId}>
          <FileSystemIcon kind={item.targetKind === "folder" ? "folder" : "file"} path={item.path} extension={extension} size={16} imageList="sys-small" gitStatus={gitStatus} />
          <span>{item.displayName}</span>
        </span>
      );
    }

    if (columnId === "path") {
      return <span role="cell" className="navigation-table__cell navigation-table__path" data-navigation-cell-id={columnId}>{item.path}</span>;
    }

    if (columnId === "status") {
      return <span role="cell" className="navigation-table__cell" data-status={item.targetStatus} data-navigation-cell-id={columnId}>{STATUS_LABELS[item.targetStatus]}</span>;
    }

    return <span role="cell" className="navigation-table__cell" data-navigation-cell-id={columnId}>{getNavigationCellText(item, columnId)}</span>;
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

      <div ref={navigationTableRef} className="navigation-table" role="table" aria-label="导航页快捷入口">
        <DetailsListBase<NavigationColumnId, NavigationColumnDefinition>
          columns={navigationColumns}
          sort={navigationSort}
          gap={NAVIGATION_GRID_COLUMN_GAP_PX}
          getColumnLabel={(column) => column.label}
          getColumnMinWidth={(column) => NAVIGATION_COLUMN_MIN_WIDTHS[column.id]}
          getColumnPixelWidth={getNavigationColumnPixelWidth}
          onSort={toggleNavigationSort}
          onResizeColumn={actions.setNavigationColumnWidth}
          onMoveColumn={actions.moveNavigationColumn}
          onSetColumnVisibility={actions.setNavigationColumnVisibility}
          onShowAllColumns={actions.showAllNavigationColumns}
          onAutoFitColumn={(column) =>
            actions.setNavigationColumnWidth(
              column.id,
              getDetailsAutoFitColumnWidth({
                root: navigationTableRef.current,
                column,
                items: visibleItems,
                cellDataAttribute: "data-navigation-cell-id",
                getHeaderText: (candidate) => candidate.label,
                getCellText: (item, candidate) => getNavigationCellText(item, candidate.id),
                getMinWidth: getNavigationColumnHeaderMinWidth,
                getIconAllowance: (candidate) => (candidate.id === "name" ? 22 : 0)
              })
            )
          }
          headerClassName="navigation-table__row navigation-table__row--header"
          cellClassName="navigation-header-cell"
          buttonClassName="navigation-header-button"
          indicatorClassName="navigation-header-cell__sort"
          resizerClassName="navigation-header-resizer"
          resizerSelector=".navigation-header-resizer"
          headerCellSelector=".navigation-header-cell"
          dropIndicatorClassName="navigation-table__column-drop-indicator"
          dataAttributeName="data-navigation-column-id"
        >
          {({ gridStyle: navigationGridStyle, visibleColumns: visibleNavigationColumns }) => (
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
          )}
        </DetailsListBase>
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

import {
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useMemo,
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
import { FileSystemIcon } from "./FileSystemIcon";
import type { EntryViewModel, NavigationItem, NavigationItemUpsertRequest, NavigationState, PanelId } from "./types";
import type { useWorkspaceController } from "./useWorkspaceController";

type WorkspaceActions = ReturnType<typeof useWorkspaceController>["actions"];

type MenuState = {
  x: number;
  y: number;
  screenX: number;
  screenY: number;
  itemId?: string;
};

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
  const visibleItems = useMemo(() => filterItems(navigation.items, navigation.filterText), [navigation.items, navigation.filterText]);
  const selectedItems = navigation.items.filter((item) => navigation.selectedItemIds.includes(item.id));
  const primarySelected = selectedItems[0];
  const canMoveUp = primarySelected ? navigation.items.findIndex((item) => item.id === primarySelected.id) > 0 : false;
  const canMoveDown = primarySelected
    ? navigation.items.findIndex((item) => item.id === primarySelected.id) < navigation.items.length - 1
    : false;

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

  const handleDrop = (event: ReactDragEvent<HTMLElement>) => {
    const paths = getDroppedPaths(event);
    if (paths.length === 0) {
      return;
    }
    event.preventDefault();
    for (const path of paths) {
      actions.saveNavigationItem({ description: "", path });
    }
  };

  const openMenu = (event: ReactMouseEvent<HTMLElement>, item?: NavigationItem) => {
    event.preventDefault();
    if (item && !navigation.selectedItemIds.includes(item.id)) {
      actions.setNavigationSelection([item.id]);
    }
    setMenu({
      x: event.clientX,
      y: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY,
      itemId: item?.id
    });
  };

  const handleWindowsFileOperations = () => {
    void actions
      .openNavigationNativeContextMenu(navigation.selectedItemIds, menu?.x ?? 0, menu?.y ?? 0, menu?.screenX ?? 0, menu?.screenY ?? 0)
      .then((opened) => {
        if (opened) {
          setMenu(null);
        }
      });
  };

  return (
    <div
      className="navigation-tab"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onContextMenu={(event) => openMenu(event)}
      onDragOver={(event) => {
        if (event.dataTransfer?.types.includes("text/plain")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
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

      {draft ? (
        <div className="navigation-editor" role="dialog" aria-label="编辑导航项">
          <label>
            <span>名称</span>
            <input value={draft.displayName ?? ""} onChange={(event) => setDraft({ ...draft, displayName: event.currentTarget.value })} />
          </label>
          <label>
            <span>描述</span>
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

      <div className="navigation-table" role="table" aria-label="导航页快捷入口">
        <div className="navigation-table__row navigation-table__row--header" role="row">
          <span role="columnheader">名称</span>
          <span role="columnheader">类型</span>
          <span role="columnheader">路径</span>
          <span role="columnheader">描述</span>
          <span role="columnheader">状态</span>
          <span role="columnheader">最近打开</span>
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
                  title={item.path}
                  onClick={(event) => actions.selectNavigationItem(item.id, event.ctrlKey || event.metaKey)}
                  onDoubleClick={() => actions.openNavigationItem(panelId, item.id)}
                  onContextMenu={(event) => openMenu(event, item)}
                >
                  <span role="cell" className="navigation-table__name">
                    <FileSystemIcon kind={item.targetKind === "folder" ? "folder" : "file"} path={item.path} extension="" size={16} imageList="sys-small" />
                    <span>{item.displayName}</span>
                  </span>
                  <span role="cell">{KIND_LABELS[item.targetKind]}</span>
                  <span role="cell" className="navigation-table__path">{item.path}</span>
                  <span role="cell">{item.description || "--"}</span>
                  <span role="cell" data-status={item.targetStatus}>{STATUS_LABELS[item.targetStatus]}</span>
                  <span role="cell">{formatTime(item.lastOpenedAt)}</span>
                </button>
              );
            })
          )}
        </div>
      </div>

      {menu ? (
        <div className="navigation-menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" onClick={() => { openDraft(); setMenu(null); }}>
            添加导航项
          </button>
          <button type="button" onClick={() => { if (primarySelected) actions.openNavigationItem(panelId, primarySelected.id); setMenu(null); }}>
            打开
          </button>
          <button type="button" onClick={() => { if (primarySelected) actions.openNavigationItemParent(panelId, primarySelected.id); setMenu(null); }}>
            打开所在文件夹
          </button>
          <button type="button" onClick={() => { if (primarySelected) openDraft(primarySelected); setMenu(null); }}>
            编辑导航项
          </button>
          <button type="button" onClick={() => { actions.deleteNavigationItems(navigation.selectedItemIds); setMenu(null); }}>
            从导航页移除
          </button>
          <button type="button" onClick={() => { void navigator.clipboard?.writeText(selectedItems.map((item) => item.path).join("\n")).catch(() => undefined); setMenu(null); }}>
            复制路径
          </button>
          <button type="button" onClick={() => { actions.refreshNavigationTargets(); setMenu(null); }}>
            刷新状态
          </button>
          <button type="button" onClick={handleWindowsFileOperations}>
            Windows 文件操作...
          </button>
        </div>
      ) : null}
    </div>
  );
}

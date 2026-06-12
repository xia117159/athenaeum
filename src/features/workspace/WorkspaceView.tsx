import { type CSSProperties, type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Copy,
  FilePlus,
  FolderPlus,
  PanelTopOpen,
  RefreshCw,
  Scissors,
  Search,
  Trash2,
  ClipboardPaste,
  TextCursorInput
} from "lucide-react";
import { ResizableSplit } from "./ResizableSplit";
import { FileListingShell as WorkspaceFileListingShell } from "./FileListing";
import { NavigationTabView } from "./NavigationTabView";
import { WorkspaceContextMenuPopover } from "./WorkspaceContextMenuPopover";
import { WorkspaceInformationPanel } from "./WorkspaceInformationPanel";
import { OperationConflictDialog, OperationSummaryButton, OperationTaskCenter } from "./OperationTaskCenter";
import { WorkspacePanelChrome } from "./WorkspacePanelChrome";
import { WorkspaceTreeBranch } from "./WorkspaceTreeBranch";
import { openSettingsWindow } from "./settingsWindow";
import { useWorkspaceController } from "./useWorkspaceController";
import { getActiveTab } from "./workspaceReducer";
import { getShortcutBinding } from "./workspaceShortcuts";
import { isDirectoryTab, isNavigationTab } from "./workspaceTabs";
import type { ColumnDefinition, DirectoryNode, EntryViewModel, PanelId, PanelState, SearchResult, TabState, WorkspaceState } from "./types";
import "./workspace.css";

type WorkspaceActions = ReturnType<typeof useWorkspaceController>["actions"];

type MenuItemDefinition = {
  label: string;
  disabled?: boolean;
  checked?: boolean;
  onSelect: () => void;
};

type MenuDefinition = {
  id: string;
  label: string;
  items: MenuItemDefinition[];
};

const LAYOUT_LABELS: Array<{ mode: WorkspaceState["layoutMode"]; label: string }> = [
  { mode: "single", label: "单面板" },
  { mode: "dual", label: "双面板" },
  { mode: "triple", label: "三面板" },
  { mode: "quad", label: "四面板" }
];

function getSourceLabel(source: WorkspaceState["source"]) {
  return source === "mock" ? "模拟数据" : "Tauri 后端";
}

function getPanelDisplayLabel(panelId: PanelId) {
  return `面板 ${panelId.replace("panel-", "")}`;
}

function getUniqueRecentPaths(history: string[], currentPath: string) {
  const seen = new Set<string>();
  const ordered = [...history].reverse();
  const result: string[] = [];

  for (const path of [currentPath, ...ordered]) {
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    result.push(path);
  }

  return result;
}

function filterEntries(entries: EntryViewModel[], filterText: string) {
  const normalized = filterText.trim().toLowerCase();
  if (!normalized) {
    return entries;
  }

  return entries.filter((entry) => {
    const searchable = [entry.name, entry.path, entry.extension, entry.description, entry.tags.join(" ")].join(" ").toLowerCase();
    return searchable.includes(normalized);
  });
}

function getSelectedEntriesForTab(entries: EntryViewModel[], selectedEntryIds: string[]) {
  if (selectedEntryIds.length === 0) {
    return [];
  }

  const selectedIds = new Set(selectedEntryIds);
  return entries.filter((entry) => selectedIds.has(entry.id));
}

export function WorkspaceView() {
  const { state, actions } = useWorkspaceController();
  const activePanel = state.panels[state.activePanelId];
  const activeTab = getActiveTab(activePanel);
  const isActiveNavigationTab = isNavigationTab(activeTab);
  const activeEntries = isActiveNavigationTab ? [] : activeTab.snapshot.entries;
  const selectedEntries = isActiveNavigationTab ? [] : getSelectedEntriesForTab(activeEntries, activeTab.selectedEntryIds);
  const filteredActiveEntries = isActiveNavigationTab ? [] : filterEntries(activeEntries, state.search.filterText);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [addressHistoryOpen, setAddressHistoryOpen] = useState(false);
  const menuRootRef = useRef<HTMLDivElement | null>(null);
  const addressBarRef = useRef<HTMLDivElement | null>(null);
  const recentPaths = isActiveNavigationTab ? [] : getUniqueRecentPaths(activeTab.history, activeTab.snapshot.location.path);
  const navigationTabOpen = Object.values(state.panels).some((panel) => panel.tabs.some((tab) => tab.kind === "navigation"));

  const handleOpenSettingsWindow = () => {
    void openSettingsWindow().catch((error) => {
      window.alert(error instanceof Error ? error.message : "无法打开设置窗口。");
    });
  };

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) {
        return;
      }

      if (menuRootRef.current && !menuRootRef.current.contains(event.target)) {
        setOpenMenuId(null);
      }

      if (addressBarRef.current && !addressBarRef.current.contains(event.target)) {
        setAddressHistoryOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const editable =
        target instanceof HTMLElement &&
        (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "," && !editable) {
        event.preventDefault();
        handleOpenSettingsWindow();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const handleMenuAction = (action: () => void) => {
    action();
    setOpenMenuId(null);
  };

  const handleAddressSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isActiveNavigationTab) {
      return;
    }
    setAddressHistoryOpen(false);
    actions.submitAddress(state.activePanelId, activeTab.addressDraft);
  };

  const canUseDirectoryCommands = isDirectoryTab(activeTab);
  const canGoBack = canUseDirectoryCommands && activeTab.historyIndex > 0;
  const canGoForward = canUseDirectoryCommands && activeTab.historyIndex < activeTab.history.length - 1;
  const menuDefinitions: MenuDefinition[] = [
    {
      id: "file",
      label: "文件",
      items: [
        { label: "新建标签页", onSelect: () => actions.openNewTab(state.activePanelId) },
        { label: "新建文件夹", disabled: !canUseDirectoryCommands, onSelect: () => actions.createFolder(state.activePanelId) },
        { label: "新建文件", disabled: !canUseDirectoryCommands, onSelect: () => actions.createFile(state.activePanelId) },
        { label: "关闭当前标签页", onSelect: () => actions.closeTab(state.activePanelId, activeTab.id) }
      ]
    },
    {
      id: "edit",
      label: "编辑",
      items: [
        { label: "复制", disabled: !canUseDirectoryCommands, onSelect: () => actions.copySelection(state.activePanelId) },
        { label: "剪切", disabled: !canUseDirectoryCommands, onSelect: () => actions.cutSelection(state.activePanelId) },
        { label: "粘贴", disabled: !canUseDirectoryCommands, onSelect: () => actions.pasteIntoPanel(state.activePanelId) },
        { label: "重命名", disabled: !canUseDirectoryCommands, onSelect: () => actions.renameSelection(state.activePanelId) },
        { label: "删除", disabled: !canUseDirectoryCommands, onSelect: () => actions.deleteSelection(state.activePanelId) }
      ]
    },
    {
      id: "view",
      label: "查看",
      items: [
        ...LAYOUT_LABELS.map((layout) => ({
          label: layout.label,
          checked: state.layoutMode === layout.mode,
          onSelect: () => actions.setLayoutMode(layout.mode)
        })),
        { label: "打开搜索面板", onSelect: () => actions.toggleSearch(true) }
      ]
    },
    {
      id: "go",
      label: "跳转",
      items: [
        { label: "后退", disabled: !canGoBack, onSelect: () => actions.navigateHistory(state.activePanelId, -1) },
        { label: "前进", disabled: !canGoForward, onSelect: () => actions.navigateHistory(state.activePanelId, 1) },
        { label: "上一级", disabled: !canUseDirectoryCommands, onSelect: () => actions.navigateUp(state.activePanelId) },
        { label: "刷新", onSelect: () => actions.refreshPanel(state.activePanelId) }
      ]
    },
    {
      id: "tab",
      label: "标签页",
      items: [
        { label: "新建标签页", onSelect: () => actions.openNewTab(state.activePanelId) },
        { label: "关闭当前标签页", onSelect: () => actions.closeTab(state.activePanelId, activeTab.id) },
        { label: "切换到下一个面板", onSelect: () => actions.focusNextPanel() }
      ]
    },
    {
      id: "tools",
      label: "工具",
      items: [
        {
          label: navigationTabOpen ? "隐藏导航页" : "显示导航页",
          checked: navigationTabOpen,
          onSelect: () => (navigationTabOpen ? actions.closeNavigationTab() : actions.openNavigationTab())
        },
        { label: "搜索", onSelect: () => actions.toggleSearch(true) },
        { label: "设置", onSelect: handleOpenSettingsWindow }
      ]
    },
    {
      id: "help",
      label: "帮助",
      items: [
        {
          label: "关于",
          onSelect: () => {
            if (typeof window !== "undefined") {
              window.alert("简单文件管理器桌面原型\n当前为精简工作区界面。");
            }
          }
        }
      ]
    }
  ];

  return (
    <div className={`workspace-shell${state.status === "loading" ? " workspace-shell--loading" : ""}`}>
      <header className="workspace-menubar" ref={menuRootRef}>
        <div className="workspace-menubar__menus">
          {menuDefinitions.map((menu) => (
            <div
              key={menu.id}
              className="menu-root"
              onMouseEnter={() => {
                if (openMenuId) {
                  setOpenMenuId(menu.id);
                }
              }}
            >
              <button
                type="button"
                className={`menu-button${openMenuId === menu.id ? " is-open" : ""}`}
                onClick={() => setOpenMenuId((current) => (current === menu.id ? null : menu.id))}
              >
                {menu.label}
              </button>
              {openMenuId === menu.id ? (
                <div className="menu-dropdown">
                  {menu.items.map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      className="menu-dropdown__item"
                      disabled={item.disabled}
                      onClick={() => handleMenuAction(item.onSelect)}
                    >
                      <span className="menu-dropdown__check">{item.checked ? "√" : ""}</span>
                      <span>{item.label}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>

        <div className="workspace-menubar__meta">
          <span className={`workspace-menubar__badge workspace-menubar__badge--${state.source}`}>{getSourceLabel(state.source)}</span>
        </div>
      </header>

      <section className="workspace-commandbar">
        <div className="workspace-toolbar__actions">
          <div className="workspace-toolbar__nav">
            <button type="button" className="toolbar-button toolbar-button--icon" title="后退" aria-label="后退" disabled={!canGoBack} onClick={() => actions.navigateHistory(state.activePanelId, -1)}>
              <ArrowLeft size={16} aria-hidden="true" />
            </button>
            <button type="button" className="toolbar-button toolbar-button--icon" title="前进" aria-label="前进" disabled={!canGoForward} onClick={() => actions.navigateHistory(state.activePanelId, 1)}>
              <ArrowRight size={16} aria-hidden="true" />
            </button>
            <button type="button" className="toolbar-button toolbar-button--icon" title="上一级" aria-label="上一级" disabled={!canUseDirectoryCommands} onClick={() => actions.navigateUp(state.activePanelId)}>
              <ArrowUp size={16} aria-hidden="true" />
            </button>
            <button type="button" className="toolbar-button toolbar-button--icon" title="刷新" aria-label="刷新" onClick={() => actions.refreshPanel(state.activePanelId)}>
              <RefreshCw size={16} aria-hidden="true" />
            </button>
          </div>
          <span className="workspace-toolbar__separator" aria-hidden="true" />
          <button type="button" className="toolbar-button toolbar-button--icon" title="新建文件夹" aria-label="新建文件夹" disabled={!canUseDirectoryCommands} onClick={() => actions.createFolder(state.activePanelId)}>
            <FolderPlus size={16} aria-hidden="true" />
          </button>
          <button type="button" className="toolbar-button toolbar-button--icon" title="新建文件" aria-label="新建文件" disabled={!canUseDirectoryCommands} onClick={() => actions.createFile(state.activePanelId)}>
            <FilePlus size={16} aria-hidden="true" />
          </button>
          <button type="button" className="toolbar-button toolbar-button--icon" title="新建标签页" aria-label="新建标签页" onClick={() => actions.openNewTab(state.activePanelId)}>
            <PanelTopOpen size={16} aria-hidden="true" />
          </button>
          <span className="workspace-toolbar__separator" aria-hidden="true" />
          <button type="button" className="toolbar-button toolbar-button--icon" title="复制" aria-label="复制" disabled={!canUseDirectoryCommands} onClick={() => actions.copySelection(state.activePanelId)}>
            <Copy size={16} aria-hidden="true" />
          </button>
          <button type="button" className="toolbar-button toolbar-button--icon" title="剪切" aria-label="剪切" disabled={!canUseDirectoryCommands} onClick={() => actions.cutSelection(state.activePanelId)}>
            <Scissors size={16} aria-hidden="true" />
          </button>
          <button type="button" className="toolbar-button toolbar-button--icon" title="粘贴" aria-label="粘贴" disabled={!canUseDirectoryCommands} onClick={() => actions.pasteIntoPanel(state.activePanelId)}>
            <ClipboardPaste size={16} aria-hidden="true" />
          </button>
          <button type="button" className="toolbar-button toolbar-button--icon" title="重命名" aria-label="重命名" disabled={!canUseDirectoryCommands} onClick={() => actions.renameSelection(state.activePanelId)}>
            <TextCursorInput size={16} aria-hidden="true" />
          </button>
          <button type="button" className="toolbar-button toolbar-button--icon" title="删除" aria-label="删除" disabled={!canUseDirectoryCommands} onClick={() => actions.deleteSelection(state.activePanelId)}>
            <Trash2 size={16} aria-hidden="true" />
          </button>
          <span className="workspace-toolbar__separator" aria-hidden="true" />
          <button type="button" className="toolbar-button toolbar-button--icon" title="搜索" aria-label="搜索" onClick={() => actions.toggleSearch(true)}>
            <Search size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="workspace-toolbar__history">
          <OperationSummaryButton operations={state.operations} onOpen={() => actions.setOperationTasksOpen(true)} />
        </div>
      </section>

      <section className="workspace-addressbar" ref={addressBarRef}>
        <form className="address-bar" onSubmit={handleAddressSubmit}>
          <span className="address-bar__prefix">路径</span>
          <input
            type="text"
            value={isActiveNavigationTab ? "导航" : activeTab.addressDraft}
            readOnly={isActiveNavigationTab}
            onChange={(event) => actions.updateAddressDraft(state.activePanelId, activeTab.id, event.target.value)}
            onFocus={() => setAddressHistoryOpen(false)}
            aria-label="当前路径"
          />
          <button
            type="button"
            className="address-bar__history-toggle"
            aria-label="显示历史路径"
            onClick={() => setAddressHistoryOpen((open) => !open)}
          >
            ▾
          </button>
          <button type="submit" className="toolbar-button toolbar-button--flat" disabled={isActiveNavigationTab}>
            转到
          </button>

          {addressHistoryOpen && recentPaths.length > 0 ? (
            <div className="address-history">
              {recentPaths.map((path) => (
                <button
                  key={path}
                  type="button"
                  className="address-history__item"
                  onClick={() => {
                    setAddressHistoryOpen(false);
                    actions.updateAddressDraft(state.activePanelId, activeTab.id, path);
                    actions.submitAddress(state.activePanelId, path);
                  }}
                >
                  {path}
                </button>
              ))}
            </div>
          ) : null}
        </form>
      </section>

      <section className="workspace-main">
        <div className="workspace-main__content">
          <ResizableSplit
            direction="horizontal"
            ratio={state.layoutRatios.tree}
            min={0.12}
            max={0.36}
            minSizePx={160}
            handleSize={8}
            onRatioChange={(value) => actions.setSplitRatio("tree", value)}
          >
            <ExplorerTreePane
              nodes={state.directoryTree}
              activePath={isActiveNavigationTab ? "" : activeTab.snapshot.location.path}
              expandedNodePaths={isActiveNavigationTab ? [] : activeTab.expandedNodePaths}
              onToggle={(path) => {
                if (isActiveNavigationTab) {
                  return;
                }
                const isExpanded = activeTab.expandedNodePaths.includes(path);
                actions.toggleTreeNode(state.activePanelId, activeTab.id, path, !isExpanded);
              }}
              onNavigate={(node) => actions.openTreeNode(state.activePanelId, node.path, node.kind)}
            />
            <WorkspaceRightContent
              state={state}
              actions={actions}
              activeFilterText={state.search.filterText}
              activeEntries={filteredActiveEntries}
              selectedEntries={selectedEntries}
            />
          </ResizableSplit>
        </div>
      </section>

      {state.contextMenu ? (
        <WorkspaceContextMenuPopover
          contextMenu={state.contextMenu}
          viewMode={
            state.panels[state.contextMenu.panelId].tabs.find((tab) => tab.id === state.contextMenu?.tabId)?.viewMode ??
            getActiveTab(state.panels[state.contextMenu.panelId]).viewMode
          }
          tab={state.panels[state.contextMenu.panelId].tabs.find((tab) => tab.id === state.contextMenu?.tabId)}
          actions={actions}
          onClose={() => actions.closeContextMenu()}
        />
      ) : null}

      <OperationTaskCenter
        operations={state.operations}
        onOpenChange={actions.setOperationTasksOpen}
        onCancelTask={actions.cancelOperation}
        onUndoLatest={actions.undoLatestOperation}
        onUndoRecord={actions.undoOperation}
      />

      <OperationConflictDialog
        dialog={state.operations.conflictDialog}
        onUpdate={actions.updateOperationConflictDialog}
        onResolve={actions.resolveOperationConflict}
        onCancelTask={actions.cancelOperation}
      />

      {state.status === "loading" ? (
        <div className="workspace-loading">
          <strong>正在加载工作区</strong>
          <span>初始化本地目录、布局和远程连接配置。</span>
        </div>
      ) : null}

    </div>
  );
}

function ExplorerTreePane({
  nodes,
  activePath,
  expandedNodePaths,
  onToggle,
  onNavigate
}: {
  nodes: DirectoryNode[];
  activePath: string;
  expandedNodePaths: string[];
  onToggle: (path: string) => void;
  onNavigate: (node: DirectoryNode) => void;
}) {
  return (
    <aside className="tree-pane" onMouseDown={(event) => event.stopPropagation()}>
      <div className="tree-pane__header">
        <strong>目录树</strong>
        <span title={activePath}>{activePath}</span>
      </div>
      <div className="directory-tree">
        {nodes.map((node) => (
          <WorkspaceTreeBranch
            key={node.id}
            node={node}
            depth={0}
            activePath={activePath}
            expandedNodePaths={expandedNodePaths}
            onToggle={onToggle}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </aside>
  );
}

function WorkspaceRightContent({
  state,
  actions,
  activeFilterText,
  activeEntries,
  selectedEntries
}: {
  state: WorkspaceState;
  actions: WorkspaceActions;
  activeFilterText: string;
  activeEntries: EntryViewModel[];
  selectedEntries: EntryViewModel[];
}) {
  const panels = <PanelLayout state={state} actions={actions} activeFilterText={activeFilterText} />;

  if (!state.search.open) {
    return <div className="workspace-main__right">{panels}</div>;
  }

  return (
    <div className="workspace-main__right workspace-main__right--with-info">
      <ResizableSplit
        direction="vertical"
        ratio={1 - state.layoutRatios.search}
        min={0.5}
        max={0.82}
        minSizePx={240}
        secondMinSizePx={180}
        handleSize={8}
        onRatioChange={(value) => actions.setSplitRatio("search", 1 - value)}
        className="workspace-main__right-split"
      >
        {panels}
        <WorkspaceInformationPanel
          search={state.search}
          activeEntries={activeEntries}
          selectedEntries={selectedEntries}
          onToggle={(open) => actions.toggleSearch(open)}
          onRunSearch={() => actions.runSearch()}
          onStopSearch={() => actions.stopSearch()}
          onSelectSearchTab={(tab) => actions.selectSearchTab(tab)}
          onUpdateQuery={(payload) => actions.updateSearchQuery(payload)}
          onUpdateFilter={(value) => actions.updateSearchFilter(value)}
          onSelectHistory={(index) => actions.selectSearchHistory(index)}
          onDeleteHistory={(index) => actions.deleteSearchHistory(index)}
        />
      </ResizableSplit>
    </div>
  );
}

function PanelLayout({
  state,
  actions,
  activeFilterText
}: {
  state: WorkspaceState;
  actions: WorkspaceActions;
  activeFilterText: string;
}) {
  const renderPanel = (panelId: PanelId) => (
    <PanelSurface
      key={panelId}
      panel={state.panels[panelId]}
      isFocused={state.activePanelId === panelId}
      filterText={activeFilterText}
      columns={state.settings.model.columns}
      detailsRowHeight={state.settings.model.detailsRowHeight}
      entryDropMoveBinding={getShortcutBinding(state.settings.model.shortcuts, "drag-move")}
      panelFocusAccent={state.settings.model.theme.panelFocusAccent}
      tabMinWidth={state.settings.model.theme.tabMinWidth}
      navigation={state.navigation}
      actions={actions}
    />
  );

  if (state.layoutMode === "single") {
    return <div className="panel-layout panel-layout--single">{renderPanel("panel-1")}</div>;
  }

  if (state.layoutMode === "dual") {
    return (
      <ResizableSplit
        direction="horizontal"
        ratio={state.layoutRatios.primary}
        min={0}
        max={1}
        minSizePx={280}
        secondMinSizePx={280}
        handleSize={8}
        onRatioChange={(value) => actions.setSplitRatio("primary", value)}
      >
        {renderPanel("panel-1")}
        {renderPanel("panel-2")}
      </ResizableSplit>
    );
  }

  if (state.layoutMode === "triple") {
    return (
      <ResizableSplit
        direction="horizontal"
        ratio={state.layoutRatios.primary}
        min={0}
        max={1}
        minSizePx={280}
        secondMinSizePx={280}
        handleSize={8}
        onRatioChange={(value) => actions.setSplitRatio("primary", value)}
      >
        {renderPanel("panel-1")}
        <ResizableSplit
          direction="vertical"
          ratio={state.layoutRatios.tripleSecondary}
          min={0}
          max={1}
          minSizePx={180}
          secondMinSizePx={180}
          handleSize={8}
          onRatioChange={(value) => actions.setSplitRatio("tripleSecondary", value)}
        >
          {renderPanel("panel-2")}
          {renderPanel("panel-3")}
        </ResizableSplit>
      </ResizableSplit>
    );
  }

  return (
    <ResizableSplit
      direction="horizontal"
      ratio={state.layoutRatios.primary}
      min={0}
      max={1}
      minSizePx={280}
      secondMinSizePx={280}
      handleSize={8}
      onRatioChange={(value) => actions.setSplitRatio("primary", value)}
    >
      <ResizableSplit
        direction="vertical"
        ratio={state.layoutRatios.quadLeftSecondary}
        min={0}
        max={1}
        minSizePx={180}
        secondMinSizePx={180}
        handleSize={8}
        onRatioChange={(value) => actions.setSplitRatio("quadLeftSecondary", value)}
      >
        {renderPanel("panel-1")}
        {renderPanel("panel-3")}
      </ResizableSplit>
      <ResizableSplit
        direction="vertical"
        ratio={state.layoutRatios.quadRightSecondary}
        min={0}
        max={1}
        minSizePx={180}
        secondMinSizePx={180}
        handleSize={8}
        onRatioChange={(value) => actions.setSplitRatio("quadRightSecondary", value)}
      >
        {renderPanel("panel-2")}
        {renderPanel("panel-4")}
      </ResizableSplit>
    </ResizableSplit>
  );
}

function PanelSurface({
  panel,
  isFocused,
  filterText,
  columns,
  detailsRowHeight,
  entryDropMoveBinding,
  panelFocusAccent,
  tabMinWidth,
  navigation,
  actions
}: {
  panel: PanelState;
  isFocused: boolean;
  filterText: string;
  columns: ColumnDefinition[];
  detailsRowHeight: number;
  entryDropMoveBinding: string;
  panelFocusAccent: string;
  tabMinWidth: number;
  navigation: WorkspaceState["navigation"];
  actions: WorkspaceActions;
}) {
  const activeTab = getActiveTab(panel);
  const directoryContextTab = panel.tabs.find(isDirectoryTab);
  const directoryContextEntries = directoryContextTab
    ? getSelectedEntriesForTab(directoryContextTab.snapshot.entries, directoryContextTab.selectedEntryIds)
    : [];
  const entries = isNavigationTab(activeTab) ? [] : isFocused ? filterEntries(activeTab.snapshot.entries, filterText) : activeTab.snapshot.entries;
  const isSearchResultsTab = activeTab.kind === "search-results";
  const isNavigationActive = activeTab.kind === "navigation";
  const isReconnectRequired = activeTab.status === "reconnect-required";

  // Memoize selection callbacks to prevent useEffect re-registration in FileListing
  const handleSelectMultiple = useCallback(
    (entryIds: string[]) => {
      actions.selectMultipleEntries(panel.id, activeTab.id, entryIds);
    },
    [actions, panel.id, activeTab.id]
  );

  const handleSelectAll = useCallback(() => {
    actions.selectAllEntries(panel.id, activeTab.id);
  }, [actions, panel.id, activeTab.id]);

  const handleSelectRange = useCallback(
    (fromId: string, toId: string) => {
      actions.selectEntryRange(panel.id, activeTab.id, fromId, toId);
    },
    [actions, panel.id, activeTab.id]
  );

  const handleClearSelection = useCallback(() => {
    actions.clearSelection(panel.id, activeTab.id);
  }, [actions, panel.id, activeTab.id]);

  return (
    <section
      className={`panel-surface${isFocused ? " is-focused" : ""}`}
      style={{ "--panel-focus-accent": panelFocusAccent, "--tab-min-width": `${tabMinWidth}px` } as CSSProperties}
      onMouseDown={() => actions.focusPanel(panel.id)}
    >
      <WorkspacePanelChrome
        panelId={panel.id}
        tabs={panel.tabs}
        activeTabId={panel.activeTabId}
        breadcrumbs={activeTab.snapshot.breadcrumbs}
        history={activeTab.history}
        historyIndex={activeTab.historyIndex}
        onActivateTab={(tabId) => actions.activateTab(panel.id, tabId)}
        onCloseTab={(tabId) => actions.closeTab(panel.id, tabId)}
        onMoveTab={(sourcePanelId, targetPanelId, tabId, targetIndex) =>
          actions.moveTab(sourcePanelId, targetPanelId, tabId, targetIndex)
        }
        onOpenTabContextMenu={(tabId, x, y) =>
          actions.openContextMenu({
            x,
            y,
            panelId: panel.id,
            tabId,
            mode: "custom",
            scope: "tab"
          })
        }
        onOpenNewTab={() => actions.openNewTab(panel.id)}
        onNavigateToPath={(path) => actions.navigateBreadcrumbPath(panel.id, path)}
        onDropEntries={(paths, destination, operation) => actions.dropEntries(paths, destination, operation)}
        entryDropMoveBinding={entryDropMoveBinding}
      />

      <div className="panel-listing">
        {isReconnectRequired ? (
          <ReconnectPanel tab={activeTab} onReconnect={() => actions.reconnectTab(panel.id, activeTab.id)} />
        ) : isNavigationActive ? (
          <NavigationTabView
            panelId={panel.id}
            navigation={navigation}
            currentFolder={
              directoryContextTab
                ? {
                    displayName: directoryContextTab.snapshot.location.label,
                    path: directoryContextTab.snapshot.location.path
                  }
                : undefined
            }
            selectedEntries={directoryContextEntries}
            actions={actions}
          />
        ) : isSearchResultsTab ? (
          <SearchResultsListing
            tab={activeTab}
            filterText={isFocused ? filterText : ""}
            onOpenResult={(result) => actions.navigateToPath(panel.id, result.openPath)}
          />
        ) : (
          <WorkspaceFileListingShell
            panelId={panel.id}
            tabId={activeTab.id}
            entries={entries}
            columns={activeTab.columns ?? columns}
            sort={activeTab.sort}
            currentPath={activeTab.snapshot.location.path}
            selectedEntryIds={activeTab.selectedEntryIds}
            viewMode={activeTab.viewMode}
            inlineEdit={activeTab.inlineEdit}
            onSort={(columnId) => actions.sortEntries(panel.id, activeTab.id, columnId)}
            onResizeColumn={(columnId, width) => actions.setColumnWidth(panel.id, activeTab.id, columnId, width)}
            onSelect={(entry, multi) => actions.selectEntry(panel.id, activeTab.id, entry.id, multi)}
            onSelectMultiple={handleSelectMultiple}
            onSelectAll={handleSelectAll}
            onSelectRange={handleSelectRange}
            onClearSelection={handleClearSelection}
            onOpen={(entry) => actions.openEntry(panel.id, entry)}
            detailsRowHeight={detailsRowHeight}
            onOpenContextMenu={(payload) => actions.openContextMenu(payload)}
            onOpenNativeContextMenu={(payload) => actions.openNativeContextMenu(payload)}
            onDropEntries={(paths, destination, operation) => actions.dropEntries(paths, destination, operation)}
            entryDropMoveBinding={entryDropMoveBinding}
            onInlineEditChange={(value) => actions.updateInlineEdit(panel.id, activeTab.id, value)}
            onInlineEditCommit={(value) => actions.commitInlineEdit(panel.id, activeTab.id, value)}
            onInlineEditCancel={() => actions.cancelInlineEdit(panel.id, activeTab.id)}
          />
        )}
      </div>
    </section>
  );
}

function ReconnectPanel({ tab, onReconnect }: { tab: TabState; onReconnect: () => void }) {
  return (
    <div className="reconnect-panel">
      <button type="button" className="toolbar-button reconnect-panel__button" onClick={onReconnect}>
        重新连接
      </button>
      <span title={tab.reconnect?.path ?? tab.snapshot.location.path}>{tab.reconnect?.path ?? tab.snapshot.location.path}</span>
      {tab.reconnect?.message ? <small>{tab.reconnect.message}</small> : null}
    </div>
  );
}

function filterSearchResults(results: SearchResult[], filterText: string) {
  const normalized = filterText.trim().toLowerCase();
  if (!normalized) {
    return results;
  }

  return results.filter((result) =>
    [result.name, result.path, result.parentPath, result.match].join(" ").toLowerCase().includes(normalized)
  );
}

function SearchResultsListing({
  tab,
  filterText,
  onOpenResult
}: {
  tab: TabState;
  filterText: string;
  onOpenResult: (result: SearchResult) => void;
}) {
  const results = filterSearchResults(tab.search?.results ?? [], filterText);
  const progressText = tab.search?.progress?.statusText ?? `${results.length} 个结果`;

  return (
    <div className="search-results-tab">
      <div className="search-results-tab__header">
        <div>
          <strong>{tab.title}</strong>
          <span title={tab.search?.sourcePath}>{tab.search?.sourcePath ?? tab.snapshot.location.path}</span>
        </div>
        <span>{progressText}</span>
      </div>

      <div className="search-results-tab__table" role="table" aria-label="搜索结果">
        <div className="search-results-tab__row search-results-tab__row--header" role="row">
          <span role="columnheader">名称</span>
          <span role="columnheader">类型</span>
          <span role="columnheader">位置</span>
          <span role="columnheader">匹配</span>
        </div>
        <div className="search-results-tab__body">
          {results.length === 0 ? (
            <div className="search-results-tab__empty">无结果</div>
          ) : (
            results.map((result) => (
              <button
                key={result.id}
                type="button"
                className="search-results-tab__row search-results-tab__result"
                role="row"
                title={result.path}
                onClick={() => onOpenResult(result)}
              >
                <span role="cell">{result.name}</span>
                <span role="cell">{result.kind === "folder" ? "文件夹" : "文件"}</span>
                <span role="cell">{result.parentPath}</span>
                <span role="cell">{result.match}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

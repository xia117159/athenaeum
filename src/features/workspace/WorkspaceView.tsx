import { type CSSProperties, type DragEvent as ReactDragEvent, type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ArrowUp, ClipboardPaste, Copy, FilePlus, FolderPlus, Palette, PanelLeftClose, PanelLeftOpen, PanelTopOpen, RefreshCw, Scissors, Search, TextCursorInput, Trash2, X } from "lucide-react";
import { ResizableSplit } from "./ResizableSplit";
import { FileListingShell as WorkspaceFileListingShell } from "./FileListing";
import { NavigationTabView } from "./NavigationTabView";
import { WorkspaceContextMenuPopover } from "./WorkspaceContextMenuPopover";
import { WorkspaceInformationPanel } from "./WorkspaceInformationPanel";
import { WorkspaceMenuBar } from "./WorkspaceMenuBar";
import { WorkspacePanelChrome } from "./WorkspacePanelChrome";
import { WorkspaceTreeBranch } from "./WorkspaceTreeBranch";
import { openSettingsWindow } from "./settingsWindow";
import { listenSystemFileDrops } from "./systemDragDrop";
import { disposeQuietly } from "./workspaceIpc";
import { useWorkspaceController } from "./useWorkspaceController";
import { getActiveTab, getVisiblePanelIds } from "./workspaceReducer";
import { getShortcutBinding } from "./workspaceShortcuts";
import { isDirectoryTab, isNavigationTab } from "./workspaceTabs";
import { filterDirectoryNodesByFileVisibility } from "./workspaceVisibility";
import { getFolderListingRows, supportsFolderExpansion } from "./folderExpansion";
import type {
  ColumnDefinition,
  ColumnId,
  ContextMenuDefault,
  DirectoryNode,
  EntryViewModel,
  PanelId,
  PanelState,
  TabState,
  WindowsDragDropEnvironment,
  WorkspaceState
} from "./types";
import "./workspace.css";

type WorkspaceActions = ReturnType<typeof useWorkspaceController>["actions"];

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
  const filteredActiveEntries = getFolderListingRows(activeTab, state.fileVisibility, state.search.filterText,
    state.settings.model.folderExpansionEnabled === true).map((row) => row.entry);
  const selectedEntries = getSelectedEntriesForTab(filteredActiveEntries, activeTab.selectedEntryIds);
  const contextTab = state.contextMenu
    ? state.panels[state.contextMenu.panelId].tabs.find((tab) => tab.id === state.contextMenu?.tabId) : undefined;
  const [addressHistoryOpen, setAddressHistoryOpen] = useState(false);
  const addressBarRef = useRef<HTMLDivElement | null>(null);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const actionsRef = useRef(actions);
  const explorerDragWarningShownRef = useRef(false);
  const recentPaths = isActiveNavigationTab ? [] : getUniqueRecentPaths(activeTab.history, activeTab.snapshot.location.path);

  actionsRef.current = actions;

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

      if (addressBarRef.current && !addressBarRef.current.contains(event.target)) {
        setAddressHistoryOpen(false);
        // 点击地址栏外部时，让输入框失去焦点
        if (addressInputRef.current && document.activeElement === addressInputRef.current) {
          addressInputRef.current.blur();
        }
      }
      if (event.target instanceof Element && !event.target.closest(".inline-edit-input")) {
        const owningListing = event.target.closest(".file-listing");
        if (!owningListing?.querySelector(".inline-edit-input")) {
          actions.commitActiveInlineEdits();
        }
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [actions]);

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

  const handleExplorerFileDropsBlocked = useCallback(
    (environment: WindowsDragDropEnvironment) => {
      if (explorerDragWarningShownRef.current) {
        return;
      }
      explorerDragWarningShownRef.current = true;
      actionsRef.current.showNotification(
        "warning",
        `Windows 已阻止从资源管理器拖入文件：当前应用为 ${environment.integrityLevel} 完整性级别。请用普通权限重新启动应用。`
      );
    },
    []
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void listenSystemFileDrops(
      (paths, destination) => {
        actionsRef.current.dropEntries(paths, destination, "copy");
      },
      {
        onExplorerFileDropsBlocked: handleExplorerFileDropsBlocked
      }
    )
      .then((cleanup) => {
        if (disposed) {
          cleanup();
          return;
        }
        unlisten = cleanup;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      disposeQuietly(unlisten);
    };
  }, [handleExplorerFileDropsBlocked]);

  const handleExternalFileDrag = (event: ReactDragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) {
      return;
    }

    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
  };

  const handleAddressInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const isCtrl = event.ctrlKey || event.metaKey;

    // 当地址栏输入框获得焦点时，处理特定快捷键
    if (isCtrl) {
      const key = event.key.toLowerCase();

      // Ctrl+A: 全选输入框文字（浏览器原生行为，阻止冒泡到全局处理器）
      if (key === 'a') {
        event.stopPropagation();
        // 让浏览器原生处理全选，不需要 preventDefault
        return;
      }

      // Ctrl+F: 打开程序搜索面板（阻止浏览器默认搜索）
      if (key === 'f') {
        event.preventDefault();
        event.stopPropagation();
        actions.toggleSearch(true);
        return;
      }

      // Ctrl+C/X/V: 剪贴板操作（浏览器原生行为，阻止冒泡到全局处理器）
      if (['c', 'x', 'v'].includes(key)) {
        event.stopPropagation();
        return;
      }

      // Ctrl+Z/Y: 撤销/重做（浏览器原生行为，阻止冒泡）
      if (['z', 'y'].includes(key)) {
        event.stopPropagation();
        return;
      }
    }
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
  return (
    <div
      data-workspace-root
      tabIndex={-1}
      className={`workspace-shell${state.status === "loading" ? " workspace-shell--loading" : ""}`}
      onDragEnter={handleExternalFileDrag}
      onDragOver={handleExternalFileDrag}
      onDrop={handleExternalFileDrag}
    >
      <WorkspaceMenuBar
        state={state}
        actions={actions}
        activeTab={activeTab}
        canUseDirectoryCommands={canUseDirectoryCommands}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
      />

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
            <button
              type="button"
              className={`toolbar-button toolbar-button--icon${state.treeVisible ? " is-active" : ""}`}
              title={state.treeVisible ? "隐藏目录树" : "显示目录树"}
              aria-label={state.treeVisible ? "隐藏目录树" : "显示目录树"}
              aria-pressed={state.treeVisible}
              onClick={() => actions.setTreeVisible(!state.treeVisible)}
            >
              {state.treeVisible ? <PanelLeftClose size={16} aria-hidden="true" /> : <PanelLeftOpen size={16} aria-hidden="true" />}
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
          <button
            type="button"
            className={`toolbar-button toolbar-button--icon${state.settings.model.colorFilterEnabled !== false ? " is-active" : ""}`}
            title={state.settings.model.colorFilterEnabled !== false ? "关闭颜色过滤器" : "启用颜色过滤器"}
            aria-label={state.settings.model.colorFilterEnabled !== false ? "关闭颜色过滤器" : "启用颜色过滤器"}
            aria-pressed={state.settings.model.colorFilterEnabled !== false}
            aria-busy={state.colorFilterTogglePending || undefined}
            disabled={state.colorFilterTogglePending}
            onClick={() => void actions.toggleColorFilter(state.settings.model.colorFilterEnabled === false)}
          >
            <Palette size={16} aria-hidden="true" />
          </button>
        </div>

      </section>

      <section className="workspace-addressbar" ref={addressBarRef}>
        <form className="address-bar" onSubmit={handleAddressSubmit}>
          <input
            ref={addressInputRef}
            type="text"
            value={isActiveNavigationTab ? "导航" : activeTab.addressDraft}
            readOnly={isActiveNavigationTab}
            onChange={(event) => actions.updateAddressDraft(state.activePanelId, activeTab.id, event.target.value)}
            onKeyDown={handleAddressInputKeyDown}
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
        <div className={`workspace-main__content${state.treeVisible ? "" : " workspace-main__content--tree-hidden"}`}>
          {state.treeVisible ? (
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
                nodes={filterDirectoryNodesByFileVisibility(state.directoryTree, state.fileVisibility)}
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
          ) : (
            <WorkspaceRightContent
              state={state}
              actions={actions}
              activeFilterText={state.search.filterText}
              activeEntries={filteredActiveEntries}
              selectedEntries={selectedEntries}
            />
          )}
        </div>
      </section>

      {state.contextMenu ? (
        <WorkspaceContextMenuPopover
          contextMenu={state.contextMenu}
          viewMode={
            state.panels[state.contextMenu.panelId].tabs.find((tab) => tab.id === state.contextMenu?.tabId)?.viewMode ??
            getActiveTab(state.panels[state.contextMenu.panelId]).viewMode
          }
          tab={contextTab}
          visibleEntries={contextTab ? getFolderListingRows(contextTab, state.fileVisibility,
            state.contextMenu.panelId === state.activePanelId ? state.search.filterText : "",
            state.settings.model.folderExpansionEnabled === true).map((row) => row.entry) : []}
          clipboard={state.clipboard}
          actions={actions}
          layoutMode={state.layoutMode}
          panelIds={getVisiblePanelIds(state.layoutMode)}
          onClose={() => actions.closeContextMenu()}
        />
      ) : null}

      {state.notifications.length > 0 ? (
        <div className="workspace-notification-stack" role="region" aria-label="通知">
          {state.notifications.map((notification) => (
            <div
              key={notification.id}
              className={`workspace-notification workspace-notification--${notification.intent}`}
              role={notification.intent === "danger" ? "alert" : "status"}
            >
              <span>{notification.message}</span>
              <button
                type="button"
                className="workspace-notification__close"
                title="关闭通知"
                aria-label="关闭通知"
                onClick={() => actions.dismissNotification(notification.id)}
              >
                <X size={12} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

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

  const informationPanel = (
    <WorkspaceInformationPanel
      informationPanel={state.informationPanel}
      search={state.search}
      operations={state.operations}
      activeEntries={activeEntries}
      selectedEntries={selectedEntries}
      onToggleExpanded={actions.setInformationPanelExpanded}
      onSelectInformationTab={actions.selectInformationPanelTab}
      onOpenHistory={actions.openOperationHistory}
      onRunSearch={() => actions.runSearch()}
      onStopSearch={() => actions.stopSearch()}
      onSelectSearchTab={(tab) => actions.selectSearchTab(tab)}
      onUpdateQuery={(payload) => actions.updateSearchQuery(payload)}
      onUpdateFilter={(value) => actions.updateSearchFilter(value)}
      onSelectHistory={(index) => actions.selectSearchHistory(index)}
      onDeleteHistory={(index) => actions.deleteSearchHistory(index)}
    />
  );

  if (!state.informationPanel.expanded) {
    return (
      <div className="workspace-main__right workspace-main__right--with-summary">
        {panels}
        {informationPanel}
      </div>
    );
  }

  return (
    <div className="workspace-main__right workspace-main__right--with-info">
      <ResizableSplit
        direction="vertical"
        ratio={1 - state.layoutRatios.search}
        min={0.5}
        max={0.82}
        minSizePx={240}
        secondMinSizePx={222}
        handleSize={8}
        onRatioChange={(value) => actions.setSplitRatio("search", 1 - value)}
        className="workspace-main__right-split"
      >
        {panels}
        {informationPanel}
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
  const handleSyncScroll = useCallback(
    (sourcePanelId: PanelId, deltaX: number, deltaY: number) => {
      if (!state.syncScroll || (deltaX === 0 && deltaY === 0)) {
        return;
      }

      const visiblePanelIds = new Set(getVisiblePanelIds(state.layoutMode));
      const scrollContainers = Array.from(document.querySelectorAll<HTMLElement>(".file-listing__scroll[data-panel-id]"));
      for (const scrollContainer of scrollContainers) {
        const panelId = scrollContainer.dataset.panelId as PanelId | undefined;
        if (!panelId || panelId === sourcePanelId || !visiblePanelIds.has(panelId)) {
          continue;
        }
        scrollContainer.scrollLeft += deltaX;
        scrollContainer.scrollTop += deltaY;
      }
    },
    [state.layoutMode, state.syncScroll]
  );

  const renderPanel = (panelId: PanelId) => (
    <PanelSurface
      key={panelId}
      panel={state.panels[panelId]}
      isFocused={state.activePanelId === panelId}
      filterText={activeFilterText}
      columns={state.settings.model.columns}
      navigationColumns={state.settings.model.navigationColumns}
      clipboard={state.clipboard}
      detailsRowHeight={state.settings.model.detailsRowHeight}
      tooltipHoverDelayMs={state.settings.model.tooltipHoverDelayMs}
      entryDropMoveBinding={getShortcutBinding(state.settings.model.shortcuts, "drag-move")}
      contextMenuDefault={state.settings.model.contextMenu.defaultMenu}
      contextMenuToggleBinding={getShortcutBinding(state.settings.model.shortcuts, "context-menu-toggle")}
      panelFocusAccent={state.settings.model.theme.panelFocusAccent}
      activeTabBackground={state.settings.model.theme.activeTabBackground}
      dropHighlightFill={state.settings.model.theme.dropHighlightFill}
      dropHighlightBorder={state.settings.model.theme.dropHighlightBorder}
      tabMinWidth={state.settings.model.theme.tabMinWidth}
      fileVisibility={state.fileVisibility}
      colorFilterEnabled={state.settings.model.colorFilterEnabled ?? true}
      folderExpansionEnabled={state.settings.model.folderExpansionEnabled === true}
      syncScrollEnabled={state.syncScroll}
      navigation={state.navigation}
      keyboardNavToken={state.keyboardNavToken}
      actions={actions}
      onSyncScroll={handleSyncScroll}
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
  navigationColumns,
  clipboard,
  detailsRowHeight,
  tooltipHoverDelayMs,
  entryDropMoveBinding,
  contextMenuDefault,
  contextMenuToggleBinding,
  panelFocusAccent,
  activeTabBackground,
  dropHighlightFill,
  dropHighlightBorder,
  tabMinWidth,
  fileVisibility,
  colorFilterEnabled,
  folderExpansionEnabled,
  syncScrollEnabled,
  navigation,
  keyboardNavToken,
  actions,
  onSyncScroll
}: {
  panel: PanelState;
  isFocused: boolean;
  filterText: string;
  columns: ColumnDefinition[];
  navigationColumns: WorkspaceState["settings"]["model"]["navigationColumns"];
  clipboard: WorkspaceState["clipboard"];
  detailsRowHeight: number;
  tooltipHoverDelayMs: number;
  entryDropMoveBinding: string;
  contextMenuDefault: ContextMenuDefault;
  contextMenuToggleBinding: string;
  panelFocusAccent: string;
  activeTabBackground: string;
  dropHighlightFill: string;
  dropHighlightBorder: string;
  tabMinWidth: number;
  fileVisibility: WorkspaceState["fileVisibility"];
  colorFilterEnabled: boolean;
  folderExpansionEnabled: boolean;
  syncScrollEnabled: boolean;
  navigation: WorkspaceState["navigation"];
  keyboardNavToken?: symbol;
  actions: WorkspaceActions;
  onSyncScroll: (sourcePanelId: PanelId, deltaX: number, deltaY: number) => void;
}) {
  const activeTab = getActiveTab(panel);
  const directoryContextTab = panel.tabs.find(isDirectoryTab);
  const directoryContextEntries = directoryContextTab
    ? getSelectedEntriesForTab(getFolderListingRows(directoryContextTab, fileVisibility, "", folderExpansionEnabled).map((row) => row.entry), directoryContextTab.selectedEntryIds)
    : [];
  const rows = getFolderListingRows(activeTab, fileVisibility, isFocused ? filterText : "", folderExpansionEnabled);
  const entries = rows.map((row) => row.entry);
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
    (fromId: string, toId: string, orderedEntryIds?: string[]) => {
      actions.selectEntryRange(panel.id, activeTab.id, fromId, toId, orderedEntryIds);
    },
    [actions, panel.id, activeTab.id]
  );

  const handleClearSelection = useCallback(() => {
    actions.clearSelection(panel.id, activeTab.id);
  }, [actions, panel.id, activeTab.id]);

  return (
    <section
      className={`panel-surface${isFocused ? " is-focused" : ""}`}
      style={
        {
          "--panel-focus-accent": panelFocusAccent,
          "--active-tab-background": activeTabBackground,
          "--drop-highlight-fill": dropHighlightFill,
          "--drop-highlight-border": dropHighlightBorder,
          "--tab-min-width": `${tabMinWidth}px`
        } as CSSProperties
      }
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
            navigationColumns={navigationColumns}
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
        ) : (
          <WorkspaceFileListingShell
            colorFilterEnabled={colorFilterEnabled}
            panelId={panel.id}
            tabId={activeTab.id}
            entries={entries}
            folderRows={supportsFolderExpansion(activeTab, folderExpansionEnabled) ? rows : undefined}
            onToggleFolderExpansion={(path) => actions.toggleFolderExpansion(panel.id, activeTab.id, path)}
            onRetryFolderExpansion={(path) => actions.retryFolderExpansion(panel.id, activeTab.id, path)}
            columns={activeTab.columns ?? columns}
            sort={activeTab.sort}
            currentPath={activeTab.snapshot.location.path}
            selectedEntryIds={activeTab.selectedEntryIds}
            viewMode={activeTab.viewMode}
            inlineEdit={activeTab.inlineEdit}
            clipboard={clipboard}
            gitStatus={activeTab.gitStatus}
            keyboardNavToken={keyboardNavToken}
            selectionCursorId={activeTab.selectionCursorId}
            onSort={(columnId) => actions.sortEntries(panel.id, activeTab.id, columnId)}
            onResizeColumn={(columnId, width) => actions.setColumnWidth(panel.id, activeTab.id, columnId, width)}
            onSetColumnVisibility={(columnId: ColumnId, visible: boolean) =>
              actions.setColumnVisibility(panel.id, activeTab.id, columnId, visible)
            }
            onMoveColumn={(sourceId: ColumnId, targetId: ColumnId, placement: "before" | "after") =>
              actions.moveColumn(panel.id, activeTab.id, sourceId, targetId, placement)
            }
            onShowAllColumns={(columnIds: ColumnId[]) => actions.showAllColumns(panel.id, activeTab.id, columnIds)}
            onSelect={(entry, multi) => actions.selectEntry(panel.id, activeTab.id, entry.id, multi)}
            onSelectMultiple={handleSelectMultiple}
            onSelectAll={handleSelectAll}
            onSelectRange={handleSelectRange}
            onClearSelection={handleClearSelection}
            onOpen={(entry) => {
              if (activeTab.kind === "search-results") {
                actions.openSearchResult(panel.id, entry);
                return;
              }
              actions.openEntry(panel.id, entry);
            }}
            detailsRowHeight={detailsRowHeight}
            tooltipHoverDelayMs={tooltipHoverDelayMs}
            onOpenContextMenu={(payload) => actions.openContextMenu(payload)}
            onOpenNativeContextMenu={(payload) => actions.openNativeContextMenu(payload)}
            onDropEntries={(paths, destination, operation) => actions.dropEntries(paths, destination, operation)}
            onAddEntriesToNavigation={(paths) => actions.addPathsToNavigation(paths)}
            onStartSystemFileDrag={(paths) => actions.startSystemFileDrag(paths)}
            entryDropMoveBinding={entryDropMoveBinding}
            contextMenuDefault={contextMenuDefault}
            contextMenuToggleBinding={contextMenuToggleBinding}
            syncScrollEnabled={syncScrollEnabled}
            onSyncScroll={onSyncScroll}
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

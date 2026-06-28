import { type ReactNode, useEffect, useRef, useState } from "react";
import { WorkspaceSortMenuItems, WorkspaceViewMenuItems } from "./WorkspaceSharedMenuItems";
import { openAboutWindow } from "./aboutWindow";
import { openSettingsWindow } from "./settingsWindow";
import { useWorkspaceController } from "./useWorkspaceController";
import { getShortcutBinding } from "./workspaceShortcuts";
import type { TabState, WorkspaceState } from "./types";

type WorkspaceActions = ReturnType<typeof useWorkspaceController>["actions"];

type MenuActionItemDefinition = {
  kind?: "action";
  label: string;
  disabled?: boolean;
  checked?: boolean;
  shortcut?: string;
  onSelect: () => void;
};

type MenuSubmenuItemDefinition = {
  kind: "submenu";
  label: string;
  disabled?: boolean;
  children: ReactNode;
};

type MenuSeparatorDefinition = {
  kind: "separator";
  id: string;
};

type MenuItemDefinition = MenuActionItemDefinition | MenuSubmenuItemDefinition | MenuSeparatorDefinition;

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

function createWindowOpenHandler(openWindow: () => Promise<void>, fallback: string) {
  return () => {
    void openWindow().catch((error) => {
      window.alert(error instanceof Error ? error.message : fallback);
    });
  };
}

export function WorkspaceMenuBar({
  state,
  actions,
  activeTab,
  canUseDirectoryCommands,
  canGoBack,
  canGoForward
}: {
  state: WorkspaceState;
  actions: WorkspaceActions;
  activeTab: TabState;
  canUseDirectoryCommands: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}) {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const menuRootRef = useRef<HTMLDivElement | null>(null);
  const navigationTabOpen = Object.values(state.panels).some((panel) => panel.tabs.some((tab) => tab.kind === "navigation"));
  const handleOpenSettingsWindow = createWindowOpenHandler(openSettingsWindow, "无法打开设置窗口。");
  const handleOpenAboutWindow = createWindowOpenHandler(openAboutWindow, "无法打开关于窗口。");

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && menuRootRef.current && !menuRootRef.current.contains(event.target)) {
        setOpenMenuId(null);
      }
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  const handleMenuAction = (action: () => void) => {
    action();
    setOpenMenuId(null);
  };

  const renderMenuItem = (item: MenuItemDefinition) => {
    if (item.kind === "separator") {
      return <div key={item.id} className="menu-dropdown__separator" role="separator" />;
    }
    if (item.kind === "submenu") {
      return (
        <div key={item.label} className={`menu-dropdown__submenu${item.disabled ? " is-disabled" : ""}`} role="none">
          <button type="button" className="menu-dropdown__item menu-dropdown__item--submenu-trigger" disabled={item.disabled} aria-haspopup="menu">
            <span className="menu-dropdown__check" />
            <span className="menu-dropdown__item-label">{item.label}</span>
            <span className="menu-dropdown__shortcut" />
          </button>
          <div className="menu-dropdown__submenu-items" role="menu">{item.children}</div>
        </div>
      );
    }
    return (
      <button key={item.label} type="button" className="menu-dropdown__item" disabled={item.disabled} onClick={() => handleMenuAction(item.onSelect)}>
        <span className="menu-dropdown__check">{item.checked ? "√" : ""}</span>
        <span className="menu-dropdown__item-label">{item.label}</span>
        <span className="menu-dropdown__shortcut">{item.shortcut ?? ""}</span>
      </button>
    );
  };

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
        { label: "删除", disabled: !canUseDirectoryCommands, onSelect: () => actions.deleteSelection(state.activePanelId) },
        { kind: "separator", id: "edit-file-search-separator" },
        { label: "文件查找", onSelect: () => actions.openSearchPanel("name") },
        { kind: "separator", id: "edit-content-search-separator" },
        { label: "根据内容查找", onSelect: () => actions.openSearchPanel("content") }
      ]
    },
    {
      id: "view",
      label: "查看",
      items: [
        {
          kind: "submenu",
          label: "视图",
          disabled: !canUseDirectoryCommands,
          children: (
            <WorkspaceViewMenuItems
              classNames={{ item: "menu-dropdown__item", check: "menu-dropdown__check" }}
              disabled={!canUseDirectoryCommands}
              viewMode={canUseDirectoryCommands ? activeTab.viewMode : "details"}
              onSelect={(viewMode) => handleMenuAction(() => actions.setTabViewMode(state.activePanelId, activeTab.id, viewMode))}
            />
          )
        },
        {
          kind: "submenu",
          label: "排序方式",
          disabled: !canUseDirectoryCommands,
          children: (
            <WorkspaceSortMenuItems
              classNames={{ item: "menu-dropdown__item", check: "menu-dropdown__check", separator: "menu-dropdown__separator" }}
              disabled={!canUseDirectoryCommands}
              sort={canUseDirectoryCommands ? activeTab.sort : undefined}
              onSelectColumn={(columnId) => handleMenuAction(() => actions.setSort(state.activePanelId, activeTab.id, { columnId }))}
              onSelectDirection={(direction) => handleMenuAction(() => actions.setSort(state.activePanelId, activeTab.id, { direction }))}
            />
          )
        },
        { kind: "separator", id: "view-tree-separator" },
        { label: "显示目录树", checked: state.treeVisible, onSelect: () => actions.setTreeVisible(!state.treeVisible) },
        { kind: "separator", id: "view-refresh-separator" },
        { label: "刷新", shortcut: getShortcutBinding(state.settings.model.shortcuts, "refresh"), onSelect: () => actions.refreshPanel(state.activePanelId) },
        { kind: "separator", id: "view-items-separator" },
        {
          kind: "submenu",
          label: "显示项目",
          children: (
            <>
              <button type="button" className="menu-dropdown__item" role="menuitemcheckbox" aria-checked={state.fileVisibility.showHidden} onClick={() => handleMenuAction(() => actions.setFileVisibility({ showHidden: !state.fileVisibility.showHidden }))}>
                <span className="menu-dropdown__check">{state.fileVisibility.showHidden ? "√" : ""}</span>
                <span className="menu-dropdown__item-label">显示隐藏文件和文件夹</span>
                <span className="menu-dropdown__shortcut" />
              </button>
              <button type="button" className="menu-dropdown__item" role="menuitemcheckbox" aria-checked={state.fileVisibility.showSystem} onClick={() => handleMenuAction(() => actions.setFileVisibility({ showSystem: !state.fileVisibility.showSystem }))}>
                <span className="menu-dropdown__check">{state.fileVisibility.showSystem ? "√" : ""}</span>
                <span className="menu-dropdown__item-label">显示系统文件和文件夹</span>
                <span className="menu-dropdown__shortcut" />
              </button>
              <button type="button" className="menu-dropdown__item" role="menuitemcheckbox" aria-checked={state.fileVisibility.hideProtectedOperatingSystemFiles} onClick={() => handleMenuAction(() => actions.setFileVisibility({ hideProtectedOperatingSystemFiles: !state.fileVisibility.hideProtectedOperatingSystemFiles }))}>
                <span className="menu-dropdown__check">{state.fileVisibility.hideProtectedOperatingSystemFiles ? "√" : ""}</span>
                <span className="menu-dropdown__item-label">隐藏受系统保护的操作系统文件</span>
                <span className="menu-dropdown__shortcut" />
              </button>
            </>
          )
        }
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
        { label: "切换到下一个面板", onSelect: () => actions.focusNextPanel() },
        { kind: "separator", id: "tab-panel-layout-separator" },
        {
          kind: "submenu",
          label: "标签页面板",
          children: (
            <>
              {LAYOUT_LABELS.map((layout) => (
                <button key={layout.mode} type="button" className="menu-dropdown__item" role="menuitemradio" aria-checked={state.layoutMode === layout.mode} onClick={() => handleMenuAction(() => actions.setLayoutMode(layout.mode))}>
                  <span className="menu-dropdown__check">{state.layoutMode === layout.mode ? "√" : ""}</span>
                  <span className="menu-dropdown__item-label">{layout.label}</span>
                  <span className="menu-dropdown__shortcut" />
                </button>
              ))}
            </>
          )
        },
        { kind: "separator", id: "tab-sync-scroll-separator" },
        { label: "同步滚动", checked: state.syncScroll, onSelect: () => actions.setSyncScroll(!state.syncScroll) }
      ]
    },
    {
      id: "tools",
      label: "工具",
      items: [
        { label: navigationTabOpen ? "隐藏导航页" : "显示导航页", checked: navigationTabOpen, onSelect: () => (navigationTabOpen ? actions.closeNavigationTab() : actions.openNavigationTab()) },
        { label: "搜索", onSelect: () => actions.toggleSearch(true) },
        { label: "设置", onSelect: handleOpenSettingsWindow }
      ]
    },
    { id: "help", label: "帮助", items: [{ label: "关于", onSelect: handleOpenAboutWindow }] }
  ];

  return (
    <header className="workspace-menubar" ref={menuRootRef}>
      <div className="workspace-menubar__menus">
        {menuDefinitions.map((menu) => (
          <div key={menu.id} className="menu-root" onMouseEnter={() => { if (openMenuId) setOpenMenuId(menu.id); }}>
            <button type="button" className={`menu-button${openMenuId === menu.id ? " is-open" : ""}`} onClick={() => setOpenMenuId((current) => (current === menu.id ? null : menu.id))}>
              {menu.label}
            </button>
            {openMenuId === menu.id ? <div className="menu-dropdown">{menu.items.map(renderMenuItem)}</div> : null}
          </div>
        ))}
      </div>
      <div className="workspace-menubar__meta">
        <span className={`workspace-menubar__badge workspace-menubar__badge--${state.source}`}>{getSourceLabel(state.source)}</span>
      </div>
    </header>
  );
}

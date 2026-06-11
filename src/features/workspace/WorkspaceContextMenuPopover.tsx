import { type CSSProperties, useLayoutEffect, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TAB_VIEW_MODE_OPTIONS } from "./FileListing";
import type { ContextMenuState, TabState, TabViewMode } from "./types";
import type { useWorkspaceController } from "./useWorkspaceController";

type WorkspaceActions = ReturnType<typeof useWorkspaceController>["actions"];
const MENU_VIEWPORT_PADDING = 8;
const MENU_Z_INDEX = 10000;

export function WorkspaceContextMenuPopover({
  contextMenu,
  viewMode,
  tab,
  actions,
  onClose
}: {
  contextMenu: ContextMenuState;
  viewMode: TabViewMode;
  tab?: TabState;
  actions: WorkspaceActions;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState(() => ({ x: contextMenu.x, y: contextMenu.y }));

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || typeof window === "undefined") {
      return;
    }

    const rect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const maxX = Math.max(MENU_VIEWPORT_PADDING, viewportWidth - rect.width - MENU_VIEWPORT_PADDING);
    const maxY = Math.max(MENU_VIEWPORT_PADDING, viewportHeight - rect.height - MENU_VIEWPORT_PADDING);
    setPosition({
      x: Math.min(Math.max(MENU_VIEWPORT_PADDING, contextMenu.x), maxX),
      y: Math.min(Math.max(MENU_VIEWPORT_PADDING, contextMenu.y), maxY)
    });
  }, [contextMenu.x, contextMenu.y]);

  useEffect(() => {
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
      onClose();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const menuStyle = {
    position: "fixed",
    left: `${position.x}px`,
    top: `${position.y}px`,
    zIndex: MENU_Z_INDEX
  } as CSSProperties;

  const handleAction = (action: () => void) => {
    action();
    onClose();
  };
  const isNavigationTab = tab?.kind === "navigation";
  const isDirectoryTab = tab?.kind === "directory";

  const renderViewSubmenu = () => (
    <div className="context-menu__submenu">
      <span className="context-menu__submenu-label">查看</span>
      <div className="context-menu__submenu-items">
        {TAB_VIEW_MODE_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            className="context-menu__item"
            onClick={() => handleAction(() => actions.setTabViewMode(contextMenu.panelId, contextMenu.tabId, option.id))}
          >
            <span className="context-menu__check">{viewMode === option.id ? "✓" : ""}</span>
            <span>{option.label}</span>
          </button>
        ))}
      </div>
    </div>
  );

  const renderTabMenu = () => (
    <>
      <button type="button" className="context-menu__item" onClick={() => handleAction(() => actions.toggleTabLock(contextMenu.panelId, contextMenu.tabId))}>
        <span className="context-menu__check">{tab?.locked ? "✓" : ""}</span>
        <span>{tab?.locked ? "取消锁定标签页" : "锁定标签页"}</span>
      </button>
      <button type="button" className="context-menu__item" onClick={() => handleAction(() => actions.closeOtherTabs(contextMenu.panelId, contextMenu.tabId, true))}>
        <span className="context-menu__check" />
        <span>关闭所有其他标签页</span>
      </button>
      <button type="button" className="context-menu__item" onClick={() => handleAction(() => actions.closeTab(contextMenu.panelId, contextMenu.tabId))} disabled={tab?.locked}>
        <span className="context-menu__check" />
        <span>关闭当前标签页</span>
      </button>
      <button type="button" className="context-menu__item" onClick={() => handleAction(() => actions.closeOtherTabs(contextMenu.panelId, contextMenu.tabId, false))}>
        <span className="context-menu__check" />
        <span>关闭所有其他未锁定的标签页</span>
      </button>
      <div className="context-menu__separator" />
      <button type="button" className="context-menu__item" disabled={isNavigationTab} onClick={() => handleAction(() => actions.copyTabPath(contextMenu.panelId, contextMenu.tabId))}>
        <span className="context-menu__check" />
        <span>复制路径</span>
      </button>
      <button
        type="button"
        className="context-menu__item"
        disabled={isNavigationTab}
        onClick={() =>
          handleAction(() => {
            const nextTitle = window.prompt("重命名标签页", tab?.title ?? "");
            if (nextTitle?.trim()) {
              actions.renameTab(contextMenu.panelId, contextMenu.tabId, nextTitle);
            }
          })
        }
      >
        <span className="context-menu__check" />
        <span>重命名标签页</span>
      </button>
      <button type="button" className="context-menu__item" disabled={isNavigationTab} onClick={() => handleAction(() => actions.openNewTab(contextMenu.panelId, tab?.snapshot.location.path))}>
        <span className="context-menu__check" />
        <span>复制到新标签页</span>
      </button>
    </>
  );

  const renderPanelMenu = () => (
    <>
      <button type="button" className="context-menu__item" disabled={!isDirectoryTab} onClick={() => handleAction(() => actions.createFolder(contextMenu.panelId))}>
        <span className="context-menu__check" />
        <span>新建文件夹</span>
      </button>
      <button type="button" className="context-menu__item" disabled={!isDirectoryTab} onClick={() => handleAction(() => actions.createFile(contextMenu.panelId))}>
        <span className="context-menu__check" />
        <span>新建文件</span>
      </button>
      <button type="button" className="context-menu__item" disabled={!isDirectoryTab} onClick={() => handleAction(() => actions.copyTabPath(contextMenu.panelId, contextMenu.tabId))}>
        <span className="context-menu__check" />
        <span>复制路径</span>
      </button>
      <button type="button" className="context-menu__item" disabled={!isDirectoryTab} onClick={() => handleAction(() => actions.addCurrentFolderToNavigation())}>
        <span className="context-menu__check" />
        <span>添加当前文件夹到导航页</span>
      </button>
      {renderViewSubmenu()}
      <button type="button" className="context-menu__item" disabled={!isDirectoryTab && !isNavigationTab} onClick={() => handleAction(() => actions.refreshPanel(contextMenu.panelId))}>
        <span className="context-menu__check" />
        <span>刷新</span>
      </button>
      <button type="button" className="context-menu__item" onClick={() => handleAction(() => actions.openNewTab(contextMenu.panelId))}>
        <span className="context-menu__check" />
        <span>新建标签页</span>
      </button>
      {contextMenu.scope === "selection" ? (
        <>
          <div className="context-menu__separator" />
          <button type="button" className="context-menu__item" disabled={!isDirectoryTab} onClick={() => handleAction(() => actions.addSelectedEntriesToNavigation(contextMenu.panelId))}>
            <span className="context-menu__check" />
            <span>添加到导航页</span>
          </button>
          <button type="button" className="context-menu__item" disabled={!isDirectoryTab} onClick={() => handleAction(() => actions.copySelection(contextMenu.panelId))}>
            <span className="context-menu__check" />
            <span>复制</span>
          </button>
          <button type="button" className="context-menu__item" disabled={!isDirectoryTab} onClick={() => handleAction(() => actions.cutSelection(contextMenu.panelId))}>
            <span className="context-menu__check" />
            <span>剪切</span>
          </button>
          <button type="button" className="context-menu__item" disabled={!isDirectoryTab} onClick={() => handleAction(() => actions.renameSelection(contextMenu.panelId))}>
            <span className="context-menu__check" />
            <span>重命名</span>
          </button>
          <button type="button" className="context-menu__item" disabled={!isDirectoryTab} onClick={() => handleAction(() => actions.deleteSelection(contextMenu.panelId))}>
            <span className="context-menu__check" />
            <span>删除</span>
          </button>
        </>
      ) : null}
    </>
  );

  const menu = (
    <div ref={menuRef} className="context-menu" style={menuStyle}>
      <div className="context-menu__header">
        <strong>{contextMenu.scope === "tab" ? "标签页" : contextMenu.scope === "panel" ? "面板操作" : "项目操作"}</strong>
        <span>{contextMenu.mode === "custom" ? "应用右键菜单" : "系统菜单不可用，已回退到应用菜单"}</span>
      </div>
      {contextMenu.scope === "tab" ? renderTabMenu() : renderPanelMenu()}
    </div>
  );

  return createPortal(menu, document.body);
}

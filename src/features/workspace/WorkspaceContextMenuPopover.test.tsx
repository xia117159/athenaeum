import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { WorkspaceContextMenuPopover } from "./WorkspaceContextMenuPopover";
import type { ContextMenuState, TabViewMode } from "./types";

const { JSDOM } = require("jsdom") as {
  JSDOM: new (
    html?: string,
    options?: {
      url?: string;
    }
  ) => {
    window: Window & typeof globalThis;
  };
};

function assertTest(name: string, fn: () => Promise<void>) {
  return fn()
    .then(() => {
      console.log(`ok - ${name}`);
    })
    .catch((error) => {
      console.error(`not ok - ${name}`);
      throw error;
    });
}

function installDomEnvironment() {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost"
  });

  globalThis.window = dom.window as typeof globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.Event = dom.window.Event;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.PointerEvent = dom.window.PointerEvent;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator
  });
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 800
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: 600
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  return dom;
}

async function flushEffects() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createActions() {
  return {
    setTabViewMode() {},
    pasteIntoPanel() {},
    createFolder() {},
    createFile() {},
    openNewTab() {},
    refreshPanel() {},
    copySelection() {},
    cutSelection() {},
    renameSelection() {},
    deleteSelection() {},
    closeTab() {},
    closeOtherTabs() {},
    toggleTabLock() {},
    renameTab() {},
    copyTabPath() {},
    addCurrentFolderToNavigation() {},
    addSelectedEntriesToNavigation() {},
    moveTab() {},
    activateTab() {}
  };
}

const contextMenu = {
  x: 790,
  y: 590,
  panelId: "panel-1",
  tabId: "panel-1-tab-1",
  mode: "system-fallback",
  scope: "selection"
} satisfies ContextMenuState;

export const completion = (async () => {
  const dom = installDomEnvironment();
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("test root container is missing");
  }

  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.classList.contains("context-menu")) {
      return {
        width: 260,
        height: 320,
        top: 590,
        right: 1050,
        bottom: 910,
        left: 790,
        x: 790,
        y: 590,
        toJSON: () => ({})
      } as DOMRect;
    }

    return originalGetBoundingClientRect.call(this);
  };

  const root = ReactDOM.createRoot(container);

  try {
    await assertTest("WorkspaceContextMenuPopover portals above the shell and clamps to viewport edges", async () => {
      await act(async () => {
        root.render(
          React.createElement(WorkspaceContextMenuPopover, {
            contextMenu,
            viewMode: "details" as TabViewMode,
            actions: createActions() as never,
            onClose: () => undefined
          })
        );
        await flushEffects();
      });

      const menu = document.body.querySelector(".context-menu") as HTMLElement | null;
      assert.ok(menu);
      assert.equal(container.contains(menu), false);
      assert.equal(menu.style.left, "532px");
      assert.equal(menu.style.top, "272px");
      assert.equal(menu.style.zIndex, "10000");
    });

    await assertTest("WorkspaceContextMenuPopover orders panel actions for common file-manager use", async () => {
      await act(async () => {
        root.render(
          React.createElement(WorkspaceContextMenuPopover, {
            contextMenu: { ...contextMenu, mode: "custom", scope: "panel" },
            viewMode: "details" as TabViewMode,
            actions: createActions() as never,
            onClose: () => undefined
          })
        );
        await flushEffects();
      });

      const labels = Array.from(document.body.querySelectorAll(".context-menu__item span:last-child")).map((item) =>
        item.textContent?.trim()
      );
      assert.deepEqual(labels.slice(0, 7), ["新建文件夹", "新建文件", "复制路径", "添加当前文件夹到导航页", "超大图标", "大图标", "中等图标"]);
      assert.equal(labels.includes("刷新"), true);
      assert.equal(labels.includes("新建标签页"), true);
    });
  } finally {
    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    dom.window.close();
  }
})();

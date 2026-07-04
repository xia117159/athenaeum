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

function createActions(overrides: Record<string, unknown> = {}) {
  return {
    setTabViewMode() {},
    setSort() {},
    pasteIntoPanel() {},
    createFolder() {},
    createFile() {},
    openNewTab() {},
    navigateToPath() {},
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
    editEntryComment() {},
    copyEntryComment() {},
    pasteEntryComment() {},
    removeEntryComment() {},
    moveTab() {},
    activateTab() {},
    ...overrides
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

const directoryTab = {
  id: "panel-1-tab-1",
  title: "Documents",
  kind: "directory",
  locked: false,
  viewMode: "details",
  sort: {
    columnId: "name",
    direction: "asc"
  },
  snapshot: {
    location: {
      path: "D:\\Projects",
      label: "Projects",
      kind: "folder"
    }
  }
};

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
            tab: directoryTab as never,
            actions: createActions() as never,
            layoutMode: "single" as never,
            panelIds: ["panel-1"] as never,
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

    await assertTest("WorkspaceContextMenuPopover renders Explorer-style panel commands with nested menus", async () => {
      await act(async () => {
        root.render(
          React.createElement(WorkspaceContextMenuPopover, {
            contextMenu: { ...contextMenu, mode: "custom", scope: "panel" },
            viewMode: "details" as TabViewMode,
            tab: directoryTab as never,
            actions: createActions() as never,
            layoutMode: "single" as never,
            panelIds: ["panel-1"] as never,
            onClose: () => undefined
          })
        );
        await flushEffects();
      });

      const topLabels = Array.from(
        document.body.querySelectorAll(
          ".context-menu > .context-menu__item span:last-child, .context-menu > .context-menu__submenu > .context-menu__item span:last-child"
        )
      ).map((item) => item.textContent?.trim());
      assert.deepEqual(topLabels.slice(0, 5), ["新建文件", "新建文件夹", "视图", "排序方式", "粘贴"]);

      const submenus = Array.from(document.body.querySelectorAll(".context-menu__submenu"));
      const submenuLabels = (index: number) =>
        Array.from(submenus[index].querySelectorAll(".context-menu__submenu-items .context-menu__item span:last-child")).map((item) =>
          item.textContent?.trim()
        );

      assert.deepEqual(submenuLabels(0), ["超大图标", "大图标", "中等图标", "小图标", "列表", "详细信息列表", "平铺", "内容"]);
      assert.deepEqual(submenuLabels(1), ["名称", "修改日期", "类型", "大小", "递增", "递减"]);

      const pasteButton = Array.from(document.body.querySelectorAll(".context-menu > .context-menu__item")).find((item) =>
        item.textContent?.includes("粘贴")
      ) as HTMLButtonElement | undefined;
      assert.equal(pasteButton?.disabled, true);
      assert.equal(topLabels.includes("刷新"), true);
      assert.equal(topLabels.includes("新建标签页"), true);
    });

    await assertTest("WorkspaceContextMenuPopover enables paste when clipboard has entries and routes sort choices", async () => {
      const sortCalls: unknown[] = [];
      let pasteCalls = 0;
      await act(async () => {
        root.render(
          React.createElement(WorkspaceContextMenuPopover, {
            contextMenu: { ...contextMenu, mode: "custom", scope: "panel" },
            viewMode: "details" as TabViewMode,
            tab: directoryTab as never,
            clipboard: { mode: "copy", paths: ["D:\\Source\\note.txt"] },
            actions: createActions({
              pasteIntoPanel: () => {
                pasteCalls += 1;
              },
              setSort: (...args: unknown[]) => {
                sortCalls.push(args);
              }
            }) as never,
            layoutMode: "single" as never,
            panelIds: ["panel-1"] as never,
            onClose: () => undefined
          })
        );
        await flushEffects();
      });

      const pasteButton = Array.from(document.body.querySelectorAll(".context-menu > .context-menu__item")).find((item) =>
        item.textContent?.includes("粘贴")
      ) as HTMLButtonElement | undefined;
      assert.equal(pasteButton?.disabled, false);
      pasteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      assert.equal(pasteCalls, 1);

      const sizeButton = Array.from(document.body.querySelectorAll(".context-menu__submenu-items .context-menu__item")).find((item) =>
        item.textContent?.includes("大小")
      ) as HTMLButtonElement | undefined;
      sizeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      assert.deepEqual(sortCalls[0], ["panel-1", "panel-1-tab-1", { columnId: "size" }]);

      const descendingButton = Array.from(document.body.querySelectorAll(".context-menu__submenu-items .context-menu__item")).find((item) =>
        item.textContent?.includes("递减")
      ) as HTMLButtonElement | undefined;
      descendingButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      assert.deepEqual(sortCalls[1], ["panel-1", "panel-1-tab-1", { direction: "desc" }]);
    });

    await assertTest("WorkspaceContextMenuPopover renders the comment-only menu for comment cells", async () => {
      const calls: unknown[][] = [];
      const commentTab = {
        ...directoryTab,
        snapshot: {
          ...directoryTab.snapshot,
          entries: [
            {
              id: "file-source",
              name: "report.txt",
              kind: "file",
              path: "D:\\Projects\\report.txt",
              parentPath: "D:\\Projects",
              sizeLabel: "2 KB",
              modifiedLabel: "2026-04-21 10:00",
              extension: ".txt",
              attributes: ["A"],
              accentColor: "#0f6cbd",
              tags: [],
              comment: "Existing note",
              description: "Text report"
            }
          ]
        }
      };

      await act(async () => {
        root.render(
          React.createElement(WorkspaceContextMenuPopover, {
            contextMenu: {
              ...contextMenu,
              mode: "custom",
              scope: "comment",
              columnId: "comment",
              entryPath: "D:\\Projects\\report.txt"
            },
            viewMode: "details" as TabViewMode,
            tab: commentTab as never,
            actions: createActions({
              editEntryComment: (...args: unknown[]) => calls.push(["edit", ...args]),
              copyEntryComment: (...args: unknown[]) => calls.push(["copy", ...args]),
              pasteEntryComment: (...args: unknown[]) => calls.push(["paste", ...args]),
              removeEntryComment: (...args: unknown[]) => calls.push(["remove", ...args])
            }) as never,
            layoutMode: "single" as never,
            panelIds: ["panel-1"] as never,
            onClose: () => undefined
          })
        );
        await flushEffects();
      });

      const labels = Array.from(document.body.querySelectorAll(".context-menu > .context-menu__item span:last-child")).map((item) =>
        item.textContent?.trim()
      );
      assert.deepEqual(labels, ["编辑注释", "复制注释", "粘贴注释（从剪切板）", "移除注释"]);

      const buttons = Array.from(document.body.querySelectorAll<HTMLButtonElement>(".context-menu > .context-menu__item"));
      buttons[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
      buttons[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
      buttons[2].dispatchEvent(new MouseEvent("click", { bubbles: true }));
      buttons[3].dispatchEvent(new MouseEvent("click", { bubbles: true }));
      assert.deepEqual(calls, [
        ["edit", "panel-1", "panel-1-tab-1", "D:\\Projects\\report.txt"],
        ["copy", "D:\\Projects\\report.txt", "Existing note"],
        ["paste", "panel-1", "panel-1-tab-1", "D:\\Projects\\report.txt"],
        ["remove", "panel-1", "panel-1-tab-1", "D:\\Projects\\report.txt"]
      ]);
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

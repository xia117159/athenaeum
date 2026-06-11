import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { WorkspacePanelChrome } from "./WorkspacePanelChrome";
import { cloneColumns } from "./workspaceMappers";
import type { BreadcrumbItem, TabState } from "./types";

const ENTRY_DRAG_MIME = "application/x-simplefilemanager-entry-list";

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
  globalThis.Element = dom.window.Element;
  globalThis.Node = dom.window.Node;
  globalThis.Event = dom.window.Event;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.PointerEvent = dom.window.PointerEvent;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  if (!globalThis.HTMLElement.prototype.setPointerCapture) {
    globalThis.HTMLElement.prototype.setPointerCapture = () => undefined;
  }
  if (!globalThis.HTMLElement.prototype.releasePointerCapture) {
    globalThis.HTMLElement.prototype.releasePointerCapture = () => undefined;
  }

  return dom;
}

async function flushEffects() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createPointerEvent(
  type: string,
  options: { pointerId?: number; button?: number; buttons?: number; clientX?: number; clientY?: number } = {}
) {
  const event = new Event(type, {
    bubbles: true,
    cancelable: true
  });
  for (const [key, value] of Object.entries({
    pointerId: options.pointerId ?? 1,
    button: options.button ?? 0,
    buttons: options.buttons ?? 1,
    clientX: options.clientX ?? 0,
    clientY: options.clientY ?? 0
  })) {
    Object.defineProperty(event, key, {
      configurable: true,
      value
    });
  }
  return event;
}

function createDataTransfer() {
  const store = new Map<string, string>();
  return {
    dropEffect: "move",
    effectAllowed: "all",
    get types() {
      return Array.from(store.keys());
    },
    setData(type: string, value: string) {
      store.set(type, value);
    },
    getData(type: string) {
      return store.get(type) ?? "";
    }
  };
}

function dispatchDragEvent(
  target: Element,
  type: string,
  dataTransfer: ReturnType<typeof createDataTransfer>,
  modifiers: { ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean } = {}
): Event {
  const event = new Event(type, {
    bubbles: true,
    cancelable: true
  }) as Event & {
    ctrlKey: boolean;
    altKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    dataTransfer: ReturnType<typeof createDataTransfer>;
  };

  Object.defineProperties(event, {
    ctrlKey: { configurable: true, value: modifiers.ctrlKey ?? false },
    altKey: { configurable: true, value: modifiers.altKey ?? false },
    metaKey: { configurable: true, value: modifiers.metaKey ?? false },
    shiftKey: { configurable: true, value: modifiers.shiftKey ?? false },
    dataTransfer: { configurable: true, value: dataTransfer }
  });

  target.dispatchEvent(event);
  return event;
}

function stubElementFromPoint(element: Element | null) {
  const original = document.elementFromPoint;
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => element
  });
  return () => {
    if (original) {
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: original
      });
      return;
    }
    Reflect.deleteProperty(document, "elementFromPoint");
  };
}

function mockRect(element: Element, rect: { left: number; top: number; width: number; height: number }) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: rect.left,
      right: rect.left + rect.width,
      width: rect.width,
      top: rect.top,
      bottom: rect.top + rect.height,
      height: rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({})
    })
  });
}

function recordMovedTab(
  movedTabs: Array<{ sourcePanelId: string; targetPanelId: string; tabId: string; targetIndex: number }>
) {
  return (sourcePanelId: string, targetPanelId: string, tabId: string, targetIndex: number) =>
    movedTabs.push({ sourcePanelId, targetPanelId, tabId, targetIndex });
}

function createTab(id: string, title: string, path: string): TabState {
  return {
    id,
    title,
    kind: "directory",
    addressDraft: path,
    history: [path],
    historyIndex: 0,
    selectedEntryIds: [],
    expandedNodePaths: [path],
    viewMode: "details",
    sort: {
      columnId: "name",
      direction: "asc"
    },
    columns: cloneColumns(),
    status: "ready",
    snapshot: {
      location: {
        kind: "local",
        label: title,
        path
      },
      breadcrumbs: [
        { id: "C:\\", label: "C:", path: "C:\\" },
        { id: "C:\\Workspace", label: "Workspace", path: "C:\\Workspace" },
        { id: path, label: title, path }
      ],
      entries: []
    }
  };
}

function createNavigationTab(id: string): TabState {
  const path = "navigation://shortcuts";
  return {
    ...createTab(id, "Navigation", path),
    kind: "navigation",
    virtualPath: path,
    addressDraft: "Navigation",
    history: [],
    expandedNodePaths: [],
    snapshot: {
      location: {
        kind: "virtual",
        label: "Navigation",
        path
      },
      breadcrumbs: [{ id: path, label: "Navigation", path }],
      entries: []
    }
  };
}

export const completion = (async () => {
  const dom = installDomEnvironment();
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("test root container is missing");
  }

  const root = ReactDOM.createRoot(container);
  const activatedTabs: string[] = [];
  const closedTabs: string[] = [];
  const movedTabs: Array<{ sourcePanelId: string; targetPanelId: string; tabId: string; targetIndex: number }> = [];
  const tabMenus: Array<{ tabId: string; x: number; y: number }> = [];
  const droppedEntries: Array<{ paths: string[]; destination: string; operation: "copy" | "move" }> = [];
  const navigatedPaths: string[] = [];
  let openCount = 0;
  const tabs = [
    createTab("panel-1-tab-1", "Workspace", "C:\\Workspace"),
    createTab("panel-1-tab-2", "Downloads", "C:\\Workspace\\Downloads")
  ];
  const breadcrumbs: BreadcrumbItem[] = tabs[1].snapshot.breadcrumbs;

  try {
    await assertTest("WorkspacePanelChrome keeps the add button inline with the tab buttons", async () => {
      await act(async () => {
        root.render(
          React.createElement(WorkspacePanelChrome, {
            panelId: "panel-1",
            tabs,
            activeTabId: "panel-1-tab-2",
            breadcrumbs,
            onActivateTab: (tabId: string) => activatedTabs.push(tabId),
            onCloseTab: (tabId: string) => closedTabs.push(tabId),
            onMoveTab: recordMovedTab(movedTabs),
            onOpenTabContextMenu: (tabId: string, x: number, y: number) => tabMenus.push({ tabId, x, y }),
            onOpenNewTab: () => {
              openCount += 1;
            },
            onNavigateToPath: (path: string) => navigatedPaths.push(path)
          })
        );
        await flushEffects();
      });

      const tabsContainer = container.querySelector(".tab-strip__tabs");
      const addButton = tabsContainer?.lastElementChild;
      const select = container.querySelector(".tab-strip select");

      assert.ok(tabsContainer);
      assert.ok(addButton);
      assert.equal(addButton?.classList.contains("tab-strip__add"), true);
      assert.equal(select, null);
    });

    await assertTest("WorkspacePanelChrome renders breadcrumb buttons for the active tab path", async () => {
      const breadcrumbButtons = Array.from(container.querySelectorAll(".panel-breadcrumbs__segment"));
      const separators = Array.from(container.querySelectorAll(".panel-breadcrumbs__separator"));
      assert.equal(breadcrumbButtons.length, 3);
      assert.deepEqual(breadcrumbButtons.map((button) => button.textContent?.trim()), ["C:", "Workspace", "Downloads"]);
      assert.equal(separators.length, 2);
      assert.equal(
        separators.every((separator) => separator.querySelector(".lucide-chevron-right")),
        true
      );
      assert.deepEqual(separators.map((separator) => separator.textContent?.trim()), ["", ""]);

      await act(async () => {
        (breadcrumbButtons[1] as HTMLButtonElement).click();
        await flushEffects();
      });

      assert.deepEqual(navigatedPaths, ["C:\\Workspace"]);
    });

    await assertTest("WorkspacePanelChrome wires tab activation, active-tab close, and open actions to the strip controls", async () => {
      const tabButtons = Array.from(container.querySelectorAll(".tab-strip__tab"));
      const closeButtons = Array.from(container.querySelectorAll(".tab-strip__close"));
      const addButton = container.querySelector(".tab-strip__add");

      assert.equal(tabButtons.length, 2);
      assert.equal(closeButtons.length, 1);
      assert.equal(closeButtons[0].getAttribute("aria-label"), "关闭 Downloads");
      assert.ok(addButton);

      await act(async () => {
        (tabButtons[0] as HTMLButtonElement).click();
        await flushEffects();
      });

      await act(async () => {
        (closeButtons[0] as HTMLButtonElement).click();
        await flushEffects();
      });

      await act(async () => {
        (addButton as HTMLButtonElement).click();
        await flushEffects();
      });

      assert.deepEqual(activatedTabs, ["panel-1-tab-1"]);
      assert.deepEqual(closedTabs, ["panel-1-tab-2"]);
      assert.equal(openCount, 1);
    });

    await assertTest("WorkspacePanelChrome uses icon-only controls for tab close and tab creation", async () => {
      await act(async () => {
        root.render(
          React.createElement(WorkspacePanelChrome, {
            panelId: "panel-1",
            tabs,
            activeTabId: "panel-1-tab-2",
            breadcrumbs,
            onActivateTab: (tabId: string) => activatedTabs.push(tabId),
            onCloseTab: (tabId: string) => closedTabs.push(tabId),
            onMoveTab: recordMovedTab(movedTabs),
            onOpenTabContextMenu: (tabId: string, x: number, y: number) => tabMenus.push({ tabId, x, y }),
            onOpenNewTab: () => {
              openCount += 1;
            },
            onNavigateToPath: (path: string) => navigatedPaths.push(path)
          })
        );
        await flushEffects();
      });

      const closeButton = container.querySelector(".tab-strip__close");
      const addButton = container.querySelector(".tab-strip__add");

      assert.ok(closeButton);
      assert.ok(addButton);
      assert.ok(closeButton.querySelector(".tab-strip__close-icon.lucide-x"));
      assert.ok(addButton.querySelector(".tab-strip__add-icon.lucide-plus"));
      assert.equal(closeButton.textContent?.trim(), "");
      assert.equal(addButton.textContent?.trim(), "");
    });

    await assertTest("WorkspacePanelChrome opens tab context menus and avoids native HTML tab dragging", async () => {
      movedTabs.length = 0;
      tabMenus.length = 0;
      const tabButtons = Array.from(container.querySelectorAll(".tab-strip__tab"));
      assert.equal(tabButtons.length, 2);

      await act(async () => {
        tabButtons[1].dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 44,
            clientY: 55
          })
        );
        await flushEffects();
      });

      assert.deepEqual(tabMenus, [{ tabId: "panel-1-tab-2", x: 44, y: 55 }]);
      assert.equal(tabButtons.some((button) => (button as HTMLButtonElement).draggable), false);
    });

    await assertTest("WorkspacePanelChrome moves tabs with pointer drag inside the same panel", async () => {
      movedTabs.length = 0;
      activatedTabs.length = 0;
      const tabButtons = Array.from(container.querySelectorAll(".tab-strip__tab"));
      assert.equal(tabButtons.length, 2);

      mockRect(tabButtons[1], { left: 100, top: 0, width: 100, height: 24 });
      const restoreElementFromPoint = stubElementFromPoint(tabButtons[1]);

      try {
        await act(async () => {
          tabButtons[0].dispatchEvent(createPointerEvent("pointerdown", { clientX: 10, clientY: 8 }));
          window.dispatchEvent(createPointerEvent("pointermove", { clientX: 50, clientY: 8 }));
          window.dispatchEvent(createPointerEvent("pointerup", { clientX: 175, clientY: 8, buttons: 0 }));
          tabButtons[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          await flushEffects();
        });
      } finally {
        restoreElementFromPoint();
      }

      assert.deepEqual(movedTabs, [
        { sourcePanelId: "panel-1", targetPanelId: "panel-1", tabId: "panel-1-tab-1", targetIndex: 2 }
      ]);
      assert.deepEqual(activatedTabs, []);
    });

    await assertTest("WorkspacePanelChrome moves tabs across panels with pointer hit-testing", async () => {
      movedTabs.length = 0;
      const targetTabs = [
        createTab("panel-2-tab-1", "B", "F:\\B"),
        createTab("panel-2-tab-2", "Navigation", "navigation://shortcuts")
      ];

      await act(async () => {
        root.render(
          React.createElement(
            "div",
            null,
            React.createElement(WorkspacePanelChrome, {
              panelId: "panel-1",
              tabs,
              activeTabId: "panel-1-tab-2",
              breadcrumbs,
              onActivateTab: (tabId: string) => activatedTabs.push(tabId),
              onCloseTab: (tabId: string) => closedTabs.push(tabId),
              onMoveTab: recordMovedTab(movedTabs),
              onOpenTabContextMenu: (tabId: string, x: number, y: number) => tabMenus.push({ tabId, x, y }),
              onOpenNewTab: () => {
                openCount += 1;
              },
              onNavigateToPath: (path: string) => navigatedPaths.push(path)
            }),
            React.createElement(WorkspacePanelChrome, {
              panelId: "panel-2",
              tabs: targetTabs,
              activeTabId: "panel-2-tab-1",
              breadcrumbs: targetTabs[0].snapshot.breadcrumbs,
              onActivateTab: (tabId: string) => activatedTabs.push(tabId),
              onCloseTab: (tabId: string) => closedTabs.push(tabId),
              onMoveTab: recordMovedTab(movedTabs),
              onOpenTabContextMenu: (tabId: string, x: number, y: number) => tabMenus.push({ tabId, x, y }),
              onOpenNewTab: () => {
                openCount += 1;
              },
              onNavigateToPath: (path: string) => navigatedPaths.push(path)
            })
          )
        );
        await flushEffects();
      });

      const sourceTab = container.querySelector(".tab-strip__tab");
      const targetStrip = container.querySelectorAll(".tab-strip")[1];
      assert.ok(sourceTab);
      assert.ok(targetStrip);

      const restoreElementFromPoint = stubElementFromPoint(targetStrip);
      try {
        await act(async () => {
          sourceTab.dispatchEvent(createPointerEvent("pointerdown", { clientX: 10, clientY: 8 }));
          window.dispatchEvent(createPointerEvent("pointermove", { clientX: 520, clientY: 8 }));
          window.dispatchEvent(createPointerEvent("pointerup", { clientX: 520, clientY: 8, buttons: 0 }));
          await flushEffects();
        });
      } finally {
        restoreElementFromPoint();
      }

      assert.deepEqual(movedTabs, [
        { sourcePanelId: "panel-1", targetPanelId: "panel-2", tabId: "panel-1-tab-1", targetIndex: targetTabs.length }
      ]);
    });

    await assertTest("WorkspacePanelChrome copies dragged entries onto directory tabs and uses the configured move modifier", async () => {
      droppedEntries.length = 0;

      await act(async () => {
        root.render(
          React.createElement(WorkspacePanelChrome, {
            panelId: "panel-1",
            tabs,
            activeTabId: "panel-1-tab-1",
            breadcrumbs,
            entryDropMoveBinding: "Alt",
            onActivateTab: (tabId: string) => activatedTabs.push(tabId),
            onCloseTab: (tabId: string) => closedTabs.push(tabId),
            onMoveTab: recordMovedTab(movedTabs),
            onOpenTabContextMenu: (tabId: string, x: number, y: number) => tabMenus.push({ tabId, x, y }),
            onOpenNewTab: () => {
              openCount += 1;
            },
            onNavigateToPath: (path: string) => navigatedPaths.push(path),
            onDropEntries: (paths: string[], destination: string, operation: "copy" | "move") =>
              droppedEntries.push({ paths, destination, operation })
          })
        );
        await flushEffects();
      });

      const tabButtons = Array.from(container.querySelectorAll(".tab-strip__tab"));
      const targetTab = tabButtons[1];
      assert.ok(targetTab);

      const copyTransfer = createDataTransfer();
      copyTransfer.setData(
        ENTRY_DRAG_MIME,
        JSON.stringify({ sourcePanelId: "panel-1", sourceTabId: "panel-1-tab-1", paths: ["C:\\Workspace\\project"] })
      );
      let copyOverEvent: Event | undefined;
      await act(async () => {
        copyOverEvent = dispatchDragEvent(targetTab, "dragover", copyTransfer);
        dispatchDragEvent(targetTab, "drop", copyTransfer);
        await flushEffects();
      });

      const shiftTransfer = createDataTransfer();
      shiftTransfer.setData(
        ENTRY_DRAG_MIME,
        JSON.stringify({ sourcePanelId: "panel-1", sourceTabId: "panel-1-tab-1", paths: ["C:\\Workspace\\draft.txt"] })
      );
      await act(async () => {
        dispatchDragEvent(targetTab, "dragover", shiftTransfer, { shiftKey: true });
        dispatchDragEvent(targetTab, "drop", shiftTransfer, { shiftKey: true });
        await flushEffects();
      });

      const moveTransfer = createDataTransfer();
      moveTransfer.setData(
        ENTRY_DRAG_MIME,
        JSON.stringify({ sourcePanelId: "panel-1", sourceTabId: "panel-1-tab-1", paths: ["C:\\Workspace\\asset.png"] })
      );
      let moveOverEvent: Event | undefined;
      await act(async () => {
        moveOverEvent = dispatchDragEvent(targetTab, "dragover", moveTransfer, { altKey: true });
        dispatchDragEvent(targetTab, "drop", moveTransfer, { altKey: true });
        await flushEffects();
      });

      assert.equal(copyOverEvent?.defaultPrevented, true);
      assert.equal(moveOverEvent?.defaultPrevented, true);
      assert.equal(copyTransfer.dropEffect, "copy");
      assert.equal(shiftTransfer.dropEffect, "copy");
      assert.equal(moveTransfer.dropEffect, "move");
      assert.deepEqual(droppedEntries, [
        { paths: ["C:\\Workspace\\project"], destination: "C:\\Workspace\\Downloads", operation: "copy" },
        { paths: ["C:\\Workspace\\draft.txt"], destination: "C:\\Workspace\\Downloads", operation: "copy" },
        { paths: ["C:\\Workspace\\asset.png"], destination: "C:\\Workspace\\Downloads", operation: "move" }
      ]);
    });

    await assertTest("WorkspacePanelChrome exposes pointer drop metadata only on ready directory tabs", async () => {
      const navigationTabs = [createTab("panel-1-tab-1", "Workspace", "C:\\Workspace"), createNavigationTab("navigation-tab")];

      await act(async () => {
        root.render(
          React.createElement(WorkspacePanelChrome, {
            panelId: "panel-1",
            tabs: navigationTabs,
            activeTabId: "panel-1-tab-1",
            breadcrumbs,
            onActivateTab: (tabId: string) => activatedTabs.push(tabId),
            onCloseTab: (tabId: string) => closedTabs.push(tabId),
            onMoveTab: recordMovedTab(movedTabs),
            onOpenTabContextMenu: (tabId: string, x: number, y: number) => tabMenus.push({ tabId, x, y }),
            onOpenNewTab: () => {
              openCount += 1;
            },
            onNavigateToPath: (path: string) => navigatedPaths.push(path),
            onDropEntries: (paths: string[], destination: string, operation: "copy" | "move") =>
              droppedEntries.push({ paths, destination, operation })
          })
        );
        await flushEffects();
      });

      const tabButtons = Array.from(container.querySelectorAll(".tab-strip__tab"));
      assert.equal(tabButtons[0].getAttribute("data-entry-drop-kind"), "tab");
      assert.equal(tabButtons[0].getAttribute("data-entry-drop-path"), "C:\\Workspace");
      assert.equal(tabButtons[1].hasAttribute("data-entry-drop-kind"), false);
      assert.equal(tabButtons[1].hasAttribute("data-entry-drop-path"), false);
    });

    await assertTest("WorkspacePanelChrome resolves tab drops from the strip hit-test target", async () => {
      droppedEntries.length = 0;

      await act(async () => {
        root.render(
          React.createElement(WorkspacePanelChrome, {
            panelId: "panel-1",
            tabs,
            activeTabId: "panel-1-tab-1",
            breadcrumbs,
            onActivateTab: (tabId: string) => activatedTabs.push(tabId),
            onCloseTab: (tabId: string) => closedTabs.push(tabId),
            onMoveTab: recordMovedTab(movedTabs),
            onOpenTabContextMenu: (tabId: string, x: number, y: number) => tabMenus.push({ tabId, x, y }),
            onOpenNewTab: () => {
              openCount += 1;
            },
            onNavigateToPath: (path: string) => navigatedPaths.push(path),
            onDropEntries: (paths: string[], destination: string, operation: "copy" | "move") =>
              droppedEntries.push({ paths, destination, operation })
          })
        );
        await flushEffects();
      });

      const tabStrip = container.querySelector(".tab-strip");
      const targetTab = Array.from(container.querySelectorAll(".tab-strip__tab"))[1];
      assert.ok(tabStrip);
      assert.ok(targetTab);

      const restoreElementFromPoint = stubElementFromPoint(targetTab);
      try {
        const transfer = createDataTransfer();
        transfer.setData(
          ENTRY_DRAG_MIME,
          JSON.stringify({ sourcePanelId: "panel-1", sourceTabId: "panel-1-tab-1", paths: ["C:\\Workspace\\via-strip.txt"] })
        );

        let overEvent: Event | undefined;
        await act(async () => {
          overEvent = dispatchDragEvent(tabStrip, "dragover", transfer);
          dispatchDragEvent(tabStrip, "drop", transfer);
          await flushEffects();
        });

        assert.equal(overEvent?.defaultPrevented, true);
        assert.equal(transfer.dropEffect, "copy");
        assert.deepEqual(droppedEntries, [
          { paths: ["C:\\Workspace\\via-strip.txt"], destination: "C:\\Workspace\\Downloads", operation: "copy" }
        ]);
      } finally {
        restoreElementFromPoint();
      }
    });

    await assertTest("WorkspacePanelChrome rejects entry drops onto navigation tabs", async () => {
      droppedEntries.length = 0;
      const navigationTabs = [createTab("panel-1-tab-1", "Workspace", "C:\\Workspace"), createNavigationTab("navigation-tab")];

      await act(async () => {
        root.render(
          React.createElement(WorkspacePanelChrome, {
            panelId: "panel-1",
            tabs: navigationTabs,
            activeTabId: "panel-1-tab-1",
            breadcrumbs,
            onActivateTab: (tabId: string) => activatedTabs.push(tabId),
            onCloseTab: (tabId: string) => closedTabs.push(tabId),
            onMoveTab: recordMovedTab(movedTabs),
            onOpenTabContextMenu: (tabId: string, x: number, y: number) => tabMenus.push({ tabId, x, y }),
            onOpenNewTab: () => {
              openCount += 1;
            },
            onNavigateToPath: (path: string) => navigatedPaths.push(path),
            onDropEntries: (paths: string[], destination: string, operation: "copy" | "move") =>
              droppedEntries.push({ paths, destination, operation })
          })
        );
        await flushEffects();
      });

      const navigationTab = Array.from(container.querySelectorAll(".tab-strip__tab"))[1];
      assert.ok(navigationTab);

      const transfer = createDataTransfer();
      transfer.setData(
        ENTRY_DRAG_MIME,
        JSON.stringify({ sourcePanelId: "panel-1", sourceTabId: "panel-1-tab-1", paths: ["C:\\Workspace\\project"] })
      );
      let overEvent: Event | undefined;
      await act(async () => {
        overEvent = dispatchDragEvent(navigationTab, "dragover", transfer);
        dispatchDragEvent(navigationTab, "drop", transfer);
        await flushEffects();
      });

      assert.equal(overEvent?.defaultPrevented, false);
      assert.deepEqual(droppedEntries, []);
    });

    await assertTest("WorkspacePanelChrome shows clickable faded child breadcrumbs from the deepest forward history", async () => {
      navigatedPaths.length = 0;
      const parentBreadcrumbs: BreadcrumbItem[] = [
        { id: "C:\\", label: "C:", path: "C:\\" },
        { id: "C:\\Workspace", label: "Workspace", path: "C:\\Workspace" }
      ];

      await act(async () => {
        root.render(
          React.createElement(WorkspacePanelChrome, {
            panelId: "panel-1",
            tabs,
            activeTabId: "panel-1-tab-1",
            breadcrumbs: parentBreadcrumbs,
            history: ["C:\\Workspace", "C:\\Workspace\\Downloads", "C:\\Workspace\\Downloads\\release-candidate"],
            historyIndex: 0,
            onActivateTab: (tabId: string) => activatedTabs.push(tabId),
            onCloseTab: (tabId: string) => closedTabs.push(tabId),
            onMoveTab: recordMovedTab(movedTabs),
            onOpenTabContextMenu: (tabId: string, x: number, y: number) => tabMenus.push({ tabId, x, y }),
            onOpenNewTab: () => {
              openCount += 1;
            },
            onNavigateToPath: (path: string) => navigatedPaths.push(path)
          })
        );
        await flushEffects();
      });

      const breadcrumbButtons = Array.from(container.querySelectorAll(".panel-breadcrumbs__segment"));
      const futureButtons = Array.from(container.querySelectorAll(".panel-breadcrumbs__segment--future")) as HTMLButtonElement[];

      assert.equal(breadcrumbButtons.length, 4);
      assert.deepEqual(breadcrumbButtons.map((button) => button.textContent?.trim()), [
        "C:",
        "Workspace",
        "Downloads",
        "release-candidate"
      ]);
      assert.equal(breadcrumbButtons[1].getAttribute("aria-current"), "page");
      assert.equal(futureButtons.length, 2);
      assert.equal(futureButtons.every((button) => button.getAttribute("aria-current") === null), true);

      await act(async () => {
        futureButtons[1].click();
        await flushEffects();
      });

      assert.deepEqual(navigatedPaths, ["C:\\Workspace\\Downloads\\release-candidate"]);
    });
  } finally {
    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    dom.window.close();
  }
})();


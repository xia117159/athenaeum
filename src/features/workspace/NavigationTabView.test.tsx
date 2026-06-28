import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { ENTRY_DRAG_MIME } from "./entryDrag";
import { NavigationTabView } from "./NavigationTabView";
import { installLegacyInputEventPatch } from "./testDom";
import type { EntryViewModel, NavigationItem, NavigationState } from "./types";
import type { useWorkspaceController } from "./useWorkspaceController";

type WorkspaceActions = ReturnType<typeof useWorkspaceController>["actions"];

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
  globalThis.KeyboardEvent = dom.window.KeyboardEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.PointerEvent = dom.window.PointerEvent ?? (dom.window.MouseEvent as unknown as typeof PointerEvent);
  installLegacyInputEventPatch(dom);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  return dom;
}

async function flushEffects() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createEntry(name: string, path: string, kind: EntryViewModel["kind"] = "file"): EntryViewModel {
  return {
    id: path,
    name,
    kind,
    path,
    parentPath: "C:\\Users\\Admin\\Documents",
    sizeLabel: kind === "folder" ? "--" : "1 KB",
    modifiedLabel: "2026-06-08 09:00",
    extension: kind === "folder" ? "" : ".txt",
    attributes: kind === "folder" ? ["D"] : ["A"],
    accentColor: "#0f6cbd",
    tags: [],
    description: ""
  };
}

function createNavigationState(items: NavigationItem[] = []): NavigationState {
  return {
    items,
    selectedItemIds: items.slice(0, 1).map((item) => item.id),
    filterText: "",
    status: "idle"
  };
}

function getButton(container: HTMLElement, label: string) {
  const button = container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
  assert.ok(button, `missing button ${label}`);
  return button;
}

function createNavigationItem(id: string, path: string, kind: NavigationItem["targetKind"] = "file"): NavigationItem {
  return {
    id,
    displayName: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
    description: "",
    path,
    targetKind: kind,
    targetStatus: "ok",
    sortOrder: 1,
    createdAt: "2026-06-08T09:00:00Z",
    updatedAt: "2026-06-08T09:00:00Z"
  };
}

function createDropEvent(type: string, data: Record<string, string>) {
  const event = new Event(type, {
    bubbles: true,
    cancelable: true
  }) as Event & {
    dataTransfer: {
      dropEffect: string;
      types: string[];
      getData: (type: string) => string;
    };
  };

  Object.defineProperty(event, "dataTransfer", {
    configurable: true,
    value: {
      dropEffect: "none",
      types: Object.keys(data),
      getData: (type: string) => data[type] ?? ""
    }
  });

  return event;
}

function dispatchPointerLikeMouseEvent(target: EventTarget, type: string, clientX: number) {
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      screenX: clientX
    })
  );
}

export const completion = (async () => {
  installDomEnvironment();
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("test root container is missing");
  }

  const root = ReactDOM.createRoot(container);

  try {
    await assertTest("NavigationTabView passes explicit directory context to add actions", async () => {
      const currentFolderAdds: unknown[] = [];
      const selectedEntryAdds: unknown[] = [];
      const selectedEntries = [
        createEntry("report.txt", "C:\\Users\\Admin\\Documents\\report.txt"),
        createEntry("Archive", "C:\\Users\\Admin\\Documents\\Archive", "folder")
      ];
      const actions = {
        addCurrentFolderToNavigation(folder: unknown) {
          currentFolderAdds.push(folder);
        },
        addSelectedEntriesToNavigation(panelId: unknown, entries: unknown) {
          selectedEntryAdds.push({ panelId, entries });
        },
        setNavigationFilter() {},
        saveNavigationItem() {},
        openNavigationItem() {},
        openNavigationItemParent() {},
        deleteNavigationItems() {},
        reorderNavigationItem() {},
        setNavigationSelection() {},
        selectNavigationItem() {},
        refreshNavigationTargets() {},
        openNavigationNativeContextMenu() {
          return Promise.resolve(false);
        }
      } as unknown as WorkspaceActions;

      await act(async () => {
        root.render(
          React.createElement(NavigationTabView, {
            panelId: "panel-1",
            navigation: createNavigationState(),
            currentFolder: {
              displayName: "Documents",
              path: "C:\\Users\\Admin\\Documents"
            },
            selectedEntries,
            actions
          })
        );
        await flushEffects();
      });

      await act(async () => {
        getButton(container, "添加当前文件夹").click();
        getButton(container, "从选中项添加").click();
        await flushEffects();
      });

      assert.deepEqual(currentFolderAdds, [
        {
          displayName: "Documents",
          path: "C:\\Users\\Admin\\Documents"
        }
      ]);
      assert.deepEqual(selectedEntryAdds, [{ panelId: "panel-1", entries: selectedEntries }]);
    });

    await assertTest("NavigationTabView consumes handled shortcuts and keeps F2 to name editing", async () => {
      const deletedSelections: string[][] = [];
      let bubbledKeydowns = 0;
      const item: NavigationItem = {
        id: "nav-report",
        displayName: "Report",
        description: "",
        path: "C:\\Users\\Admin\\Documents\\report.txt",
        targetKind: "file",
        targetStatus: "ok",
        sortOrder: 1,
        createdAt: "2026-06-08T09:00:00Z",
        updatedAt: "2026-06-08T09:00:00Z"
      };
      const actions = {
        setNavigationFilter() {},
        saveNavigationItem() {},
        openNavigationItem() {},
        openNavigationItemParent() {},
        deleteNavigationItems(ids: string[]) {
          deletedSelections.push([...ids]);
        },
        reorderNavigationItem() {},
        setNavigationSelection() {},
        selectNavigationItem() {},
        refreshNavigationTargets() {},
        addCurrentFolderToNavigation() {},
        addSelectedEntriesToNavigation() {},
        openNavigationNativeContextMenu() {
          return Promise.resolve(false);
        }
      } as unknown as WorkspaceActions;

      await act(async () => {
        root.render(
          React.createElement(
            "div",
            {
              onKeyDown: () => {
                bubbledKeydowns += 1;
              }
            },
            React.createElement(NavigationTabView, {
              panelId: "panel-1",
              navigation: createNavigationState([item]),
              selectedEntries: [],
              actions
            })
          )
        );
        await flushEffects();
      });

      const navigationRoot = container.querySelector(".navigation-tab");
      assert.ok(navigationRoot);

      await act(async () => {
        navigationRoot.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Delete" }));
        await flushEffects();
      });

      assert.deepEqual(deletedSelections, [["nav-report"]]);
      assert.equal(bubbledKeydowns, 0);

      await act(async () => {
        navigationRoot.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "F2" }));
        await flushEffects();
      });

      assert.equal(Boolean(container.querySelector('.navigation-editor[aria-label="编辑导航项名称"]')), true);
      assert.equal(Boolean(container.querySelector('.navigation-editor[aria-label="编辑导航项"]')), false);
      assert.equal(bubbledKeydowns, 0);
    });

    await assertTest("NavigationTabView ignores navigation shortcuts from editable child inputs", async () => {
      const calls: string[] = [];
      const item: NavigationItem = {
        id: "nav-report",
        displayName: "Report",
        description: "",
        path: "C:\\Users\\Admin\\Documents\\report.txt",
        targetKind: "file",
        targetStatus: "ok",
        sortOrder: 1,
        createdAt: "2026-06-08T09:00:00Z",
        updatedAt: "2026-06-08T09:00:00Z"
      };
      const actions = {
        setNavigationFilter(value: string) {
          calls.push(`filter:${value}`);
        },
        saveNavigationItem() {
          calls.push("save");
        },
        openNavigationItem() {
          calls.push("open");
        },
        openNavigationItemParent() {
          calls.push("open-parent");
        },
        deleteNavigationItems() {
          calls.push("delete");
        },
        reorderNavigationItem() {
          calls.push("reorder");
        },
        setNavigationSelection() {
          calls.push("select-all");
        },
        selectNavigationItem() {
          calls.push("select");
        },
        refreshNavigationTargets() {
          calls.push("refresh");
        },
        addCurrentFolderToNavigation() {
          calls.push("add-current");
        },
        addSelectedEntriesToNavigation() {
          calls.push("add-selected");
        },
        openNavigationNativeContextMenu() {
          calls.push("native-menu");
          return Promise.resolve(false);
        }
      } as unknown as WorkspaceActions;

      await act(async () => {
        root.render(
          React.createElement(NavigationTabView, {
            panelId: "panel-1",
            navigation: createNavigationState([item]),
            selectedEntries: [],
            actions
          })
        );
        await flushEffects();
      });

      const dispatchEditableKey = async (target: HTMLInputElement, init: KeyboardEventInit) => {
        const event = new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          ...init
        });
        await act(async () => {
          target.dispatchEvent(event);
          await flushEffects();
        });
        assert.equal(event.defaultPrevented, false, `${init.key ?? ""} should keep editable default behavior`);
      };

      const filterInput = container.querySelector<HTMLInputElement>(".navigation-tab__filter input");
      assert.ok(filterInput);
      for (const init of [
        { key: "a", ctrlKey: true },
        { key: "Delete" },
        { key: "Enter" },
        { key: "F2" }
      ]) {
        await dispatchEditableKey(filterInput, init);
      }
      assert.deepEqual(calls, []);
      assert.equal(container.querySelector(".navigation-editor"), null);

      await act(async () => {
        container.querySelector(".navigation-tab")?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "F2" }));
        await flushEffects();
      });
      const editorInput = container.querySelector<HTMLInputElement>(".navigation-editor input");
      assert.ok(editorInput);
      calls.length = 0;

      for (const init of [
        { key: "a", ctrlKey: true },
        { key: "Delete" },
        { key: "Enter" },
        { key: "F2" }
      ]) {
        await dispatchEditableKey(editorInput, init);
      }
      assert.deepEqual(calls, []);
    });

    await assertTest("NavigationTabView closes its context menu on outside pointer and Escape", async () => {
      const item = createNavigationItem("nav-report", "C:\\Users\\Admin\\Documents\\report.txt");
      const actions = {
        setNavigationFilter() {},
        saveNavigationItem() {},
        openNavigationItem() {},
        openNavigationItemParent() {},
        deleteNavigationItems() {},
        reorderNavigationItem() {},
        setNavigationSelection() {},
        selectNavigationItem() {},
        refreshNavigationTargets() {},
        addCurrentFolderToNavigation() {},
        addSelectedEntriesToNavigation() {},
        addPathsToNavigation() {},
        openNavigationNativeContextMenu() {
          return Promise.resolve(false);
        }
      } as unknown as WorkspaceActions;

      await act(async () => {
        root.render(
          React.createElement(NavigationTabView, {
            panelId: "panel-1",
            navigation: createNavigationState([item]),
            selectedEntries: [],
            actions
          })
        );
        await flushEffects();
      });

      const row = container.querySelector<HTMLElement>(".navigation-table__item");
      assert.ok(row);

      await act(async () => {
        row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, shiftKey: true, clientX: 16, clientY: 18 }));
        await flushEffects();
      });
      assert.ok(container.querySelector(".navigation-menu"));

      await act(async () => {
        document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        await flushEffects();
      });
      assert.equal(container.querySelector(".navigation-menu"), null);

      await act(async () => {
        row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, shiftKey: true, clientX: 16, clientY: 18 }));
        await flushEffects();
      });
      assert.ok(container.querySelector(".navigation-menu"));

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
        await flushEffects();
      });
      assert.equal(container.querySelector(".navigation-menu"), null);
    });

    await assertTest("NavigationTabView opens the native menu for a normal right-click on one selected item", async () => {
      const item = createNavigationItem("nav-report", "C:\\Users\\Admin\\Documents\\report.txt");
      const nativeMenus: Array<{ ids: string[]; clientX: number; clientY: number; screenX: number; screenY: number }> = [];
      const actions = {
        setNavigationFilter() {},
        saveNavigationItem() {},
        openNavigationItem() {},
        openNavigationItemParent() {},
        deleteNavigationItems() {},
        reorderNavigationItem() {},
        setNavigationSelection() {},
        selectNavigationItem() {},
        refreshNavigationTargets() {},
        addCurrentFolderToNavigation() {},
        addSelectedEntriesToNavigation() {},
        addPathsToNavigation() {},
        openNavigationNativeContextMenu(ids: string[], clientX: number, clientY: number, screenX: number, screenY: number) {
          nativeMenus.push({ ids: [...ids], clientX, clientY, screenX, screenY });
          return Promise.resolve(true);
        }
      } as unknown as WorkspaceActions;

      await act(async () => {
        root.render(
          React.createElement(NavigationTabView, {
            panelId: "panel-1",
            navigation: createNavigationState([item]),
            selectedEntries: [],
            actions
          })
        );
        await flushEffects();
      });

      const row = container.querySelector<HTMLElement>(".navigation-table__item");
      assert.ok(row);

      await act(async () => {
        row.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 16,
            clientY: 18,
            screenX: 116,
            screenY: 118
          })
        );
        await flushEffects();
      });

      assert.deepEqual(nativeMenus, [
        {
          ids: ["nav-report"],
          clientX: 16,
          clientY: 18,
          screenX: 116,
          screenY: 118
        }
      ]);
      assert.equal(container.querySelector(".navigation-menu"), null);
    });

    await assertTest("NavigationTabView uses its custom menu for Shift right-clicks", async () => {
      const item = createNavigationItem("nav-report", "C:\\Users\\Admin\\Documents\\report.txt");
      const nativeMenus: string[][] = [];
      const actions = {
        setNavigationFilter() {},
        saveNavigationItem() {},
        openNavigationItem() {},
        openNavigationItemParent() {},
        deleteNavigationItems() {},
        reorderNavigationItem() {},
        setNavigationSelection() {},
        selectNavigationItem() {},
        refreshNavigationTargets() {},
        addCurrentFolderToNavigation() {},
        addSelectedEntriesToNavigation() {},
        addPathsToNavigation() {},
        openNavigationNativeContextMenu(ids: string[]) {
          nativeMenus.push([...ids]);
          return Promise.resolve(true);
        }
      } as unknown as WorkspaceActions;

      await act(async () => {
        root.render(
          React.createElement(NavigationTabView, {
            panelId: "panel-1",
            navigation: createNavigationState([item]),
            selectedEntries: [],
            actions
          })
        );
        await flushEffects();
      });

      const row = container.querySelector<HTMLElement>(".navigation-table__item");
      assert.ok(row);

      await act(async () => {
        row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, shiftKey: true, clientX: 16, clientY: 18 }));
        await flushEffects();
      });

      assert.deepEqual(nativeMenus, []);
      assert.ok(container.querySelector(".navigation-menu"));
    });

    await assertTest("NavigationTabView keeps multi-selection on the custom menu and disables native file operations", async () => {
      const items = [
        createNavigationItem("nav-report", "C:\\Users\\Admin\\Documents\\report.txt"),
        createNavigationItem("nav-archive", "C:\\Users\\Admin\\Documents\\Archive", "folder")
      ];
      const nativeMenus: string[][] = [];
      const selections: string[][] = [];
      const actions = {
        setNavigationFilter() {},
        saveNavigationItem() {},
        openNavigationItem() {},
        openNavigationItemParent() {},
        deleteNavigationItems() {},
        reorderNavigationItem() {},
        setNavigationSelection(ids: string[]) {
          selections.push([...ids]);
        },
        selectNavigationItem() {},
        refreshNavigationTargets() {},
        addCurrentFolderToNavigation() {},
        addSelectedEntriesToNavigation() {},
        addPathsToNavigation() {},
        openNavigationNativeContextMenu(ids: string[]) {
          nativeMenus.push([...ids]);
          return Promise.resolve(true);
        }
      } as unknown as WorkspaceActions;

      await act(async () => {
        root.render(
          React.createElement(NavigationTabView, {
            panelId: "panel-1",
            navigation: {
              ...createNavigationState(items),
              selectedItemIds: items.map((item) => item.id)
            },
            selectedEntries: [],
            actions
          })
        );
        await flushEffects();
      });

      const rows = Array.from(container.querySelectorAll<HTMLElement>(".navigation-table__item"));
      assert.ok(rows[1]);

      await act(async () => {
        rows[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 24 }));
        await flushEffects();
      });

      const nativeButton = Array.from(container.querySelectorAll<HTMLButtonElement>(".navigation-menu button")).find((button) =>
        button.textContent?.includes("Windows")
      );
      assert.ok(nativeButton);
      assert.equal(nativeButton.disabled, true);
      assert.deepEqual(nativeMenus, []);
      assert.deepEqual(selections, []);
    });

    await assertTest("NavigationTabView materializes resizable fixed column tracks", async () => {
      const item = createNavigationItem("nav-report", "C:\\Users\\Admin\\Documents\\report.txt");
      const actions = {
        setNavigationFilter() {},
        saveNavigationItem() {},
        openNavigationItem() {},
        openNavigationItemParent() {},
        deleteNavigationItems() {},
        reorderNavigationItem() {},
        setNavigationSelection() {},
        selectNavigationItem() {},
        refreshNavigationTargets() {},
        addCurrentFolderToNavigation() {},
        addSelectedEntriesToNavigation() {},
        addPathsToNavigation() {},
        openNavigationNativeContextMenu() {
          return Promise.resolve(false);
        }
      } as unknown as WorkspaceActions;

      await act(async () => {
        root.render(
          React.createElement(NavigationTabView, {
            panelId: "panel-1",
            navigation: createNavigationState([item]),
            selectedEntries: [],
            actions
          })
        );
        await flushEffects();
      });

      const header = container.querySelector<HTMLElement>(".navigation-table__row--header");
      const row = container.querySelector<HTMLElement>(".navigation-table__item");
      const resizeHandles = Array.from(container.querySelectorAll(".navigation-header-resizer"));
      const tableInFillRow = container.querySelector(".navigation-tab__content > .navigation-tab__editor-slot + .navigation-table");
      assert.ok(tableInFillRow);
      assert.ok(header);
      assert.ok(row);
      assert.equal(resizeHandles.length, 6);
      assert.doesNotMatch(header.style.gridTemplateColumns, /fr/);
      assert.equal(row.style.gridTemplateColumns, header.style.gridTemplateColumns);

      const firstHeaderCell = resizeHandles[0].closest(".navigation-header-cell") as HTMLElement | null;
      assert.ok(firstHeaderCell);
      firstHeaderCell.getBoundingClientRect = () =>
        ({
          width: 240,
          height: 24,
          top: 0,
          right: 240,
          bottom: 24,
          left: 0,
          x: 0,
          y: 0,
          toJSON: () => ({})
        }) as DOMRect;

      await act(async () => {
        dispatchPointerLikeMouseEvent(resizeHandles[0], "mousedown", 240);
        dispatchPointerLikeMouseEvent(window, "mousemove", 312);
        dispatchPointerLikeMouseEvent(window, "mouseup", 312);
        await flushEffects();
      });

      assert.match(header.style.gridTemplateColumns, /^312px\s+\d+px\s+\d+px\s+\d+px\s+\d+px\s+\d+px$/);
      assert.equal(row.style.gridTemplateColumns, header.style.gridTemplateColumns);
      assert.equal(row.style.width, header.style.width);
    });

    await assertTest("NavigationTabView opens a column header menu with a comment column instead of description", async () => {
      const item = {
        ...createNavigationItem("nav-report", "C:\\Users\\Admin\\Documents\\report.txt"),
        description: "release note"
      };
      const actions = {
        setNavigationFilter() {},
        saveNavigationItem() {},
        openNavigationItem() {},
        openNavigationItemParent() {},
        deleteNavigationItems() {},
        reorderNavigationItem() {},
        setNavigationSelection() {},
        selectNavigationItem() {},
        refreshNavigationTargets() {},
        addCurrentFolderToNavigation() {},
        addSelectedEntriesToNavigation() {},
        addPathsToNavigation() {},
        openNavigationNativeContextMenu() {
          return Promise.resolve(false);
        }
      } as unknown as WorkspaceActions;

      await act(async () => {
        root.render(
          React.createElement(NavigationTabView, {
            panelId: "panel-1",
            navigation: createNavigationState([item]),
            selectedEntries: [],
            actions
          })
        );
        await flushEffects();
      });

      const header = container.querySelector<HTMLElement>(".navigation-table__row--header");
      assert.ok(header);
      assert.equal(container.querySelector('[data-navigation-column-id="description"]'), null);
      assert.ok(container.querySelector('[data-navigation-column-id="comment"]'));
      assert.ok(container.querySelector('[data-navigation-cell-id="comment"]'));

      await act(async () => {
        header.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 80, clientY: 34 }));
        await flushEffects();
      });

      const menu = container.querySelector(".column-header-menu") as HTMLElement | null;
      assert.ok(menu);
      assert.equal(menu.textContent?.includes("\u6ce8\u91ca"), true);
      assert.equal(menu.textContent?.includes("\u63cf\u8ff0"), false);
    });

    await assertTest("NavigationTabView adds dropped entry-drag payload paths to navigation", async () => {
      const addedPaths: string[][] = [];
      const savedPaths: string[] = [];
      const actions = {
        setNavigationFilter() {},
        saveNavigationItem(item: { path: string }) {
          savedPaths.push(item.path);
        },
        openNavigationItem() {},
        openNavigationItemParent() {},
        deleteNavigationItems() {},
        reorderNavigationItem() {},
        setNavigationSelection() {},
        selectNavigationItem() {},
        refreshNavigationTargets() {},
        addCurrentFolderToNavigation() {},
        addSelectedEntriesToNavigation() {},
        addPathsToNavigation(paths: string[]) {
          addedPaths.push([...paths]);
        },
        openNavigationNativeContextMenu() {
          return Promise.resolve(false);
        }
      } as unknown as WorkspaceActions;

      await act(async () => {
        root.render(
          React.createElement(NavigationTabView, {
            panelId: "panel-1",
            navigation: createNavigationState(),
            selectedEntries: [],
            actions
          })
        );
        await flushEffects();
      });

      const navigationRoot = container.querySelector<HTMLElement>(".navigation-tab");
      assert.ok(navigationRoot);
      const payload = {
        sourcePanelId: "panel-1",
        sourceTabId: "panel-1-tab-1",
        paths: ["C:\\Users\\Admin\\Documents\\report.txt", "D:\\Archive"]
      };

      await act(async () => {
        const dragOver = createDropEvent("dragover", {
          [ENTRY_DRAG_MIME]: JSON.stringify(payload)
        });
        navigationRoot.dispatchEvent(dragOver);
        assert.equal(dragOver.defaultPrevented, true);
        const drop = createDropEvent("drop", {
          [ENTRY_DRAG_MIME]: JSON.stringify(payload)
        });
        navigationRoot.dispatchEvent(drop);
        await flushEffects();
      });

      assert.deepEqual(addedPaths, [["C:\\Users\\Admin\\Documents\\report.txt", "D:\\Archive"]]);
      assert.deepEqual(savedPaths, []);
    });
  } finally {
    await act(async () => {
      root.unmount();
      await flushEffects();
    });
  }
})();

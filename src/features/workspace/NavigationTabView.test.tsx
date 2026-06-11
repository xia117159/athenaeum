import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { NavigationTabView } from "./NavigationTabView";
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
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    configurable: true,
    value: () => undefined
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    value: () => undefined
  });
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
  } finally {
    await act(async () => {
      root.unmount();
      await flushEffects();
    });
  }
})();

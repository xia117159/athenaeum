import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { WorkspaceInformationPanel } from "./WorkspaceInformationPanel";
import type { EntryViewModel, WorkspaceState } from "./types";

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
  globalThis.KeyboardEvent = dom.window.KeyboardEvent;
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

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  if (valueSetter) {
    valueSetter.call(input, value);
    return;
  }
  input.value = value;
}

function createEntry(name: string, sizeLabel: string, kind: EntryViewModel["kind"] = "file"): EntryViewModel {
  return {
    id: `D:\\Workspace:${name}`,
    name,
    kind,
    path: `D:\\Workspace\\${name}`,
    parentPath: "D:\\Workspace",
    sizeLabel,
    modifiedLabel: "2026-06-07 10:00",
    extension: kind === "file" && name.includes(".") ? `.${name.split(".").pop()}` : "",
    attributes: kind === "folder" ? ["D"] : ["A"],
    accentColor: "#0f6cbd",
    tags: [],
    description: name
  };
}

const searchState: WorkspaceState["search"] = {
  open: true,
  loading: false,
  filterText: "report",
  query: {
    name: "",
    content: "void",
    nameMode: "normal",
    contentMode: "regex",
    extensionFilterText: "",
    extensionFilterMode: "include",
    includeFolders: false,
    recursive: true,
    caseSensitive: true,
    scope: "active-panel"
  },
  activeTab: "content",
  histories: {
    name: ["report", "archive"],
    content: ["void", "warning", "error"]
  },
  results: [],
  history: ["void", "warning", "error"],
  selectedHistoryIndex: 1,
  progress: {
    searchId: "search-1",
    scannedEntries: 180,
    matchedEntries: 4,
    cancelled: false,
    statusText: "已扫描 180 项，匹配 4 项"
  }
};

export const completion = (async () => {
  const dom = installDomEnvironment();
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("test root container is missing");
  }

  const root = ReactDOM.createRoot(container);
  const queryUpdates: Array<Partial<WorkspaceState["search"]["query"]>> = [];
  const filterUpdates: string[] = [];
  const selectedHistory: number[] = [];
  const deletedHistory: number[] = [];
  let runCount = 0;
  let stopCount = 0;
  let closeCount = 0;

  const createPanelProps = (search: WorkspaceState["search"] = searchState) => ({
    search,
    activeEntries: [createEntry("report.txt", "2 KB"), createEntry("src", "--", "folder")],
    selectedEntries: [createEntry("report.txt", "2 KB")],
    onToggle: (open: boolean) => {
      if (!open) {
        closeCount += 1;
      }
    },
    onRunSearch: () => {
      runCount += 1;
    },
    onStopSearch: () => {
      stopCount += 1;
    },
    onSelectSearchTab: (tab: WorkspaceState["search"]["activeTab"]) => {
      queryUpdates.push({ name: `tab:${tab}` });
    },
    onUpdateQuery: (payload: Partial<WorkspaceState["search"]["query"]>) => {
      queryUpdates.push(payload);
    },
    onUpdateFilter: (value: string) => {
      filterUpdates.push(value);
    },
    onSelectHistory: (index: number) => {
      selectedHistory.push(index);
    },
    onDeleteHistory: (index: number) => {
      deletedHistory.push(index);
    }
  });

  try {
    await assertTest("WorkspaceInformationPanel renders the content tab as three columns with Chinese labels", async () => {
      await act(async () => {
        root.render(
          React.createElement(WorkspaceInformationPanel, {
            ...createPanelProps()
          })
        );
        await flushEffects();
      });

      assert.ok(container.querySelector(".information-panel"));
      assert.equal(container.querySelector<HTMLInputElement>(".information-panel__filter input")?.value, "report");
      assert.equal(container.textContent?.includes("输入或粘贴要查找的文件的部分内容"), true);
      assert.equal(container.querySelector<HTMLTextAreaElement>(".information-panel__content-input")?.value, "void");
      assert.equal(container.querySelector<HTMLSelectElement>("#info-content-mode")?.value, "regex");
      assert.equal(container.querySelector<HTMLInputElement>("#info-case-sensitive")?.checked, true);
      assert.equal(container.querySelector<HTMLInputElement>("#info-recursive-search")?.checked, true);
      assert.equal(container.querySelectorAll(".information-panel__tab").length, 7);
      assert.equal(container.querySelector(".information-panel__tab.is-active")?.textContent?.trim(), "内容");
      assert.equal(container.querySelector(".information-panel__progress")?.textContent?.includes("已扫描 180 项"), true);
      assert.equal(container.querySelector(".information-panel__scope"), null);
      assert.equal(container.textContent?.includes("内容查找"), false);
      assert.equal(container.textContent?.includes("D:\\Workspace"), false);
      assert.equal(container.querySelectorAll(".information-panel__history-item").length, 3);
    });

    await assertTest("WorkspaceInformationPanel updates content, toggles recursive search, selects history, deletes selected history, and runs search", async () => {
      const contentInput = container.querySelector<HTMLTextAreaElement>(".information-panel__content-input");
      assert.ok(contentInput);
      await act(async () => {
        setInputValue(contentInput, "warning");
        contentInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        await flushEffects();
      });

      const recursiveInput = container.querySelector<HTMLInputElement>("#info-recursive-search");
      assert.ok(recursiveInput);
      await act(async () => {
        recursiveInput.click();
        await flushEffects();
      });

      const filterInput = container.querySelector<HTMLInputElement>(".information-panel__filter input");
      assert.ok(filterInput);
      await act(async () => {
        setInputValue(filterInput, "error");
        filterInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        await flushEffects();
      });

      const historyItems = Array.from(container.querySelectorAll<HTMLButtonElement>(".information-panel__history-item"));
      await act(async () => {
        historyItems[2].click();
        await flushEffects();
      });

      const historyList = container.querySelector<HTMLDivElement>(".information-panel__history");
      assert.ok(historyList);
      await act(async () => {
        historyList.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
        await flushEffects();
      });

      const searchButton = container.querySelector<HTMLButtonElement>(".information-panel__run");
      assert.ok(searchButton);
      await act(async () => {
        searchButton.click();
        await flushEffects();
      });

      assert.deepEqual(queryUpdates.at(-2), { content: "warning" });
      assert.deepEqual(queryUpdates.at(-1), { recursive: false });
      assert.equal(filterUpdates.at(-1), "error");
      assert.deepEqual(selectedHistory, [2]);
      assert.deepEqual(deletedHistory, [1]);
      assert.equal(runCount, 1);
    });

    await assertTest("WorkspaceInformationPanel switches the search action to stop while a search is running", async () => {
      await act(async () => {
        root.render(
          React.createElement(WorkspaceInformationPanel, {
            ...createPanelProps({
              ...searchState,
              loading: true,
              progress: {
                searchId: "search-active",
                scannedEntries: 260,
                matchedEntries: 12,
                cancelled: false,
                statusText: "正在搜索..."
              }
            }),
            selectedEntries: []
          })
        );
        await flushEffects();
      });

      const searchButton = container.querySelector<HTMLButtonElement>(".information-panel__run");
      assert.ok(searchButton);
      assert.equal(searchButton.textContent?.includes("停止搜索"), true);
      assert.equal(searchButton.disabled, false);
      const runCountBeforeStop = runCount;

      await act(async () => {
        searchButton.click();
        await flushEffects();
      });

      assert.equal(stopCount, 1);
      assert.equal(runCount, runCountBeforeStop);
    });

    await assertTest("WorkspaceInformationPanel renders the name tab with independent history, recursive search, and extension filters", async () => {
      await act(async () => {
        root.render(
          React.createElement(WorkspaceInformationPanel, {
            ...createPanelProps({
              ...searchState,
              activeTab: "name",
              history: ["report", "archive"],
              selectedHistoryIndex: 0,
              query: {
                ...searchState.query,
                name: "report",
                nameMode: "wildcard",
                extensionFilterText: "ts;tsx",
                extensionFilterMode: "exclude",
                includeFolders: true,
                recursive: false
              }
            }),
            selectedEntries: []
          })
        );
        await flushEffects();
      });

      assert.equal(container.querySelector(".information-panel__tab.is-active")?.textContent?.trim(), "名称和位置");
      assert.equal(container.querySelector<HTMLTextAreaElement>(".information-panel__content-input")?.value, "report");
      assert.equal(container.querySelector<HTMLSelectElement>("#info-name-mode")?.value, "wildcard");
      assert.equal(container.querySelector<HTMLInputElement>("#info-recursive-search")?.checked, false);
      assert.equal(container.querySelector<HTMLInputElement>("#info-include-folders")?.checked, true);
      assert.equal(container.querySelector<HTMLInputElement>("#info-extension-filter")?.value, "ts;tsx");
      assert.equal(container.querySelector<HTMLSelectElement>("#info-extension-filter-mode")?.value, "exclude");
      assert.equal(container.querySelectorAll(".information-panel__history-item").length, 2);

      const nameInput = container.querySelector<HTMLTextAreaElement>(".information-panel__content-input");
      assert.ok(nameInput);
      await act(async () => {
        setInputValue(nameInput, "release");
        nameInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        await flushEffects();
      });

      const includeFolders = container.querySelector<HTMLInputElement>("#info-include-folders");
      assert.ok(includeFolders);
      await act(async () => {
        includeFolders.click();
        await flushEffects();
      });

      const recursiveInput = container.querySelector<HTMLInputElement>("#info-recursive-search");
      assert.ok(recursiveInput);
      await act(async () => {
        recursiveInput.click();
        await flushEffects();
      });

      assert.deepEqual(queryUpdates.at(-3), { name: "release" });
      assert.deepEqual(queryUpdates.at(-2), { includeFolders: false });
      assert.deepEqual(queryUpdates.at(-1), { recursive: true });
    });

    await assertTest("workspace information panel styles define three internal content-search zones", async () => {
      const css = fs.readFileSync(path.join(process.cwd(), "src/features/workspace/workspace.css"), "utf8");
      assert.equal(css.includes(".information-panel__content-search"), true);
      assert.equal(css.includes(".information-panel__content-editor"), true);
      assert.equal(css.includes(".information-panel__content-label"), true);
      assert.equal(css.includes(".information-panel__extension-filter"), true);
      assert.equal(css.includes(".information-panel__actions"), true);
      assert.equal(css.includes("grid-auto-rows: max-content;"), true);
      assert.equal(css.includes(".information-panel__actions {\n  display: grid;\n  grid-template-rows: none;"), true);
      assert.equal(css.includes(".information-panel__actions {\n  display: grid;\n  grid-template-rows: auto auto auto auto minmax(0, 1fr);"), false);
      assert.equal(css.includes("gap: 3px;"), true);
      assert.equal(css.includes("min-height: 18px;"), true);
      assert.equal(css.includes(".information-panel__history"), true);
      assert.equal(css.includes(".information-panel__scope"), false);
      assert.equal(css.includes(".workspace-main__content--with-info"), false);
    });
  } finally {
    assert.equal(closeCount, 0);
    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    dom.window.close();
  }
})();

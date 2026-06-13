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
  const selectedInformationTabs: WorkspaceState["informationPanel"]["activeTab"][] = [];
  const openedHistory: boolean[] = [];
  let runCount = 0;
  let stopCount = 0;
  let closeCount = 0;

  const createPanelProps = (
    search: WorkspaceState["search"] = searchState,
    informationPanelOverrides: Partial<WorkspaceState["informationPanel"]> = {}
  ) => ({
    informationPanel: {
      expanded: true,
      activeTab: "search",
      properties: {
        status: "idle"
      },
      ...informationPanelOverrides
    } satisfies WorkspaceState["informationPanel"],
    search,
    operations: {
      tasksOpen: false,
      tasks: [],
      taskSequence: 0,
      history: [],
      historySequence: 0
    } satisfies WorkspaceState["operations"],
    activeEntries: [createEntry("report.txt", "2 KB"), createEntry("src", "--", "folder")],
    selectedEntries: [createEntry("report.txt", "2 KB")],
    onToggleExpanded: (expanded: boolean) => {
      if (!expanded) {
        closeCount += 1;
      }
    },
    onSelectInformationTab: (tab: WorkspaceState["informationPanel"]["activeTab"]) => {
      selectedInformationTabs.push(tab);
    },
    onOpenHistory: () => {
      openedHistory.push(true);
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
    },
    onCancelTask: () => undefined,
    onUndoLatest: () => undefined,
    onUndoRecord: () => undefined
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

    await assertTest("WorkspaceInformationPanel keeps the summary bar while collapsed", async () => {
      await act(async () => {
        root.render(
          React.createElement(WorkspaceInformationPanel, {
            ...createPanelProps(searchState, {
              expanded: false,
              activeTab: "properties"
            })
          })
        );
        await flushEffects();
      });

      assert.ok(container.querySelector(".information-panel.is-collapsed"));
      assert.ok(container.querySelector(".information-panel__summary"));
      assert.equal(container.querySelector(".information-panel__content-shell"), null);
      assert.equal(container.querySelector<HTMLInputElement>(".information-panel__filter input")?.value, "report");
      assert.equal(container.querySelector<HTMLButtonElement>(".operation-summary-button")?.nextElementSibling?.className, "information-panel__collapse-toggle");
    });

    await assertTest("WorkspaceInformationPanel places the summary bar above expanded panel content", async () => {
      await act(async () => {
        root.render(
          React.createElement(WorkspaceInformationPanel, {
            ...createPanelProps(searchState, {
              expanded: true,
              activeTab: "properties"
            })
          })
        );
        await flushEffects();
      });

      const panel = container.querySelector(".information-panel");
      assert.ok(panel);
      const directChildren = Array.from(panel.children);
      assert.equal(directChildren[0]?.classList.contains("information-panel__summary"), true);
      assert.equal(directChildren[1]?.classList.contains("information-panel__content-shell"), true);
    });

    await assertTest("WorkspaceInformationPanel renders top tabs and keeps keyboard focus on the selected tab", async () => {
      let activeTab: WorkspaceState["informationPanel"]["activeTab"] = "properties";
      const renderWithActiveTab = async () => {
        await act(async () => {
          root.render(
            React.createElement(WorkspaceInformationPanel, {
              ...createPanelProps(searchState, {
                expanded: true,
                activeTab
              }),
              onSelectInformationTab: (tab: WorkspaceState["informationPanel"]["activeTab"]) => {
                selectedInformationTabs.push(tab);
                activeTab = tab;
                void renderWithActiveTab();
              }
            })
          );
          await flushEffects();
        });
      };

      await renderWithActiveTab();
      const tabs = () => Array.from(container.querySelectorAll<HTMLButtonElement>(".information-panel__top-tab"));
      assert.deepEqual(tabs().map((tab) => tab.textContent?.trim()), ["属性", "查找", "操作历史"]);

      tabs()[0].focus();
      await act(async () => {
        tabs()[0].dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        await flushEffects();
      });
      assert.equal(document.activeElement, tabs()[1]);
      assert.equal(tabs()[1].getAttribute("aria-selected"), "true");

      await act(async () => {
        tabs()[1].dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
        await flushEffects();
      });
      assert.equal(document.activeElement, tabs()[2]);
      assert.equal(tabs()[2].getAttribute("aria-selected"), "true");

      await act(async () => {
        tabs()[2].dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Home", bubbles: true }));
        await flushEffects();
      });
      assert.equal(document.activeElement, tabs()[0]);
      assert.equal(tabs()[0].getAttribute("aria-selected"), "true");
      assert.deepEqual(selectedInformationTabs.slice(-3), ["search", "history", "properties"]);
    });

    await assertTest("WorkspaceInformationPanel opens operation history from the summary button and renders history tab content", async () => {
      await act(async () => {
        root.render(
          React.createElement(WorkspaceInformationPanel, {
            ...createPanelProps(searchState, {
              expanded: true,
              activeTab: "history"
            }),
            operations: {
              tasksOpen: false,
              tasks: [
                {
                  taskId: "task-running",
                  requestId: "request-running",
                  kind: "copy",
                  label: "复制项目",
                  status: "running",
                  createdAt: "2026-06-10T08:00:00.000Z",
                  startedAt: "2026-06-10T08:00:00.000Z",
                  finishedAt: null,
                  totalEntries: 3,
                  completedEntries: 1,
                  failedEntries: 0,
                  totalBytes: null,
                  completedBytes: null,
                  currentPath: "D:\\Workspace\\report.txt",
                  message: null,
                  cancelable: true,
                  undoable: false,
                  affectedRoots: [{ kind: "local", path: "D:\\Workspace" }],
                  entryResults: [],
                  sequence: 1,
                  updatedAt: "2026-06-10T08:00:00.000Z"
                }
              ],
              taskSequence: 1,
              history: [],
              historySequence: 0
            }
          })
        );
        await flushEffects();
      });

      const historyButton = container.querySelector<HTMLButtonElement>(".operation-summary-button");
      assert.ok(historyButton);
      assert.equal(historyButton.getAttribute("aria-label"), "打开操作历史");
      await act(async () => {
        historyButton.click();
        await flushEffects();
      });

      assert.equal(openedHistory.length > 0, true);
      assert.ok(container.querySelector(".operation-history-panel"));
      assert.equal(container.textContent?.includes("进行中"), true);
      assert.equal(container.textContent?.includes("操作历史"), true);
    });

    await assertTest("WorkspaceInformationPanel shows loading and failed properties states without successful fallback rows", async () => {
      const selectedFile = { ...createEntry("report.txt", "2 KB"), sizeBytes: 2048 };
      await act(async () => {
        root.render(
          React.createElement(WorkspaceInformationPanel, {
            ...createPanelProps(searchState, {
              expanded: true,
              activeTab: "properties",
              properties: {
                status: "loading",
                requestId: "properties-loading",
                targetKey: `single:${selectedFile.path}`
              }
            }),
            selectedEntries: [selectedFile]
          })
        );
        await flushEffects();
      });

      let panel = container.querySelector(".properties-panel");
      assert.ok(panel);
      assert.equal(panel.textContent?.includes("正在读取属性"), true);
      assert.equal(panel.textContent?.includes("2 KB"), false);

      await act(async () => {
        root.render(
          React.createElement(WorkspaceInformationPanel, {
            ...createPanelProps(searchState, {
              expanded: true,
              activeTab: "properties",
              properties: {
                status: "failed",
                requestId: "properties-failed",
                targetKey: `single:${selectedFile.path}`,
                errorMessage: "远程凭据无效"
              }
            }),
            selectedEntries: [selectedFile]
          })
        );
        await flushEffects();
      });

      panel = container.querySelector(".properties-panel");
      assert.ok(panel);
      assert.equal(panel.textContent?.includes("无法读取属性"), true);
      assert.equal(panel.textContent?.includes("远程凭据无效"), true);
      assert.equal(panel.textContent?.includes("2 KB"), false);
    });

    await assertTest("WorkspaceInformationPanel shows current-folder property failures when nothing is selected", async () => {
      await act(async () => {
        root.render(
          React.createElement(WorkspaceInformationPanel, {
            ...createPanelProps(searchState, {
              expanded: true,
              activeTab: "properties",
              properties: {
                status: "failed",
                requestId: "properties-folder-failed",
                targetKey: "single:D:\\Workspace",
                errorMessage: "没有访问权限"
              }
            }),
            selectedEntries: []
          })
        );
        await flushEffects();
      });

      const panel = container.querySelector(".properties-panel");
      assert.ok(panel);
      assert.equal(panel.textContent?.includes("无法读取属性"), true);
      assert.equal(panel.textContent?.includes("没有访问权限"), true);
      assert.equal(panel.textContent?.includes("当前文件夹"), false);
    });

    await assertTest("WorkspaceInformationPanel renders directory size state instead of treating null directory size as unavailable", async () => {
      const folderEntry = { ...createEntry("src", "--", "folder"), sizeBytes: null };
      await act(async () => {
        root.render(
          React.createElement(WorkspaceInformationPanel, {
            ...createPanelProps(searchState, {
              expanded: true,
              activeTab: "properties",
              properties: {
                status: "ready",
                item: {
                  requestId: "properties-folder",
                  target: { kind: "local", path: folderEntry.path },
                  displayPath: folderEntry.path,
                  actualPath: folderEntry.path,
                  parentPath: folderEntry.parentPath,
                  name: folderEntry.name,
                  extension: null,
                  kind: "folder",
                  sizeBytes: null,
                  allocatedBytes: null,
                  createdAt: null,
                  modifiedAt: null,
                  accessedAt: null,
                  isHidden: false,
                  isReadOnly: false,
                  isSymlink: false,
                  directorySizeState: {
                    state: "notComputed"
                  },
                  fieldStates: [],
                  errorMessage: null
                }
              }
            }),
            selectedEntries: [folderEntry]
          })
        );
        await flushEffects();
      });

      assert.equal(container.textContent?.includes("未计算"), true);
    });

    await assertTest("WorkspaceInformationPanel keeps zero-byte file size distinct from unavailable size", async () => {
      const zeroFile = { ...createEntry("empty.txt", "0 B"), sizeBytes: 0 };
      await act(async () => {
        root.render(
          React.createElement(WorkspaceInformationPanel, {
            ...createPanelProps(searchState, {
              expanded: true,
              activeTab: "properties",
              properties: {
                status: "ready",
                item: {
                  requestId: "properties-empty",
                  target: { kind: "local", path: zeroFile.path },
                  displayPath: zeroFile.path,
                  actualPath: zeroFile.path,
                  parentPath: zeroFile.parentPath,
                  name: zeroFile.name,
                  extension: ".txt",
                  kind: "file",
                  sizeBytes: 0,
                  allocatedBytes: null,
                  createdAt: null,
                  modifiedAt: null,
                  accessedAt: null,
                  isHidden: false,
                  isReadOnly: false,
                  isSymlink: false,
                  directorySizeState: {
                    state: "notApplicable"
                  },
                  fieldStates: [],
                  errorMessage: null
                }
              }
            }),
            selectedEntries: [zeroFile]
          })
        );
        await flushEffects();
      });

      assert.equal(container.textContent?.includes("0 B"), true);
    });

    await assertTest("WorkspaceInformationPanel uses the multi-selection summary common extension", async () => {
      const txtFile = { ...createEntry("report.txt", "2 KB"), extension: ".txt", sizeBytes: 2048 };
      const folderEntry = { ...createEntry("src", "--", "folder"), extension: "", sizeBytes: null };
      const noExtensionFile = { ...createEntry("README", "1 KB"), extension: "", sizeBytes: 1024 };

      await act(async () => {
        root.render(
          React.createElement(WorkspaceInformationPanel, {
            ...createPanelProps(searchState, {
              expanded: true,
              activeTab: "properties",
              properties: {
                status: "ready",
                summary: {
                  selectionKey: `${txtFile.id}|${folderEntry.id}`,
                  count: 2,
                  knownSizeBytes: 2048,
                  unknownSizeCount: 1,
                  directoryCount: 1,
                  commonParentPath: "D:\\Workspace",
                  commonExtension: undefined,
                  fieldStates: []
                }
              }
            }),
            selectedEntries: [txtFile, folderEntry]
          })
        );
        await flushEffects();
      });

      let rows = Array.from(container.querySelectorAll(".properties-panel__row"));
      assert.equal(rows[2]?.textContent?.includes(".txt"), false);

      await act(async () => {
        root.render(
          React.createElement(WorkspaceInformationPanel, {
            ...createPanelProps(searchState, {
              expanded: true,
              activeTab: "properties",
              properties: {
                status: "ready",
                summary: {
                  selectionKey: `${txtFile.id}|${noExtensionFile.id}`,
                  count: 2,
                  knownSizeBytes: 3072,
                  unknownSizeCount: 0,
                  directoryCount: 0,
                  commonParentPath: "D:\\Workspace",
                  commonExtension: undefined,
                  fieldStates: []
                }
              }
            }),
            selectedEntries: [txtFile, noExtensionFile]
          })
        );
        await flushEffects();
      });

      rows = Array.from(container.querySelectorAll(".properties-panel__row"));
      assert.equal(rows[2]?.textContent?.includes(".txt"), false);

      await act(async () => {
        root.render(
          React.createElement(WorkspaceInformationPanel, {
            ...createPanelProps(searchState, {
              expanded: true,
              activeTab: "properties",
              properties: {
                status: "ready",
                summary: {
                  selectionKey: "txt-files",
                  count: 2,
                  knownSizeBytes: 4096,
                  unknownSizeCount: 0,
                  directoryCount: 0,
                  commonParentPath: "D:\\Workspace",
                  commonExtension: ".txt",
                  fieldStates: []
                }
              }
            }),
            selectedEntries: [txtFile, { ...txtFile, id: "notes", name: "notes.txt", path: "D:\\Workspace\\notes.txt" }]
          })
        );
        await flushEffects();
      });

      rows = Array.from(container.querySelectorAll(".properties-panel__row"));
      assert.equal(rows[2]?.textContent?.includes(".txt"), true);
    });

    await assertTest("workspace information panel styles define the shell, tabs, and compact summary bar", async () => {
      const css = fs.readFileSync(path.join(process.cwd(), "src/features/workspace/workspace.css"), "utf8");
      assert.equal(css.includes(".workspace-main__right--with-summary"), true);
      assert.equal(css.includes(".information-panel__content-shell"), true);
      assert.equal(css.includes(".information-panel__top-tabs"), true);
      assert.equal(css.includes(".information-panel__top-tab"), true);
      assert.equal(css.includes(".information-panel__content-search"), true);
      assert.equal(css.includes(".information-panel__content-editor"), true);
      assert.equal(css.includes(".information-panel__content-label"), true);
      assert.equal(css.includes(".information-panel__extension-filter"), true);
      assert.equal(css.includes(".information-panel__actions"), true);
      assert.equal(css.includes("grid-auto-rows: max-content;"), true);
      assert.equal(css.includes("grid-template-rows: none;"), true);
      assert.equal(css.includes(".information-panel__actions {\n  display: grid;\n  grid-template-rows: auto auto auto auto minmax(0, 1fr);"), false);
      assert.equal(css.includes(".properties-panel__grid"), true);
      assert.equal(css.includes(".operation-history-panel"), true);
      assert.equal(css.includes("max-height: 30px;"), true);
      assert.equal(css.includes("gap: 3px;"), true);
      assert.equal(css.includes("min-height: 18px;"), true);
      assert.equal(css.includes("grid-template-columns: minmax(128px, 260px) minmax(76px, 0.7fr) minmax(64px, 0.6fr) minmax(96px, 0.9fr) minmax(118px, 1fr) 26px 26px;"), true);
      assert.equal(css.includes("width: 24px;"), true);
      assert.equal(css.includes("height: 24px;"), true);
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

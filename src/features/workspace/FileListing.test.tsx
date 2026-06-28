import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { FileListingShell, TAB_VIEW_MODE_OPTIONS } from "./FileListing";
import { clearSystemFileDropHighlight, updateSystemFileDropHighlight } from "./systemDragDrop";
import {
  clearSystemIconCacheForTests,
  setSystemIconResolverForTests,
  type SystemIconRequest
} from "./systemIconGateway";
import { installLegacyInputEventPatch } from "./testDom";
import type {
  ClipboardState,
  ColumnDefinition,
  ColumnId,
  ContextMenuState,
  EntryViewModel,
  InlineEditState,
  NativeContextMenuRequest,
  PanelId,
  SortState
} from "./types";
import { readWorkspaceCss } from "./workspaceCssTestUtils";

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
  installLegacyInputEventPatch(dom);
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

function createDataTransfer() {
  const store = new Map<string, string>();
  let readBlocked = false;
  let typesHidden = false;
  return {
    dropEffect: "move",
    effectAllowed: "all",
    get types() {
      if (typesHidden) {
        return [];
      }
      return Array.from(store.keys());
    },
    setReadBlocked(blocked: boolean) {
      readBlocked = blocked;
    },
    setTypesHidden(hidden: boolean) {
      typesHidden = hidden;
    },
    setData(type: string, value: string) {
      store.set(type, value);
    },
    getData(type: string) {
      if (readBlocked) {
        return "";
      }
      return store.get(type) ?? "";
    },
    files: []
  };
}

function createExternalFileDataTransfer() {
  return {
    dropEffect: "none",
    effectAllowed: "copy",
    types: ["Files"],
    files: [{}],
    setData() {
      return undefined;
    },
    getData() {
      return "";
    }
  };
}

function dispatchDragEvent(
  target: Element,
  type: string,
  dataTransfer: ReturnType<typeof createDataTransfer> | ReturnType<typeof createExternalFileDataTransfer>,
  ctrlKey = false,
  shiftKey = false
): Event {
  const event = new Event(type, {
    bubbles: true,
    cancelable: true
  }) as Event & {
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    clientX: number;
    clientY: number;
    dataTransfer: ReturnType<typeof createDataTransfer> | ReturnType<typeof createExternalFileDataTransfer>;
  };

  Object.defineProperties(event, {
    ctrlKey: { configurable: true, value: ctrlKey },
    metaKey: { configurable: true, value: false },
    shiftKey: { configurable: true, value: shiftKey },
    clientX: { configurable: true, value: 20 },
    clientY: { configurable: true, value: 40 },
    dataTransfer: { configurable: true, value: dataTransfer }
  });

  target.dispatchEvent(event);
  return event;
}

function dispatchPointerLikeMouseEvent(target: Element | Window, type: string, clientX: number) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY: 16
  });

  target.dispatchEvent(event);
  return event;
}

function createPointerEvent(
  type: string,
  options: {
    pointerId?: number;
    button?: number;
    buttons?: number;
    clientX?: number;
    clientY?: number;
    ctrlKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    metaKey?: boolean;
  } = {}
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
    clientY: options.clientY ?? 0,
    ctrlKey: options.ctrlKey ?? false,
    altKey: options.altKey ?? false,
    shiftKey: options.shiftKey ?? false,
    metaKey: options.metaKey ?? false
  })) {
    Object.defineProperty(event, key, {
      configurable: true,
      value
    });
  }
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

function createTabDropTarget(path: string, panelId: PanelId = "panel-2") {
  const tab = document.createElement("button");
  tab.type = "button";
  tab.dataset.panelId = panelId;
  tab.dataset.entryDropKind = "tab";
  tab.dataset.entryDropPath = path;
  document.body.appendChild(tab);
  return tab;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  if (valueSetter) {
    valueSetter.call(input, value);
    return;
  }
  input.value = value;
}

const columns: ColumnDefinition[] = [
  { id: "name", label: "名称", visible: true, width: "2fr", align: "left" },
  { id: "type", label: "类型", visible: true, width: "1fr", align: "left" },
  { id: "size", label: "大小", visible: true, width: "1fr", align: "right" }
];

const entries: EntryViewModel[] = [
  {
    id: "folder-target",
    name: "塔原理：e思维与表达和解决现实世界复杂问题的逻辑",
    kind: "folder",
    path: "D:\\Archive",
    parentPath: "D:\\",
    sizeLabel: "--",
    modifiedLabel: "2026-04-21 09:00",
    extension: "",
    attributes: ["D"],
    accentColor: "#107c10",
    tags: ["Folder"],
    description: "Archive folder"
  },
  {
    id: "file-source",
    name: "report.txt",
    kind: "file",
    path: "D:\\report.txt",
    parentPath: "D:\\",
    sizeLabel: "2 KB",
    modifiedLabel: "2026-04-21 10:00",
    extension: ".txt",
    attributes: ["A"],
    accentColor: "#0f6cbd",
    tags: ["Doc"],
    description: "Text report",
    contentText: "alpha beta"
  }
];

export const completion = (async () => {
  const dom = installDomEnvironment();
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("test root container is missing");
  }

  const root = ReactDOM.createRoot(container);
  const dropped: Array<{ paths: string[]; destination: string; operation: "copy" | "move" }> = [];
  const customMenus: Array<Pick<ContextMenuState, "mode" | "scope" | "columnId" | "entryPath">> = [];
  const nativeMenus: Array<{
    target: NativeContextMenuRequest["target"];
    paths: string[];
    directoryPath?: string;
    clientX: number;
    clientY: number;
    screenX: number;
    screenY: number;
  }> = [];
  const selectedEntries: Array<{ entryId: string; multi: boolean }> = [];
  const rangeSelections: Array<{ fromEntryId: string; toEntryId: string; orderedEntryIds: string[] }> = [];
  const resizedColumns: Array<{ columnId: ColumnDefinition["id"]; width: string }> = [];
  const columnVisibilityChanges: Array<{ columnId: ColumnId; visible: boolean }> = [];
  let showAllColumnsCalls = 0;
  const resolvedIconRequests: SystemIconRequest[] = [];
  const inlineChanges: string[] = [];
  const inlineCommits: string[] = [];
  const inlineCommitValues: Array<string | undefined> = [];
  const inlineCancels: string[] = [];
  const systemDragStarts: string[][] = [];
  const navigationAdds: string[][] = [];
  const columnOrderChanges: Array<{ sourceId: ColumnId; targetId: ColumnId; placement: "before" | "after" }> = [];

  setSystemIconResolverForTests(async (request) => {
    resolvedIconRequests.push(request);
    return `data:image/mock;base64,${request.kind}`;
  });

  function render(
    viewMode = "details" as (typeof TAB_VIEW_MODE_OPTIONS)[number]["id"],
    inlineEdit?: InlineEditState,
    renderPanelId: PanelId = "panel-1",
    selectedIds: string[] = ["file-source"],
    entryDropMoveBinding = "Shift",
    renderColumns: ColumnDefinition[] = columns,
    contextMenuDefault: "native" | "custom" = "native",
    contextMenuToggleBinding = "Shift",
    clipboard?: ClipboardState,
    renderEntries: EntryViewModel[] = entries,
    renderSort: SortState = { columnId: "name", direction: "asc" },
    tooltipHoverDelayMs = 200
  ) {
    root.render(
      React.createElement(FileListingShell, {
        panelId: renderPanelId,
        tabId: "panel-1-tab-1",
        entries: renderEntries,
        columns: renderColumns,
        sort: renderSort,
        currentPath: "D:\\",
        selectedEntryIds: selectedIds,
        viewMode,
        inlineEdit,
        clipboard,
        detailsRowHeight: 42,
        tooltipHoverDelayMs,
        entryDropMoveBinding,
        contextMenuDefault,
        contextMenuToggleBinding,
        syncScrollEnabled: false,
        onSyncScroll: () => undefined,
        onSort: () => undefined,
        onResizeColumn: (columnId, width) => {
          resizedColumns.push({ columnId, width });
        },
        onSetColumnVisibility: (columnId, visible) => {
          columnVisibilityChanges.push({ columnId, visible });
        },
        onMoveColumn: (sourceId, targetId, placement) => {
          columnOrderChanges.push({ sourceId, targetId, placement });
        },
        onShowAllColumns: () => {
          showAllColumnsCalls += 1;
        },
        onSelect: (entry, multi) => {
          selectedEntries.push({ entryId: entry.id, multi });
        },
        onSelectRange: (fromEntryId, toEntryId, orderedEntryIds) => {
          rangeSelections.push({ fromEntryId, toEntryId, orderedEntryIds });
        },
        onOpen: () => undefined,
        onOpenContextMenu: (payload) => {
          const captured: Pick<ContextMenuState, "mode" | "scope" | "columnId" | "entryPath"> = {
            mode: payload.mode,
            scope: payload.scope
          };
          if (payload.columnId) {
            captured.columnId = payload.columnId;
          }
          if (payload.entryPath) {
            captured.entryPath = payload.entryPath;
          }
          customMenus.push(captured);
        },
        onOpenNativeContextMenu: (payload: NativeContextMenuRequest) => {
          nativeMenus.push({
            target: payload.target,
            paths: [...payload.paths],
            directoryPath: payload.directoryPath,
            clientX: payload.clientX,
            clientY: payload.clientY,
            screenX: payload.screenX,
            screenY: payload.screenY
          });
        },
        onDropEntries: (paths, destination, operation) => {
          dropped.push({ paths, destination, operation });
        },
        onAddEntriesToNavigation: (paths) => {
          navigationAdds.push([...paths]);
        },
        onStartSystemFileDrag: (paths) => {
          systemDragStarts.push([...paths]);
        },
        onInlineEditChange: (value) => {
          inlineChanges.push(value);
        },
        onInlineEditCommit: (value) => {
          inlineCommits.push("commit");
          inlineCommitValues.push(value);
        },
        onInlineEditCancel: () => {
          inlineCancels.push("cancel");
        }
      })
    );
  }

  try {
    await assertTest("FileListingShell keeps the details header and rows in one horizontal scroll region", async () => {
      await act(async () => {
        render("details");
        await flushEffects();
      });

      const header = container.querySelector(".file-listing__header");
      const scroll = container.querySelector(".file-listing__scroll");
      const body = container.querySelector(".file-listing__body");

      assert.ok(header);
      assert.ok(scroll);
      assert.ok(body);
      assert.equal(scroll.contains(header), true);
      assert.equal(scroll.contains(body), true);
      assert.equal(header?.getAttribute("data-details-scroll-header"), "true");
    });

    await assertTest("workspace details listing body reserves only the space below the sticky header", async () => {
      const css = readWorkspaceCss();
      const listingRule = css.match(/\.file-listing\s*\{([^}]*)\}/)?.[1] ?? "";
      const detailsBodyRule = css.match(/\.file-listing__body--details\s*\{([^}]*)\}/)?.[1] ?? "";

      assert.match(listingRule, /--details-header-height:\s*24px;/);
      assert.match(detailsBodyRule, /min-height:\s*calc\(100%\s*-\s*var\(--details-header-height\)\);/);
      assert.match(detailsBodyRule, /height:\s*auto;/);
    });

    await assertTest("FileListingShell sends the current visible sorted order for Shift range selection", async () => {
      rangeSelections.length = 0;
      selectedEntries.length = 0;
      const sortableEntries: EntryViewModel[] = [
        { ...entries[1], id: "alpha", name: "alpha.txt", path: "D:\\alpha.txt", modifiedLabel: "2026-04-21 12:00" },
        { ...entries[1], id: "bravo", name: "bravo.txt", path: "D:\\bravo.txt", modifiedLabel: "2026-04-21 09:00" },
        { ...entries[1], id: "charlie", name: "charlie.txt", path: "D:\\charlie.txt", modifiedLabel: "2026-04-21 10:00" }
      ];

      await act(async () => {
        render(
          "details",
          undefined,
          "panel-1",
          [],
          "Shift",
          columns,
          "native",
          "Shift",
          undefined,
          sortableEntries,
          { columnId: "modified", direction: "asc" }
        );
        await flushEffects();
      });

      const rows = Array.from(container.querySelectorAll<HTMLElement>(".file-row"));
      assert.equal(rows.length, 3);
      assert.deepEqual(rows.map((row) => row.dataset.entryPath), ["D:\\bravo.txt", "D:\\charlie.txt", "D:\\alpha.txt"]);

      await act(async () => {
        rows[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        rows[2].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));
        await flushEffects();
      });

      assert.deepEqual(selectedEntries, [{ entryId: "bravo", multi: false }]);
      assert.deepEqual(rangeSelections, [
        { fromEntryId: "bravo", toEntryId: "alpha", orderedEntryIds: ["bravo", "charlie", "alpha"] }
      ]);
    });

    await assertTest("FileListingShell falls back to a normal click when the Shift anchor is no longer visible", async () => {
      rangeSelections.length = 0;
      selectedEntries.length = 0;
      const visibleEntries: EntryViewModel[] = [
        { ...entries[1], id: "alpha", name: "alpha.txt", path: "D:\\alpha.txt", modifiedLabel: "2026-04-21 12:00" },
        { ...entries[1], id: "bravo", name: "bravo.txt", path: "D:\\bravo.txt", modifiedLabel: "2026-04-21 09:00" },
        { ...entries[1], id: "charlie", name: "charlie.txt", path: "D:\\charlie.txt", modifiedLabel: "2026-04-21 10:00" }
      ];

      await act(async () => {
        render("details", undefined, "panel-1", [], "Shift", columns, "native", "Shift", undefined, visibleEntries);
        await flushEffects();
      });
      let rows = Array.from(container.querySelectorAll<HTMLElement>(".file-row"));
      await act(async () => {
        rows[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await flushEffects();
      });

      await act(async () => {
        render("details", undefined, "panel-1", [], "Shift", columns, "native", "Shift", undefined, visibleEntries.slice(1));
        await flushEffects();
      });
      rows = Array.from(container.querySelectorAll<HTMLElement>(".file-row"));
      await act(async () => {
        rows[1].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));
        await flushEffects();
      });

      assert.deepEqual(rangeSelections, []);
      assert.deepEqual(selectedEntries, [
        { entryId: "alpha", multi: false },
        { entryId: "charlie", multi: false }
      ]);
    });

    await assertTest("FileListingShell opens a Windows-style column menu from the details header", async () => {
      customMenus.length = 0;
      columnVisibilityChanges.length = 0;
      showAllColumnsCalls = 0;
      const menuColumns: ColumnDefinition[] = [
        { id: "name", label: "名称", visible: true, width: "2fr", align: "left" },
        { id: "type", label: "类型", visible: true, width: "1fr", align: "left" },
        { id: "size", label: "大小", visible: true, width: "1fr", align: "right" },
        { id: "modified", label: "修改时间", visible: true, width: "1.2fr", align: "left" },
        { id: "tags", label: "标签", visible: false, width: "1fr", align: "left" }
      ];

      await act(async () => {
        render("details", undefined, "panel-1", ["file-source"], "Shift", menuColumns);
        await flushEffects();
      });

      const header = container.querySelector(".file-listing__header");
      assert.ok(header);
      await act(async () => {
        header.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 120,
            clientY: 44
          })
        );
        await flushEffects();
      });

      const menu = container.querySelector(".column-header-menu") as HTMLElement | null;
      assert.ok(menu);
      assert.equal(menu.getAttribute("role"), "menu");
      assert.equal(menu.style.left, "120px");
      assert.equal(menu.style.top, "44px");
      assert.equal(menu.querySelectorAll('[role="separator"]').length, 1);
      assert.equal(menu.textContent?.includes("名称"), true);
      assert.equal(menu.textContent?.includes("类型"), true);
      assert.equal(menu.textContent?.includes("大小"), true);
      assert.equal(menu.textContent?.includes("修改日期"), true);
      assert.equal(menu.textContent?.includes("标签"), true);
      assert.equal(menu.textContent?.includes("显示所有列"), true);
      assert.equal(menu.textContent?.includes("立即自动调整列宽"), true);

      const nameItem = Array.from(menu.querySelectorAll("button")).find((button) => button.textContent?.includes("名称"));
      const tagsItem = Array.from(menu.querySelectorAll("button")).find((button) => button.textContent?.includes("标签"));
      assert.equal(nameItem?.getAttribute("aria-checked"), "true");
      assert.equal(tagsItem?.getAttribute("aria-checked"), "false");
      assert.deepEqual(customMenus, []);
    });

    await assertTest("FileListingShell column menu can hide a visible detail column", async () => {
      columnVisibilityChanges.length = 0;
      const menuColumns: ColumnDefinition[] = [
        { id: "name", label: "鍚嶇О", visible: true, width: "2fr", align: "left" },
        { id: "type", label: "绫诲瀷", visible: true, width: "1fr", align: "left" },
        { id: "size", label: "澶у皬", visible: true, width: "1fr", align: "right" },
        { id: "modified", label: "淇敼鏃堕棿", visible: true, width: "1.2fr", align: "left" },
        { id: "tags", label: "鏍囩", visible: false, width: "1fr", align: "left" }
      ];

      await act(async () => {
        render("details", undefined, "panel-1", ["file-source"], "Shift", menuColumns);
        await flushEffects();
      });

      const header = container.querySelector(".file-listing__header");
      assert.ok(header);
      await act(async () => {
        header.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 80, clientY: 34 }));
        await flushEffects();
      });

      const menu = container.querySelector(".column-header-menu") as HTMLElement | null;
      assert.ok(menu);
      const typeItem = Array.from(menu.querySelectorAll('[role="menuitemcheckbox"]'))[1];
      assert.ok(typeItem);

      await act(async () => {
        typeItem.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await flushEffects();
      });

      assert.deepEqual(columnVisibilityChanges, [{ columnId: "type", visible: false }]);
    });

    await assertTest("FileListingShell column menu toggles column visibility and can show all columns", async () => {
      columnVisibilityChanges.length = 0;
      showAllColumnsCalls = 0;
      const menuColumns: ColumnDefinition[] = [
        { id: "name", label: "名称", visible: true, width: "2fr", align: "left" },
        { id: "type", label: "类型", visible: true, width: "1fr", align: "left" },
        { id: "size", label: "大小", visible: true, width: "1fr", align: "right" },
        { id: "modified", label: "修改时间", visible: false, width: "1.2fr", align: "left" },
        { id: "tags", label: "标签", visible: false, width: "1fr", align: "left" }
      ];

      await act(async () => {
        render("details", undefined, "panel-1", ["file-source"], "Shift", menuColumns);
        await flushEffects();
      });

      const header = container.querySelector(".file-listing__header");
      assert.ok(header);
      await act(async () => {
        header.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 80, clientY: 34 }));
        await flushEffects();
      });
      let menu = container.querySelector(".column-header-menu") as HTMLElement | null;
      assert.ok(menu);
      const tagsItem = Array.from(menu.querySelectorAll("button")).find((button) => button.textContent?.includes("标签"));
      assert.ok(tagsItem);

      await act(async () => {
        tagsItem!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await flushEffects();
      });

      assert.deepEqual(columnVisibilityChanges, [{ columnId: "tags", visible: true }]);

      await act(async () => {
        header.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 80, clientY: 34 }));
        await flushEffects();
      });
      menu = container.querySelector(".column-header-menu") as HTMLElement | null;
      assert.ok(menu);
      const showAllItem = Array.from(menu.querySelectorAll("button")).find((button) => button.textContent?.includes("显示所有列"));
      assert.ok(showAllItem);

      await act(async () => {
        showAllItem!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await flushEffects();
      });

      assert.equal(showAllColumnsCalls, 1);
    });

    await assertTest("FileListingShell copies selected entries to directory tabs with pointer drag", async () => {
      await act(async () => {
        render("details", undefined, "panel-1", ["folder-target", "file-source"]);
        await flushEffects();
      });

      dropped.length = 0;
      const rows = Array.from(container.querySelectorAll(".file-row"));
      const sourceRow = rows[1];
      assert.ok(sourceRow);
      assert.equal((sourceRow as HTMLElement).draggable, false);

      const targetTab = createTabDropTarget("E:\\Target");
      const restoreElementFromPoint = stubElementFromPoint(targetTab);
      try {
        await act(async () => {
          sourceRow.dispatchEvent(createPointerEvent("pointerdown", { clientX: 10, clientY: 8 }));
          window.dispatchEvent(createPointerEvent("pointermove", { clientX: 28, clientY: 8 }));
          window.dispatchEvent(createPointerEvent("pointerup", { clientX: 420, clientY: 8, buttons: 0 }));
          await flushEffects();
        });
      } finally {
        restoreElementFromPoint();
        targetTab.remove();
      }

      assert.deepEqual(dropped, [
        { paths: ["D:\\Archive", "D:\\report.txt"], destination: "E:\\Target", operation: "copy" }
      ]);
    });

    await assertTest("FileListingShell adds pointer-dragged entries to navigation drop targets without file operations", async () => {
      dropped.length = 0;
      navigationAdds.length = 0;

      await act(async () => {
        render("details");
        await flushEffects();
      });

      const navigationTarget = document.createElement("div");
      navigationTarget.dataset.entryDropKind = "navigation";
      document.body.appendChild(navigationTarget);
      const restoreElementFromPoint = stubElementFromPoint(navigationTarget);
      try {
        const rows = Array.from(container.querySelectorAll(".file-row"));
        const sourceRow = rows[1];
        assert.ok(sourceRow);

        await act(async () => {
          sourceRow.dispatchEvent(createPointerEvent("pointerdown", { clientX: 10, clientY: 8 }));
          window.dispatchEvent(createPointerEvent("pointermove", { clientX: 28, clientY: 8 }));
          window.dispatchEvent(createPointerEvent("pointerup", { clientX: 420, clientY: 8, buttons: 0 }));
          await flushEffects();
        });
      } finally {
        restoreElementFromPoint();
        navigationTarget.remove();
      }

      assert.deepEqual(navigationAdds, [["D:\\report.txt"]]);
      assert.deepEqual(dropped, []);
    });

    await assertTest("FileListingShell starts a native system drag when a pointer drag leaves the window", async () => {
      systemDragStarts.length = 0;
      await act(async () => {
        render("details", undefined, "panel-1", ["file-source"], "Shift", columns, "native", "Shift", {
          mode: "cut",
          paths: ["D:\\report.txt"]
        });
        await flushEffects();
      });

      const rows = Array.from(container.querySelectorAll(".file-row"));
      const sourceRow = rows[1] as HTMLElement | undefined;
      assert.ok(sourceRow);
      assert.equal(sourceRow.classList.contains("is-cut"), true);
      assert.equal(sourceRow.dataset.clipboardMode, "cut");
      assert.equal(sourceRow.draggable, false);

      await act(async () => {
        sourceRow.dispatchEvent(createPointerEvent("pointerdown", { clientX: 10, clientY: 8 }));
        window.dispatchEvent(createPointerEvent("pointermove", { clientX: 28, clientY: 8 }));
        window.dispatchEvent(createPointerEvent("pointermove", { clientX: -8, clientY: 8 }));
        await flushEffects();
      });

      assert.deepEqual(systemDragStarts, [["D:\\report.txt"]]);
    });

    await assertTest("FileListingShell starts a native system drag when hit-testing leaves the WebView content", async () => {
      systemDragStarts.length = 0;
      await act(async () => {
        render("details", undefined, "panel-1", ["file-source"]);
        await flushEffects();
      });

      const rows = Array.from(container.querySelectorAll(".file-row"));
      const sourceRow = rows[1] as HTMLElement | undefined;
      assert.ok(sourceRow);

      const restoreElementFromPoint = stubElementFromPoint(null);
      try {
        await act(async () => {
          sourceRow.dispatchEvent(createPointerEvent("pointerdown", { clientX: 10, clientY: 8 }));
          window.dispatchEvent(createPointerEvent("pointermove", { clientX: 28, clientY: 8 }));
          await flushEffects();
        });
      } finally {
        restoreElementFromPoint();
      }

      assert.deepEqual(systemDragStarts, [["D:\\report.txt"]]);
    });

    await assertTest("FileListingShell uses the configured modifier for pointer move drops onto tabs", async () => {
      await act(async () => {
        render("details", undefined, "panel-1", ["file-source"], "Alt");
        await flushEffects();
      });

      dropped.length = 0;
      const rows = Array.from(container.querySelectorAll(".file-row"));
      const sourceRow = rows[1];
      assert.ok(sourceRow);

      const targetTab = createTabDropTarget("E:\\Target");
      const restoreElementFromPoint = stubElementFromPoint(targetTab);
      try {
        await act(async () => {
          sourceRow.dispatchEvent(createPointerEvent("pointerdown", { clientX: 10, clientY: 8 }));
          window.dispatchEvent(createPointerEvent("pointermove", { clientX: 28, clientY: 8, shiftKey: true }));
          window.dispatchEvent(createPointerEvent("pointerup", { clientX: 420, clientY: 8, buttons: 0, shiftKey: true }));
          await flushEffects();
        });

        await act(async () => {
          sourceRow.dispatchEvent(createPointerEvent("pointerdown", { pointerId: 2, clientX: 10, clientY: 8 }));
          window.dispatchEvent(createPointerEvent("pointermove", { pointerId: 2, clientX: 28, clientY: 8, altKey: true }));
          window.dispatchEvent(
            createPointerEvent("pointerup", { pointerId: 2, clientX: 420, clientY: 8, buttons: 0, altKey: true })
          );
          await flushEffects();
        });
      } finally {
        restoreElementFromPoint();
        targetTab.remove();
      }

      assert.deepEqual(dropped, [
        { paths: ["D:\\report.txt"], destination: "E:\\Target", operation: "copy" },
        { paths: ["D:\\report.txt"], destination: "E:\\Target", operation: "move" }
      ]);
    });

    await assertTest("FileListingShell moves pointer-dragged entries onto folder rows in the same panel", async () => {
      await act(async () => {
        render("details");
        await flushEffects();
      });

      dropped.length = 0;
      const rows = Array.from(container.querySelectorAll(".file-row"));
      const targetRow = rows[0];
      const sourceRow = rows[1];
      assert.ok(targetRow);
      assert.ok(sourceRow);

      const restoreElementFromPoint = stubElementFromPoint(targetRow);
      try {
        await act(async () => {
          sourceRow.dispatchEvent(createPointerEvent("pointerdown", { clientX: 10, clientY: 8 }));
          window.dispatchEvent(createPointerEvent("pointermove", { clientX: 24, clientY: 8 }));
          window.dispatchEvent(createPointerEvent("pointerup", { clientX: 24, clientY: 8, buttons: 0 }));
          await flushEffects();
        });
      } finally {
        restoreElementFromPoint();
      }

      assert.deepEqual(dropped, [{ paths: ["D:\\report.txt"], destination: "D:\\Archive", operation: "move" }]);
    });

    await assertTest("FileListingShell moves pointer-dragged entries onto current-directory blank space", async () => {
      await act(async () => {
        render("details");
        await flushEffects();
      });

      dropped.length = 0;
      const rows = Array.from(container.querySelectorAll(".file-row"));
      const sourceRow = rows[1];
      const scroll = container.querySelector(".file-listing__scroll");
      assert.ok(sourceRow);
      assert.ok(scroll);

      const restoreElementFromPoint = stubElementFromPoint(scroll);
      try {
        await act(async () => {
          sourceRow.dispatchEvent(createPointerEvent("pointerdown", { clientX: 10, clientY: 8 }));
          window.dispatchEvent(createPointerEvent("pointermove", { clientX: 24, clientY: 8 }));
          window.dispatchEvent(createPointerEvent("pointerup", { clientX: 80, clientY: 90, buttons: 0 }));
          await flushEffects();
        });
      } finally {
        restoreElementFromPoint();
      }

      assert.deepEqual(dropped, [{ paths: ["D:\\report.txt"], destination: "D:\\", operation: "move" }]);
    });

    await assertTest("FileListingShell highlights and drops onto the listing when pointer drag hovers a plain file row", async () => {
      await act(async () => {
        render("details", undefined, "panel-1", ["folder-target"]);
        await flushEffects();
      });

      dropped.length = 0;
      const rows = Array.from(container.querySelectorAll(".file-row"));
      const sourceRow = rows[0];
      const plainFileRow = rows[1];
      const scroll = container.querySelector(".file-listing__scroll");
      assert.ok(sourceRow);
      assert.ok(plainFileRow);
      assert.ok(scroll);

      const restoreElementFromPoint = stubElementFromPoint(plainFileRow);
      try {
        await act(async () => {
          sourceRow.dispatchEvent(createPointerEvent("pointerdown", { clientX: 10, clientY: 8 }));
          window.dispatchEvent(createPointerEvent("pointermove", { clientX: 24, clientY: 8 }));
          await flushEffects();
        });

        assert.equal(scroll.classList.contains("is-drop-target"), true);
        assert.equal((scroll as HTMLElement).dataset.dropOperation, "move");
        const follower = container.querySelector<HTMLElement>(".entry-drag-follower");
        assert.ok(follower);
        assert.equal(follower.style.left, "36px");
        assert.equal(follower.style.top, "20px");

        await act(async () => {
          window.dispatchEvent(createPointerEvent("pointerup", { clientX: 80, clientY: 90, buttons: 0 }));
          await flushEffects();
        });
      } finally {
        restoreElementFromPoint();
      }

      assert.deepEqual(dropped, [{ paths: ["D:\\Archive"], destination: "D:\\", operation: "move" }]);
      assert.equal(scroll.classList.contains("is-drop-target"), false);
      assert.equal(document.body.style.getPropertyValue("--entry-pointer-drag-x"), "");
      assert.equal(document.body.style.getPropertyValue("--entry-pointer-drag-y"), "");
    });

    await assertTest("FileListingShell transfers pointer-drag listing highlight between file lists", async () => {
      dropped.length = 0;
      await act(async () => {
        root.render(
          React.createElement(
            "div",
            null,
            React.createElement(FileListingShell, {
              panelId: "panel-1",
              tabId: "panel-1-tab-1",
              entries,
              columns,
              sort: { columnId: "name", direction: "asc" },
              currentPath: "D:\\",
              selectedEntryIds: ["file-source"],
              viewMode: "details",
              detailsRowHeight: 42,
              onSort: () => undefined,
              onResizeColumn: () => undefined,
              onSelect: () => undefined,
              onOpen: () => undefined,
              onOpenContextMenu: () => undefined,
              onOpenNativeContextMenu: () => undefined,
              onDropEntries: (paths, destination, operation) => {
                dropped.push({ paths, destination, operation });
              },
              onInlineEditChange: () => undefined,
              onInlineEditCommit: () => undefined,
              onInlineEditCancel: () => undefined
            }),
            React.createElement(FileListingShell, {
              panelId: "panel-2",
              tabId: "panel-2-tab-1",
              entries,
              columns,
              sort: { columnId: "name", direction: "asc" },
              currentPath: "E:\\",
              selectedEntryIds: [],
              viewMode: "details",
              detailsRowHeight: 42,
              onSort: () => undefined,
              onResizeColumn: () => undefined,
              onSelect: () => undefined,
              onOpen: () => undefined,
              onOpenContextMenu: () => undefined,
              onOpenNativeContextMenu: () => undefined,
              onDropEntries: (paths, destination, operation) => {
                dropped.push({ paths, destination, operation });
              },
              onInlineEditChange: () => undefined,
              onInlineEditCommit: () => undefined,
              onInlineEditCancel: () => undefined
            })
          )
        );
        await flushEffects();
      });

      const scrolls = Array.from(container.querySelectorAll(".file-listing__scroll")) as HTMLElement[];
      const rows = Array.from(container.querySelectorAll(".file-row"));
      const sourceRow = rows[1];
      const sourceScroll = scrolls[0];
      const targetScroll = scrolls[1];
      assert.ok(sourceRow);
      assert.ok(sourceScroll);
      assert.ok(targetScroll);

      let pointedElement: Element | null = sourceScroll;
      const restoreElementFromPoint = stubElementFromPoint(null);
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: () => pointedElement
      });
      try {
        await act(async () => {
          sourceRow.dispatchEvent(createPointerEvent("pointerdown", { clientX: 10, clientY: 8 }));
          window.dispatchEvent(createPointerEvent("pointermove", { clientX: 24, clientY: 8 }));
          await flushEffects();
        });
        assert.equal(sourceScroll.classList.contains("is-drop-target"), true);
        assert.equal(targetScroll.classList.contains("is-drop-target"), false);

        pointedElement = targetScroll;
        await act(async () => {
          window.dispatchEvent(createPointerEvent("pointermove", { clientX: 80, clientY: 14 }));
          await flushEffects();
        });
        assert.equal(sourceScroll.classList.contains("is-drop-target"), false);
        assert.equal(targetScroll.classList.contains("is-drop-target"), true);

        await act(async () => {
          window.dispatchEvent(createPointerEvent("pointerup", { clientX: 80, clientY: 14, buttons: 0 }));
          await flushEffects();
        });
      } finally {
        restoreElementFromPoint();
      }

      assert.deepEqual(dropped, [{ paths: ["D:\\report.txt"], destination: "E:\\", operation: "copy" }]);
      assert.equal(sourceScroll.classList.contains("is-drop-target"), false);
      assert.equal(targetScroll.classList.contains("is-drop-target"), false);
    });

    await assertTest("FileListingShell pointer-drag cleanup keeps an active system drop highlight", async () => {
      dropped.length = 0;
      await act(async () => {
        render("details", undefined, "panel-1", ["file-source"]);
        await flushEffects();
      });

      const scroll = container.querySelector(".file-listing__scroll") as HTMLElement | null;
      const rows = Array.from(container.querySelectorAll(".file-row"));
      const sourceRow = rows[1];
      assert.ok(scroll);
      assert.ok(sourceRow);

      // A system (Tauri native) drag is hovering this listing.
      const restoreSystemPoint = stubElementFromPoint(scroll);
      updateSystemFileDropHighlight({ x: 24, y: 8 });
      restoreSystemPoint();
      assert.equal(scroll!.classList.contains("is-system-drop-target"), true);
      assert.equal(scroll!.dataset.systemDropOperation, "copy");

      // An internal pointer drag over the same listing applies/clears its own
      // highlight without touching the system highlight class/data.
      const restoreElementFromPoint = stubElementFromPoint(scroll);
      try {
        await act(async () => {
          sourceRow.dispatchEvent(createPointerEvent("pointerdown", { clientX: 10, clientY: 8 }));
          window.dispatchEvent(createPointerEvent("pointermove", { clientX: 24, clientY: 8 }));
          await flushEffects();
        });

        assert.equal(scroll!.classList.contains("is-drop-target"), true);
        assert.equal(scroll!.classList.contains("is-system-drop-target"), true);

        await act(async () => {
          window.dispatchEvent(createPointerEvent("pointerup", { clientX: 24, clientY: 8, buttons: 0 }));
          await flushEffects();
        });
      } finally {
        restoreElementFromPoint();
      }

      // Internal pointer cleanup cleared its own class but kept the system one.
      assert.equal(scroll!.classList.contains("is-drop-target"), false);
      assert.equal(scroll!.classList.contains("is-system-drop-target"), true);
      assert.equal(scroll!.dataset.systemDropOperation, "copy");
      clearSystemFileDropHighlight();
      assert.equal(scroll!.classList.contains("is-system-drop-target"), false);
    });

    await assertTest("FileListingShell shows an icon and name follower while pointer-dragging entries", async () => {
      await act(async () => {
        render("details", undefined, "panel-1", ["folder-target", "file-source"]);
        await flushEffects();
      });

      const rows = Array.from(container.querySelectorAll<HTMLElement>(".file-row"));
      const sourceRow = rows[1];
      const scroll = container.querySelector(".file-listing__scroll");
      assert.ok(sourceRow);
      assert.ok(scroll);
      const restoreElementFromPoint = stubElementFromPoint(scroll);
      try {
        await act(async () => {
          sourceRow.dispatchEvent(createPointerEvent("pointerdown", { clientX: 10, clientY: 8 }));
          window.dispatchEvent(createPointerEvent("pointermove", { clientX: 28, clientY: 18 }));
          await flushEffects();
        });

        const follower = container.querySelector<HTMLElement>(".entry-drag-follower");
        assert.ok(follower);
        assert.equal(follower.style.left, "40px");
        assert.equal(follower.style.top, "30px");
        assert.equal(follower.textContent?.includes("report.txt"), true);
        assert.equal(follower.textContent?.includes("2"), true);
        assert.equal(follower.querySelector(".entry-icon")?.getAttribute("data-kind"), "file");

        await act(async () => {
          window.dispatchEvent(createPointerEvent("pointerup", { clientX: 28, clientY: 18, buttons: 0 }));
          await flushEffects();
        });
      } finally {
        restoreElementFromPoint();
      }

      assert.equal(container.querySelector(".entry-drag-follower"), null);
    });

    await assertTest("workspace file drag preview uses a DOM follower instead of a pseudo badge", async () => {
      const css = readWorkspaceCss();
      assert.match(css, /body\.is-entry-pointer-dragging[\s\S]*cursor:\s*default\s*!important;/);
      assert.match(css, /\.entry-drag-follower\s*\{/);
      assert.match(css, /\.entry-drag-follower__name\s*\{/);
      assert.doesNotMatch(css, /body\.is-entry-pointer-dragging::after/);
      assert.doesNotMatch(css, /body\.is-entry-pointer-dragging[\s\S]*cursor:\s*grabbing\s*!important;/);
    });

    await assertTest("FileListingShell accepts external file drags over folder rows, file rows, and listing blank space", async () => {
      await act(async () => {
        render("details");
        await flushEffects();
      });

      dropped.length = 0;
      const rows = Array.from(container.querySelectorAll(".file-row"));
      const [targetRow, fileRow] = rows;
      const scroll = container.querySelector(".file-listing__scroll");
      assert.ok(targetRow);
      assert.ok(fileRow);
      assert.ok(scroll);

      const targets = [targetRow, fileRow, scroll].map((target) => [target, createExternalFileDataTransfer()] as const);
      const overEvents: Event[] = [];
      const dropEvents: Event[] = [];
      await act(async () => {
        for (const [target, transfer] of targets) {
          overEvents.push(dispatchDragEvent(target, "dragover", transfer));
          dropEvents.push(dispatchDragEvent(target, "drop", createExternalFileDataTransfer()));
        }
        await flushEffects();
      });

      assert.deepEqual([overEvents, dropEvents].map((events) => events.map((event) => event.defaultPrevented)), [[true, true, true], [true, true, true]]);
      assert.deepEqual(targets.map(([, transfer]) => transfer.dropEffect), ["copy", "copy", "copy"]);
      assert.deepEqual(dropped, []);
    });

    await assertTest("FileListingShell ignores HTML5 drops without internal entry payloads", async () => {
      await act(async () => {
        render("details");
        await flushEffects();
      });

      dropped.length = 0;
      const rows = Array.from(container.querySelectorAll(".file-row"));
      const sourceRow = rows[1];
      const scroll = container.querySelector(".file-listing__scroll");
      assert.ok(sourceRow);
      assert.ok(scroll);

      const transfer = createDataTransfer();
      let dragOverEvent: Event | undefined;
      await act(async () => {
        transfer.setReadBlocked(true);
        transfer.setTypesHidden(true);
        dragOverEvent = dispatchDragEvent(scroll, "dragover", transfer);
        transfer.setReadBlocked(false);
        transfer.setTypesHidden(false);
        dispatchDragEvent(scroll, "drop", transfer);
        await flushEffects();
      });

      assert.equal(dragOverEvent?.defaultPrevented, false);
      assert.deepEqual(dropped, []);
    });

    await assertTest("FileListingShell exposes all Windows-aligned view mode classes", async () => {
      for (const option of TAB_VIEW_MODE_OPTIONS) {
        await act(async () => {
          render(option.id);
          await flushEffects();
        });

        const listingElement: Element | null = container.querySelector(".file-listing");
        assert.ok(listingElement);
        assert.equal(listingElement.classList.contains(`file-listing--${option.id}`), true);
      }
    });

    await assertTest("FileListingShell renders resolved system icons with multiline titles and no type subtitle in icon view", async () => {
      await act(async () => {
        render("extra-large-icons");
        await flushEffects();
      });

      const title = container.querySelector(".file-card__title");
      const metaLine = container.querySelector(".file-card__meta-line");
      const folderIcon = container.querySelector('.entry-icon[data-kind="folder"] img');
      const fileIcon = container.querySelector('.entry-icon[data-kind="file"] img');

      assert.ok(title);
      assert.equal(title.classList.contains("file-card__title--multiline"), true);
      assert.equal(metaLine, null);
      assert.ok(folderIcon);
      assert.ok(fileIcon);
    });

    await assertTest("FileListingShell requests Windows shell image lists that match each view mode", async () => {
      resolvedIconRequests.length = 0;
      clearSystemIconCacheForTests();

      await act(async () => {
        render("details");
        await flushEffects();
      });

      assert.equal(
        resolvedIconRequests.some((request) => request.kind === "file" && request.imageList === "sys-small"),
        true
      );
      assert.equal(
        resolvedIconRequests.some((request) => request.kind === "folder" && request.imageList === "sys-small"),
        true
      );

      resolvedIconRequests.length = 0;
      clearSystemIconCacheForTests();

      await act(async () => {
        render("small-icons");
        await flushEffects();
      });

      assert.equal(
        resolvedIconRequests.some((request) => request.kind === "file" && request.imageList === "small"),
        true
      );
      assert.equal(
        resolvedIconRequests.some((request) => request.kind === "folder" && request.imageList === "small"),
        true
      );

      resolvedIconRequests.length = 0;
      clearSystemIconCacheForTests();

      await act(async () => {
        render("medium-icons");
        await flushEffects();
      });

      assert.equal(
        resolvedIconRequests.some((request) => request.kind === "file" && request.imageList === "large"),
        true
      );
      assert.equal(
        resolvedIconRequests.some((request) => request.kind === "folder" && request.imageList === "large"),
        true
      );

      resolvedIconRequests.length = 0;
      clearSystemIconCacheForTests();

      await act(async () => {
        render("large-icons");
        await flushEffects();
      });

      assert.equal(
        resolvedIconRequests.some((request) => request.kind === "file" && request.imageList === "extra-large"),
        true
      );
      assert.equal(
        resolvedIconRequests.some((request) => request.kind === "folder" && request.imageList === "extra-large"),
        true
      );

      resolvedIconRequests.length = 0;
      clearSystemIconCacheForTests();

      await act(async () => {
        render("extra-large-icons");
        await flushEffects();
      });

      assert.equal(
        resolvedIconRequests.some((request) => request.kind === "file" && request.imageList === "jumbo"),
        true
      );
      assert.equal(
        resolvedIconRequests.some((request) => request.kind === "folder" && request.imageList === "jumbo"),
        true
      );
    });

    await assertTest("FileListingShell keeps the marquee rectangle inside the listing content region", async () => {
      await act(async () => {
        render("details", undefined, "panel-1", []);
        await flushEffects();
      });

      const scroll = container.querySelector(".file-listing__scroll") as HTMLElement | null;
      assert.ok(scroll);
      scroll.getBoundingClientRect = () =>
        ({
          width: 400,
          height: 200,
          top: 40,
          right: 500,
          bottom: 240,
          left: 100,
          x: 100,
          y: 40,
          toJSON: () => ({})
        }) as DOMRect;

      await act(async () => {
        scroll.dispatchEvent(
          new MouseEvent("mousedown", {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: 420,
            clientY: 200
          })
        );
        window.dispatchEvent(
          new MouseEvent("mousemove", {
            bubbles: true,
            cancelable: true,
            clientX: 20,
            clientY: 10
          })
        );
        await flushEffects();
      });

      const marquee = container.querySelector(".file-listing__marquee") as HTMLElement | null;
      assert.ok(marquee);
      assert.equal(marquee.style.left, "100px");
      assert.equal(marquee.style.top, "40px");
      assert.equal(marquee.style.width, "320px");
      assert.equal(marquee.style.height, "160px");

      await act(async () => {
        window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        await flushEffects();
      });
    });

    await assertTest("FileListingShell defaults cross-panel drops to copy and allows Shift to force move", async () => {
      await act(async () => {
        render("details", undefined, "panel-2");
        await flushEffects();
      });

      dropped.length = 0;
      const rows = Array.from(container.querySelectorAll(".file-row"));
      const targetRow = rows[0];
      const sourceRow = rows[1];
      assert.ok(targetRow);
      assert.ok(sourceRow);

      const copyTransfer = createDataTransfer();
      copyTransfer.setData(
        "application/x-athenaeum-entry-list",
        JSON.stringify({ sourcePanelId: "panel-1", sourceTabId: "panel-1-tab-1", paths: ["D:\\report.txt"] })
      );
      await act(async () => {
        dispatchDragEvent(targetRow, "dragover", copyTransfer);
        dispatchDragEvent(targetRow, "drop", copyTransfer);
        await flushEffects();
      });

      const moveTransfer = createDataTransfer();
      moveTransfer.setData(
        "application/x-athenaeum-entry-list",
        JSON.stringify({ sourcePanelId: "panel-1", sourceTabId: "panel-1-tab-1", paths: ["D:\\report.txt"] })
      );
      await act(async () => {
        dispatchDragEvent(targetRow, "dragover", moveTransfer, false, true);
        dispatchDragEvent(targetRow, "drop", moveTransfer, false, true);
        await flushEffects();
      });

      assert.deepEqual(dropped, [
        { paths: ["D:\\report.txt"], destination: "D:\\Archive", operation: "copy" },
        { paths: ["D:\\report.txt"], destination: "D:\\Archive", operation: "move" }
      ]);
    });

    await assertTest("FileListingShell emits resized detail column widths from the header divider", async () => {
      resizedColumns.length = 0;

      await act(async () => {
        render("details");
        await flushEffects();
      });

      const resizeHandles = Array.from(container.querySelectorAll(".file-header-resizer"));
      assert.ok(resizeHandles[0]);
      const firstHeader = resizeHandles[0].closest(".file-header-cell") as HTMLElement | null;
      assert.ok(firstHeader);
      firstHeader.getBoundingClientRect = () =>
        ({
          width: 220,
          height: 24,
          top: 0,
          right: 220,
          bottom: 24,
          left: 0,
          x: 0,
          y: 0,
          toJSON: () => ({})
        }) as DOMRect;

      await act(async () => {
        dispatchPointerLikeMouseEvent(resizeHandles[0], "mousedown", 220);
        dispatchPointerLikeMouseEvent(window, "mousemove", 280);
        dispatchPointerLikeMouseEvent(window, "mouseup", 280);
        await flushEffects();
      });

      assert.deepEqual(resizedColumns, [{ columnId: "name", width: "280px" }]);
    });

    await assertTest("FileListingShell materializes detail columns as fixed pixel tracks without resizing sibling columns", async () => {
      const mixedColumns: ColumnDefinition[] = [
        { id: "name", label: "name", visible: true, width: "360px", align: "left" },
        { id: "type", label: "type", visible: true, width: "1fr", align: "left" },
        { id: "size", label: "size", visible: true, width: "1fr", align: "right" },
        { id: "modified", label: "modified", visible: true, width: "1.2fr", align: "left" }
      ];

      await act(async () => {
        render("details", undefined, "panel-1", ["file-source"], "Shift", mixedColumns);
        await flushEffects();
      });

      const header = container.querySelector<HTMLElement>(".file-listing__header");
      const rowGrid = container.querySelector<HTMLElement>(".file-row__grid");
      assert.ok(header);
      assert.ok(rowGrid);
      assert.doesNotMatch(header.style.gridTemplateColumns, /fr/);
      assert.doesNotMatch(rowGrid.style.gridTemplateColumns, /fr/);
      assert.match(header.style.gridTemplateColumns, /^360px\s+\d+px\s+\d+px\s+\d+px$/);
      assert.equal(rowGrid.style.gridTemplateColumns, header.style.gridTemplateColumns);
      assert.equal(rowGrid.style.width, header.style.width);

      const css = readWorkspaceCss();
      assert.match(css, /\.file-listing--details\s+\.file-row\s*\{[^}]*width:\s*max-content;/);
      assert.doesNotMatch(css, /\.file-row__grid\s*\{[^}]*min-width:\s*100%;/);
    });

    await assertTest("FileListingShell clamps column resizing to at least the header text width", async () => {
      resizedColumns.length = 0;
      const narrowColumns: ColumnDefinition[] = [
        { id: "modified", label: "modified", visible: true, width: "160px", align: "left" }
      ];

      await act(async () => {
        render("details", undefined, "panel-1", ["file-source"], "Shift", narrowColumns);
        await flushEffects();
      });

      const resizeHandle = container.querySelector(".file-header-resizer");
      assert.ok(resizeHandle);
      const headerCell = resizeHandle.closest(".file-header-cell") as HTMLElement | null;
      assert.ok(headerCell);
      headerCell.getBoundingClientRect = () =>
        ({
          width: 160,
          height: 24,
          top: 0,
          right: 160,
          bottom: 24,
          left: 0,
          x: 0,
          y: 0,
          toJSON: () => ({})
        }) as DOMRect;

      await act(async () => {
        dispatchPointerLikeMouseEvent(resizeHandle, "mousedown", 160);
        dispatchPointerLikeMouseEvent(window, "mousemove", -100);
        dispatchPointerLikeMouseEvent(window, "mouseup", -100);
        await flushEffects();
      });

      assert.equal(resizedColumns[0]?.columnId, "modified");
      assert.ok(Number.parseInt(resizedColumns[0]?.width ?? "0", 10) >= 80);
    });

    await assertTest("FileListingShell opens the native background context menu when blank space is right-clicked", async () => {
      customMenus.length = 0;
      nativeMenus.length = 0;

      await act(async () => {
        render("details");
        await flushEffects();
      });

      const scroll = container.querySelector(".file-listing__scroll");
      assert.ok(scroll);

      await act(async () => {
        scroll.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 48,
            clientY: 64,
            screenX: 148,
            screenY: 164
          })
        );
        await flushEffects();
      });

      assert.deepEqual(nativeMenus, [
        {
          target: "background",
          paths: [],
          directoryPath: "D:\\",
          clientX: 48,
          clientY: 64,
          screenX: 148,
          screenY: 164
        }
      ]);
      assert.deepEqual(customMenus, []);
    });

    await assertTest("FileListingShell opens the app context menu when the context-menu shortcut right-clicks blank space", async () => {
      customMenus.length = 0;
      nativeMenus.length = 0;

      await act(async () => {
        render("details");
        await flushEffects();
      });

      const scroll = container.querySelector(".file-listing__scroll");
      assert.ok(scroll);

      await act(async () => {
        scroll.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            shiftKey: true,
            clientX: 48,
            clientY: 64
          })
        );
        await flushEffects();
      });

      assert.deepEqual(customMenus, [{ mode: "custom", scope: "panel" }]);
      assert.equal(nativeMenus.length, 0);
    });

    await assertTest("FileListingShell suppresses Shift right-button text selection before opening a blank app menu", async () => {
      customMenus.length = 0;
      nativeMenus.length = 0;

      await act(async () => {
        render("details");
        await flushEffects();
      });

      const scroll = container.querySelector(".file-listing__scroll");
      assert.ok(scroll);

      const mouseDown = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 2,
        shiftKey: true,
        clientX: 48,
        clientY: 64
      });

      await act(async () => {
        scroll.dispatchEvent(mouseDown);
        await flushEffects();
      });

      assert.equal(mouseDown.defaultPrevented, true);
      assert.deepEqual(customMenus, []);
      assert.deepEqual(nativeMenus, []);

      await act(async () => {
        scroll.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            shiftKey: true,
            clientX: 48,
            clientY: 64
          })
        );
        await flushEffects();
      });

      assert.deepEqual(customMenus, [{ mode: "custom", scope: "panel" }]);
      assert.equal(nativeMenus.length, 0);
    });

    await assertTest("FileListingShell opens the native background menu from blank icon-card padding", async () => {
      customMenus.length = 0;
      nativeMenus.length = 0;

      await act(async () => {
        render("large-icons");
        await flushEffects();
      });

      const iconCard = container.querySelector(".file-card--icon");
      assert.ok(iconCard);

      await act(async () => {
        iconCard.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 72,
            clientY: 80,
            screenX: 172,
            screenY: 180
          })
        );
        await flushEffects();
      });

      assert.deepEqual(nativeMenus, [
        {
          target: "background",
          paths: [],
          directoryPath: "D:\\",
          clientX: 72,
          clientY: 80,
          screenX: 172,
          screenY: 180
        }
      ]);
      assert.deepEqual(customMenus, []);
    });

    await assertTest("FileListingShell keeps multi-selection when right-clicking an already selected entry and opens the native menu", async () => {
      customMenus.length = 0;
      nativeMenus.length = 0;
      selectedEntries.length = 0;

      await act(async () => {
        render("details");
        await flushEffects();
      });

      const rows = Array.from(container.querySelectorAll(".file-row"));
      const selectedRow = rows[1];
      assert.ok(selectedRow);

      await act(async () => {
        selectedRow.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 24,
            clientY: 36,
            screenX: 320,
            screenY: 540
          })
        );
        await flushEffects();
      });

      assert.equal(selectedEntries.length, 0);
      assert.deepEqual(nativeMenus, [
        {
          target: "selection",
          paths: ["D:\\report.txt"],
          directoryPath: undefined,
          clientX: 24,
          clientY: 36,
          screenX: 320,
          screenY: 540
        }
      ]);
      assert.equal(customMenus.length, 0);
    });

    await assertTest("FileListingShell narrows selection before opening the native menu for an unselected entry", async () => {
      customMenus.length = 0;
      nativeMenus.length = 0;
      selectedEntries.length = 0;

      await act(async () => {
        render("details");
        await flushEffects();
      });

      const rows = Array.from(container.querySelectorAll(".file-row"));
      const unselectedRow = rows[0];
      assert.ok(unselectedRow);

      await act(async () => {
        unselectedRow.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 20,
            clientY: 28,
            screenX: 420,
            screenY: 680
          })
        );
        await flushEffects();
      });

      assert.deepEqual(selectedEntries, [{ entryId: "folder-target", multi: false }]);
      assert.deepEqual(nativeMenus, [
        {
          target: "selection",
          paths: ["D:\\Archive"],
          directoryPath: undefined,
          clientX: 20,
          clientY: 28,
          screenX: 420,
          screenY: 680
        }
      ]);
      assert.equal(customMenus.length, 0);
    });

    await assertTest("FileListingShell opens the app selection menu when the context-menu shortcut right-clicks an entry", async () => {
      customMenus.length = 0;
      nativeMenus.length = 0;
      selectedEntries.length = 0;

      await act(async () => {
        render("details");
        await flushEffects();
      });

      const rows = Array.from(container.querySelectorAll(".file-row"));
      const selectedRow = rows[1];
      assert.ok(selectedRow);

      await act(async () => {
        selectedRow.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            shiftKey: true,
            clientX: 24,
            clientY: 36,
            screenX: 320,
            screenY: 540
          })
        );
        await flushEffects();
      });

      assert.equal(selectedEntries.length, 0);
      assert.deepEqual(customMenus, [{ mode: "custom", scope: "selection" }]);
      assert.deepEqual(nativeMenus, []);
    });

    await assertTest("FileListingShell opens native menus with the shortcut when custom menus are the default", async () => {
      customMenus.length = 0;
      nativeMenus.length = 0;

      await act(async () => {
        render("details", undefined, "panel-1", ["file-source"], "Shift", columns, "custom", "Shift");
        await flushEffects();
      });

      const scroll = container.querySelector(".file-listing__scroll");
      assert.ok(scroll);

      await act(async () => {
        scroll.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            shiftKey: true,
            clientX: 48,
            clientY: 64,
            screenX: 148,
            screenY: 164
          })
        );
        await flushEffects();
      });

      assert.deepEqual(nativeMenus, [
        {
          target: "background",
          paths: [],
          directoryPath: "D:\\",
          clientX: 48,
          clientY: 64,
          screenX: 148,
          screenY: 164
        }
      ]);
      assert.deepEqual(customMenus, []);
    });

    await assertTest("FileListingShell renders create-folder inline edit as a focused list item and commits with Enter", async () => {
      inlineChanges.length = 0;
      inlineCommits.length = 0;
      inlineCancels.length = 0;

      await act(async () => {
        render("details", {
          mode: "create-folder",
          value: "新建文件夹",
          kind: "folder",
          parentPath: "D:\\"
        });
        await flushEffects();
      });

      const input = container.querySelector(".inline-edit-input") as HTMLInputElement | null;
      const firstRow = container.querySelector(".file-row");
      assert.ok(input);
      assert.equal(document.activeElement, input);
      assert.equal(input.value, "新建文件夹");
      assert.equal(firstRow?.getAttribute("data-inline-edit"), "true");

      await act(async () => {
        setInputValue(input, "Release");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Enter"
          })
        );
        await flushEffects();
      });

      assert.deepEqual(inlineChanges, ["Release"]);
      assert.deepEqual(inlineCommits, ["commit"]);
      assert.deepEqual(inlineCancels, []);
    });

    await assertTest("FileListingShell cancels inline edit with Escape without committing", async () => {
      inlineChanges.length = 0;
      inlineCommits.length = 0;
      inlineCancels.length = 0;

      await act(async () => {
        render("list", {
          mode: "create-folder",
          value: "新建文件夹",
          kind: "folder",
          parentPath: "D:\\"
        });
        await flushEffects();
      });

      const input = container.querySelector(".inline-edit-input") as HTMLInputElement | null;
      assert.ok(input);

      await act(async () => {
        input.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Escape"
          })
        );
        await flushEffects();
      });

      assert.deepEqual(inlineCommits, []);
      assert.deepEqual(inlineCancels, ["cancel"]);
    });

    await assertTest("FileListingShell replaces a renamed entry name with an inline edit input", async () => {
      inlineChanges.length = 0;
      inlineCommits.length = 0;
      inlineCancels.length = 0;

      await act(async () => {
        render("tiles", {
          mode: "rename",
          value: "report.txt",
          kind: "file",
          parentPath: "D:\\",
          entryId: "file-source",
          originalName: "report.txt",
          originalPath: "D:\\report.txt"
        });
        await flushEffects();
      });

      const input = container.querySelector(".inline-edit-input") as HTMLInputElement | null;
      assert.ok(input);
      assert.equal(input.value, "report.txt");
      assert.equal(input.closest("[data-inline-edit]")?.getAttribute("data-inline-edit"), "true");

      await act(async () => {
        input.blur();
        await flushEffects();
      });

      assert.deepEqual(inlineCommits, ["commit"]);
      assert.deepEqual(inlineCancels, []);
    });

    await assertTest("FileListingShell commits an active rename when blank listing space is clicked", async () => {
      inlineChanges.length = 0;
      inlineCommits.length = 0;
      inlineCommitValues.length = 0;
      inlineCancels.length = 0;

      await act(async () => {
        render("details", {
          mode: "rename",
          value: "report.txt",
          kind: "file",
          parentPath: "D:\\",
          entryId: "file-source",
          originalName: "report.txt",
          originalPath: "D:\\report.txt"
        });
        await flushEffects();
      });

      const input = container.querySelector(".inline-edit-input") as HTMLInputElement | null;
      const scroll = container.querySelector(".file-listing__scroll");
      assert.ok(input);
      assert.ok(scroll);

      await act(async () => {
        setInputValue(input, "report-final.txt");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        scroll.dispatchEvent(
          new MouseEvent("mousedown", {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: 180,
            clientY: 96
          })
        );
        await flushEffects();
      });

      assert.deepEqual(inlineCommits, ["commit"]);
      assert.deepEqual(inlineCommitValues, ["report-final.txt"]);
      assert.deepEqual(inlineCancels, []);
      assert.equal(container.querySelector(".file-listing__marquee"), null);
    });

    await assertTest("workspace details rename input fills the available name column width", async () => {
      const css = readWorkspaceCss();
      assert.match(
        css,
        /\.file-listing--details\s+\.file-row\.is-inline-editing\s+\.entry-name\s*\{[^}]*width:\s*100%;/s
      );
      assert.match(
        css,
        /\.file-listing--details\s+\.file-row\.is-inline-editing\s+\.inline-edit-input\s*\{[^}]*max-width:\s*none;/s
      );
    });
  } finally {
    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    setSystemIconResolverForTests(undefined);
    clearSystemIconCacheForTests();
    dom.window.close();
  }
})();

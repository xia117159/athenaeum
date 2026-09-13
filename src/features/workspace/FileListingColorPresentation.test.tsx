import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { FileListingShell } from "./FileListing";
import { clearSystemIconCacheForTests, setSystemIconResolverForTests } from "./systemIconGateway";
import type {
  ColumnDefinition,
  ContextMenuState,
  EntryViewModel,
  InlineEditState,
  NativeContextMenuRequest,
  PanelId,
  SortState,
  TabViewMode
} from "./types";
import { installLegacyInputEventPatch } from "./testDom";

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

const columns: ColumnDefinition[] = [
  { id: "name", label: "名称", visible: true, width: "2fr", align: "left" },
  { id: "type", label: "类型", visible: true, width: "1fr", align: "left" },
  { id: "size", label: "大小", visible: true, width: "1fr", align: "right" }
];

const coloredEntries: EntryViewModel[] = [
  {
    id: "colored-file",
    name: "季度报告.docx",
    kind: "file",
    path: "D:\\季度报告.docx",
    parentPath: "D:\\",
    sizeLabel: "2 KB",
    modifiedLabel: "2026-04-21 10:00",
    extension: ".docx",
    attributes: ["A"],
    accentColor: "#0f6cbd",
    tags: ["Doc"],
    description: "Colored text document",
    foregroundColorHex: "#2266a8",
    backgroundColorHex: "#fff4ce"
  },
  {
    id: "plain-file",
    name: "notes.txt",
    kind: "file",
    path: "D:\\notes.txt",
    parentPath: "D:\\",
    sizeLabel: "1 KB",
    modifiedLabel: "2026-04-21 11:00",
    extension: ".txt",
    attributes: ["A"],
    accentColor: "#0f6cbd",
    tags: [],
    description: "Plain text document",
    foregroundColorHex: null,
    backgroundColorHex: null
  }
];

export const completion = (async () => {
  const dom = installDomEnvironment();
  setSystemIconResolverForTests(async (request) => `data:image/mock;base64,${request.kind}`);
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("test root container is missing");
  }

  const root = ReactDOM.createRoot(container);
  const selectedEntries: Array<{ entryId: string; multi: boolean }> = [];
  const dropped: unknown[] = [];
  const customMenus: Array<Pick<ContextMenuState, "mode" | "scope">> = [];
  const nativeMenus: NativeContextMenuRequest[] = [];
  const sorts: string[] = [];

  function render(
    viewMode: TabViewMode,
    selectedIds: string[] = [],
    renderEntries: EntryViewModel[] = coloredEntries
  ) {
    root.render(
      React.createElement(FileListingShell, {
        panelId: "panel-1",
        tabId: "panel-1-tab-1",
        entries: renderEntries,
        columns,
        sort: { columnId: "name", direction: "asc" },
        currentPath: "D:\\",
        selectedEntryIds: selectedIds,
        viewMode,
        detailsRowHeight: 42,
        tooltipHoverDelayMs: 200,
        entryDropMoveBinding: "Shift",
        contextMenuDefault: "native",
        contextMenuToggleBinding: "Shift",
        syncScrollEnabled: false,
        onSyncScroll: () => undefined,
        colorFilterEnabled: true,
        onSort: (columnId) => {
          sorts.push(columnId);
        },
        onSelect: (entry, multi) => {
          selectedEntries.push({ entryId: entry.id, multi });
        },
        onOpen: () => undefined,
        onOpenContextMenu: (payload) => {
          customMenus.push({ mode: payload.mode, scope: payload.scope });
        },
        onOpenNativeContextMenu: (payload) => {
          nativeMenus.push(payload);
        },
        onResizeColumn: () => undefined,
        onDropEntries: (paths, destination, operation) => {
          dropped.push({ paths, destination, operation });
        },
        onInlineEditChange: () => undefined,
        onInlineEditCommit: () => undefined,
        onInlineEditCancel: () => undefined
      })
    );
  }

  const ROW_SELECTOR = ".file-row, .file-card, .file-list-item, .file-content-item";
  const VIEW_MODES: TabViewMode[] = ["details", "list", "tiles", "medium-icons", "content"];

  try {
    await assertTest("colored entries paint the rule background only behind the name label in every view mode", async () => {
      for (const viewMode of VIEW_MODES) {
        await act(async () => {
          render(viewMode);
          await flushEffects();
        });

        const row = container.querySelector(ROW_SELECTOR);
        assert.ok(row, `${viewMode} renders an entry surface`);
        const rowStyle = (row as HTMLElement).getAttribute("style") ?? "";
        assert.ok(rowStyle.includes("--entry-rule-foreground"), `${viewMode} row carries the foreground variable`);
        assert.ok(
          !rowStyle.includes("--entry-rule-background"),
          `${viewMode} row must not carry the background variable on the surrounding surface`
        );

        const label: HTMLElement | null = container.querySelector<HTMLElement>(".entry-name__label--rule-background");
        assert.ok(label, `${viewMode} renders a rule-colored name label`);
        assert.equal(label!.textContent, "季度报告.docx");
        const labelStyle = label!.getAttribute("style") ?? "";
        assert.ok(labelStyle.includes("--entry-rule-background"), `${viewMode} name label carries the background variable`);
        assert.notEqual(label, row, `${viewMode} name label is a separate element above the surface`);
      }

      // 未着色条目不产生名称标签类或背景变量。
      await act(async () => {
        render("list");
        await flushEffects();
      });
      const plainRow = Array.from(container.querySelectorAll(".file-list-item")).find(
        (row) => row.textContent?.includes("notes.txt")
      );
      assert.ok(plainRow, "plain entry renders a list row");
      assert.equal(plainRow!.querySelector(".entry-name__label--rule-background"), null);
      const coloredRow = Array.from(container.querySelectorAll(".file-list-item")).find(
        (row) => row.textContent?.includes("季度报告.docx")
      );
      assert.ok(coloredRow, "colored entry renders a list row");
      assert.ok(coloredRow!.querySelector(".entry-name__label--rule-background"));
    });

    await assertTest("selected colored entries keep their name-label colors above the selection surface", async () => {
      await act(async () => {
        render("details", ["colored-file"]);
        await flushEffects();
      });

      const selectedRow = container.querySelector(".file-row");
      assert.ok(selectedRow);
      assert.match(selectedRow!.className, /\bis-selected\b/);
      const rowStyle = (selectedRow as HTMLElement).getAttribute("style") ?? "";
      assert.ok(rowStyle.includes("--entry-rule-foreground"), "selected colored row keeps the foreground variable");
      const label = selectedRow!.querySelector<HTMLElement>(".entry-name__label--rule-background");
      assert.ok(label, "selected colored entry keeps its name-label background element");
      assert.ok((label!.getAttribute("style") ?? "").includes("--entry-rule-background"));

      // 未选中的普通条目不参与着色。
      const plainRow = Array.from(container.querySelectorAll(".file-row")).find(
        (row) => row.textContent?.includes("notes.txt")
      );
      assert.ok(plainRow, "plain entry renders in details view");
      assert.equal(plainRow!.querySelector(".entry-name__label--rule-background"), null);
    });

    await assertTest("selection click commits synchronously without timers, refresh callbacks, or color-rule evaluation", async () => {
      await act(async () => {
        render("list", []);
        await flushEffects();
      });

      selectedEntries.length = 0;
      const nativeMenusBefore = nativeMenus.length;
      const droppedBefore = dropped.length;
      const sortsBefore = sorts.length;

      // 选择路径禁止出现异步调度：定时器被拨到“点击路径内直接抛错”。
      const originalSetTimeout = globalThis.setTimeout;
      const originalSetInterval = globalThis.setInterval;
      const timerGuard = () => {
        throw new Error("async timer scheduled inside the selection click path");
      };
      globalThis.setTimeout = timerGuard as unknown as typeof setTimeout;
      globalThis.setInterval = timerGuard as unknown as typeof setInterval;
      try {
        const row = container.querySelector(".file-list-item")!;
        row.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.setInterval = originalSetInterval;
      }

      // onSelect 在同一个事件回合内同步提交，没有计时器、刷新或拖放副作用。
      assert.deepEqual(selectedEntries, [{ entryId: "colored-file", multi: false }]);
      assert.equal(nativeMenus.length, nativeMenusBefore);
      assert.equal(dropped.length, droppedBefore);
      assert.equal(sorts.length, sortsBefore);

      // 紧随其后的受控重绘把条目标记为选中，且名称标签配色保留。
      await act(async () => {
        render("list", ["colored-file"]);
        await flushEffects();
      });
      const selectedRow = container.querySelector(".file-list-item.is-selected");
      assert.ok(selectedRow);
      const label = selectedRow!.querySelector<HTMLElement>(".entry-name__label--rule-background");
      assert.ok(label, "name label keeps its rule background after selection");
      assert.ok((label!.getAttribute("style") ?? "").includes("--entry-rule-background"));
    });

    await assertTest("selection spy records only onSelect and never schedules work for colored rows", async () => {
      await act(async () => {
        render("content", []);
        await flushEffects();
      });

      selectedEntries.length = 0;
      const customMenusBefore = customMenus.length;
      const row = container.querySelector(".file-content-item");
      assert.ok(row);
      row!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      assert.equal(selectedEntries.length, 1);
      assert.equal(selectedEntries[0].entryId, "colored-file");
      assert.equal(customMenus.length, customMenusBefore);
    });
  } finally {
    setSystemIconResolverForTests(undefined);
    clearSystemIconCacheForTests();
    await act(async () => {
      root.unmount();
    });
    dom.window.close();
  }
})();

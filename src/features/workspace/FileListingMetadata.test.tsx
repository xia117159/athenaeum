import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { FileListingShell } from "./FileListing";
import { installLegacyInputEventPatch } from "./testDom";
import type {
  ColumnDefinition,
  ColumnId,
  ContextMenuState,
  EntryViewModel,
  NativeContextMenuRequest
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

  return dom;
}

async function flushEffects() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createPointerEvent(
  type: string,
  options: {
    pointerId?: number;
    button?: number;
    clientX?: number;
    clientY?: number;
  } = {}
) {
  const event = new Event(type, {
    bubbles: true,
    cancelable: true
  });
  for (const [key, value] of Object.entries({
    pointerId: options.pointerId ?? 1,
    button: options.button ?? 0,
    buttons: 1,
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

const columns: ColumnDefinition[] = [
  { id: "name", label: "名称", visible: true, width: "240px", align: "left" },
  { id: "type", label: "类型", visible: true, width: "112px", align: "left" },
  { id: "size", label: "大小", visible: true, width: "96px", align: "right" }
];

const entries: EntryViewModel[] = [
  {
    id: "folder-target",
    name: "Archive",
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
    description: "Text report"
  }
];

export const completion = (async () => {
  installDomEnvironment();
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("test root container is missing");
  }

  const root = ReactDOM.createRoot(container);
  const customMenus: Array<Pick<ContextMenuState, "mode" | "scope" | "columnId" | "entryPath">> = [];
  const nativeMenus: NativeContextMenuRequest[] = [];
  const selectedEntries: Array<{ entryId: string; multi: boolean }> = [];
  const columnOrderChanges: Array<{ sourceId: ColumnId; targetId: ColumnId; placement: "before" | "after" }> = [];

  function render({
    renderColumns = columns,
    renderEntries = entries,
    selectedIds = ["file-source"],
    tooltipHoverDelayMs = 200
  }: {
    renderColumns?: ColumnDefinition[];
    renderEntries?: EntryViewModel[];
    selectedIds?: string[];
    tooltipHoverDelayMs?: number;
  } = {}) {
    root.render(
      React.createElement(FileListingShell, {
        panelId: "panel-1",
        tabId: "panel-1-tab-1",
        entries: renderEntries,
        columns: renderColumns,
        sort: { columnId: "name", direction: "asc" },
        currentPath: "D:\\",
        selectedEntryIds: selectedIds,
        viewMode: "details",
        detailsRowHeight: 42,
        tooltipHoverDelayMs,
        onSort: () => undefined,
        onSelect: (entry, multi) => selectedEntries.push({ entryId: entry.id, multi }),
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
        onOpenNativeContextMenu: (payload) => nativeMenus.push(payload),
        onResizeColumn: () => undefined,
        onMoveColumn: (sourceId, targetId, placement) => columnOrderChanges.push({ sourceId, targetId, placement }),
        onDropEntries: () => undefined,
        onInlineEditChange: () => undefined,
        onInlineEditCommit: () => undefined,
        onInlineEditCancel: () => undefined
      })
    );
  }

  try {
    await assertTest("workspace file listing styles no longer draw accent left borders", async () => {
      const css = readWorkspaceCss();
      assert.equal(css.includes("border-left: 2px solid var(--row-accent);"), false);
    });

    await assertTest("FileListingShell applies the configurable details row height to the listing root", async () => {
      await act(async () => {
        render();
        await flushEffects();
      });

      const listing = container.querySelector(".file-listing");
      assert.ok(listing);
      assert.equal((listing as HTMLElement).style.getPropertyValue("--details-row-height"), "42px");
    });

    await assertTest("workspace details header resize dividers are visible by default", async () => {
      const css = readWorkspaceCss();
      const defaultDividerRule = css.match(/\.file-header-resizer::after\s*\{([^}]*)\}/)?.[1] ?? "";

      assert.notEqual(defaultDividerRule, "");
      assert.match(defaultDividerRule, /background:\s*[^;]+;/);
      assert.doesNotMatch(defaultDividerRule, /background:\s*transparent\b/);
      assert.match(css, /\.file-header-resizer:hover::after\s*\{[\s\S]*background:\s*#8a8a8a;/);
    });

    await assertTest("FileListingShell exposes column menu items in the current full column order", async () => {
      const menuColumns: ColumnDefinition[] = [
        { id: "name", label: "Name", visible: true, width: "240px", align: "left" },
        { id: "size", label: "Size", visible: true, width: "96px", align: "right" },
        { id: "type", label: "Type", visible: true, width: "112px", align: "left" },
        { id: "extension", label: "Extension", visible: false, width: "100px", align: "left" },
        { id: "comment", label: "Comment", visible: false, width: "220px", align: "left" }
      ];

      await act(async () => {
        render({ renderColumns: menuColumns });
        await flushEffects();
      });

      const header = container.querySelector(".file-listing__header");
      assert.ok(header);
      await act(async () => {
        header.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
        await flushEffects();
      });

      assert.deepEqual(
        Array.from(container.querySelectorAll<HTMLElement>("[data-column-menu-id]")).map((item) => item.dataset.columnMenuId),
        ["name", "size", "type", "extension", "comment"]
      );
    });

    await assertTest("FileListingShell emits a column move when a detail header is pointer-dragged", async () => {
      columnOrderChanges.length = 0;
      const dragColumns: ColumnDefinition[] = [
        { id: "name", label: "Name", visible: true, width: "240px", align: "left" },
        { id: "type", label: "Type", visible: true, width: "112px", align: "left" },
        { id: "extension", label: "Extension", visible: false, width: "100px", align: "left" },
        { id: "size", label: "Size", visible: true, width: "96px", align: "right" }
      ];

      await act(async () => {
        render({ renderColumns: dragColumns });
        await flushEffects();
      });

      const source = container.querySelector<HTMLElement>("[data-column-id='size']");
      const target = container.querySelector<HTMLElement>("[data-column-id='type']");
      assert.ok(source);
      assert.ok(target);
      Object.defineProperty(target, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ left: 100, right: 212, top: 0, bottom: 24, width: 112, height: 24 })
      });
      const restore = stubElementFromPoint(target);

      await act(async () => {
        source.dispatchEvent(createPointerEvent("pointerdown", { pointerId: 7, button: 0, clientX: 360, clientY: 12 }));
        window.dispatchEvent(createPointerEvent("pointermove", { pointerId: 7, clientX: 120, clientY: 12 }));
        window.dispatchEvent(createPointerEvent("pointerup", { pointerId: 7, clientX: 120, clientY: 12 }));
        await flushEffects();
      });
      restore();

      assert.deepEqual(columnOrderChanges, [{ sourceId: "size", targetId: "type", placement: "before" }]);
    });

    await assertTest("FileListingShell shows a multiline row tooltip after the configured hover delay", async () => {
      const tooltipEntries = entries.map((entry) =>
        entry.id === "file-source"
          ? {
              ...entry,
              tags: ["个人"],
              comment: "这是我自己的数据的文件夹，里面主要存放一些个人数据。\n第二行"
            }
          : entry
      );

      await act(async () => {
        render({ renderEntries: tooltipEntries, tooltipHoverDelayMs: 0 });
        await flushEffects();
      });

      const row = Array.from(container.querySelectorAll<HTMLElement>("[data-entry-path]")).find(
        (element) => element.dataset.entryPath === "D:\\report.txt"
      );
      assert.ok(row);
      await act(async () => {
        row!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: 120, clientY: 80 }));
        await flushEffects();
      });

      const tooltip = container.querySelector<HTMLElement>(".file-listing__tooltip");
      assert.ok(tooltip);
      assert.equal(tooltip!.textContent?.includes("名称：report.txt"), true);
      assert.equal(tooltip!.textContent?.includes("修改日期：2026-04-21 10:00"), true);
      assert.equal(tooltip!.textContent?.includes("标签：个人"), true);
      assert.equal(tooltip!.textContent?.includes("第二行"), true);
      assert.match(readWorkspaceCss(), /\.file-listing__tooltip\s*\{[\s\S]*?text-align:\s*left;/);
      assert.match(readWorkspaceCss(), /\.context-menu\s*\{[\s\S]*?z-index:\s*60;/);
      assert.match(readWorkspaceCss(), /\.file-listing__tooltip\s*\{[\s\S]*?z-index:\s*59;/);
    });

    await assertTest("FileListingShell opens the comment menu from a comment detail cell", async () => {
      customMenus.length = 0;
      nativeMenus.length = 0;
      selectedEntries.length = 0;
      const commentColumns: ColumnDefinition[] = [
        { id: "name", label: "名称", visible: true, width: "240px", align: "left" },
        { id: "comment", label: "注释", visible: true, width: "220px", align: "left" }
      ];

      await act(async () => {
        render({ renderColumns: commentColumns, selectedIds: [] });
        await flushEffects();
      });

      const fileRow = Array.from(container.querySelectorAll<HTMLElement>("[data-entry-path]")).find(
        (element) => element.dataset.entryPath === "D:\\report.txt"
      );
      const commentCell = fileRow?.querySelector<HTMLElement>("[data-cell-column-id='comment']");
      assert.ok(commentCell);
      await act(async () => {
        commentCell!.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 180,
            clientY: 72
          })
        );
        await flushEffects();
      });

      assert.deepEqual(customMenus, [
        {
          mode: "custom",
          scope: "comment",
          columnId: "comment",
          entryPath: "D:\\report.txt"
        }
      ]);
      assert.deepEqual(selectedEntries, [{ entryId: "file-source", multi: false }]);
      assert.deepEqual(nativeMenus, []);
    });
  } finally {
    await act(async () => {
      root.unmount();
      await flushEffects();
    });
  }
})();

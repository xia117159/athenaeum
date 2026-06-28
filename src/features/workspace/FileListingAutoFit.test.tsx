import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { FileListingShell } from "./FileListing";
import { installLegacyInputEventPatch } from "./testDom";
import type { ColumnDefinition, EntryViewModel } from "./types";

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
    .then(() => console.log(`ok - ${name}`))
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

const columns: ColumnDefinition[] = [
  { id: "name", label: "名称", visible: true, width: "2fr", align: "left" },
  { id: "type", label: "类型", visible: true, width: "1fr", align: "left" },
  { id: "size", label: "大小", visible: true, width: "1fr", align: "right" },
  { id: "modified", label: "修改时间", visible: true, width: "1.2fr", align: "left" },
  { id: "tags", label: "标签", visible: false, width: "1fr", align: "left" }
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
    tags: [],
    description: "Archive folder"
  },
  {
    id: "file-source",
    name: "very-wide-report-name.txt",
    kind: "file",
    path: "D:\\very-wide-report-name.txt",
    parentPath: "D:\\",
    sizeLabel: "2 KB",
    modifiedLabel: "2026-04-21 10:00",
    extension: ".txt",
    attributes: ["A"],
    accentColor: "#0f6cbd",
    tags: [],
    description: "Text report"
  }
];

export const fileListingAutoFitTests = (async () => {
  installDomEnvironment();
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("test root container is missing");
  }

  const root = ReactDOM.createRoot(container);
  const resizedColumns: Array<{ columnId: ColumnDefinition["id"]; width: string }> = [];
  const originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
  const measuredWidths: Record<string, number> = {
    name: 286,
    type: 124,
    size: 88,
    modified: 172
  };

  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get() {
      const element = this as HTMLElement;
      const columnId = element.dataset.cellColumnId ?? element.closest<HTMLElement>("[data-column-id]")?.dataset.columnId;
      return columnId ? measuredWidths[columnId] ?? 24 : 24;
    }
  });

  try {
    await assertTest("FileListingShell auto-fits columns from measured rendered cell widths", async () => {
      await act(async () => {
        root.render(
          React.createElement(FileListingShell, {
            panelId: "panel-1",
            tabId: "panel-1-tab-1",
            entries,
            columns,
            sort: { columnId: "name", direction: "asc" },
            currentPath: "D:\\",
            selectedEntryIds: [],
            viewMode: "details",
            detailsRowHeight: 42,
            onSort: () => undefined,
            onSelect: () => undefined,
            onOpen: () => undefined,
            onOpenContextMenu: () => undefined,
            onOpenNativeContextMenu: () => undefined,
            onResizeColumn: (columnId, width) => resizedColumns.push({ columnId, width }),
            onDropEntries: () => undefined,
            onInlineEditChange: () => undefined,
            onInlineEditCommit: () => undefined,
            onInlineEditCancel: () => undefined
          })
        );
        await flushEffects();
      });

      const header = container.querySelector(".file-listing__header");
      assert.ok(header);
      await act(async () => {
        header.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 96, clientY: 40 }));
        await flushEffects();
      });

      const autoFitItem = Array.from(container.querySelectorAll<HTMLButtonElement>(".column-header-menu button")).find((button) =>
        button.textContent?.includes("立即自动调整列宽")
      );
      assert.ok(autoFitItem);
      await act(async () => {
        autoFitItem!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await flushEffects();
      });

      assert.deepEqual(resizedColumns, [
        { columnId: "name", width: "302px" },
        { columnId: "type", width: "140px" },
        { columnId: "size", width: "104px" },
        { columnId: "modified", width: "188px" }
      ]);
    });
  } finally {
    if (originalScrollWidth) {
      Object.defineProperty(HTMLElement.prototype, "scrollWidth", originalScrollWidth);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth");
    }
    await act(async () => {
      root.unmount();
      await flushEffects();
    });
  }
})();

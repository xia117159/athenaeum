import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { FileListingShell } from "./FileListing";
import type { ColumnDefinition, ColumnId, EntryViewModel, SortState } from "./types";

const { JSDOM } = require("jsdom") as {
  JSDOM: new (html?: string, options?: { url?: string }) => { window: Window & typeof globalThis };
};

function assertTest(name: string, fn: () => Promise<void>) {
  return fn().then(() => console.log(`ok - ${name}`));
}

function installDomEnvironment() {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://localhost" });
  globalThis.window = dom.window as typeof globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Element = dom.window.Element;
  globalThis.Node = dom.window.Node;
  globalThis.Event = dom.window.Event;
  globalThis.MouseEvent = dom.window.MouseEvent;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

async function flushEffects() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const columns: ColumnDefinition[] = [
  { id: "name", label: "Name", visible: true, width: "2fr", align: "left" },
  { id: "modified", label: "Modified", visible: true, width: "1fr", align: "left" }
];
const entries: EntryViewModel[] = [
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
const sort: SortState = { columnId: "name", direction: "asc" };

export const completion = (async () => {
  const dom = installDomEnvironment();
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("test root container is missing");
  }
  const root = ReactDOM.createRoot(container);
  const sortedColumns: ColumnId[] = [];

  function render() {
    root.render(
      React.createElement(FileListingShell, {
        panelId: "panel-1",
        tabId: "panel-1-tab-1",
        entries,
        columns,
        sort,
        currentPath: "D:\\",
        selectedEntryIds: [],
        viewMode: "details",
        detailsRowHeight: 42,
        onSort: (columnId) => sortedColumns.push(columnId),
        onSelect: () => undefined,
        onOpen: () => undefined,
        onOpenContextMenu: () => undefined,
        onOpenNativeContextMenu: () => undefined,
        onResizeColumn: () => undefined,
        onSetColumnVisibility: () => undefined,
        onMoveColumn: () => undefined,
        onShowAllColumns: () => undefined,
        onDropEntries: () => undefined,
        onAddEntriesToNavigation: () => undefined,
        onStartSystemFileDrag: () => undefined,
        onInlineEditChange: () => undefined,
        onInlineEditCommit: () => undefined,
        onInlineEditCancel: () => undefined
      })
    );
  }

  try {
    await assertTest("FileListingShell sorts when pointer capture retargets a header click to the cell", async () => {
      sortedColumns.length = 0;
      await act(async () => {
        render();
        await flushEffects();
      });
      const nameHeaderCell = container.querySelector<HTMLElement>('[data-column-id="name"]');
      assert.ok(nameHeaderCell);
      await act(async () => {
        nameHeaderCell.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await flushEffects();
      });
      assert.deepEqual(sortedColumns, ["name"]);
    });

    await assertTest("FileListingShell does not sort when clicking a header resize handle", async () => {
      sortedColumns.length = 0;
      const resizeHandle = container.querySelector<HTMLElement>(".file-header-resizer");
      assert.ok(resizeHandle);
      await act(async () => {
        resizeHandle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await flushEffects();
      });
      assert.deepEqual(sortedColumns, []);
    });
  } finally {
    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    dom.window.close();
  }
})();

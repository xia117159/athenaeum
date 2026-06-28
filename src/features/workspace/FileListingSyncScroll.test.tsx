import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { FileListingShell } from "./FileListing";
import type { ColumnDefinition, EntryViewModel, PanelId, SortState } from "./types";

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
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

async function flushEffects() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const columns: ColumnDefinition[] = [{ id: "name", label: "名称", visible: true, width: "2fr", align: "left" }];
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

export const completion = (async () => {
  const dom = installDomEnvironment();
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("test root container is missing");
  }
  const testContainer = container;
  const root = ReactDOM.createRoot(container);
  const syncScrollEvents: Array<{ panelId: PanelId; deltaX: number; deltaY: number }> = [];
  const sort: SortState = { columnId: "name", direction: "asc" };

  function render(syncScrollEnabled: boolean, panelId: PanelId = "panel-1") {
    root.render(
      React.createElement(FileListingShell, {
        panelId,
        tabId: "panel-1-tab-1",
        entries,
        columns,
        sort,
        currentPath: "D:\\",
        selectedEntryIds: ["file-source"],
        viewMode: "details",
        detailsRowHeight: 42,
        tooltipHoverDelayMs: 200,
        entryDropMoveBinding: "Shift",
        contextMenuDefault: "native",
        contextMenuToggleBinding: "Shift",
        syncScrollEnabled,
        onSyncScroll: (eventPanelId, deltaX, deltaY) => syncScrollEvents.push({ panelId: eventPanelId, deltaX, deltaY }),
        onSort: () => undefined,
        onResizeColumn: () => undefined,
        onSetColumnVisibility: () => undefined,
        onMoveColumn: () => undefined,
        onShowAllColumns: () => undefined,
        onSelect: () => undefined,
        onSelectRange: () => undefined,
        onOpen: () => undefined,
        onOpenContextMenu: () => undefined,
        onOpenNativeContextMenu: () => undefined,
        onDropEntries: () => undefined,
        onAddEntriesToNavigation: () => undefined,
        onStartSystemFileDrag: () => undefined,
        onInlineEditChange: () => undefined,
        onInlineEditCommit: () => undefined,
        onInlineEditCancel: () => undefined
      })
    );
  }

  async function dispatchWheel(deltaX: number, deltaY: number) {
    const scroll = testContainer.querySelector(".file-listing__scroll");
    assert.ok(scroll);
    const wheel = new Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperties(wheel, {
      deltaX: { configurable: true, value: deltaX },
      deltaY: { configurable: true, value: deltaY }
    });
    await act(async () => {
      scroll.dispatchEvent(wheel);
      await flushEffects();
    });
  }

  try {
    await assertTest("FileListingShell emits wheel deltas for synchronized scrolling when enabled", async () => {
      syncScrollEvents.length = 0;
      await act(async () => {
        render(true, "panel-2");
        await flushEffects();
      });
      await dispatchWheel(6, 48);
      assert.deepEqual(syncScrollEvents, [{ panelId: "panel-2", deltaX: 6, deltaY: 48 }]);
    });

    await assertTest("FileListingShell ignores wheel deltas for synchronized scrolling when disabled", async () => {
      syncScrollEvents.length = 0;
      await act(async () => {
        render(false);
        await flushEffects();
      });
      await dispatchWheel(1, 12);
      assert.deepEqual(syncScrollEvents, []);
    });
  } finally {
    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    dom.window.close();
  }
})();

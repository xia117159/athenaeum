import assert from "node:assert/strict";
import React, { act, useState } from "react";
import ReactDOM from "react-dom/client";
import { FileListingShell } from "./FileListing";
import type { EntryViewModel } from "./types";

const { JSDOM } = require("jsdom") as { JSDOM: new (html?: string, options?: { url?: string }) => { window: Window & typeof globalThis } };
const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost" });
globalThis.window = dom.window as typeof globalThis.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.Event = dom.window.Event;
dom.window.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number;
dom.window.cancelAnimationFrame = (id: number) => clearTimeout(id);
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const entries: EntryViewModel[] = Array.from({ length: 20_000 }, (_, index) => ({
  id: `file-${index}`, name: `file-${index}.txt`, kind: "file", path: `D:\\file-${index}.txt`, parentPath: "D:\\",
  sizeLabel: "1 KB", modifiedLabel: "2026-09-26", extension: ".txt", attributes: [], tags: [],
  description: "", accentColor: ""
}));
const columns = [{ id: "name" as const, label: "Name", visible: true, width: "300px", align: "left" as const }];
const sort = { columnId: "name" as const, direction: "asc" as const };
const renderCounts = new Map<string, number>();
const onRowRender = (id: string) => renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1);

function Harness() {
  const [selection, setSelection] = useState<string[]>([]);
  return <FileListingShell panelId="panel-1" tabId="tab-1" entries={entries} entriesAreProjected columns={columns} sort={sort}
    currentPath="D:\\" selectedEntryIds={selection} viewMode="details" detailsRowHeight={24} tooltipHoverDelayMs={0}
    onSort={() => undefined} onSelect={(entry) => setSelection([entry.id])} onOpen={() => undefined}
    onOpenContextMenu={() => undefined} onOpenNativeContextMenu={() => undefined}
    onResizeColumn={() => undefined} onDropEntries={() => undefined} onInlineEditChange={() => undefined}
    onInlineEditCommit={() => undefined} onInlineEditCancel={() => undefined} onRowRender={onRowRender} />;
}

export const completion = (async () => {
  const root = ReactDOM.createRoot(document.getElementById("root")!);
  try {
    await act(async () => { root.render(<Harness />); });
    const first = document.querySelector<HTMLElement>("#entry-file-0")!;
    assert.ok(first, "the first row must mount");
    const firstBefore = renderCounts.get("file-0") ?? 0;
    const secondBefore = renderCounts.get("file-1") ?? 0;
    assert.ok(firstBefore > 0 && secondBefore > 0, "the render probe observes visible row bodies");
    assert.ok(document.querySelectorAll("[data-entry-path]").length < 200,
      "a 20k listing mounts only a bounded visible subset");

    await act(async () => { first.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    assert.equal(renderCounts.get("file-0"), firstBefore + 1, "selected row updates");
    assert.equal(renderCounts.get("file-1"), secondBefore, "unaffected row stays memoized");

    await act(async () => { first.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true, clientX: 20, clientY: 30 })); });
    assert.ok(document.querySelector(".file-listing__tooltip"), "hover opens the independent tooltip layer");
    const afterHover = renderCounts.get("file-1");
    await act(async () => { first.dispatchEvent(new dom.window.MouseEvent("mousemove", { bubbles: true, clientX: 40, clientY: 50 })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    assert.equal(renderCounts.get("file-1"), afterHover, "tooltip movement never rerenders a row");
    assert.equal((document.querySelector(".file-listing__tooltip") as HTMLElement).style.left, "54px");
    console.log("ok - 20k listing selected row isolation and tooltip movement");
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
  }
})();

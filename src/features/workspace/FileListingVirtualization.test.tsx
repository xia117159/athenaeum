import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { FileSystemIcon } from "./FileSystemIcon";
import { peekSystemIcon, setSystemIconResolverForTests } from "./systemIconGateway";
import type { EntryViewModel, TabViewMode } from "./types";
import type { FolderListingRow } from "./folderExpansion";

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
Object.defineProperty(globalThis.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
Object.defineProperty(globalThis.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 800 });
Object.defineProperty(globalThis.HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement) {
    if (this.classList.contains("file-listing__virtual-row")) {
      const listing = this.closest<HTMLElement>(".file-listing");
      const mode = listing?.dataset.viewMode;
      if (mode === "details") return Number.parseFloat(listing?.style.getPropertyValue("--details-row-height") ?? "") || 24;
      if (mode === "content") return 112;
      if (mode === "list") return 42;
      if (mode === "tiles") return 76;
      return ({ "extra-large-icons": 180, "large-icons": 156, "medium-icons": 140, "small-icons": 124 } as Record<string, number>)[mode ?? ""] ?? 42;
    }
    return 600;
  }
});
Object.defineProperty(globalThis.HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 800 });
(globalThis.HTMLElement.prototype as HTMLElement & { attachEvent: () => void; detachEvent: () => void }).attachEvent = () => undefined;
(globalThis.HTMLElement.prototype as HTMLElement & { attachEvent: () => void; detachEvent: () => void }).detachEvent = () => undefined;
Object.defineProperty(globalThis.HTMLElement.prototype, "scrollHeight", {
  configurable: true,
  get(this: HTMLElement) {
    const virtualContent = this.querySelector<HTMLElement>(".file-listing__virtual-content");
    return virtualContent ? Number.parseFloat(virtualContent.style.height) : 600;
  }
});
globalThis.HTMLElement.prototype.getBoundingClientRect = () => ({
  x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600,
  toJSON: () => ({})
} as DOMRect);
Object.defineProperty(globalThis.HTMLElement.prototype, "scrollTo", {
  configurable: true,
  value(this: HTMLElement, options: ScrollToOptions) {
    this.scrollTop = options.top ?? this.scrollTop;
    queueMicrotask(() => this.dispatchEvent(new dom.window.Event("scroll")));
  }
});
const { FileListingShell, TAB_VIEW_MODE_OPTIONS } = require("./FileListing") as typeof import("./FileListing");

const container = document.getElementById("root")!;
const root = ReactDOM.createRoot(container);
const entries: EntryViewModel[] = Array.from({ length: 20_000 }, (_, index) => ({
  id: `file-${index}`, name: `file-${String(index).padStart(5, "0")}.txt`, kind: "file",
  path: `D:\\file-${index}.txt`, parentPath: "D:\\", sizeLabel: "1 KB",
  modifiedLabel: "2026-09-26", extension: ".txt", attributes: [], tags: [], description: "", accentColor: ""
}));
const columns = [{ id: "name" as const, label: "Name", visible: true, width: "300px", align: "left" as const }];
function listing(viewMode: TabViewMode, selectionCursorId?: string, keyboardNavToken?: symbol, inlineEdit?: { mode: "rename"; entryId: string; value: string; kind: "file"; parentPath: string }, options?: {
  tabId?: string; initialScrollTop?: number; detailsRowHeight?: number; onScrollTopChange?: (top: number) => void;
  projectedEntries?: EntryViewModel[]; entriesAreProjected?: boolean;
  folderRows?: FolderListingRow[]; onSelectMultiple?: (ids: string[]) => void; onClearSelection?: () => void
}) {
  return <FileListingShell panelId="panel-1" tabId={options?.tabId ?? "tab-1"} entries={options?.projectedEntries ?? entries} columns={columns}
    sort={{ columnId: "name", direction: "asc" }} currentPath="D:\\" selectedEntryIds={selectionCursorId ? [selectionCursorId] : []}
    selectionCursorId={selectionCursorId} keyboardNavToken={keyboardNavToken} viewMode={viewMode} detailsRowHeight={options?.detailsRowHeight ?? 24} inlineEdit={inlineEdit}
    initialScrollTop={options?.initialScrollTop} onScrollTopChange={options?.onScrollTopChange}
    entriesAreProjected={options?.entriesAreProjected}
    folderRows={options?.folderRows}
    onSort={() => undefined} onSelect={() => undefined} onSelectMultiple={options?.onSelectMultiple} onClearSelection={options?.onClearSelection} onOpen={() => undefined}
    onOpenContextMenu={() => undefined} onOpenNativeContextMenu={() => undefined}
    onResizeColumn={() => undefined} onDropEntries={() => undefined} onInlineEditChange={() => undefined}
    onInlineEditCommit={() => undefined} onInlineEditCancel={() => undefined} />;
}

export const completion = (async () => {
  setSystemIconResolverForTests(async () => "data:image/mock;base64,icon");
  try {
    for (const { id } of TAB_VIEW_MODE_OPTIONS) {
      await act(async () => { root.render(listing(id)); });
      const rows = container.querySelectorAll("[data-entry-path]");
      assert.ok(rows.length > 0, `${id} must mount its first row`);
      assert.equal(rows[0].getAttribute("data-entry-path"), entries[0].path, `${id} first row`);
      const rowHeight = ({ details: 24, content: 112, list: 42, tiles: 76,
        "extra-large-icons": 180, "large-icons": 156, "medium-icons": 140, "small-icons": 124 } as Record<string, number>)[id];
      const columns = ({ details: 1, content: 1, list: 3, tiles: 3,
        "extra-large-icons": 4, "large-icons": 4, "medium-icons": 5, "small-icons": 7 } as Record<string, number>)[id];
      const maxMounted = (Math.ceil(600 / rowHeight) + 1 + 20) * columns;
      assert.ok(rows.length <= maxMounted, `${id} mounted ${rows.length} entries; viewport/overscan limit is ${maxMounted}`);
    }
    const projectedEntries = [...entries].reverse();
    for (const { id } of TAB_VIEW_MODE_OPTIONS) {
      await act(async () => { root.render(listing(id, undefined, undefined, undefined, { projectedEntries, entriesAreProjected: true })); });
      assert.equal(container.querySelector("[data-entry-path]")?.getAttribute("data-entry-path"), projectedEntries[0].path,
        `${id} must preserve the authoritative projection order`);
    }
    await act(async () => { root.render(listing("details")); });
    assert.equal(container.querySelector("#entry-file-15000"), null);
    await act(async () => { root.render(listing("details", "file-15000", Symbol("keyboard"))); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    assert.ok(container.querySelector("#entry-file-15000"), `keyboard navigation mounts the target row (scrollTop=${container.querySelector<HTMLElement>(".file-listing__scroll")?.scrollTop}, first=${container.querySelector("[data-entry-path]")?.id})`);

    await act(async () => { root.render(listing("details", undefined, undefined, { mode: "rename", entryId: "file-15000", value: "renamed", kind: "file", parentPath: "D:\\" })); });
    const editInput = container.querySelector<HTMLInputElement>(".inline-edit-input");
    assert.ok(editInput, "a distant inline edit mounts its input");
    assert.equal(document.activeElement, editInput, "distant inline edit receives focus");
    assert.ok((container.querySelector(".file-listing__scroll") as HTMLElement).scrollTop > 0, "the edited row scrolls into view");

    await act(async () => { root.render(<React.Fragment key="tab-b">{listing("details", undefined, undefined, undefined, { tabId: "tab-b" })}</React.Fragment>); });
    let remembered = -1;
    await act(async () => { root.render(<React.Fragment key="tab-a">{listing("details", undefined, undefined, undefined, { tabId: "tab-a", initialScrollTop: 1200, onScrollTopChange: (top) => { remembered = top; } })}</React.Fragment>); });
    const scroll = container.querySelector<HTMLElement>(".file-listing__scroll")!;
    assert.equal(scroll.scrollTop, 1200, "tab A restores its own scroll offset before paint");
    await act(async () => { scroll.scrollTop = 1800; scroll.dispatchEvent(new dom.window.Event("scroll", { bubbles: true })); });
    assert.equal(remembered, 1800, "tab A records later scroll movement");

    const before = Number.parseFloat(container.querySelector<HTMLElement>(".file-listing__virtual-content")!.style.height);
    await act(async () => { root.render(<React.Fragment key="tab-a">{listing("details", undefined, undefined, undefined, { tabId: "tab-a", initialScrollTop: 1200, detailsRowHeight: 40 })}</React.Fragment>); });
    const after = Number.parseFloat(container.querySelector<HTMLElement>(".file-listing__virtual-content")!.style.height);
    assert.ok(after > before * 1.5, `row-height update must invalidate virtual measurements: ${before} -> ${after}`);

    const expandedEntries = [...entries];
    expandedEntries[100] = { ...entries[100], kind: "folder", name: "parent", path: "D:\\parent" };
    expandedEntries[101] = { ...entries[101], path: "D:\\parent\\child.txt", parentPath: "D:\\parent" };
    const folderRows = expandedEntries.map((entry, index) => ({ entry, depth: index === 101 ? 1 : 0 }));
    let selectedByMarquee: string[] = [];
    await act(async () => { root.render(<React.Fragment key="marquee">{listing("details", undefined, undefined, undefined, {
      tabId: "marquee", projectedEntries: expandedEntries, entriesAreProjected: true, folderRows,
      onSelectMultiple: (ids) => { selectedByMarquee = ids; }
    })}</React.Fragment>); });
    const marqueeScroll = container.querySelector<HTMLElement>(".file-listing__scroll")!;
    const body = container.querySelector<HTMLElement>(".file-listing__body")!;
    const header = container.querySelector<HTMLElement>(".file-listing__header")!;
    header.getBoundingClientRect = () => ({ height: 24 } as DOMRect);
    body.getBoundingClientRect = () => ({ left: 0, top: 24 - marqueeScroll.scrollTop, right: 800, bottom: 24 - marqueeScroll.scrollTop + 480_000, width: 800, height: 480_000 } as DOMRect);
    marqueeScroll.scrollTop = 2400;
    await act(async () => { marqueeScroll.dispatchEvent(new dom.window.Event("scroll")); await new Promise((resolve) => setTimeout(resolve, 20)); });
    await act(async () => {
      marqueeScroll.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 790, clientY: 48 }));
      window.dispatchEvent(new dom.window.MouseEvent("mousemove", { bubbles: true, clientX: 0, clientY: 100 }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      window.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true, clientX: 0, clientY: 100 }));
    });
    assert.deepEqual(selectedByMarquee, expandedEntries.slice(101, 104).map((entry) => entry.id),
      "a scrolled marquee selects the expanded child and adjacent projected rows exactly");
    const beforeEdge = marqueeScroll.scrollTop;
    await act(async () => {
      marqueeScroll.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 790, clientY: 48 }));
      window.dispatchEvent(new dom.window.MouseEvent("mousemove", { bubbles: true, clientX: 0, clientY: 590 }));
      await new Promise((resolve) => setTimeout(resolve, 80));
      window.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true, clientX: 0, clientY: 590 }));
    });
    assert.ok(marqueeScroll.scrollTop > beforeEdge, "edge drag scrolls the listing");
    const lastIndex = Math.floor((566 + marqueeScroll.scrollTop - 1) / 24);
    assert.deepEqual(selectedByMarquee, expandedEntries.slice(101, lastIndex + 1).map((entry) => entry.id),
      "edge scrolling retains the exact traversed selection from the expanded child");

    // 拖动竖向滚动条不能开始框选，不能当作空白点击清空选择，也不能阻止原生滚动条拖动。
    const selectionBeforeScrollbar = selectedByMarquee;
    let clearedByScrollbar = false;
    await act(async () => { root.render(<React.Fragment key="marquee">{listing("details", "file-101", undefined, undefined, {
      tabId: "marquee", projectedEntries: expandedEntries, entriesAreProjected: true, folderRows,
      onSelectMultiple: (ids) => { selectedByMarquee = ids; }, onClearSelection: () => { clearedByScrollbar = true; }
    })}</React.Fragment>); });
    Object.defineProperty(marqueeScroll, "clientWidth", { configurable: true, value: 783 });
    let scrollbarPressNotPrevented = false;
    await act(async () => {
      scrollbarPressNotPrevented = marqueeScroll.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 795, clientY: 300 }));
      window.dispatchEvent(new dom.window.MouseEvent("mousemove", { bubbles: true, clientX: 0, clientY: 100 }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      window.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true, clientX: 0, clientY: 100 }));
    });
    delete (marqueeScroll as { clientWidth?: number }).clientWidth;
    assert.equal(selectedByMarquee, selectionBeforeScrollbar, "a scrollbar drag does not start a marquee");
    assert.equal(clearedByScrollbar, false, "a scrollbar press does not clear the selection");
    assert.equal(scrollbarPressNotPrevented, true, "a scrollbar press keeps the native scrollbar drag");

    const iconRequest = { kind: "file" as const, path: "D:\\cached.txt", extension: ".txt", includeOverlays: true };
    await act(async () => { root.render(<FileSystemIcon {...iconRequest} />); });
    assert.ok(peekSystemIcon(iconRequest));
    await act(async () => { root.render(<div />); });
    await act(async () => { root.render(<FileSystemIcon {...iconRequest} />); });
    assert.ok(container.querySelector(".entry-icon img"), "cached icon is shown on the remount frame");
    console.log("ok - 20k listing virtualization, off-DOM keyboard focus, synchronous cached icons");
  } finally {
    await act(async () => { root.unmount(); });
    setSystemIconResolverForTests();
    dom.window.close();
  }
})();

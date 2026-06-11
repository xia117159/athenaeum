import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { FileListingShell, TAB_VIEW_MODE_OPTIONS } from "./FileListing";
import {
  clearSystemIconCacheForTests,
  setSystemIconResolverForTests,
  type SystemIconRequest
} from "./systemIconGateway";
import type { ColumnDefinition, EntryViewModel, InlineEditState, NativeContextMenuRequest, PanelId } from "./types";

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
    }
  };
}

function dispatchDragEvent(
  target: Element,
  type: string,
  dataTransfer: ReturnType<typeof createDataTransfer>,
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
    dataTransfer: ReturnType<typeof createDataTransfer>;
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
  const customMenus: Array<{ mode: string; scope: string }> = [];
  const nativeMenus: Array<{ paths: string[]; clientX: number; clientY: number; screenX: number; screenY: number }> = [];
  const selectedEntries: Array<{ entryId: string; multi: boolean }> = [];
  const resizedColumns: Array<{ columnId: ColumnDefinition["id"]; width: string }> = [];
  const resolvedIconRequests: SystemIconRequest[] = [];
  const inlineChanges: string[] = [];
  const inlineCommits: string[] = [];
  const inlineCancels: string[] = [];

  setSystemIconResolverForTests(async (request) => {
    resolvedIconRequests.push(request);
    return `data:image/mock;base64,${request.kind}`;
  });

  function render(
    viewMode = "details" as (typeof TAB_VIEW_MODE_OPTIONS)[number]["id"],
    inlineEdit?: InlineEditState,
    renderPanelId: PanelId = "panel-1",
    selectedIds: string[] = ["file-source"],
    entryDropMoveBinding = "Shift"
  ) {
    root.render(
      React.createElement(FileListingShell, {
        panelId: renderPanelId,
        tabId: "panel-1-tab-1",
        entries,
        columns,
        sort: { columnId: "name", direction: "asc" },
        currentPath: "D:\\",
        selectedEntryIds: selectedIds,
        viewMode,
        inlineEdit,
        detailsRowHeight: 42,
        entryDropMoveBinding,
        onSort: () => undefined,
        onResizeColumn: (columnId, width) => {
          resizedColumns.push({ columnId, width });
        },
        onSelect: (entry, multi) => {
          selectedEntries.push({ entryId: entry.id, multi });
        },
        onOpen: () => undefined,
        onOpenContextMenu: (payload) => {
          customMenus.push({ mode: payload.mode, scope: payload.scope });
        },
        onOpenNativeContextMenu: (payload: NativeContextMenuRequest) => {
          nativeMenus.push({
            paths: [...payload.paths],
            clientX: payload.clientX,
            clientY: payload.clientY,
            screenX: payload.screenX,
            screenY: payload.screenY
          });
        },
        onDropEntries: (paths, destination, operation) => {
          dropped.push({ paths, destination, operation });
        },
        onInlineEditChange: (value) => {
          inlineChanges.push(value);
        },
        onInlineEditCommit: () => {
          inlineCommits.push("commit");
        },
        onInlineEditCancel: () => {
          inlineCancels.push("cancel");
        }
      })
    );
  }

  try {
    await assertTest("FileListingShell keeps the details header outside the scrollable content region", async () => {
      await act(async () => {
        render("details");
        await flushEffects();
      });

      const header = container.querySelector(".file-listing__header");
      const scroll = container.querySelector(".file-listing__scroll");

      assert.ok(header);
      assert.ok(scroll);
      assert.equal(scroll.contains(header), false);
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

    await assertTest("FileListingShell emits move and Ctrl-copy drop operations onto folder rows", async () => {
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

      const moveTransfer = createDataTransfer();
      const dragOverEvents: Event[] = [];
      await act(async () => {
        dispatchDragEvent(sourceRow, "dragstart", moveTransfer);
        moveTransfer.setReadBlocked(true);
        dragOverEvents.push(dispatchDragEvent(targetRow, "dragover", moveTransfer));
        moveTransfer.setReadBlocked(false);
        dispatchDragEvent(targetRow, "drop", moveTransfer);
        await flushEffects();
      });

      const copyTransfer = createDataTransfer();
      await act(async () => {
        dispatchDragEvent(sourceRow, "dragstart", copyTransfer);
        copyTransfer.setReadBlocked(true);
        dragOverEvents.push(dispatchDragEvent(targetRow, "dragover", copyTransfer, true));
        copyTransfer.setReadBlocked(false);
        dispatchDragEvent(targetRow, "drop", copyTransfer, true);
        await flushEffects();
      });

      assert.equal(dragOverEvents[0].defaultPrevented, true);
      assert.equal(dragOverEvents[1].defaultPrevented, true);
      assert.deepEqual(dropped, [
        { paths: ["D:\\report.txt"], destination: "D:\\Archive", operation: "move" },
        { paths: ["D:\\report.txt"], destination: "D:\\Archive", operation: "copy" }
      ]);
    });

    await assertTest("FileListingShell allows dropping entries onto the current directory when transfer types are hidden", async () => {
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
        dispatchDragEvent(sourceRow, "dragstart", transfer);
        transfer.setReadBlocked(true);
        transfer.setTypesHidden(true);
        dragOverEvent = dispatchDragEvent(scroll, "dragover", transfer);
        transfer.setReadBlocked(false);
        transfer.setTypesHidden(false);
        dispatchDragEvent(scroll, "drop", transfer);
        await flushEffects();
      });

      assert.equal(dragOverEvent?.defaultPrevented, true);
      assert.deepEqual(dropped, [{ paths: ["D:\\report.txt"], destination: "D:\\", operation: "move" }]);
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

    await assertTest("workspace file listing styles no longer draw accent left borders", async () => {
      const css = fs.readFileSync(path.join(process.cwd(), "src/features/workspace/workspace.css"), "utf8");
      assert.equal(css.includes("border-left: 2px solid var(--row-accent);"), false);
    });

    await assertTest("FileListingShell applies the configurable details row height to the listing root", async () => {
      await act(async () => {
        render("details");
        await flushEffects();
      });

      const listing = container.querySelector(".file-listing");
      assert.ok(listing);
      assert.equal((listing as HTMLElement).style.getPropertyValue("--details-row-height"), "42px");
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
        "application/x-simplefilemanager-entry-list",
        JSON.stringify({ sourcePanelId: "panel-1", sourceTabId: "panel-1-tab-1", paths: ["D:\\report.txt"] })
      );
      await act(async () => {
        dispatchDragEvent(targetRow, "dragover", copyTransfer);
        dispatchDragEvent(targetRow, "drop", copyTransfer);
        await flushEffects();
      });

      const moveTransfer = createDataTransfer();
      moveTransfer.setData(
        "application/x-simplefilemanager-entry-list",
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

    await assertTest("FileListingShell opens the app context menu when blank space is right-clicked", async () => {
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
            clientY: 64
          })
        );
        await flushEffects();
      });

      assert.deepEqual(customMenus, [{ mode: "custom", scope: "panel" }]);
      assert.equal(nativeMenus.length, 0);
    });

    await assertTest("FileListingShell opens the app context menu from blank icon-card padding", async () => {
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
            clientY: 80
          })
        );
        await flushEffects();
      });

      assert.deepEqual(customMenus, [{ mode: "custom", scope: "panel" }]);
      assert.equal(nativeMenus.length, 0);
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
          paths: ["D:\\report.txt"],
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
          paths: ["D:\\Archive"],
          clientX: 20,
          clientY: 28,
          screenX: 420,
          screenY: 680
        }
      ]);
      assert.equal(customMenus.length, 0);
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

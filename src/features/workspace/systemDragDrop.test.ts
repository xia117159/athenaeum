import assert from "node:assert/strict";
import {
  clearSystemFileDropHighlight,
  createSystemFileDropPayloadHandler,
  findSystemFileDropTargetFromPoint,
  updateSystemFileDropHighlight,
  warnIfExplorerFileDropsAreBlocked
} from "./systemDragDrop";

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

function assertTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function installDomEnvironment() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost"
  });
  globalThis.window = dom.window as typeof globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Element = dom.window.Element;
  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    value: 2
  });
}

function stubElementFromPoint(element: Element | null) {
  const original = document.elementFromPoint;
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: (x: number, y: number) => {
      (document as Document & { __lastPoint?: { x: number; y: number } }).__lastPoint = { x, y };
      return element;
    }
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

export const systemDragDropTests = (() => {
  installDomEnvironment();

  assertTest("findSystemFileDropTargetFromPoint resolves physical Tauri coordinates to a folder target", () => {
    const folder = document.createElement("div");
    folder.dataset.entryDropKind = "folder";
    folder.dataset.entryDropPath = "D:\\Archive";
    document.body.appendChild(folder);

    const restore = stubElementFromPoint(folder);
    try {
      const target = findSystemFileDropTargetFromPoint({ x: 80, y: 120 });
      assert.equal(target?.path, "D:\\Archive");
      assert.equal(target?.kind, "folder");
      assert.deepEqual((document as Document & { __lastPoint?: { x: number; y: number } }).__lastPoint, {
        x: 40,
        y: 60
      });
    } finally {
      restore();
      folder.remove();
    }
  });

  assertTest("updateSystemFileDropHighlight applies Windows drop target classes and clears previous targets", () => {
    const tab = document.createElement("button");
    tab.dataset.entryDropKind = "tab";
    tab.dataset.entryDropPath = "D:\\";
    const listing = document.createElement("div");
    listing.dataset.entryDropKind = "listing";
    listing.dataset.entryDropPath = "D:\\";
    document.body.append(tab, listing);

    let restore = stubElementFromPoint(tab);
    try {
      const target = updateSystemFileDropHighlight({ x: 10, y: 10 });
      assert.equal(target?.path, "D:\\");
      assert.equal(tab.classList.contains("is-entry-drop-target"), true);
      assert.equal(tab.dataset.dropOperation, "copy");
    } finally {
      restore();
    }

    restore = stubElementFromPoint(listing);
    try {
      const target = updateSystemFileDropHighlight({ x: 12, y: 12 });
      assert.equal(target?.path, "D:\\");
      assert.equal(tab.classList.contains("is-entry-drop-target"), false);
      assert.equal(listing.classList.contains("is-drop-target"), true);
      assert.equal(listing.dataset.dropOperation, "copy");
    } finally {
      restore();
      clearSystemFileDropHighlight();
      tab.remove();
      listing.remove();
    }

    assert.equal(listing.classList.contains("is-drop-target"), false);
    assert.equal(listing.dataset.dropOperation, undefined);
  });

  assertTest("updateSystemFileDropHighlight falls back from plain file rows to their listing", () => {
    const listing = document.createElement("div");
    listing.dataset.entryDropKind = "listing";
    listing.dataset.entryDropPath = "D:\\Inbox";
    const fileRow = document.createElement("div");
    fileRow.dataset.entryPath = "D:\\Inbox\\report.txt";
    listing.appendChild(fileRow);
    document.body.appendChild(listing);

    const restore = stubElementFromPoint(fileRow);
    try {
      const target = updateSystemFileDropHighlight({ x: 20, y: 20 });
      assert.equal(target?.path, "D:\\Inbox");
      assert.equal(target?.kind, "listing");
      assert.equal(listing.classList.contains("is-drop-target"), true);
      assert.equal(listing.dataset.dropOperation, "copy");
    } finally {
      restore();
      clearSystemFileDropHighlight();
      listing.remove();
    }

    assert.equal(listing.classList.contains("is-drop-target"), false);
    assert.equal(listing.dataset.dropOperation, undefined);
  });

  assertTest("updateSystemFileDropHighlight recovers when a highlighted listing was removed before the next drag", () => {
    const staleListing = document.createElement("div");
    staleListing.dataset.entryDropKind = "listing";
    staleListing.dataset.entryDropPath = "D:\\Deleted";
    const nextListing = document.createElement("div");
    nextListing.dataset.entryDropKind = "listing";
    nextListing.dataset.entryDropPath = "E:\\Target";
    document.body.append(staleListing, nextListing);

    let restore = stubElementFromPoint(staleListing);
    try {
      updateSystemFileDropHighlight({ x: 10, y: 10 });
      assert.equal(staleListing.classList.contains("is-drop-target"), true);
    } finally {
      restore();
    }

    staleListing.remove();
    restore = stubElementFromPoint(nextListing);
    try {
      const target = updateSystemFileDropHighlight({ x: 12, y: 12 });
      assert.equal(target?.path, "E:\\Target");
      assert.equal(nextListing.classList.contains("is-drop-target"), true);
      assert.equal(nextListing.dataset.dropOperation, "copy");
    } finally {
      restore();
      clearSystemFileDropHighlight();
      nextListing.remove();
    }
  });

  assertTest("createSystemFileDropPayloadHandler drops external files on the highlighted target", () => {
    const listing = document.createElement("div");
    listing.dataset.entryDropKind = "listing";
    listing.dataset.entryDropPath = "D:\\Inbox";
    document.body.appendChild(listing);

    const received: Array<{ paths: string[]; destination: string }> = [];
    const handlePayload = createSystemFileDropPayloadHandler((paths, destination) => {
      received.push({ paths, destination });
    });
    const restore = stubElementFromPoint(listing);
    try {
      handlePayload({
        type: "enter",
        paths: ["C:\\Users\\me\\Desktop\\a.txt"],
        position: { x: 20, y: 20 }
      });
      assert.equal(listing.classList.contains("is-drop-target"), true);
      assert.equal(listing.dataset.dropOperation, "copy");

      handlePayload({
        type: "drop",
        paths: ["C:\\Users\\me\\Desktop\\a.txt"],
        position: { x: 20, y: 20 }
      });
    } finally {
      restore();
      listing.remove();
      clearSystemFileDropHighlight();
    }

    assert.deepEqual(received, [
      {
        paths: ["C:\\Users\\me\\Desktop\\a.txt"],
        destination: "D:\\Inbox"
      }
    ]);
    assert.equal(listing.classList.contains("is-drop-target"), false);
  });

  assertTest("createSystemFileDropPayloadHandler ignores drops after a leave event", () => {
    const listing = document.createElement("div");
    listing.dataset.entryDropKind = "listing";
    listing.dataset.entryDropPath = "D:\\Inbox";
    document.body.appendChild(listing);

    const received: Array<{ paths: string[]; destination: string }> = [];
    const handlePayload = createSystemFileDropPayloadHandler((paths, destination) => {
      received.push({ paths, destination });
    });
    const restore = stubElementFromPoint(listing);
    try {
      handlePayload({
        type: "enter",
        paths: ["C:\\Users\\me\\Desktop\\a.txt"],
        position: { x: 20, y: 20 }
      });
      handlePayload({ type: "leave" });
      handlePayload({
        type: "drop",
        paths: ["C:\\Users\\me\\Desktop\\a.txt"],
        position: { x: 20, y: 20 }
      });
    } finally {
      restore();
      listing.remove();
      clearSystemFileDropHighlight();
    }

    assert.deepEqual(received, []);
  });

  assertTest("warnIfExplorerFileDropsAreBlocked reports elevated Windows drop blocking", () => {
    const warnings: unknown[][] = [];
    const blocked = warnIfExplorerFileDropsAreBlocked(
      {
        isElevated: true,
        integrityLevel: "high",
        explorerToAppDragBlocked: true,
        message: "Explorer file drops are blocked while elevated."
      },
      (...args) => warnings.push(args)
    );
    warnIfExplorerFileDropsAreBlocked(
      {
        isElevated: false,
        integrityLevel: "medium",
        explorerToAppDragBlocked: false,
        message: null
      },
      (...args) => warnings.push(args)
    );

    assert.equal(blocked, true);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.[0]), /Explorer file drops/);
  });
})();

import assert from "node:assert/strict";
import {
  clearSystemFileDropHighlight,
  findSystemFileDropTargetFromPoint,
  updateSystemFileDropHighlight
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
})();

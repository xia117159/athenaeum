import assert from "node:assert/strict";
import {
  beginAppOriginSystemDrag,
  clearSystemFileDropHighlight,
  createSystemFileDropPayloadHandler,
  endAppOriginSystemDrag,
  findSystemFileDropTargetFromPoint,
  handleSystemDragPosition,
  resetSystemDragStateForTests,
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

  assertTest("updateSystemFileDropHighlight applies isolated Windows drop target classes and clears previous targets", () => {
    const tab = document.createElement("button");
    tab.dataset.entryDropKind = "tab";
    tab.dataset.entryDropPath = "D:\\";
    const listing = document.createElement("div");
    listing.dataset.entryDropKind = "listing";
    listing.dataset.entryDropPath = "D:\\";
    listing.classList.add("is-drop-target");
    listing.dataset.dropOperation = "move";
    document.body.append(tab, listing);

    let restore = stubElementFromPoint(tab);
    try {
      const target = updateSystemFileDropHighlight({ x: 10, y: 10 });
      assert.equal(target?.path, "D:\\");
      assert.equal(tab.classList.contains("is-system-entry-drop-target"), true);
      assert.equal(tab.dataset.systemDropOperation, "copy");
    } finally {
      restore();
    }

    restore = stubElementFromPoint(listing);
    try {
      const target = updateSystemFileDropHighlight({ x: 12, y: 12 });
      assert.equal(target?.path, "D:\\");
      assert.equal(tab.classList.contains("is-system-entry-drop-target"), false);
      assert.equal(listing.classList.contains("is-system-drop-target"), true);
      assert.equal(listing.classList.contains("is-drop-target"), true);
      assert.equal(listing.dataset.systemDropOperation, "copy");
      assert.equal(listing.dataset.dropOperation, "move");
    } finally {
      restore();
      clearSystemFileDropHighlight();
      tab.remove();
      listing.remove();
    }

    assert.equal(listing.classList.contains("is-system-drop-target"), false);
    assert.equal(listing.classList.contains("is-drop-target"), true);
    assert.equal(listing.dataset.systemDropOperation, undefined);
    assert.equal(listing.dataset.dropOperation, "move");
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
      assert.equal(listing.classList.contains("is-system-drop-target"), true);
      assert.equal(listing.dataset.systemDropOperation, "copy");
    } finally {
      restore();
      clearSystemFileDropHighlight();
      listing.remove();
    }

    assert.equal(listing.classList.contains("is-system-drop-target"), false);
    assert.equal(listing.dataset.systemDropOperation, undefined);
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
      assert.equal(staleListing.classList.contains("is-system-drop-target"), true);
    } finally {
      restore();
    }

    staleListing.remove();
    restore = stubElementFromPoint(nextListing);
    try {
      const target = updateSystemFileDropHighlight({ x: 12, y: 12 });
      assert.equal(target?.path, "E:\\Target");
      assert.equal(nextListing.classList.contains("is-system-drop-target"), true);
      assert.equal(nextListing.dataset.systemDropOperation, "copy");
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
      assert.equal(listing.classList.contains("is-system-drop-target"), true);
      assert.equal(listing.dataset.systemDropOperation, "copy");

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
    assert.equal(listing.classList.contains("is-system-drop-target"), false);
  });

  assertTest("createSystemFileDropPayloadHandler ignores duplicate enter/drop payloads within the dedupe window", () => {
    const listing = document.createElement("div");
    listing.dataset.entryDropKind = "listing";
    listing.dataset.entryDropPath = "D:\\DuplicateInbox";
    document.body.appendChild(listing);

    const received: Array<{ paths: string[]; destination: string }> = [];
    const handlePayload = createSystemFileDropPayloadHandler((paths, destination) => {
      received.push({ paths, destination });
    });
    const restore = stubElementFromPoint(listing);
    const paths = ["C:\\Users\\me\\Desktop\\duplicate.txt"];
    try {
      handlePayload({
        type: "enter",
        paths,
        position: { x: 20, y: 20 }
      });
      handlePayload({
        type: "drop",
        paths,
        position: { x: 20, y: 20 }
      });
      handlePayload({
        type: "enter",
        paths,
        position: { x: 20, y: 20 }
      });
      handlePayload({
        type: "drop",
        paths,
        position: { x: 20, y: 20 }
      });
    } finally {
      restore();
      listing.remove();
      clearSystemFileDropHighlight();
    }

    assert.deepEqual(received, [
      {
        paths,
        destination: "D:\\DuplicateInbox"
      }
    ]);
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

  assertTest(
    "createSystemFileDropPayloadHandler highlights an App-origin re-entry that only delivers over/drop",
    () => {
      const listing = document.createElement("div");
      listing.dataset.entryDropKind = "listing";
      listing.dataset.entryDropPath = "E:\\Target";
      document.body.appendChild(listing);

      const received: Array<{ paths: string[]; destination: string }> = [];
      const handlePayload = createSystemFileDropPayloadHandler((paths, destination) => {
        received.push({ paths, destination });
      });
      const restore = stubElementFromPoint(listing);
      const paths = ["D:\\Archive\\report.txt"];
      try {
        // App-origin system drag re-entering the WebView may skip `enter`
        // (or send it without paths), so the first reliable payload is `over`.
        handlePayload({
          type: "over",
          position: { x: 30, y: 30 }
        });
        assert.equal(listing.classList.contains("is-system-drop-target"), true);
        assert.equal(listing.dataset.systemDropOperation, "copy");

        handlePayload({
          type: "drop",
          paths,
          position: { x: 30, y: 30 }
        });
      } finally {
        restore();
        listing.remove();
        clearSystemFileDropHighlight();
      }

      assert.deepEqual(received, [
        {
          paths,
          destination: "E:\\Target"
        }
      ]);
      assert.equal(listing.classList.contains("is-system-drop-target"), false);
    }
  );

  assertTest(
    "createSystemFileDropPayloadHandler highlights after an enter that arrives without paths",
    () => {
      const listing = document.createElement("div");
      listing.dataset.entryDropKind = "listing";
      listing.dataset.entryDropPath = "E:\\Resumed";
      document.body.appendChild(listing);

      const handlePayload = createSystemFileDropPayloadHandler(() => undefined);
      const restore = stubElementFromPoint(listing);
      try {
        handlePayload({
          type: "enter",
          paths: [],
          position: { x: 12, y: 12 }
        });
        handlePayload({
          type: "over",
          position: { x: 12, y: 12 }
        });
        assert.equal(listing.classList.contains("is-system-drop-target"), true);
        assert.equal(listing.dataset.systemDropOperation, "copy");
      } finally {
        restore();
        listing.remove();
        clearSystemFileDropHighlight();
      }
    }
  );

  assertTest(
    "createSystemFileDropPayloadHandler keeps hovering after a duplicate drop is deduped",
    () => {
      const listing = document.createElement("div");
      listing.dataset.entryDropKind = "listing";
      listing.dataset.entryDropPath = "D:\\DedupeHover";
      document.body.appendChild(listing);

      const received: Array<{ paths: string[]; destination: string }> = [];
      const handlePayload = createSystemFileDropPayloadHandler((paths, destination) => {
        received.push({ paths, destination });
      });
      const restore = stubElementFromPoint(listing);
      const paths = ["C:\\Users\\me\\Desktop\\dedupe.txt"];
      try {
        handlePayload({ type: "enter", paths, position: { x: 20, y: 20 } });
        handlePayload({ type: "drop", paths, position: { x: 20, y: 20 } });

        // A duplicate drop is deduped, but the next hover must still highlight.
        handlePayload({ type: "enter", paths, position: { x: 20, y: 20 } });
        assert.equal(listing.classList.contains("is-system-drop-target"), true);
        assert.equal(listing.dataset.systemDropOperation, "copy");
        handlePayload({ type: "over", position: { x: 20, y: 20 } });
        assert.equal(listing.classList.contains("is-system-drop-target"), true);

        handlePayload({ type: "drop", paths, position: { x: 20, y: 20 } });
      } finally {
        restore();
        listing.remove();
        clearSystemFileDropHighlight();
      }

      assert.deepEqual(received, [
        {
          paths,
          destination: "D:\\DedupeHover"
        }
      ]);
    }
  );

  assertTest("clearSystemFileDropHighlight leaves internal pointer highlight classes untouched", () => {
    const listing = document.createElement("div");
    listing.dataset.entryDropKind = "listing";
    listing.dataset.entryDropPath = "D:\\Mixed";
    listing.classList.add("is-drop-target");
    listing.dataset.dropOperation = "move";
    document.body.appendChild(listing);

    const restore = stubElementFromPoint(listing);
    try {
      updateSystemFileDropHighlight({ x: 10, y: 10 });
      assert.equal(listing.classList.contains("is-system-drop-target"), true);
      assert.equal(listing.classList.contains("is-drop-target"), true);

      clearSystemFileDropHighlight();
      assert.equal(listing.classList.contains("is-system-drop-target"), false);
      assert.equal(listing.dataset.systemDropOperation, undefined);
      // Internal pointer-drag highlight must survive a system cleanup.
      assert.equal(listing.classList.contains("is-drop-target"), true);
      assert.equal(listing.dataset.dropOperation, "move");
    } finally {
      restore();
      listing.remove();
    }
  });

  assertTest("handleSystemDragPosition drives the system highlight only while an App-origin drag is active", () => {
    resetSystemDragStateForTests();
    const listing = document.createElement("div");
    listing.dataset.entryDropKind = "listing";
    listing.dataset.entryDropPath = "E:\\Feed";
    document.body.appendChild(listing);

    const restore = stubElementFromPoint(listing);
    try {
      // Without an active App-origin drag the feed is inert: position events from
      // a stale GiveFeedback burst must not paint a highlight.
      const before = handleSystemDragPosition({ x: 10, y: 10 });
      assert.equal(before, null);
      assert.equal(listing.classList.contains("is-system-drop-target"), false);

      beginAppOriginSystemDrag();
      const target = handleSystemDragPosition({ x: 10, y: 10 });
      assert.equal(target?.path, "E:\\Feed");
      assert.equal(listing.classList.contains("is-system-drop-target"), true);
      assert.equal(listing.dataset.systemDropOperation, "copy");

      endAppOriginSystemDrag();
      assert.equal(listing.classList.contains("is-system-drop-target"), false);
      assert.equal(listing.dataset.systemDropOperation, undefined);

      // After the drag ends the feed is inert again.
      assert.equal(handleSystemDragPosition({ x: 10, y: 10 }), null);
      assert.equal(listing.classList.contains("is-system-drop-target"), false);
    } finally {
      restore();
      listing.remove();
      resetSystemDragStateForTests();
    }
  });

  assertTest(
    "createSystemFileDropPayloadHandler lets the position feed own the highlight during an App-origin drag",
    () => {
      resetSystemDragStateForTests();
      const listingA = document.createElement("div");
      listingA.dataset.entryDropKind = "listing";
      listingA.dataset.entryDropPath = "D:\\Source";
      const listingB = document.createElement("div");
      listingB.dataset.entryDropKind = "listing";
      listingB.dataset.entryDropPath = "E:\\Target";
      document.body.append(listingA, listingB);

      let pointed: Element | null = listingB;
      const original = document.elementFromPoint;
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: () => pointed
      });

      const received: Array<{ paths: string[]; destination: string }> = [];
      const handlePayload = createSystemFileDropPayloadHandler((paths, destination) => {
        received.push({ paths, destination });
      });
      const paths = ["D:\\Source\\report.txt"];
      try {
        beginAppOriginSystemDrag();

        // The live feed paints B as the cursor moves over it.
        pointed = listingB;
        handleSystemDragPosition({ x: 30, y: 30 });
        assert.equal(listingB.classList.contains("is-system-drop-target"), true);

        // The buffered native enter/over burst flushes at drop time replaying the
        // A->B cursor path. While the feed owns the highlight these stale events
        // must NOT move the highlight back onto A.
        pointed = listingA;
        handlePayload({ type: "enter", paths, position: { x: 5, y: 5 } });
        handlePayload({ type: "over", position: { x: 5, y: 5 } });
        assert.equal(listingA.classList.contains("is-system-drop-target"), false);
        assert.equal(listingB.classList.contains("is-system-drop-target"), true);

        // The drop resolves against its own position (B), not the stale burst.
        pointed = listingB;
        handlePayload({ type: "drop", paths, position: { x: 30, y: 30 } });
      } finally {
        if (original) {
          Object.defineProperty(document, "elementFromPoint", {
            configurable: true,
            value: original
          });
        } else {
          Reflect.deleteProperty(document, "elementFromPoint");
        }
        listingA.remove();
        listingB.remove();
        resetSystemDragStateForTests();
      }

      assert.deepEqual(received, [
        {
          paths,
          destination: "E:\\Target"
        }
      ]);
      assert.equal(listingB.classList.contains("is-system-drop-target"), false);
    }
  );

  assertTest(
    "createSystemFileDropPayloadHandler keeps deferring to the feed within the post-drag suppression window",
    () => {
      resetSystemDragStateForTests();
      const listingA = document.createElement("div");
      listingA.dataset.entryDropKind = "listing";
      listingA.dataset.entryDropPath = "D:\\Replay";
      document.body.appendChild(listingA);

      const original = document.elementFromPoint;
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: () => listingA
      });

      const handlePayload = createSystemFileDropPayloadHandler(() => undefined);
      try {
        // A feed position arrived "just now"; even after the drag flag is cleared
        // the timestamp window keeps the stale enter/over burst suppressed. Seed
        // with the real clock so the handler's Date.now()-based window check sees
        // the feed position as recent.
        beginAppOriginSystemDrag();
        handleSystemDragPosition({ x: 30, y: 30 }, Date.now());
        endAppOriginSystemDrag();

        handlePayload({ type: "enter", paths: ["D:\\Replay\\a.txt"], position: { x: 5, y: 5 } });
        assert.equal(listingA.classList.contains("is-system-drop-target"), false);
      } finally {
        if (original) {
          Object.defineProperty(document, "elementFromPoint", {
            configurable: true,
            value: original
          });
        } else {
          Reflect.deleteProperty(document, "elementFromPoint");
        }
        listingA.remove();
        resetSystemDragStateForTests();
      }
    }
  );

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

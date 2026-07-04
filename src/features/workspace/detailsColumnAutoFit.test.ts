import assert from "node:assert/strict";
import { estimateDetailsAutoFitColumnWidth, getDetailsAutoFitColumnWidthFromDom } from "./detailsColumnAutoFit";

const { JSDOM } = require("jsdom") as {
  JSDOM: new (html?: string) => {
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

assertTest("estimateDetailsAutoFitColumnWidth uses one formula for different details-list adapters", () => {
  const items = [
    { displayName: "Report", path: "C:\\Docs\\Report.txt" },
    { displayName: "Archive", path: "D:\\Archive" }
  ];

  const fileNameWidth = estimateDetailsAutoFitColumnWidth({
    column: { id: "name" },
    items,
    getHeaderText: () => "\u540d\u79f0",
    getCellText: (item) => item.displayName,
    getMinWidth: () => 40,
    getIconAllowance: () => 22
  });
  const navigationNameWidth = estimateDetailsAutoFitColumnWidth({
    column: { id: "name" },
    items,
    getHeaderText: () => "\u540d\u79f0",
    getCellText: (item) => item.displayName,
    getMinWidth: () => 40,
    getIconAllowance: () => 22
  });
  const navigationPathWidth = estimateDetailsAutoFitColumnWidth({
    column: { id: "path" },
    items,
    getHeaderText: () => "\u8def\u5f84",
    getCellText: (item) => item.path,
    getMinWidth: () => 64,
    getIconAllowance: () => 0
  });

  assert.equal(fileNameWidth, "72px");
  assert.equal(navigationNameWidth, fileNameWidth);
  assert.equal(navigationPathWidth, "116px");
});

assertTest("estimateDetailsAutoFitColumnWidth applies shared min width and max width clamps", () => {
  const shortWidth = estimateDetailsAutoFitColumnWidth({
    column: { id: "status" },
    items: [{ label: "OK" }],
    getHeaderText: () => "\u72b6\u6001",
    getCellText: (item) => item.label,
    getMinWidth: () => 80,
    getIconAllowance: () => 0
  });
  const longWidth = estimateDetailsAutoFitColumnWidth({
    column: { id: "path" },
    items: [{ label: "x".repeat(200) }],
    getHeaderText: () => "\u8def\u5f84",
    getCellText: (item) => item.label,
    getMinWidth: () => 64,
    getIconAllowance: () => 0
  });

  assert.equal(shortWidth, "80px");
  assert.equal(longWidth, "520px");
});

assertTest("getDetailsAutoFitColumnWidthFromDom preserves inherited computed font while measuring cloned cells", () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><div class="navigation-table"><span class="navigation-table__cell" data-navigation-cell-id="status">\u6b63\u5e38</span></div></body></html>'
  );
  const { document } = dom.window;
  const cell = document.querySelector<HTMLElement>(".navigation-table__cell");
  assert.ok(cell);

  const originalScrollWidth = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, "scrollWidth");
  const originalGetComputedStyle = dom.window.getComputedStyle;
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get() {
      const element = this as HTMLElement;
      if (element.textContent !== "\u6b63\u5e38") {
        return 0;
      }
      return element.style.fontSize === "12px" ? 24 : 32;
    }
  });
  Object.defineProperty(dom.window, "getComputedStyle", {
    configurable: true,
    value: (element: Element) => {
      const fallback = originalGetComputedStyle.call(dom.window, element);
      return {
        ...fallback,
        fontFamily: "Segoe UI",
        fontSize: element === cell ? "12px" : "16px",
        fontStretch: "normal",
        fontStyle: "normal",
        fontVariant: "normal",
        fontWeight: "400",
        letterSpacing: "normal",
        lineHeight: "16px",
        textTransform: "none",
        wordSpacing: "0px"
      } as CSSStyleDeclaration;
    }
  });

  try {
    assert.equal(
      getDetailsAutoFitColumnWidthFromDom({
        root: document.querySelector<HTMLElement>(".navigation-table"),
        columnId: "status",
        minWidth: 1,
        cellDataAttribute: "data-navigation-cell-id"
      }),
      "28px"
    );
  } finally {
    if (originalScrollWidth) {
      Object.defineProperty(dom.window.HTMLElement.prototype, "scrollWidth", originalScrollWidth);
    } else {
      Reflect.deleteProperty(dom.window.HTMLElement.prototype, "scrollWidth");
    }
    Object.defineProperty(dom.window, "getComputedStyle", {
      configurable: true,
      value: originalGetComputedStyle
    });
  }
});

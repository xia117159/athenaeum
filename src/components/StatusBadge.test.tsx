import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { StatusBadge } from "./StatusBadge";

const { JSDOM } = require("jsdom") as { JSDOM: new (html?: string) => { window: Window & typeof globalThis } };

function assertTest(name: string, fn: () => Promise<void>) {
  return fn().then(() => console.log(`ok - ${name}`));
}

export const completion = (async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>");
  globalThis.window = dom.window as typeof globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.getElementById("root")!;
  const root = ReactDOM.createRoot(container);

  try {
    await assertTest("StatusBadge exposes configurable content colors size and accessible text", async () => {
      await act(async () => {
        root.render(React.createElement(StatusBadge, {
          content: "99+",
          backgroundColor: "#c42b1c",
          color: "#ffffff",
          size: 18,
          ariaLabel: "105 \u4e2a\u672a\u67e5\u770b\u95ee\u9898",
          className: "test-badge"
        }));
      });
      const badge = container.querySelector<HTMLElement>(".status-badge");
      assert.ok(badge);
      assert.equal(badge.textContent, "99+");
      assert.equal(badge.classList.contains("test-badge"), true);
      assert.equal(badge.getAttribute("aria-label"), "105 \u4e2a\u672a\u67e5\u770b\u95ee\u9898");
      assert.equal(badge.style.getPropertyValue("--status-badge-background"), "#c42b1c");
      assert.equal(badge.style.getPropertyValue("--status-badge-color"), "#ffffff");
      assert.equal(badge.style.getPropertyValue("--status-badge-size"), "18px");
    });

    await assertTest("StatusBadge clamps unsafe numeric sizes", async () => {
      await act(async () => {
        root.render(React.createElement(StatusBadge, { content: "1", size: 2 }));
      });
      assert.equal(
        container.querySelector<HTMLElement>(".status-badge")?.style.getPropertyValue("--status-badge-size"),
        "12px"
      );
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
})();

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { AboutWindowView, ABOUT_APP_INFO } from "./AboutWindowView";

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
    url: "http://localhost/?view=about"
  });

  globalThis.window = dom.window as typeof globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLImageElement = dom.window.HTMLImageElement;
  globalThis.Node = dom.window.Node;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  return dom;
}

async function flushEffects() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export const completion = (async () => {
  const dom = installDomEnvironment();
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("test root container is missing");
  }
  const root = ReactDOM.createRoot(container);

  try {
    await assertTest("AboutWindowView renders Windows-style product identity and open-source details", async () => {
      await act(async () => {
        root.render(React.createElement(AboutWindowView));
        await flushEffects();
      });

      const image = container.querySelector<HTMLImageElement>(".about-window__icon");
      assert.ok(image);
      assert.equal(image.alt, `${ABOUT_APP_INFO.name} 图标`);
      assert.ok(image.src.includes("128x128.png"));

      assert.equal(container.querySelector("h1")?.textContent, ABOUT_APP_INFO.name);
      assert.equal(container.textContent?.includes(`版本 ${ABOUT_APP_INFO.version}`), true);
      assert.equal(container.textContent?.includes(ABOUT_APP_INFO.description), true);
      assert.equal(container.textContent?.includes("开源信息"), true);
      assert.equal(container.textContent?.includes(ABOUT_APP_INFO.repository), true);
      assert.equal(container.textContent?.includes("Tauri v2"), true);
      assert.equal(container.textContent?.includes("Rust"), true);
      assert.equal(container.textContent?.includes("React"), true);
      assert.equal(container.textContent?.includes("TypeScript"), true);
      assert.equal(container.querySelectorAll(".about-window__section").length >= 2, true);
    });

    await assertTest("AboutWindowView owns its CSS import directly", async () => {
      const source = fs.readFileSync(path.join(process.cwd(), "src/features/workspace/AboutWindowView.tsx"), "utf8");
      assert.equal(source.includes('import "./workspace.about.css";'), true);
    });
  } finally {
    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    dom.window.close();
  }
})();

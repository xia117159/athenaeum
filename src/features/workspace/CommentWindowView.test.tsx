import assert from "node:assert/strict";
import { fireEvent } from "@testing-library/react";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { CommentWindowView } from "./CommentWindowView";
import { installLegacyInputEventPatch } from "./testDom";

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
    url: "http://localhost/?view=comment&path=D%3A%5CProjects%5Creport.txt&name=report.txt&kind=file"
  });

  globalThis.window = dom.window as typeof globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
  globalThis.Node = dom.window.Node;
  globalThis.Event = dom.window.Event;
  globalThis.MouseEvent = dom.window.MouseEvent;
  installLegacyInputEventPatch(dom);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  return dom;
}

async function flushEffects() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await act(async () => {
      await flushEffects();
    });
  }
  assert.fail(message);
}

export const commentWindowViewTests = (async () => {
  const dom = installDomEnvironment();
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("test root container is missing");
  }

  const confirmMessages: string[] = [];
  let closeCalls = 0;
  const originalConfirm = window.confirm;
  const originalClose = window.close;
  window.confirm = (message?: string) => {
    confirmMessages.push(message ?? "");
    return false;
  };
  Object.defineProperty(window, "close", {
    configurable: true,
    value: () => {
      closeCalls += 1;
    }
  });

  const root = ReactDOM.createRoot(container);

  try {
    await assertTest("CommentWindowView confirms before discarding unsaved edits", async () => {
      await act(async () => {
        root.render(React.createElement(CommentWindowView));
        await flushEffects();
      });

      await waitFor(
        () => container.querySelector<HTMLTextAreaElement>("textarea")?.disabled === false,
        "comment editor did not finish loading"
      );

      const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
      assert.ok(textarea);
      await act(async () => {
        fireEvent.input(textarea!, { target: { value: "新的注释" } });
        await flushEffects();
      });
      assert.equal(textarea!.value, "新的注释");

      const cancelButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent === "取消"
      );
      assert.ok(cancelButton);
      await act(async () => {
        cancelButton!.click();
        await flushEffects();
      });

      assert.deepEqual(confirmMessages, ["未保存的更改将丢失，确定取消？"]);
      assert.equal(closeCalls, 0);
    });

    await assertTest("CommentWindowView notifies entry metadata changes after saving", async () => {
      const changedPaths: string[][] = [];
      const listener = (event: Event) => {
        changedPaths.push((event as CustomEvent<string[]>).detail);
      };
      window.addEventListener("entry_metadata_changed", listener);

      try {
        const confirmButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
          (button) => button.textContent === "确认"
        );
        assert.ok(confirmButton);
        await act(async () => {
          confirmButton!.click();
          await flushEffects();
        });

        await waitFor(() => changedPaths.length === 1, "comment save did not notify metadata changes");
        assert.deepEqual(changedPaths, [["D:\\Projects\\report.txt"]]);
        assert.equal(closeCalls, 1);
      } finally {
        window.removeEventListener("entry_metadata_changed", listener);
      }
    });
  } finally {
    window.confirm = originalConfirm;
    Object.defineProperty(window, "close", {
      configurable: true,
      value: originalClose
    });
    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    dom.window.close();
  }
})();

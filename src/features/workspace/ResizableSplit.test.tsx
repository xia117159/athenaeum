import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { ResizableSplit } from "./ResizableSplit";

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
  globalThis.Node = dom.window.Node;
  globalThis.Event = dom.window.Event;
  globalThis.MouseEvent = dom.window.MouseEvent;
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

function createPointerEvent(type: string, clientX: number, clientY: number) {
  const event = new Event(type, {
    bubbles: true,
    cancelable: true
  }) as Event & {
    button: number;
    buttons: number;
    clientX: number;
    clientY: number;
    pointerId: number;
  };

  Object.defineProperties(event, {
    button: { configurable: true, value: 0 },
    buttons: { configurable: true, value: 1 },
    clientX: { configurable: true, value: clientX },
    clientY: { configurable: true, value: clientY },
    pointerId: { configurable: true, value: 1 }
  });

  return event;
}

function dispatchPointerEvent(target: EventTarget, type: string, clientX: number, clientY: number) {
  target.dispatchEvent(createPointerEvent(type, clientX, clientY));
}

function assertClose(actual: number | undefined, expected: number, epsilon = 1e-6) {
  assert.notEqual(actual, undefined);
  const resolvedActual = actual as number;
  assert.ok(
    Math.abs(resolvedActual - expected) <= epsilon,
    `expected ${resolvedActual} to be within ${epsilon} of ${expected}`
  );
}

function mockSplitRect(element: Element, width: number, height: number, left = 0, top = 0) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      width,
      height,
      left,
      top,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => undefined
    })
  });
}

export const completion = (async () => {
  const dom = installDomEnvironment();
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("test root container is missing");
  }

  const root = ReactDOM.createRoot(container);

  function renderSplit(
    onRatioChange: (value: number) => void,
    extraProps: Record<string, unknown> = {}
  ) {
    root.render(
      React.createElement(
        ResizableSplit,
        {
          direction: "vertical",
          ratio: 0.4,
          handleSize: 10,
          min: 0,
          max: 1,
          onRatioChange,
          ...extraProps
        } as React.ComponentProps<typeof ResizableSplit>,
        React.createElement("div", null, "top"),
        React.createElement("div", null, "bottom")
      )
    );
  }

  try {
    await assertTest("ResizableSplit does not change ratio on pointerdown without a drag", async () => {
      const changes: number[] = [];

      await act(async () => {
        renderSplit((value) => changes.push(value));
        await flushEffects();
      });

      const split = container.querySelector(".split-pane");
      const handle = container.querySelector(".split-pane__handle");
      assert.ok(split);
      assert.ok(handle);
      mockSplitRect(split, 320, 1000);

      const availableSize = 1000 - 10;
      const pointerDownY = 0.4 * availableSize + 8;

      await act(async () => {
        dispatchPointerEvent(handle, "pointerdown", 40, pointerDownY);
        await flushEffects();
      });

      assert.deepEqual(changes, []);

      await act(async () => {
        dispatchPointerEvent(window, "pointerup", 40, pointerDownY);
        await flushEffects();
      });
    });

    await assertTest("ResizableSplit keeps the handle aligned to the pointer while dragging and commits on pointerup", async () => {
      const changes: number[] = [];

      await act(async () => {
        renderSplit((value) => changes.push(value));
        await flushEffects();
      });

      const split = container.querySelector(".split-pane");
      const handle = container.querySelector(".split-pane__handle");
      const firstSegment = container.querySelector(".split-pane__segment");
      assert.ok(split);
      assert.ok(handle);
      assert.ok(firstSegment);
      mockSplitRect(split, 320, 1000);

      const availableSize = 1000 - 10;
      const pointerDownY = 0.4 * availableSize + 8;
      const pointerMoveY = pointerDownY + 10;
      const initialFlexBasis = (firstSegment as HTMLElement).style.flexBasis;

      await act(async () => {
        dispatchPointerEvent(handle, "pointerdown", 40, pointerDownY);
        dispatchPointerEvent(window, "pointermove", 40, pointerMoveY);
        await flushEffects();
      });

      assert.equal(changes.length, 0);
      assert.notEqual((firstSegment as HTMLElement).style.flexBasis, initialFlexBasis);

      await act(async () => {
        dispatchPointerEvent(window, "pointerup", 40, pointerMoveY);
        await flushEffects();
      });

      assert.equal(changes.length, 1);
      assertClose(changes[0], (pointerMoveY - 10 / 2) / availableSize);
    });

    await assertTest("ResizableSplit uses pixel minimums on both panes so tall vertical splits can move past 80 percent", async () => {
      const changes: number[] = [];

      await act(async () => {
        renderSplit((value) => changes.push(value), {
          ratio: 0.54,
          handleSize: 8,
          minSizePx: 180,
          secondMinSizePx: 180
        });
        await flushEffects();
      });

      const split = container.querySelector(".split-pane");
      const handle = container.querySelector(".split-pane__handle");
      assert.ok(split);
      assert.ok(handle);
      mockSplitRect(split, 320, 2000);

      const availableSize = 2000 - 8;
      const pointerDownY = 0.54 * availableSize + 4;
      const targetRatio = 0.88;
      const pointerMoveY = pointerDownY + (targetRatio - 0.54) * availableSize;

      await act(async () => {
        dispatchPointerEvent(handle, "pointerdown", 40, pointerDownY);
        dispatchPointerEvent(window, "pointermove", 40, pointerMoveY);
        await flushEffects();
      });

      assert.equal(changes.length, 0);

      await act(async () => {
        dispatchPointerEvent(window, "pointerup", 40, pointerMoveY);
        await flushEffects();
      });

      assertClose(changes.at(-1), targetRatio);
    });

    await assertTest("ResizableSplit assigns complementary fixed pane bases so content cannot shift the horizontal handle", async () => {
      await act(async () => {
        root.render(
          React.createElement(
            ResizableSplit,
            {
              key: "fixed-horizontal-basis",
              direction: "horizontal",
              ratio: 0.35,
              handleSize: 8,
              min: 0,
              max: 1,
              onRatioChange: () => undefined
            },
            React.createElement("div", { style: { width: "1200px" } }, "left"),
            React.createElement("div", { style: { width: "2400px" } }, "right")
          )
        );
        await flushEffects();
      });

      const segments = Array.from(container.querySelectorAll(".split-pane__segment")) as HTMLElement[];
      assert.equal(segments.length, 2);
      assert.equal(segments[0].style.flexGrow, "0");
      assert.equal(segments[0].style.flexShrink, "0");
      assert.equal(segments[0].style.flexBasis, "calc(35% - 2.8px)");
      assert.equal(segments[1].style.flexGrow, "0");
      assert.equal(segments[1].style.flexShrink, "0");
      assert.equal(segments[1].style.flexBasis, "calc(65% - 5.2px)");
    });
  } finally {
    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    dom.window.close();
  }
})();

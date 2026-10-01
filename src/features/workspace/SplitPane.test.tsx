import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { readCommittedRatio, resolveSplitConstraints, SplitPane } from "./SplitPane";
import { assertTest, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";

const PANE_RATIOS_TOLERANCE = 0.001;

function readPaneRatios(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-panel]")).map((pane) =>
    Number.parseFloat(pane.style.flex)
  );
}

function assertClose(actual: number | undefined, expected: number, message: string) {
  assert.notEqual(actual, undefined, `${message}: value is missing`);
  assert.ok(
    Math.abs((actual as number) - expected) <= PANE_RATIOS_TOLERANCE,
    `${message}: expected ${actual} to be within ${PANE_RATIOS_TOLERANCE} of ${expected}`
  );
}

/**
 * jsdom 没有布局引擎，react-resizable-panels 依据面板 offsetWidth/offsetHeight
 * 计算分组尺寸。这里手工提供尺寸，让库走到真实的测量分支。
 */
function stubPaneSizes(container: HTMLElement, size = 500) {
  for (const pane of container.querySelectorAll<HTMLElement>("[data-panel]")) {
    Object.defineProperty(pane, "offsetWidth", { configurable: true, value: size });
    Object.defineProperty(pane, "offsetHeight", { configurable: true, value: size });
  }
}

function renderPane(container: HTMLElement, props: Partial<React.ComponentProps<typeof SplitPane>>) {
  const root = ReactDOM.createRoot(container);
  const render = async (nextProps: Partial<React.ComponentProps<typeof SplitPane>> = {}) =>
    act(async () => {
      root.render(
        <SplitPane
          direction="horizontal"
          ratio={0.5}
          onRatioChange={() => undefined}
          {...props}
          {...nextProps}
        >
          <div>first</div>
          <div>second</div>
        </SplitPane>
      );
      stubPaneSizes(container);
      await flushEffects();
      await flushEffects();
    });
  return { render, root };
}

export const completion = (async () => {
  const dom = installDomEnvironment();

  try {
    await assertTest("split constraints take the stricter of the fractional and pixel floors", async () => {
      // 160px is only 10% of a 1600px pane, so the 12% floor wins.
      const wide = resolveSplitConstraints({ availableSize: 1600, min: 0.12, max: 0.36, minSizePx: 160 });
      assertClose(wide.firstMinSize as number, 192, "wide group binds the fractional floor");
      assertClose(wide.firstMaxSize as number, 576, "wide group caps at the fractional ceiling");

      // At 800px the pixel floor (160px = 20%) is stricter than 12%.
      const narrow = resolveSplitConstraints({ availableSize: 800, min: 0.12, max: 0.36, minSizePx: 160 });
      assertClose(narrow.firstMinSize as number, 160, "narrow group binds the pixel floor");
    });

    await assertTest("split constraints keep the second pane above its own pixel floor", async () => {
      const constraints = resolveSplitConstraints({
        availableSize: 1000,
        min: 0.5,
        max: 0.82,
        minSizePx: 240,
        secondMinSizePx: 222
      });
      assertClose(constraints.firstMinSize as number, 500, "fractional floor wins over the 240px floor");
      assertClose(constraints.firstMaxSize as number, 778, "first pane yields 222px to the second pane");
      assertClose(constraints.secondMinSize as number, 222, "second pane keeps its pixel floor");
    });

    await assertTest("split constraints fall back to fractional bounds before the group is measured", async () => {
      const constraints = resolveSplitConstraints({ availableSize: 0, min: 0.12, max: 0.36 });
      assert.equal(constraints.firstMinSize, "12%");
      assert.equal(constraints.firstMaxSize, "36%");
      assert.equal(constraints.secondMinSize, undefined);
    });

    await assertTest("split pane renders two panes and an ARIA separator per direction", async () => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const { render, root } = renderPane(container, { direction: "vertical" });
      await render();

      assert.equal(container.querySelectorAll("[data-panel]").length, 2);
      const separator = container.querySelector("[data-separator]");
      assert.ok(separator, "separator is rendered");
      assert.equal(separator.getAttribute("role"), "separator");
      assert.equal(separator.getAttribute("aria-orientation"), "horizontal");

      await render({ direction: "horizontal" });
      assert.equal(
        container.querySelector("[data-separator]")?.getAttribute("aria-orientation"),
        "vertical"
      );

      await act(async () => {
        root.unmount();
        await flushEffects();
      });
      container.remove();
    });

    await assertTest("split pane projects the ratio prop onto its panes and follows external changes", async () => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const { render, root } = renderPane(container, { ratio: 0.4 });
      await render();

      assertClose(readPaneRatios(container)[0], 40, "initial ratio drives the first pane");
      assertClose(readPaneRatios(container)[1], 60, "panes stay complementary");

      // A ratio change that did not come from dragging the separator must still move the divider.
      await render({ ratio: 0.72 });
      assertClose(readPaneRatios(container)[0], 72, "external ratio change moves the first pane");
      assertClose(readPaneRatios(container)[1], 28, "external ratio change moves the second pane");
      assert.equal(
        container.querySelector("[data-separator]")?.getAttribute("aria-valuenow"),
        "72"
      );

      await act(async () => {
        root.unmount();
        await flushEffects();
      });
      container.remove();
    });

    await assertTest("split pane commits only divider moves, never programmatic layout changes", async () => {
      const layout = { first: 62, second: 38 };

      assertClose(
        readCommittedRatio(layout, "first", { isUserInteraction: true }) ?? undefined,
        0.62,
        "a divider move is reported"
      );
      assert.equal(
        readCommittedRatio(layout, "first", { isUserInteraction: false }),
        null,
        "a programmatic setLayout must not reach the reducer"
      );
      assert.equal(
        readCommittedRatio({ second: 100 }, "first", { isUserInteraction: true }),
        null,
        "a layout without the first pane is not committed"
      );
    });
  } finally {
    dom.window.close();
  }
})();

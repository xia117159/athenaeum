import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { expansionEntry, expansionFixture, expansionInteractions, expansionSnapshot } from "./folderExpansionTestSupport";
import { assertTest, createTestGateway, flushEffects, installDomEnvironment, waitFor } from "./workspaceControllerTestHarness";
import { getPathComparisonKey } from "./workspacePathRelations";
import type { WorkspaceBootstrap } from "./types";
import type { WorkspaceGateway } from "./workspaceGateway";

/**
 * 分片 3 补充：D24 的两项交互优化的**端到端渲染**锁定。
 *
 * 解析函数层面的矩阵在 `quickFilterState.test.ts`（D24 ①②③④），操作目标集在
 * `quickFilterProjection.test.ts`。本文件补的是唯一无法由纯函数证明的部分：
 * **真实 `WorkspaceView` 渲染出的两个面板，是否都实际显示了过滤后的行**。
 *
 * 缺少本文件时，"解析函数返回了程序"与"面板真的渲染出过滤结果"之间没有断言，
 * 而原缺陷恰恰出在显示层（`isFocused ? quickFilter : null`），不在解析层。
 */

/** 双面板、同路径：panel-2 的激活标签页停在 panel-1 的同一路径上。 */
function samePathDualBootstrap(): { bootstrap: WorkspaceBootstrap; path: string } {
  const fixture = expansionFixture();
  const bootstrap = fixture.bootstrap;
  const firstTab = bootstrap.panels["panel-1"].tabs[0];
  bootstrap.layoutMode = "dual";
  bootstrap.activePanelId = "panel-1";
  // 两个面板的标签页 id 必须不同，否则会被当成同一个标签页。
  // `id` 也必须改写：直接展开 panel-1 会让 panel-2 带着 `id: "panel-1"`，
  // 面板标题与 `data-panel-id` 就会双双错位（夹具陷阱）。
  bootstrap.panels["panel-2"] = {
    ...bootstrap.panels["panel-1"],
    id: "panel-2",
    label: "panel-2",
    tabs: [{ ...firstTab, id: "panel-2-tab" }],
    activeTabId: "panel-2-tab"
  };
  return { bootstrap, path: fixture.path };
}

async function mount(bootstrap: WorkspaceBootstrap, resolveDirectory: WorkspaceGateway["resolveDirectory"]) {
  const interactions = expansionInteractions();
  const gateway = createTestGateway(() => undefined, interactions, {
    loadBootstrap: () => bootstrap,
    resolveDirectory
  });
  // `WorkspaceView` 自身以默认 gateway 调用 `useWorkspaceController()`（无参），
  // 因此必须像 `WorkspaceFolderExpansion.test.tsx:101` 那样替换模块导出并**闭包注入 gateway**，
  // 否则渲染的是默认 mock 数据、与注入的 gateway 无关（断言会静默测错对象）。
  const module = require("./useWorkspaceController") as typeof import("./useWorkspaceController");
  const originalController = module.useWorkspaceController;
  let controller!: ReturnType<typeof originalController>;
  module.useWorkspaceController = (() => {
    controller = originalController(gateway);
    return controller;
  }) as typeof originalController;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  try {
    await act(async () => {
      root.render(React.createElement((require("./WorkspaceView") as typeof import("./WorkspaceView")).WorkspaceView));
      await flushEffects();
    });
    await waitFor(() => controller?.state.status === "ready", "workspace did not bootstrap");
  } catch (error) {
    module.useWorkspaceController = originalController;
    throw error;
  }
  return {
    get controller() { return controller; },
    /** 该面板渲染出的条目路径，按 DOM 顺序。 */
    rowsOf(panelId: string) {
      const scroll = container.querySelector<HTMLElement>(`.file-listing__scroll[data-panel-id="${panelId}"]`);
      if (!scroll) return undefined;
      return [...scroll.querySelectorAll<HTMLElement>("[data-entry-path]")].map((node) => node.dataset.entryPath!);
    },
    async close() {
      await act(async () => { root.unmount(); await flushEffects(); });
      container.remove();
      module.useWorkspaceController = originalController;
    }
  };
}

export const completion = (async () => {
  installDomEnvironment();

  await assertTest("D24 ①+② both panels on the same path render the filtered rows, and focus loss keeps them", async () => {
    const { bootstrap, path } = samePathDualBootstrap();
    const { parent, sibling } = { parent: expansionEntry(path, "parent"), sibling: expansionEntry(path, "sibling") };
    const h = await mount(bootstrap, async (requested) => expansionSnapshot(requested, [parent, sibling]));
    try {
      // 在激活面板（panel-1）写入 include 过滤：只保留命中行。
      await act(async () => {
        h.controller.actions.changeQuickFilterMode("include");
        h.controller.actions.updateQuickFilterText(path, "sibling");
        await flushEffects();
      });

      const focusedRows = h.rowsOf("panel-1");
      const unfocusedRows = h.rowsOf("panel-2");
      assert.ok(focusedRows && unfocusedRows, "precondition: both panels rendered a listing");
      assert.deepEqual(focusedRows, [sibling.path], "the focused panel shows only the matching row");
      // ① 同路径跨面板：非焦点面板必须渲染同一份过滤结果。
      assert.deepEqual(unfocusedRows, [sibling.path],
        "D24 ①: a non-focused panel on the same path must render the filtered rows too");
      assert.equal(unfocusedRows.includes(parent.path), false,
        "D24 ①: the filtered-out row must not be rendered in the non-focused panel");

      // ② 失焦不取消：把焦点移到 panel-2，两个面板都必须保持过滤。
      await act(async () => { h.controller.actions.focusPanel("panel-2"); await flushEffects(); });
      assert.equal(h.controller.state.activePanelId, "panel-2");
      assert.deepEqual(h.rowsOf("panel-1"), [sibling.path],
        "D24 ②: losing focus must not cancel the previously applied filter");
      assert.deepEqual(h.rowsOf("panel-2"), [sibling.path],
        "the newly focused panel keeps the same per-path filter");
    } finally { await h.close(); }
  });

  await assertTest("D24 ④ a panel on a different path is never affected", async () => {
    const { bootstrap, path } = samePathDualBootstrap();
    const otherPath = "D:\\elsewhere";
    const inPath = [expansionEntry(path, "parent"), expansionEntry(path, "sibling")];
    const inOther = [expansionEntry(otherPath, "keep-a"), expansionEntry(otherPath, "keep-b")];
    // panel-2 导航到另一条路径。
    bootstrap.panels["panel-2"] = {
      ...bootstrap.panels["panel-2"],
      tabs: [{
        ...bootstrap.panels["panel-2"].tabs[0],
        id: "panel-2-tab",
        snapshot: expansionSnapshot(otherPath, inOther),
        history: [otherPath],
        historyIndex: 0
      }]
    };
    const h = await mount(bootstrap, async (requested) => expansionSnapshot(requested, requested === otherPath ? inOther : inPath));
    try {
      await act(async () => {
        h.controller.actions.changeQuickFilterMode("include");
        h.controller.actions.updateQuickFilterText(path, "sibling");
        await flushEffects();
      });
      assert.deepEqual(h.rowsOf("panel-1"), [inPath[1].path], "the filtered panel keeps only the match");
      // ④ 不同路径互不广播：path 的过滤文本不得作用于 otherPath 的面板。
      assert.deepEqual(h.rowsOf("panel-2")?.sort(), inOther.map((entry) => entry.path).sort(),
        "D24 ④: a panel on another path must not inherit the filter");
      assert.deepEqual(Object.keys(h.controller.state.quickFilter.byPath), [getPathComparisonKey(path)],
        "the filter text is cached only under the edited path");
    } finally { await h.close(); }
  });
})();

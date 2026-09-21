import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { useWorkspaceController } from "./useWorkspaceController";
import { expansionEntry, expansionFixture, expansionInteractions, expansionSnapshot } from "./folderExpansionTestSupport";
import { resolveQuickFilterProgram } from "./quickFilterState";
import { assertTest, createTestGateway, flushEffects, installDomEnvironment, waitFor } from "./workspaceControllerTestHarness";
import type { WorkspaceBootstrap } from "./types";

/**
 * 评审 S2：编译调度曾只覆盖**激活面板**的路径。
 *
 * 语法是会话全局的，切到 regex 时 `applyQuickFilterSyntax` 会把**每一条**缓存路径的
 * `appliedText` 置空（因为旧语法下的有效文本在新语法下未必有效）。但调度器只重算激活面板
 * 所在路径，于是非焦点面板会停在"文本还在、生效匹配为空"的状态——列表取消过滤，
 * 直到该面板重新获得焦点才自愈。这恰好是 D24 ② 要消除的"由谁持有焦点决定过滤结果"。
 */
async function mount(bootstrap: WorkspaceBootstrap) {
  const gateway = createTestGateway(() => undefined, expansionInteractions(), { loadBootstrap: () => bootstrap });
  let current!: ReturnType<typeof useWorkspaceController>;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  function Harness() { current = useWorkspaceController(gateway); return React.createElement("div"); }
  await act(async () => { root.render(React.createElement(Harness)); await flushEffects(); });
  await waitFor(() => current?.state.status === "ready", "bootstrap did not complete");
  return {
    get controller() { return current; },
    async close() { await act(async () => { root.unmount(); await flushEffects(); }); container.remove(); }
  };
}

/** 双面板：panel-1 停在夹具路径，panel-2 停在**另一条**路径。 */
function dualFixture() {
  const f = expansionFixture();
  const bootstrap = f.bootstrap;
  const otherPath = "C:\\elsewhere";
  const first = bootstrap.panels["panel-1"].tabs[0];
  bootstrap.layoutMode = "dual";
  bootstrap.activePanelId = "panel-1";
  const otherTab = {
    ...first, id: "panel-2-tab",
    snapshot: expansionSnapshot(otherPath, [expansionEntry(otherPath, "other")]),
    history: [otherPath], historyIndex: 0
  };
  bootstrap.panels["panel-2"] = {
    ...bootstrap.panels["panel-1"], id: "panel-2", label: "panel-2",
    tabs: [otherTab], activeTabId: "panel-2-tab"
  };
  return { ...f, otherPath };
}

export const completion = (async () => {
  installDomEnvironment();

  await assertTest("S2 switching syntax recompiles a non-focused panel's path instead of un-filtering it", async () => {
    const f = dualFixture();
    const h = await mount(f.bootstrap);
    try {
      // 在 panel-1（激活）输入并生效，子串语法下立即生效。
      await act(async () => { h.controller.actions.updateQuickFilterText(f.path, "pro"); await flushEffects(); });
      assert.ok(resolveQuickFilterProgram(h.controller.state, f.path), "precondition: panel-1 must be filtered");

      // 焦点交给停在另一条路径的 panel-2：过滤必须保留（D24 ②）。
      await act(async () => { h.controller.actions.focusPanel("panel-2"); await flushEffects(); });
      assert.ok(resolveQuickFilterProgram(h.controller.state, f.path), "losing focus must not cancel the filter");

      // 会话全局的语法切换会把所有路径的 appliedText 置空；非焦点路径必须同样被重算。
      await act(async () => { h.controller.actions.changeQuickFilterSyntax("regex"); await flushEffects(); });
      assert.equal(resolveQuickFilterProgram(h.controller.state, f.path), null,
        "a syntax switch blanks appliedText first (rule 3), so the list must not keep the stale program");
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });

      // "pro" 在 regex 下同样合法，因此非焦点面板必须自行恢复过滤，而无须重新获得焦点。
      assert.ok(resolveQuickFilterProgram(h.controller.state, f.path),
        "S2: a non-focused panel must be recompiled too, not left unfiltered until it regains focus");
      assert.equal(h.controller.state.activePanelId, "panel-2", "panel-2 must still hold focus");
    } finally { await h.close(); }
  });

  await assertTest("S2 an invalid pattern still keeps the last valid match on a non-focused path", async () => {
    const f = dualFixture();
    const h = await mount(f.bootstrap);
    try {
      await act(async () => { h.controller.actions.changeQuickFilterSyntax("regex"); await flushEffects(); });
      await act(async () => { h.controller.actions.updateQuickFilterText(f.path, "p.*t"); await flushEffects(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
      assert.ok(resolveQuickFilterProgram(h.controller.state, f.path), "precondition: a valid pattern must be applied");

      // 转到另一条路径后写坏模式：非焦点路径上的"最后一次有效匹配"必须保留（规则 6）。
      await act(async () => { h.controller.actions.focusPanel("panel-2"); await flushEffects(); });
      await act(async () => { h.controller.actions.updateQuickFilterText(f.path, "a(1"); await flushEffects(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
      assert.ok(resolveQuickFilterProgram(h.controller.state, f.path),
        "an invalid pattern on a non-focused path must keep the last valid match");
    } finally { await h.close(); }
  });
})();

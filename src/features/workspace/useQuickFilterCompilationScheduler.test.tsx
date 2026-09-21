import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { useWorkspaceController } from "./useWorkspaceController";
import { expansionFixture, expansionInteractions } from "./folderExpansionTestSupport";
import { planQuickFilterCompilations, resolveQuickFilterInput } from "./quickFilterState";
import { createWorkspaceState } from "./workspaceReducer";
import { assertTest, createTestGateway, flushEffects, installDomEnvironment, waitFor } from "./workspaceControllerTestHarness";
import { getPathComparisonKey } from "./workspacePathRelations";
import { QUICK_FILTER_REGEX_DEBOUNCE_MS, type QuickFilterMode, type QuickFilterSyntax } from "./quickFilterTypes";
import type { WorkspaceBootstrap, WorkspaceState } from "./types";

/**
 * 编译调度器的覆盖（规格 §6.6）。
 *
 * 覆盖缺口：`planQuickFilterCompilations` 此前没有任何测试，而 `settled` 分支恰好是
 * 一处真实缺陷的所在地——"文本回到上一次有效值"会被判为 settled 而跳过重编译，
 * 导致 regex 的错误诊断永远留在界面上（评审 R1 / 规格 §5.7 不变量"error 永远描述用户当下看到的文本"）。
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
    async settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, QUICK_FILTER_REGEX_DEBOUNCE_MS + 50)); }); },
    async close() { await act(async () => { root.unmount(); await flushEffects(); }); container.remove(); }
  };
}

/** 直接构造快速过滤状态，避免依赖控制器即可单测计划函数。 */
function stateWithFilter(overrides: {
  text: string;
  appliedText: string;
  error?: string | null;
  syntax?: QuickFilterSyntax;
  mode?: QuickFilterMode;
}) {
  const f = expansionFixture();
  const base = createWorkspaceState(f.bootstrap);
  const key = getPathComparisonKey(f.path);
  return {
    ...base,
    quickFilter: {
      ...base.quickFilter,
      syntax: overrides.syntax ?? "substring",
      mode: overrides.mode ?? "include",
      byPath: { [key]: { text: overrides.text, appliedText: overrides.appliedText, error: overrides.error ?? null } }
    }
  } satisfies WorkspaceState;
}

export const completion = (async () => {
  installDomEnvironment();

  await assertTest("R1 a stale regex error is cleared once the text returns to the last valid pattern", async () => {
    const h = await mount(expansionFixture().bootstrap);
    try {
      const path = expansionFixture().path;
      await act(async () => { h.controller.actions.changeQuickFilterSyntax("regex"); await flushEffects(); });

      await act(async () => { h.controller.actions.updateQuickFilterText(path, "p.*t"); await flushEffects(); });
      await h.settle();
      assert.equal(resolveQuickFilterInput(h.controller.state, path).error, null, "a valid pattern must be clean");

      await act(async () => { h.controller.actions.updateQuickFilterText(path, "p.*t("); await flushEffects(); });
      await h.settle();
      assert.match(resolveQuickFilterInput(h.controller.state, path).error ?? "", /./, "an invalid pattern must report");

      // 退格回到上一个有效模式：这是最常见的"打错再改回来"路径。
      await act(async () => { h.controller.actions.updateQuickFilterText(path, "p.*t"); await flushEffects(); });
      await h.settle();
      assert.equal(resolveQuickFilterInput(h.controller.state, path).error, null,
        "R1: returning to the last valid pattern must clear the stale diagnostic (spec §5.7)");
    } finally { await h.close(); }
  });

  await assertTest("planQuickFilterCompilations re-tasks a path whose text is applied but still carries an error", async () => {
    const key = getPathComparisonKey(expansionFixture().path);
    const stale = stateWithFilter({ text: "p.*t", appliedText: "p.*t", error: "bad pattern", syntax: "regex" });
    const planned = planQuickFilterCompilations(stale);
    // 断言按**该路径的键**判定，而不是 settled 的总数：mock bootstrap 的其它面板也停在各自路径上，
    // 它们同样是 settled 的，用总数会让这条断言在夹具变化时静默失真。
    assert.deepEqual(planned.tasks.map((task) => task.key), [key],
      "R1: a settled-but-erroring path must be recompiled to clear the error");
    assert.ok(!planned.settled.includes(key), "R1: it must not be classified as settled");

    const clean = stateWithFilter({ text: "p.*t", appliedText: "p.*t", error: null, syntax: "regex" });
    const plannedClean = planQuickFilterCompilations(clean);
    assert.equal(plannedClean.tasks.length, 0, "a genuinely settled path must not be recompiled");
    assert.ok(plannedClean.settled.includes(key), "a clean applied path is settled");

    const empty = stateWithFilter({ text: "", appliedText: "", error: null, syntax: "regex" });
    assert.ok(planQuickFilterCompilations(empty).settled.includes(key), "an empty text is settled");
  });

  await assertTest("planQuickFilterCompilations spans every panel's directory tabs and skips navigation tabs", async () => {
    const f = expansionFixture();
    const base = createWorkspaceState(f.bootstrap);
    const key = getPathComparisonKey(f.path);
    const state: WorkspaceState = {
      ...base,
      layoutMode: "dual",
      panels: {
        ...base.panels,
        "panel-2": { ...base.panels["panel-1"], id: "panel-2", label: "panel-2",
          tabs: [{ ...base.panels["panel-1"].tabs[0], id: "panel-2-tab" }], activeTabId: "panel-2-tab" }
      },
      quickFilter: { ...base.quickFilter, syntax: "substring",
        byPath: { [key]: { text: "pro", appliedText: "", error: null } } }
    };
    const planned = planQuickFilterCompilations(state);
    // 两个面板停在同一条路径；去重后该路径只应产生一个任务，而不是"每个面板各一次"。
    assert.deepEqual(planned.tasks.map((task) => task.key), [key],
      "same-path tabs must collapse into a single compile task");
    assert.equal(planned.tasks[0].path, f.path, "the task must carry the real path for the dispatch");
    assert.equal(planned.liveKeys.filter((live) => live === key).length, 1,
      "the same path across panels must appear once in liveKeys");
  });
})();

import { installQuickFilterTestWorker, settleQuickFilter } from "./quickFilterWorkerTestSupport";
import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { useWorkspaceController } from "./useWorkspaceController";
import { expansionFixture, expansionInteractions, expansionSnapshot } from "./folderExpansionTestSupport";
import { getPathComparisonKey } from "./workspacePathRelations";
import { resolveQuickFilterEntry, resolveQuickFilterProgram } from "./quickFilterState";
import { assertTest, createTestGateway, flushEffects, installDomEnvironment, waitFor } from "./workspaceControllerTestHarness";
import type { WorkspaceBootstrap } from "./types";
import type { WorkspaceGateway } from "./workspaceGateway";

async function mount(bootstrap: WorkspaceBootstrap, overrides: Parameters<typeof createTestGateway>[2] = {}) {
  const interactions = expansionInteractions();
  const gateway = createTestGateway(() => undefined, interactions, { loadBootstrap: () => bootstrap, ...overrides });
  let current!: ReturnType<typeof useWorkspaceController>;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  function Harness() { current = useWorkspaceController(gateway); return React.createElement("div"); }
  await act(async () => { root.render(React.createElement(Harness)); await flushEffects(); });
  await waitFor(() => current?.state.status === "ready", "bootstrap did not complete");
  return {
    get controller() { return current; },
    get tab() { return current.state.panels["panel-1"].tabs[0]; },
    interactions, gateway,
    async close() { await act(async () => { root.unmount(); await flushEffects(); }); container.remove(); }
  };
}

/**
 * 键盘直输的集成覆盖（规格 §8 分片 4）。
 * 该文件独立于 `useWorkspaceController.test.ts`，因为后者已顶在其 source-line 预算上限，
 * 而本分片需要新增一个完整的键盘直输场景矩阵。
 */
export const completion = (async () => {
  const dom = installDomEnvironment();
  installQuickFilterTestWorker();
  const key = async (value: string, init: KeyboardEventInit = {}) => act(async () => {
    (document.activeElement ?? dom.window.document.body).dispatchEvent(new dom.window.KeyboardEvent("keydown", {
      key: value, bubbles: true, cancelable: true, ...init
    }));
    await flushEffects();
  });

  /** B25：把某个动作的绑定替换为任意字符串（沿用 DEFAULT_SHORTCUTS 的结构）。 */
  function bindShortcut(bootstrap: WorkspaceBootstrap, id: string, binding: string) {
    bootstrap.settingsModel = {
      ...bootstrap.settingsModel,
      shortcuts: bootstrap.settingsModel.shortcuts.map((shortcut) =>
        shortcut.id === id ? { ...shortcut, binding } : shortcut
      )
    };
  }

  await assertTest("a panel round trip resets typeahead without clearing its remembered filter", async () => {
    const f = expansionFixture(); f.bootstrap.layoutMode = "dual";
    const h = await mount(f.bootstrap);
    try {
      await key("a");
      await act(async () => { h.controller.actions.focusPanel("panel-2"); await flushEffects(); });
      await act(async () => { h.controller.actions.focusPanel("panel-1"); await flushEffects(); });
      assert.equal(resolveQuickFilterEntry(h.controller.state, f.path).text, "a");
      await key("b");
      assert.equal(resolveQuickFilterEntry(h.controller.state, f.path).text, "b");
      await act(async () => { h.controller.actions.selectEntry("panel-1", f.tabId, f.parent.id, false); await flushEffects(); });
      await key("c");
      assert.equal(resolveQuickFilterEntry(h.controller.state, f.path).text, "bc", "selection changes must not reset typing");
    } finally { await h.close(); }
  });

  await assertTest("tab and path round trips also reset typeahead within the same aggregation window", async () => {
    const f = expansionFixture();
    const tab = f.bootstrap.panels["panel-1"].tabs[0];
    f.bootstrap.panels["panel-1"].tabs.push({ ...tab, id: "alternate-tab" });
    const h = await mount(f.bootstrap, { resolveDirectory: async path => expansionSnapshot(path, path === f.path ? [f.parent, f.sibling] : []) });
    try {
      await key("a");
      await act(async () => { h.controller.actions.activateTab("panel-1", "alternate-tab"); await flushEffects(); });
      await act(async () => { h.controller.actions.activateTab("panel-1", f.tabId); await flushEffects(); });
      await key("b");
      assert.equal(resolveQuickFilterEntry(h.controller.state, f.path).text, "b");
      await act(async () => { h.controller.actions.navigateToPath("panel-1", "C:\\other"); await flushEffects(); });
      await waitFor(() => h.tab.snapshot.location.path === "C:\\other", "navigate away");
      await act(async () => { h.controller.actions.navigateToPath("panel-1", f.path); await flushEffects(); });
      await waitFor(() => h.tab.snapshot.location.path === f.path, "navigate back");
      await key("c");
      assert.equal(resolveQuickFilterEntry(h.controller.state, f.path).text, "c");
      await act(async () => { h.controller.actions.refreshPanel("panel-1"); await flushEffects(); });
      await key("d");
      assert.equal(resolveQuickFilterEntry(h.controller.state, f.path).text, "cd", "same-path refresh keeps aggregation");
    } finally { await h.close(); }
  });

  await assertTest("keyboard typeahead aggregates printable keys into the active tab path", async () => {
    const f = expansionFixture();
    const h = await mount(f.bootstrap);
    try {
      for (const character of "project") await key(character);
      const entry = resolveQuickFilterEntry(h.controller.state, f.path);
      assert.equal(entry.text, "project");
      assert.equal(entry.error, null);
      // 子串语法下立即生效，因此生效程序与输入框文本同步。
      assert.equal(entry.appliedText, "project");
      assert.ok(resolveQuickFilterProgram(h.controller.state, f.path));
      // 只有激活标签页所在的路径被写入（无跨路径泄漏）。
      assert.deepEqual(Object.keys(h.controller.state.quickFilter.byPath), [getPathComparisonKey(f.path)]);
    } finally { await h.close(); }
  });

  await assertTest("a 1500ms gap restarts the aggregation instead of appending", async () => {
    const f = expansionFixture();
    const h = await mount(f.bootstrap);
    try {
      for (const character of "pr") await key(character);
      assert.equal(resolveQuickFilterEntry(h.controller.state, f.path).text, "pr");
      // 手工等待超过聚合超时；真实时钟下下一次按键必须替换而不是追加。
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1600)); });
      await key("x");
      assert.equal(resolveQuickFilterEntry(h.controller.state, f.path).text, "x");
    } finally { await h.close(); }
  });

  await assertTest("Escape clears a non-empty filter without clearing the selection", async () => {
    const f = expansionFixture();
    const h = await mount(f.bootstrap);
    try {
      await act(async () => { h.controller.actions.selectEntry("panel-1", f.tabId, f.parent.id, false); await flushEffects(); });
      for (const character of "pro") await key(character);
      assert.equal(resolveQuickFilterEntry(h.controller.state, f.path).text, "pro");

      await key("Escape");
      assert.equal(resolveQuickFilterEntry(h.controller.state, f.path).text, "",
        "Esc must clear the filter text of the active path");
      // B17：消费该按键，因此既有 clear-selection 不得同时执行。
      assert.deepEqual(h.tab.selectedEntryIds, [f.parent.id]);
    } finally { await h.close(); }
  });

  await assertTest("Escape with an empty filter keeps the existing clear-selection behaviour", async () => {
    const f = expansionFixture();
    const h = await mount(f.bootstrap);
    try {
      await act(async () => { h.controller.actions.selectEntry("panel-1", f.tabId, f.parent.id, false); await flushEffects(); });
      assert.equal(resolveQuickFilterEntry(h.controller.state, f.path).text, "");
      await key("Escape");
      assert.deepEqual(h.tab.selectedEntryIds, [], "an empty filter must fall through to clear-selection");
    } finally { await h.close(); }
  });

  await assertTest("regex text is debounced and an invalid pattern reports an error without touching the list", async () => {
    const f = expansionFixture();
    const h = await mount(f.bootstrap);
    try {
      await act(async () => { h.controller.actions.changeQuickFilterSyntax("regex"); await flushEffects(); });
      // 切到 regex 时不沿用旧语法下的有效文本（规则 3）。
      assert.equal(resolveQuickFilterEntry(h.controller.state, f.path).appliedText, "");

      await act(async () => { h.controller.actions.updateQuickFilterText(f.path, "p.*t"); await flushEffects(); });
      const pending = resolveQuickFilterEntry(h.controller.state, f.path);
      assert.equal(pending.text, "p.*t");
      assert.equal(pending.appliedText, "", "regex must not take effect before the debounce elapses");
      assert.equal(pending.error, null, "the debounce window must not raise an error");

      await settleQuickFilter(() => h.controller.state, f.path);
      assert.equal(resolveQuickFilterEntry(h.controller.state, f.path).appliedText, "p.*t");
      assert.equal(resolveQuickFilterEntry(h.controller.state, f.path).error, null);

      await act(async () => { h.controller.actions.updateQuickFilterText(f.path, "a(1"); await flushEffects(); });
      await settleQuickFilter(() => h.controller.state, f.path);
      const invalid = resolveQuickFilterEntry(h.controller.state, f.path);
      assert.match(invalid.error ?? "", /./, "an invalid pattern must surface a diagnostic");
      assert.equal(invalid.appliedText, "p.*t", "an invalid pattern keeps the last valid match");
    } finally { await h.close(); }
  });

  // ===== B25/D25：单键快捷键优先于键盘直输（规格 §8 分片 4b 集成）=====

  await assertTest("a configured single-key shortcut wins over keyboard typeahead (Red)", async () => {
    const f = expansionFixture();
    bindShortcut(f.bootstrap, "navigate-up", "s");
    const h = await mount(f.bootstrap);
    try {
      // 当前（未实现 B25）行为：s 被直输写成过滤文本，路径不变。
      // B25 行为：navigate-up 命中 → 导航到父路径 C:\，过滤文本保持空。
      await key("s");
      await waitFor(() => getPathComparisonKey(h.controller.state.panels["panel-1"].tabs[0].snapshot.location.path)
        === getPathComparisonKey("C:\\"), "navigate-up must move to the parent path");
      assert.equal(resolveQuickFilterEntry(h.controller.state, f.path).text, "",
        "the bound key must not become filter text");
    } finally { await h.close(); }
  });

  await assertTest("an unbound printable key still types even when another key is bound (regression guard)", async () => {
    const f = expansionFixture();
    bindShortcut(f.bootstrap, "navigate-up", "s");
    const h = await mount(f.bootstrap);
    try {
      for (const character of "pr") await key(character);
      assert.equal(resolveQuickFilterEntry(h.controller.state, f.path).text, "pr");
      assert.equal(h.controller.state.panels["panel-1"].tabs[0].snapshot.location.path, f.path,
        "unbound typeahead keys must not navigate");
    } finally { await h.close(); }
  });

  await assertTest("a bound key does not interrupt an in-progress aggregation (Red)", async () => {
    const f = expansionFixture();
    bindShortcut(f.bootstrap, "select-next", "s");
    const h = await mount(f.bootstrap);
    try {
      for (const character of "pr") await key(character);
      assert.equal(resolveQuickFilterEntry(h.controller.state, f.path).text, "pr");
      await key("s");
      // B25 行为：s 命中 select-next → 过滤文本保持 "pr"，之后 1500ms 内直输 j 追加成 "prj"。
      assert.equal(resolveQuickFilterEntry(h.controller.state, f.path).text, "pr",
        "a shortcut-bound key must not append to the filter text");
      await key("j");
      assert.equal(resolveQuickFilterEntry(h.controller.state, f.path).text, "prj",
        "the aggregation timestamp must only advance on real typeahead keys");
    } finally { await h.close(); }
  });

  await assertTest("a binding whose action bails out still consumes the key (Red)", async () => {
    const f = expansionFixture();
    bindShortcut(f.bootstrap, "navigate-forward", "s");
    const h = await mount(f.bootstrap);
    try {
      // expansionFixture 的标签页 history: [path]、historyIndex: 0 → forward 是“命中但无动作”
      // （navigateHistoryByDelta 取 history[1] === undefined，不导航，但先 preventDefault）。
      await key("s");
      assert.equal(resolveQuickFilterEntry(h.controller.state, f.path).text, "",
        "a hit binding must consume the key even when its action does nothing");
      assert.equal(h.controller.state.panels["panel-1"].tabs[0].snapshot.location.path, f.path);
    } finally { await h.close(); }
  });

  await assertTest("binding s does not claim Shift+S; Shift+S types the capital when unbound (regression guard)", async () => {
    const f = expansionFixture();
    bindShortcut(f.bootstrap, "navigate-up", "s");
    const h = await mount(f.bootstrap);
    try {
      await key("S", { shiftKey: true });
      assert.equal(resolveQuickFilterEntry(h.controller.state, f.path).text, "S",
        "Shift+S must type the capital letter when only s is bound");
      assert.equal(h.controller.state.panels["panel-1"].tabs[0].snapshot.location.path, f.path,
        "unbound Shift+S must not trigger the s-bound navigation");
    } finally { await h.close(); }
  });

  await assertTest("a bound Shift+S executes its own action instead of typing (Red)", async () => {
    const f = expansionFixture();
    bindShortcut(f.bootstrap, "navigate-up", "s");
    bindShortcut(f.bootstrap, "select-all", "Shift+S");
    const h = await mount(f.bootstrap);
    try {
      await key("S", { shiftKey: true });
      assert.equal(resolveQuickFilterEntry(h.controller.state, f.path).text, "",
        "a bound Shift+S must run the shortcut, not type the capital");
      // B23：全选目标集按行集（路径排序）排列，parent < sibling。
      assert.deepEqual(h.controller.state.panels["panel-1"].tabs[0].selectedEntryIds,
        [f.parent.id, f.sibling.id], "Shift+S must execute select-all");
    } finally { await h.close(); }
  });

  await assertTest("focused editable element still accepts a bound character (D25 ④ regression guard)", async () => {
    const f = expansionFixture();
    bindShortcut(f.bootstrap, "navigate-up", "s");
    const h = await mount(f.bootstrap);
    const input = dom.window.document.createElement("input");
    dom.window.document.body.appendChild(input);
    input.focus();
    try {
      const event = new dom.window.KeyboardEvent("keydown", { key: "s", bubbles: true, cancelable: true });
      await act(async () => { input.dispatchEvent(event); await flushEffects(); });
      assert.equal(event.defaultPrevented, false,
        "inside an editable element the app must not consume the key (the browser would type it)");
      assert.equal(h.controller.state.panels["panel-1"].tabs[0].snapshot.location.path, f.path,
        "a bound shortcut must not fire while the filter input is focused");
      assert.equal(resolveQuickFilterEntry(h.controller.state, f.path).text, "");
    } finally {
      input.blur();
      input.remove();
      await h.close();
    }
  });

  await assertTest("Esc still clears filter text when another action is bound to Escape (B17 regression guard)", async () => {
    const f = expansionFixture();
    bindShortcut(f.bootstrap, "copy", "Escape");
    const h = await mount(f.bootstrap);
    try {
      await act(async () => { h.controller.actions.selectEntry("panel-1", f.tabId, f.parent.id, false); await flushEffects(); });
      for (const character of "pro") await key(character);
      assert.equal(resolveQuickFilterEntry(h.controller.state, f.path).text, "pro");
      await key("Escape");
      assert.equal(resolveQuickFilterEntry(h.controller.state, f.path).text, "",
        "Esc must clear the filter text before any Escape-bound action runs");
      assert.equal(h.interactions.systemClipboardWrites.length, 0,
        "the Escape-bound copy action must not run while the filter text is non-empty");
    } finally { await h.close(); }
  });

  await assertTest("Esc with empty filter text falls through to an Escape-bound action (B17 regression guard)", async () => {
    const f = expansionFixture();
    bindShortcut(f.bootstrap, "copy", "Escape");
    const h = await mount(f.bootstrap);
    try {
      await act(async () => { h.controller.actions.selectEntry("panel-1", f.tabId, f.parent.id, false); await flushEffects(); });
      assert.equal(resolveQuickFilterEntry(h.controller.state, f.path).text, "");
      await key("Escape");
      assert.equal(h.interactions.systemClipboardWrites.length, 1,
        "Esc with an empty filter must reach the shortcut chain and run the Escape-bound action");
    } finally { await h.close(); }
  });
})();

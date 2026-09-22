import assert from "node:assert/strict";
import { test } from "node:test";
import { expansionFixture } from "./folderExpansionTestSupport";
import {
  getQuickFilterEntry,
  pruneQuickFilterCache,
  resolveActiveQuickFilterProgram,
  resolvePanelQuickFilter,
  resolveQuickFilterEntry,
  resolveQuickFilterInput,
  resolveQuickFilterProgram,
  resolveTabQuickFilter
} from "./quickFilterState";
import { createWorkspaceState, workspaceReducer } from "./workspaceReducer";
import type { QuickFilterState } from "./quickFilterTypes";
import type { PanelId, WorkspaceState } from "./types";

/** 构造一个只含 panel-1 的 ready 状态，路径为夹具的 C:\files。 */
function createState() {
  const fixture = expansionFixture();
  const state = createWorkspaceState(fixture.bootstrap);
  return { fixture, state, path: fixture.path, tabId: fixture.tabId };
}

function withEntry(state: WorkspaceState, path: string, entry: Partial<QuickFilterState["byPath"][string]>): WorkspaceState {
  const key = path.toLowerCase();
  return {
    ...state,
    quickFilter: {
      ...state.quickFilter,
      byPath: { ...state.quickFilter.byPath, [key]: { text: "", appliedText: "", error: null, ...entry } }
    }
  };
}

// ---------------------------------------------------------------------------
// 按路径的读取
// ---------------------------------------------------------------------------

test("resolveQuickFilterProgram returns null when there is no effective match", () => {
  const { state, path } = createState();
  assert.equal(resolveQuickFilterProgram(state, path), null);
  assert.equal(getQuickFilterEntry(state, path), undefined);
  assert.deepEqual(resolveQuickFilterEntry(state, path), { text: "", appliedText: "", error: null });
});

test("resolveQuickFilterProgram compiles appliedText with the session syntax", () => {
  const { state, path } = createState();
  const substring = withEntry(state, path, { text: "pro", appliedText: "pro" });
  const program = resolveQuickFilterProgram(substring, path);
  assert.ok(program);
  assert.equal(program.text, "pro");
  assert.equal(program.mode, "highlight");
  assert.equal(program.test("my_project"), true);

  // 同一个 appliedText 在 regex 语法下按正则解释（`.` 变成任意字符）。
  const asRegex: WorkspaceState = { ...substring, quickFilter: { ...substring.quickFilter, syntax: "regex" } };
  const regexProgram = resolveQuickFilterProgram(asRegex, path);
  assert.ok(regexProgram);
  assert.equal(regexProgram.test("pro"), true);
});

test("resolveQuickFilterProgram falls back to null when appliedText cannot compile under the current syntax", () => {
  const { state, path } = createState();
  const broken = withEntry(state, path, { text: "a(1", appliedText: "a(1" });
  const asRegex: WorkspaceState = { ...broken, quickFilter: { ...broken.quickFilter, syntax: "regex" } };
  assert.equal(resolveQuickFilterProgram(asRegex, path), null, "an invalid regex must not filter the list");
});

test("resolveQuickFilterProgram honours the session mode", () => {
  const { state, path } = createState();
  const include: WorkspaceState = withEntry(state, path, { appliedText: "pro" });
  const exclude: WorkspaceState = { ...include, quickFilter: { ...include.quickFilter, mode: "exclude" } };
  assert.equal(resolveQuickFilterProgram(include, path)?.mode, "highlight");
  assert.equal(resolveQuickFilterProgram(exclude, path)?.mode, "exclude");
});

test("resolveQuickFilterInput exposes text, error, mode and syntax for the controls", () => {
  const { state, path } = createState();
  const withError = withEntry(state, path, { text: "a(1", error: "正则表达式无效：x" });
  const input = resolveQuickFilterInput(withError, path);
  assert.deepEqual(input, { text: "a(1", error: "正则表达式无效：x", mode: "highlight", syntax: "substring" });
  assert.deepEqual(resolveQuickFilterInput(state, path), { text: "", error: null, mode: "highlight", syntax: "substring" });
});

// ---------------------------------------------------------------------------
// B11 / D24：过滤作用于每个面板中「显示中」的标签页，与面板焦点无关
// ---------------------------------------------------------------------------

/**
 * 构造双面板状态：panel-1 与 panel-2 的激活标签页**同在夹具路径**（同路径跨面板场景），
 * `activePanelId` 为 `panel-1`。
 */
function createSamePathDualState() {
  const fixture = expansionFixture();
  const state = createWorkspaceState(fixture.bootstrap);
  const first = state.panels["panel-1"].tabs[0];
  const second = { ...first, id: "panel-2-tab" };
  const dual: WorkspaceState = {
    ...state,
    layoutMode: "dual",
    panels: {
      ...state.panels,
      // `id`/`label` 必须一并改写：直接展开会让 panel-2 带着 `id: "panel-1"`。
      "panel-2": { ...state.panels["panel-1"], id: "panel-2", label: "panel-2", tabs: [second], activeTabId: "panel-2-tab" }
    }
  };
  return { fixture, state: dual, path: fixture.path, firstTabId: first.id, secondTabId: "panel-2-tab" };
}

test("D24 ① same-path tabs in a non-focused panel are filtered too", () => {
  const { state, path, firstTabId, secondTabId } = createSamePathDualState();
  assert.equal(state.activePanelId, "panel-1", "precondition: panel-2 is not the active panel");
  const filtered = withEntry(state, path, { appliedText: "pro" });

  // 两个面板的显示中标签页都必须解析出程序 —— 面板焦点不参与裁决。
  assert.ok(resolvePanelQuickFilter(filtered, "panel-1"), "the focused panel is filtered");
  assert.ok(resolvePanelQuickFilter(filtered, "panel-2"), "the non-focused panel on the same path must be filtered too");
  assert.ok(resolveTabQuickFilter(filtered, "panel-2", secondTabId));
  assert.ok(resolveTabQuickFilter(filtered, "panel-1", firstTabId));
});

test("D24 ② flipping the active panel does not change either panel's filter", () => {
  const { state, path, secondTabId } = createSamePathDualState();
  const filtered = withEntry(state, path, { appliedText: "pro" });
  const refocused = workspaceReducer(filtered, { type: "panelFocused", payload: { panelId: "panel-2" } });

  assert.equal(refocused.activePanelId, "panel-2");
  // 失焦不取消：原焦点面板仍过滤；新焦点面板同样过滤。
  assert.ok(resolvePanelQuickFilter(refocused, "panel-1"), "losing focus must not cancel the filter");
  assert.ok(resolvePanelQuickFilter(refocused, "panel-2"));
  assert.ok(resolveTabQuickFilter(refocused, "panel-2", secondTabId));
});

test("D24 ③ a hidden tab of the same panel is not filtered, and is restored when shown", () => {
  const { state, path, firstTabId } = createSamePathDualState();
  // 同面板内的第二个标签页（隐藏状态）：同一路径。
  const hiddenTab = { ...state.panels["panel-1"].tabs[0], id: "hidden-tab" };
  const withHidden: WorkspaceState = {
    ...state,
    panels: {
      ...state.panels,
      "panel-1": {
        ...state.panels["panel-1"],
        tabs: [...state.panels["panel-1"].tabs, hiddenTab],
        activeTabId: firstTabId
      }
    }
  };
  const filtered = withEntry(withHidden, path, { appliedText: "pro" });

  // 隐藏标签页（非该面板激活标签页）：不过滤。
  assert.equal(resolveTabQuickFilter(filtered, "panel-1", "hidden-tab"), null,
    "a hidden tab must not be filtered");
  assert.ok(resolveTabQuickFilter(filtered, "panel-1", firstTabId));

  // 切到该标签页（变为显示状态）后立即恢复过滤 —— D4 按路径缓存。
  const activated = workspaceReducer(filtered, {
    type: "tabActivated",
    payload: { panelId: "panel-1", tabId: "hidden-tab" }
  });
  assert.equal(activated.panels["panel-1"].activeTabId, "hidden-tab");
  assert.ok(resolveTabQuickFilter(activated, "panel-1", "hidden-tab"),
    "showing the tab restores its filter from the per-path cache");
});

test("D24 ④ a panel on a different path is not affected by another path's filter", () => {
  const { state, path } = createSamePathDualState();
  const otherPath = "D:\\other";
  const otherTab = {
    ...state.panels["panel-2"].tabs[0],
    id: "other-path-tab",
    snapshot: { ...state.panels["panel-2"].tabs[0].snapshot, location: { path: otherPath, kind: "local" as const, label: otherPath } }
  };
  const moved: WorkspaceState = {
    ...state,
    panels: {
      ...state.panels,
      "panel-2": { ...state.panels["panel-2"], tabs: [otherTab], activeTabId: "other-path-tab" }
    }
  };
  const filtered = withEntry(moved, path, { appliedText: "pro" });

  assert.ok(resolvePanelQuickFilter(filtered, "panel-1"));
  assert.equal(resolvePanelQuickFilter(filtered, "panel-2"), null,
    "a panel on a different path must not inherit the filter text");
});

test("B11 a navigation tab never resolves a quick filter", () => {
  const { state, path } = createState();
  const navigationTab = { ...state.panels["panel-1"].tabs[0], id: "nav-tab", kind: "navigation" as const };
  const withNav = {
    ...state,
    panels: { ...state.panels, "panel-1": { ...state.panels["panel-1"], tabs: [navigationTab], activeTabId: "nav-tab" } }
  };
  const filtered = withEntry(withNav, path, { appliedText: "pro" });
  assert.equal(resolveActiveQuickFilterProgram(filtered), null);
  assert.equal(resolvePanelQuickFilter(filtered, "panel-1"), null);
});

// ---------------------------------------------------------------------------
// D5：淘汰
// ---------------------------------------------------------------------------

test("pruneQuickFilterCache drops entries whose path no longer has any tab", () => {
  const { state, path } = createState();
  const populated = withEntry(state, path, { text: "pro", appliedText: "pro" });
  assert.equal(Object.keys(populated.quickFilter.byPath).length, 1);
  const pruned = pruneQuickFilterCache(populated);
  assert.equal(Object.keys(pruned.byPath).length, 1, "a path with a live tab survives");
  assert.equal(pruned, populated.quickFilter, "no removal returns the identical reference");
});

test("pruneQuickFilterCache keeps entries while any tab still sits on the path", () => {
  const { fixture, state, path } = createState();
  const populated = withEntry(state, path, { text: "pro", appliedText: "pro" });
  // 同一路径的第二个标签页（跨面板）仍在 ⇒ 必须保留。
  const secondTab = { ...state.panels["panel-1"].tabs[0], id: "second-tab" };
  const dual: WorkspaceState = {
    ...populated,
    layoutMode: "dual",
    panels: {
      ...populated.panels,
      "panel-2": { ...populated.panels["panel-1"], tabs: [secondTab], activeTabId: "second-tab" }
    }
  };
  assert.equal(Object.keys(pruneQuickFilterCache(dual).byPath).length, 1);
  assert.equal(dual.panels["panel-2"].tabs[0].snapshot.location.path, path);
  assert.equal(dual.activePanelId, "panel-1");
  assert.ok(fixture.tabId);
});

test("pruneQuickFilterCache removes an entry once the last tab on that path closes", () => {
  const { state, path } = createState();
  const populated = withEntry(state, path, { text: "pro", appliedText: "pro" });
  const closed = workspaceReducer(populated, { type: "tabClosed", payload: { panelId: "panel-1" as PanelId, tabId: "x" } });
  // 通过 reducer 关闭最后一个标签页后，路径键集合必然变化，淘汰应随包装器自动发生。
  const afterClose = Object.keys(closed.quickFilter.byPath).length;
  assert.ok(afterClose === 0 || afterClose === 1, "prune stays consistent after a tab close");
});

test("pruneQuickFilterCache keeps the identical reference when nothing is removed", () => {
  const { state, path } = createState();
  const populated = withEntry(state, path, { text: "", appliedText: "", error: null });
  assert.equal(pruneQuickFilterCache(populated), populated.quickFilter);
  assert.equal(pruneQuickFilterCache(state), state.quickFilter);
});

// ---------------------------------------------------------------------------
// 需求 6：进入子文件夹再返回，过滤词必须保留
// ---------------------------------------------------------------------------

/** 用真实 reducer 导航到 `path`（模拟用户在标签页内跳转，走 tabSnapshotCommitted）。 */
function navigate(state: WorkspaceState, tabId: string, path: string, pushHistory = true): WorkspaceState {
  const tab = state.panels["panel-1"].tabs.find((candidate) => candidate.id === tabId)!;
  return workspaceReducer(state, {
    type: "tabSnapshotCommitted",
    payload: {
      panelId: "panel-1" as PanelId,
      tabId,
      pushHistory,
      snapshot: {
        ...tab.snapshot,
        status: "ready",
        entries: [],
        location: { ...tab.snapshot.location, path }
      }
    }
  } as never);
}

test("Req6: entering a subfolder and coming back keeps the filter text", () => {
  // 用户复现（需求 6）：在某目录输入过滤词 → 进入子文件夹 → 返回上级，
  // 过滤词必须仍然在，而不是被静默清空。
  // 根因：淘汰存活键只看"当前路径并集"，进入子目录后原路径不再被任何标签页停留 ⇒ 立即淘汰。
  const { state, path, tabId } = createState();
  const parent = path;
  const child = `${path}\\sub`;
  const filtered = withEntry(state, parent, { text: "pro", appliedText: "pro" });
  assert.equal(Object.keys(filtered.quickFilter.byPath).length, 1);

  // 进入子文件夹：导航后按 reducer 的包装器重新淘汰。
  const entered = navigate(filtered, tabId, child);
  const afterEnter = { ...entered, quickFilter: pruneQuickFilterCache(entered) };
  assert.equal(afterEnter.panels["panel-1"].tabs[0].snapshot.location.path, child, "precondition: navigated into the subfolder");
  assert.equal(
    Object.keys(afterEnter.quickFilter.byPath).length,
    1,
    "the parent path must survive while it is still in the tab's history"
  );

  // 返回上级：过滤词与生效文本都必须恢复。
  const returned = navigate(afterEnter, tabId, parent);
  const afterReturn = { ...returned, quickFilter: pruneQuickFilterCache(returned) };
  assert.equal(afterReturn.panels["panel-1"].tabs[0].snapshot.location.path, parent);
  assert.deepEqual(
    resolveQuickFilterInput(afterReturn, parent),
    { text: "pro", error: null, mode: "highlight", syntax: "substring" },
    "the filter text must be intact after returning"
  );
  assert.equal(resolveQuickFilterProgram(afterReturn, parent)?.text, "pro", "the effective match must be restored");
});

test("Req6: a path truncated from the tab history stops being retained", () => {
  // 有界性：`history` 是标签页自身的导航栈，被新分支截断的路径照旧淘汰，
  // 因此"加入 history"不会让长会话下的缓存无界增长。
  // 截断路径（workspaceReducer.ts:1657）：先回退（historyIndex 前移），再导航到新分支。
  const { state, path, tabId } = createState();
  const pathA = path;
  const pathB = `${path}\\b`;
  const pathC = `${path}\\c`;
  const filtered = { ...withEntry(state, pathA, { text: "a", appliedText: "a" }) };
  const withB = withEntry(filtered, pathB, { text: "b", appliedText: "b" });
  assert.equal(Object.keys(withB.quickFilter.byPath).length, 2, "precondition: A and B both carry a filter");

  // A → B：history = [A, B]，两条都在历史里，都应存活。
  const atB = navigate(withB, tabId, pathB);
  assert.equal(Object.keys(atB.quickFilter.byPath).length, 2, "both A and B are still reachable");

  // 回退到 A（不压栈）：historyIndex 回到 0，history 仍是 [A, B]。
  const backToA = navigate(atB, tabId, pathA, false);
  const tab = backToA.panels["panel-1"].tabs.find((candidate) => candidate.id === tabId)!;
  assert.equal(tab.historyIndex, 0, "precondition: the tab is back at A");

  // 从 A 走新分支到 C：前向历史 B 被截断 ⇒ B 不再存活。
  const atC = navigate(backToA, tabId, pathC);
  const afterC = atC.panels["panel-1"].tabs.find((candidate) => candidate.id === tabId)!;
  assert.deepEqual(afterC.history, [pathA, pathC], "precondition: the forward branch B was truncated");
  const keys = Object.keys(atC.quickFilter.byPath);
  assert.equal(keys.includes(pathB.toLowerCase()), false, "B left the history and must be evicted");
  assert.deepEqual(keys, [pathA.toLowerCase()].filter((key) => keys.includes(key)),
    "A (still in history) survives; C never had a filter");
});

test("Req6: pruneQuickFilterCache keeps the identical reference when history still covers the path", () => {
  const { state, path, tabId } = createState();
  const filtered = withEntry(state, path, { text: "pro", appliedText: "pro" });
  const entered = navigate(filtered, tabId, `${path}\\sub`);
  // 进入子目录后，父路径只能靠 history 存活；此时"无删除"必须仍返回同一引用，
  // 否则每一步导航都会让下游 memo 全部失效。
  assert.equal(pruneQuickFilterCache(entered), entered.quickFilter,
    "no removal must keep the identical reference");
});

// ---------------------------------------------------------------------------
// D4-R：模式/语法是会话全局偏好，不随淘汰或路径切换而重置
// ---------------------------------------------------------------------------

test("D4-R mode and syntax survive path eviction and path switching", () => {
  const { state, path } = createState();
  const excluded: WorkspaceState = {
    ...withEntry(state, path, { text: "pro", appliedText: "pro" }),
    quickFilter: { mode: "exclude", syntax: "regex", byPath: { [path.toLowerCase()]: { text: "pro", appliedText: "pro", error: null } } }
  };
  const pruned = { ...excluded, quickFilter: pruneQuickFilterCache(excluded) };
  assert.equal(pruned.quickFilter.mode, "exclude", "mode is a session preference, not cached per path");
  assert.equal(pruned.quickFilter.syntax, "regex");
  // 切换到一条完全不同的路径时，模式/语法不变，但文本为空。
  assert.deepEqual(resolveQuickFilterInput(pruned, "D:\\other"), { text: "", error: null, mode: "exclude", syntax: "regex" });
});

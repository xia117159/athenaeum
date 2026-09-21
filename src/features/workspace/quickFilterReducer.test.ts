import assert from "node:assert/strict";
import { test } from "node:test";
import { createMockWorkspaceBootstrap } from "./mockData";
import { createWorkspaceState, workspaceReducer } from "./workspaceReducer";
import type { WorkspaceAction } from "./workspaceReducer";
import type { WorkspaceState } from "./types";

function createState(): WorkspaceState {
  const bootstrap = createMockWorkspaceBootstrap();
  bootstrap.layoutMode = "single";
  bootstrap.activePanelId = "panel-1";
  return createWorkspaceState(bootstrap);
}

/** 激活面板激活标签页所停留的路径。 */
function activePath(state: WorkspaceState): string {
  const panel = state.panels[state.activePanelId];
  const tab = panel.tabs.find((candidate) => candidate.id === panel.activeTabId) ?? panel.tabs[0];
  return tab.snapshot.location.path;
}

function seed(state: WorkspaceState, path: string, text: string): WorkspaceState {
  return workspaceReducer(state, { type: "quickFilterTextChanged", payload: { path, text } } as WorkspaceAction);
}

const GHOST = "C:\\ghost-path-that-no-tab-uses";

// ---------------------------------------------------------------------------
// D18：移除"过滤框输入切到搜索标签"的副作用
// ---------------------------------------------------------------------------

test("D18: the quick filter never switches the information panel tab", () => {
  const state = createState();
  // 先确定性地停在一个非搜索标签页上，避免默认值恰好是 "search" 让断言变成空断言。
  const onProperties = workspaceReducer(state, {
    type: "informationPanelTabChanged",
    payload: "properties"
  } as WorkspaceAction);
  assert.equal(onProperties.informationPanel.activeTab, "properties");
  assert.notEqual(state.informationPanel.activeTab, undefined);

  const path = activePath(onProperties);
  const filtered = seed(onProperties, path, "atlas");
  assert.equal(filtered.quickFilter.byPath[path.toLowerCase()]?.text, "atlas", "the quick filter text still updates");
  assert.equal(filtered.informationPanel.activeTab, "properties", "the panel must not jump to the search tab");
  assert.equal(filtered.informationPanel, onProperties.informationPanel, "no new panel object may be created");
});

// ---------------------------------------------------------------------------
// §5.7 状态机（经由 reducer，含包装器）
// ---------------------------------------------------------------------------

test("§5.7 substring text changes take effect immediately through the reducer", () => {
  const state = createState();
  const path = activePath(state);
  const next = seed(state, path, "pro");
  const entry = next.quickFilter.byPath[path.toLowerCase()];
  assert.deepEqual(entry, { text: "pro", appliedText: "pro", error: null });
});

test("§5.7 under regex the applied text lags until the compile result lands", () => {
  const state = createState();
  const path = activePath(state);
  const asRegex = workspaceReducer(state, { type: "quickFilterSyntaxChanged", payload: { syntax: "regex" } } as WorkspaceAction);
  const typed = seed(asRegex, path, "pro");
  assert.equal(typed.quickFilter.byPath[path.toLowerCase()].text, "pro");
  assert.equal(typed.quickFilter.byPath[path.toLowerCase()].appliedText, "", "not effective until compiled");

  const applied = workspaceReducer(typed, {
    type: "quickFilterApplied",
    payload: { path, text: "pro", ok: true, message: null }
  } as WorkspaceAction);
  assert.deepEqual(applied.quickFilter.byPath[path.toLowerCase()], { text: "pro", appliedText: "pro", error: null });
});

test("§5.7 an invalid regex records the message and keeps the previous effective match", () => {
  const state = createState();
  const path = activePath(state);
  const asRegex = workspaceReducer(state, { type: "quickFilterSyntaxChanged", payload: { syntax: "regex" } } as WorkspaceAction);
  const good = workspaceReducer(seed(asRegex, path, "pro"), {
    type: "quickFilterApplied",
    payload: { path, text: "pro", ok: true, message: null }
  } as WorkspaceAction);

  const broken = workspaceReducer(good, { type: "quickFilterTextChanged", payload: { path, text: "a(1" } } as WorkspaceAction);
  const diagnosed = workspaceReducer(broken, {
    type: "quickFilterApplied",
    payload: { path, text: "a(1", ok: false, message: "正则表达式无效：x" }
  } as WorkspaceAction);
  assert.deepEqual(diagnosed.quickFilter.byPath[path.toLowerCase()], {
    text: "a(1",
    appliedText: "pro",
    error: "正则表达式无效：x"
  });

  // 空文本无条件清空生效匹配与诊断（评审 S3）。
  const cleared = workspaceReducer(diagnosed, { type: "quickFilterTextChanged", payload: { path, text: "" } } as WorkspaceAction);
  assert.deepEqual(cleared.quickFilter.byPath[path.toLowerCase()], { text: "", appliedText: "", error: null });
});

test("§5.7 a stale quickFilterApplied dispatch is dropped", () => {
  const state = createState();
  const path = activePath(state);
  const typed = seed(state, path, "newest");
  const stale = workspaceReducer(typed, {
    type: "quickFilterApplied",
    payload: { path, text: "older", ok: true, message: null }
  } as WorkspaceAction);
  assert.equal(stale, typed, "a stale dispatch must not produce a new state object");
});

test("§5.7 quickFilterTypeaheadAppended behaves exactly like quickFilterTextChanged", () => {
  const state = createState();
  const path = activePath(state);
  const viaInput = workspaceReducer(state, { type: "quickFilterTextChanged", payload: { path, text: "pro" } } as WorkspaceAction);
  const viaKeys = workspaceReducer(state, { type: "quickFilterTypeaheadAppended", payload: { path, text: "pro" } } as WorkspaceAction);
  assert.deepEqual(viaKeys.quickFilter, viaInput.quickFilter);
});

test("§5.7 switching syntax to regex invalidates the applied text; switching back recomputes it", () => {
  const state = createState();
  const path = activePath(state);
  const typed = seed(state, path, "pro");
  const asRegex = workspaceReducer(typed, { type: "quickFilterSyntaxChanged", payload: { syntax: "regex" } } as WorkspaceAction);
  assert.equal(asRegex.quickFilter.byPath[path.toLowerCase()].appliedText, "", "validity does not carry across syntaxes");
  assert.equal(asRegex.quickFilter.byPath[path.toLowerCase()].text, "pro", "the input is preserved");

  const backToSubstring = workspaceReducer(asRegex, { type: "quickFilterSyntaxChanged", payload: { syntax: "substring" } } as WorkspaceAction);
  assert.equal(backToSubstring.quickFilter.byPath[path.toLowerCase()].appliedText, "pro");
  assert.equal(backToSubstring.quickFilter.byPath[path.toLowerCase()].error, null);
});

test("quickFilterModeChanged and quickFilterCleared go through the reducer", () => {
  const state = createState();
  const path = activePath(state);
  const typed = seed(state, path, "pro");
  const excluded = workspaceReducer(typed, { type: "quickFilterModeChanged", payload: { mode: "exclude" } } as WorkspaceAction);
  assert.equal(excluded.quickFilter.mode, "exclude");
  assert.deepEqual(excluded.quickFilter.byPath, typed.quickFilter.byPath, "the mode never rewrites cached text");

  const cleared = workspaceReducer(excluded, { type: "quickFilterCleared", payload: { path } } as WorkspaceAction);
  assert.deepEqual(cleared.quickFilter.byPath[path.toLowerCase()], { text: "", appliedText: "", error: null });
  assert.equal(cleared.quickFilter.mode, "exclude", "clearing keeps the session mode");
});

// ---------------------------------------------------------------------------
// §5.8 淘汰与 G1 守卫
// ---------------------------------------------------------------------------

test("§5.8 eviction keeps live paths and drops paths no tab uses once panels change", () => {
  const state = createState();
  const live = activePath(state);
  const seeded = seed(seed(state, live, "pro"), GHOST, "ghost");

  // 面板/标签页结构未变 ⇒ 淘汰被跳过（G1），幽灵条目存活。
  const highFrequency = workspaceReducer(seeded, {
    type: "searchProgressUpdated",
    payload: { scannedEntries: 10, matchedEntries: 0, cancelled: false, statusText: "扫描中" }
  } as WorkspaceAction);
  assert.equal(highFrequency.quickFilter.byPath[GHOST.toLowerCase()]?.text, "ghost", "prune must be skipped when panels are unchanged");
  assert.equal(highFrequency.quickFilter, seeded.quickFilter, "the reference is preserved on unrelated actions");

  // 结构变化 ⇒ 淘汰执行：幽灵路径被删，真实路径保留。
  const extraTab = { ...state.panels[state.activePanelId].tabs[0], id: "extra-tab" };
  const withExtraTab = workspaceReducer(seeded, {
    type: "tabOpened",
    payload: { panelId: state.activePanelId, tab: extraTab }
  } as WorkspaceAction);
  assert.equal(withExtraTab.quickFilter.byPath[GHOST.toLowerCase()], undefined, "an unused path key is evicted");
  assert.equal(withExtraTab.quickFilter.byPath[live.toLowerCase()]?.text, "pro", "a live path key survives");
});

test("§5.8 closing the last tab on a path evicts its cached filter text", () => {
  const state = createState();
  const live = activePath(state);
  const seeded = seed(state, live, "pro");

  // 先开一个不同路径的标签页，再关掉原先那个：原路径不再有任何标签页停留。
  const otherTab = {
    ...state.panels[state.activePanelId].tabs[0],
    id: "other-path-tab",
    snapshot: {
      ...state.panels[state.activePanelId].tabs[0].snapshot,
      location: { path: "D:\\elsewhere", kind: "local" as const, label: "elsewhere" }
    }
  };
  const withOther = workspaceReducer(seeded, {
    type: "tabOpened",
    payload: { panelId: state.activePanelId, tab: otherTab }
  } as WorkspaceAction);
  assert.equal(withOther.quickFilter.byPath[live.toLowerCase()]?.text, "pro", "still alive while its tab exists");

  const originalTabId = state.panels[state.activePanelId].tabs[0].id;
  const closed = workspaceReducer(withOther, {
    type: "tabClosed",
    payload: { panelId: state.activePanelId, tabId: originalTabId }
  } as WorkspaceAction);
  assert.equal(
    closed.quickFilter.byPath[live.toLowerCase()],
    undefined,
    "the cached text must be evicted once the last tab on that path closes (D5)"
  );
});

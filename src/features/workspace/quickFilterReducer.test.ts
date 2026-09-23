import { collectQuickFilterCorpora } from "./quickFilterEvaluationState";
import { evaluateQuickFilter } from "./quickFilterEvaluator";
import { getPathComparisonKey } from "./workspacePathRelations";
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

function evaluationAction(state: WorkspaceState, path: string): WorkspaceAction {
  const key = getPathComparisonKey(path);
  const entry = state.quickFilter.byPath[key];
  const corpus = collectQuickFilterCorpora(state).get(key)!;
  return { type: "quickFilterEvaluationCommitted", payload: { path, expectedEntry: entry, corpusKey: corpus.key,
    result: evaluateQuickFilter({ text: entry.text, fallbackText: entry.appliedText, names: corpus.names, includeRanges: true }) } };
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

  const applied = workspaceReducer(typed, evaluationAction(typed, path));
  const entry = applied.quickFilter.byPath[path.toLowerCase()];
  assert.equal(entry.text, "pro");
  assert.equal(entry.appliedText, "pro");
  assert.equal(entry.error, null);
  assert.ok(entry.regexEvaluation);

});

test("§5.7 an invalid regex records the message and keeps the previous effective match", () => {
  const state = createState();
  const path = activePath(state);
  const asRegex = workspaceReducer(state, { type: "quickFilterSyntaxChanged", payload: { syntax: "regex" } } as WorkspaceAction);
  const typed = seed(asRegex, path, "pro");
  const good = workspaceReducer(typed, evaluationAction(typed, path));
  const broken = seed(good, path, "a(1");
  const diagnosed = workspaceReducer(broken, evaluationAction(broken, path));
  const entry = diagnosed.quickFilter.byPath[path.toLowerCase()];
  assert.equal(entry.text, "a(1");
  assert.equal(entry.appliedText, "pro");
  assert.ok(entry.error);
  assert.deepEqual(entry.regexEvaluation, good.quickFilter.byPath[path.toLowerCase()].regexEvaluation);

  const cleared = workspaceReducer(diagnosed, { type: "quickFilterTextChanged", payload: { path, text: "" } } as WorkspaceAction);
  assert.deepEqual(cleared.quickFilter.byPath[path.toLowerCase()], { text: "", appliedText: "", error: null });
});

test("stale Worker commit is dropped by the reducer", () => {
  const state = workspaceReducer(createState(), { type: "quickFilterSyntaxChanged", payload: { syntax: "regex" } });
  const path = activePath(state);
  const old = seed(state, path, "older");
  const action = evaluationAction(old, path);
  const typed = seed(old, path, "newest");
  assert.equal(workspaceReducer(typed, action), typed);
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

test("§5.8 + 需求 6: a path leaves the cache only when it leaves the tab's history", () => {
  const state = createState();
  const live = activePath(state);
  const seeded = seed(state, live, "pro");

  // 开一个不同路径的标签页：新标签页只在自己的路径上有历史，因此**不**覆盖 `live`。
  const firstTab = state.panels[state.activePanelId].tabs[0];
  const otherTab = {
    ...firstTab,
    id: "other-path-tab",
    history: ["D:\\elsewhere"],
    historyIndex: 0,
    snapshot: {
      ...firstTab.snapshot,
      location: { path: "D:\\elsewhere", kind: "local" as const, label: "elsewhere" }
    }
  };
  const withOther = workspaceReducer(seeded, {
    type: "tabOpened",
    payload: { panelId: state.activePanelId, tab: otherTab }
  } as WorkspaceAction);
  assert.equal(withOther.quickFilter.byPath[live.toLowerCase()]?.text, "pro", "still alive while its tab exists");

  // 把原标签页导航到子目录：`live` 仍在它的 history 里 ⇒ 仍然保留。
  const nested = `${live}\\sub`;
  const navigated = workspaceReducer(withOther, {
    type: "tabSnapshotCommitted",
    payload: {
      panelId: state.activePanelId,
      tabId: firstTab.id,
      pushHistory: true,
      snapshot: {
        ...firstTab.snapshot,
        status: "ready" as const,
        entries: [],
        location: { ...firstTab.snapshot.location, path: nested }
      }
    }
  } as WorkspaceAction);
  const navigatedTab = navigated.panels[state.activePanelId].tabs.find((tab) => tab.id === firstTab.id)!;
  assert.ok(navigatedTab.history.includes(live), "precondition: the parent path is in the tab's history");
  assert.equal(navigated.quickFilter.byPath[live.toLowerCase()]?.text, "pro",
    "the parent path must survive while it is still in that tab's history (需求 6)");

  // 关闭该标签页 ⇒ 它的 history 一并释放 ⇒ 原路径淘汰。
  const closed = workspaceReducer(navigated, {
    type: "tabClosed",
    payload: { panelId: state.activePanelId, tabId: firstTab.id }
  } as WorkspaceAction);
  assert.equal(
    closed.quickFilter.byPath[live.toLowerCase()],
    undefined,
    "the cached text must be evicted once no tab can reach that path any more (D5)"
  );
});

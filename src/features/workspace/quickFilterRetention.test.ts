import assert from "node:assert/strict";
import { test } from "node:test";
import { expansionEntry, expansionFixture, expansionSnapshot } from "./folderExpansionTestSupport";
import { createWorkspaceState, workspaceReducer } from "./workspaceReducer";
import { collectQuickFilterCorpora, type QuickFilterEvaluationCommit } from "./quickFilterEvaluationState";
import { evaluateQuickFilter } from "./quickFilterEvaluator";
import { getPathComparisonKey } from "./workspacePathRelations";
import { resolveActiveQuickFilterProgram } from "./quickFilterState";
import { getFolderListingRows, getTabSelectedEntries } from "./folderExpansion";
import type { WorkspaceState } from "./types";

function evaluate(state: WorkspaceState, path: string) {
  const entry = state.quickFilter.byPath[getPathComparisonKey(path)];
  const corpus = collectQuickFilterCorpora(state).get(getPathComparisonKey(path))!;
  const payload: QuickFilterEvaluationCommit = { path, expectedEntry: entry, corpusKey: corpus.key,
    result: evaluateQuickFilter({ text: entry.text, fallbackText: entry.appliedText, names: corpus.names, includeRanges: true }) };
  return { state: workspaceReducer(state, { type: "quickFilterEvaluationCommitted", payload }), payload };
}

test("navigation keeps filter conditions but releases historical match corpora", () => {
  const f = expansionFixture();
  let state = workspaceReducer(createWorkspaceState(f.bootstrap), { type: "quickFilterSyntaxChanged", payload: { syntax: "regex" } });
  for (let index = 0; index < 12; index++) {
    const path = `C:\\visited-${index}`;
    state = workspaceReducer(state, { type: "tabSnapshotCommitted", payload: { panelId: "panel-1", tabId: f.tabId,
      pushHistory: true, snapshot: expansionSnapshot(path, Array.from({ length: 40 }, (_, i) => expansionEntry(path, `x-${i}`))) } });
    state = workspaceReducer(state, { type: "quickFilterTextChanged", payload: { path, text: "^x" } });
    state = evaluate(state, path).state;
    const retained = Object.values(state.quickFilter.byPath);
    assert.equal(retained.reduce((sum, entry) => sum + Object.keys(entry.regexEvaluation?.matches ?? {}).length, 0), 40);
    assert.equal(retained.filter(entry => entry.regexAttempt).length, 1);
    assert.ok(retained.every(entry => entry.text === "^x" && entry.appliedText === "^x"));
  }
  assert.equal(Object.keys(state.quickFilter.byPath).length, 12, "folder conditions remain remembered");
});

test("returning to an invalid query rebuilds its last valid matches without exposing pending operation targets", () => {
  const f = expansionFixture();
  let state = createWorkspaceState(f.bootstrap);
  state = workspaceReducer(state, { type: "quickFilterSyntaxChanged", payload: { syntax: "regex" } });
  state = workspaceReducer(state, { type: "quickFilterTextChanged", payload: { path: f.path, text: "parent" } });
  const original = evaluate(state, f.path); state = original.state;
  state = workspaceReducer(state, { type: "quickFilterTextChanged", payload: { path: f.path, text: "(" } });
  state = evaluate(state, f.path).state;
  const snapshot = state.panels["panel-1"].tabs[0].snapshot;
  state = workspaceReducer(state, { type: "tabSnapshotCommitted", payload: { panelId: "panel-1", tabId: f.tabId,
    pushHistory: true, snapshot: expansionSnapshot("C:\\other", []) } });
  assert.equal(state.quickFilter.byPath[getPathComparisonKey(f.path)].regexEvaluation, undefined);
  assert.equal(workspaceReducer(state, { type: "quickFilterEvaluationCommitted", payload: original.payload }), state);
  state = workspaceReducer(state, { type: "tabSnapshotCommitted", payload: { panelId: "panel-1", tabId: f.tabId,
    pushHistory: true, snapshot } });
  const tab = state.panels["panel-1"].tabs[0]; tab.selectedEntryIds = [f.parent.id];
  for (const mode of ["include", "exclude"] as const) {
    state = workspaceReducer(state, { type: "quickFilterModeChanged", payload: { mode } });
    const program = resolveActiveQuickFilterProgram(state);
    assert.equal(program?.isPending?.(f.parent.name), true);
    assert.deepEqual(getTabSelectedEntries(tab, state.fileVisibility, program, false), []);
    assert.deepEqual(getFolderListingRows(tab, state.fileVisibility, program, false), []);
  }
  state = evaluate(state, f.path).state;
  assert.equal(resolveActiveQuickFilterProgram(state)?.test(f.parent.name), true);
  assert.ok(state.quickFilter.byPath[getPathComparisonKey(f.path)].error);
});

test("same-path active panels keep shared data while hidden tabs release their own corpora", () => {
  const f = expansionFixture();
  let state = createWorkspaceState(f.bootstrap);
  const first = state.panels["panel-1"].tabs[0];
  state.panels["panel-2"] = { ...state.panels["panel-2"], activeTabId: "second", tabs: [{ ...first, id: "second" }] };
  state = workspaceReducer(state, { type: "quickFilterSyntaxChanged", payload: { syntax: "regex" } });
  state = workspaceReducer(state, { type: "quickFilterTextChanged", payload: { path: f.path, text: "parent" } });
  state = evaluate(state, f.path).state;
  const saved = state.quickFilter.byPath[getPathComparisonKey(f.path)];
  state = workspaceReducer(state, { type: "tabSnapshotCommitted", payload: { panelId: "panel-1", tabId: f.tabId,
    pushHistory: true, snapshot: expansionSnapshot("C:\\other", []) } });
  assert.equal(state.quickFilter.byPath[getPathComparisonKey(f.path)], saved, "unfocused active panel keeps the shared result");
  state.panels["panel-2"].tabs.push({ ...first, id: "another", snapshot: expansionSnapshot("C:\\another", []) });
  state = workspaceReducer(state, { type: "tabActivated", payload: { panelId: "panel-2", tabId: "another" } });
  assert.equal(state.quickFilter.byPath[getPathComparisonKey(f.path)].regexEvaluation, undefined);
  assert.equal(collectQuickFilterCorpora(state).has(getPathComparisonKey(f.path)), false);
});

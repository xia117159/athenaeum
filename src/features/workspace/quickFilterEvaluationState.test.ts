import assert from "node:assert/strict";
import { test } from "node:test";
import { expansionEntry, expansionFixture } from "./folderExpansionTestSupport";
import { createWorkspaceState, workspaceReducer } from "./workspaceReducer";
import { applyQuickFilterEvaluation, collectQuickFilterCorpora, type QuickFilterEvaluationCommit } from "./quickFilterEvaluationState";
import { evaluateQuickFilter } from "./quickFilterEvaluator";
import { getPathComparisonKey } from "./workspacePathRelations";
import { resolveActiveQuickFilterProgram } from "./quickFilterState";
import { getFolderListingRows, getTabSelectedEntries } from "./folderExpansion";

function fixture() {
  const f = expansionFixture();
  let state = createWorkspaceState(f.bootstrap);
  state = workspaceReducer(state, { type: "quickFilterSyntaxChanged", payload: { syntax: "regex" } });
  state = workspaceReducer(state, { type: "quickFilterModeChanged", payload: { mode: "exclude" } });
  state = workspaceReducer(state, { type: "quickFilterTextChanged", payload: { path: f.path, text: "sibling" } });
  const key = getPathComparisonKey(f.path);
  const corpus = collectQuickFilterCorpora(state).get(key)!;
  const payload: QuickFilterEvaluationCommit = { path: f.path, expectedEntry: state.quickFilter.byPath[key],
    corpusKey: corpus.key, result: evaluateQuickFilter({ text: "sibling", fallbackText: "", names: corpus.names }) };
  return { ...f, state, key, payload };
}

test("Worker data is the only source for regex projection, including unknown names", () => {
  const f = fixture();
  const state = applyQuickFilterEvaluation(f.state, f.payload);
  const tab = state.panels["panel-1"].tabs[0];
  const fresh = expansionEntry(f.path, "newly-discovered");
  tab.snapshot = { ...tab.snapshot, entries: [...tab.snapshot.entries, fresh] };
  tab.selectedEntryIds = tab.snapshot.entries.map(e => e.id);
  const program = resolveActiveQuickFilterProgram(state);
  assert.ok(program);
  assert.equal(program.test("unseen"), false, "unknown names must not be synchronously regex-matched");
  assert.equal(program.isPending?.("newly-discovered"), true);
  const rows = getFolderListingRows(tab, state.fileVisibility, program, false);
  assert.deepEqual(rows.map(r => r.entry.id), [f.parent.id], "exclude must also withhold unevaluated names");
  assert.deepEqual(getTabSelectedEntries(tab, state.fileVisibility, program, false).map(e => e.id), [f.parent.id]);
});

test("query edits, clear, syntax changes and name changes fence late Worker commits", () => {
  const f = fixture();
  for (const action of [
    { type: "quickFilterTextChanged", payload: { path: f.path, text: "other" } },
    { type: "quickFilterCleared", payload: { path: f.path } },
    { type: "quickFilterSyntaxChanged", payload: { syntax: "substring" } }
  ] as const) {
    const changed = workspaceReducer(f.state, action);
    assert.equal(applyQuickFilterEvaluation(changed, f.payload), changed);
  }
  const changed = structuredClone(f.state);
  // Keep query identity intact so the corpus guard, not entry identity, rejects it.
  changed.quickFilter = f.state.quickFilter;
  changed.panels["panel-1"].tabs[0].snapshot.entries.push(expansionEntry(f.path, "new"));
  assert.equal(applyQuickFilterEvaluation(changed, f.payload), changed);
});

test("include mode withholds newly discovered selected names before evaluation", () => {
  const f = fixture();
  const state = applyQuickFilterEvaluation(f.state, f.payload);
  state.quickFilter.mode = "include";
  const tab = state.panels["panel-1"].tabs[0];
  const fresh = expansionEntry(f.path, "newly-discovered");
  tab.snapshot.entries.push(fresh);
  tab.selectedEntryIds = [fresh.id];
  const program = resolveActiveQuickFilterProgram(state);
  assert.deepEqual(getFolderListingRows(tab, state.fileVisibility, program, false).map(row => row.entry.id), [f.sibling.id]);
  assert.deepEqual(getTabSelectedEntries(tab, state.fileVisibility, program, false), []);
});

test("invalid query re-evaluates the last good pattern after directory refresh", () => {
  const result = evaluateQuickFilter({ text: "(", fallbackText: "sibling", names: ["sibling2", "other", "__proto__"] });
  assert.ok(result.error);
  assert.equal(result.evaluation?.text, "sibling");
  assert.equal(result.evaluation?.matches.sibling2.matched, true);
  assert.equal(result.evaluation?.matches.other.matched, false);
  assert.equal(result.evaluation?.matches["__proto__"].matched, false);
});

test("invalid edited query keeps committed matches visible until replacement evaluation", () => {
  const f = fixture();
  const committed = applyQuickFilterEvaluation(f.state, f.payload);
  const invalid = workspaceReducer(committed, { type: "quickFilterTextChanged", payload: { path: f.path, text: "(" } });
  const program = resolveActiveQuickFilterProgram(invalid);
  assert.ok(program);
  assert.equal(program.text, "sibling");
  assert.equal(program.test(f.parent.name), false);
});

test("both same-path panels share the corpus and commit, independent of focus", () => {
  const f = fixture();
  const state = f.state;
  state.panels["panel-2"] = { ...state.panels["panel-1"], id: "panel-2", activeTabId: "second",
    tabs: [{ ...state.panels["panel-1"].tabs[0], id: "second", snapshot: {
      ...state.panels["panel-1"].tabs[0].snapshot, entries: [expansionEntry(f.path, "extra")]
    } }] };
  const corpus = collectQuickFilterCorpora(state).get(f.key)!;
  assert.ok(corpus.names.includes("extra"));
  const changed = applyQuickFilterEvaluation(state, { ...f.payload, corpusKey: corpus.key,
    result: evaluateQuickFilter({ text: "sibling", fallbackText: "", names: corpus.names }) });
  assert.ok(changed.quickFilter.byPath[f.key].regexEvaluation?.matches.extra);
});

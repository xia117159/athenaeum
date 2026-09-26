import assert from "node:assert/strict";
import { test } from "node:test";
import { createMockWorkspaceBootstrap } from "./mockData";
import { getFolderListingEntries, getFolderListingRows, getTabSelectedEntries } from "./folderExpansion";
import { createWorkspaceState, getActiveTab, workspaceReducer } from "./workspaceReducer";
import { DEFAULT_FILE_VISIBILITY } from "./workspaceVisibility";
import { applyQuickFilterText, resolvePanelQuickFilter } from "./quickFilterState";
import { getPathComparisonKey } from "./workspacePathRelations";

test("a click selection reuses the 20k-row projection while visible inputs stay unchanged", () => {
  const state = createWorkspaceState(createMockWorkspaceBootstrap());
  const tab = getActiveTab(state.panels["panel-1"]);
  const base = tab.snapshot.entries[0];
  assert.ok(base);
  tab.snapshot = { ...tab.snapshot, entries: Array.from({ length: 20_000 }, (_, index) => ({
    ...base, id: `entry-${index}`, kind: "file" as const,
    name: `entry-${String(index).padStart(5, "0")}.txt`, path: `D:\\Projects\\Atlas\\entry-${index}.txt`
  })) };
  const before = getFolderListingRows(tab, DEFAULT_FILE_VISIBILITY, null, true);
  assert.equal(before.length, 20_000);
  const beforeEntries = getFolderListingEntries(before);
  const selected = workspaceReducer(state, {
    type: "entrySelectionSet", payload: { panelId: "panel-1", tabId: tab.id, entryIds: [before[500].entry.id] }
  });
  const afterTab = getActiveTab(selected.panels["panel-1"]);
  assert.notEqual(afterTab, tab);
  const after = getFolderListingRows(afterTab, DEFAULT_FILE_VISIBILITY, null, true);
  assert.strictEqual(after, before, "selection alone must retain the already projected row array");
  assert.strictEqual(getFolderListingEntries(after), beforeEntries,
    "the workspace listing must retain its mapped entry array after a click");
});

test("selection after a warm projection reads only selected rows", () => {
  const state = createWorkspaceState(createMockWorkspaceBootstrap());
  const tab = getActiveTab(state.panels["panel-1"]);
  const base = tab.snapshot.entries[0];
  assert.ok(base);
  tab.snapshot = { ...tab.snapshot, entries: Array.from({ length: 20_000 }, (_, index) => ({
    ...base, id: `entry-${index}`, kind: "file" as const,
    name: `entry-${String(index).padStart(5, "0")}.txt`, path: `D:\\Projects\\Atlas\\entry-${index}.txt`
  })) };
  const rows = getFolderListingRows(tab, DEFAULT_FILE_VISIBILITY, null, true);
  let entryReads = 0;
  for (const row of rows) {
    const entry = row.entry;
    Object.defineProperty(row, "entry", { get() { entryReads++; return entry; } });
  }
  tab.selectedEntryIds = [rows[500].entry.id];
  assert.deepEqual(getTabSelectedEntries(tab, DEFAULT_FILE_VISIBILITY, null, true).map((entry) => entry.id), [tab.selectedEntryIds[0]]);
  entryReads = 0;
  tab.selectedEntryIds = [rows[19_500].entry.id];
  assert.deepEqual(getTabSelectedEntries(tab, DEFAULT_FILE_VISIBILITY, null, true).map((entry) => entry.id), [tab.selectedEntryIds[0]]);
  assert.ok(entryReads < 10, `a later click read ${entryReads} projected rows`);
});

test("selection reuses a 20k-row projection with committed and pending regex filters", () => {
  for (const committed of [false, true]) {
    const state = createWorkspaceState(createMockWorkspaceBootstrap());
    const tab = getActiveTab(state.panels["panel-1"]);
    const base = tab.snapshot.entries[0];
    assert.ok(base);
    tab.snapshot = { ...tab.snapshot, entries: Array.from({ length: 20_000 }, (_, index) => ({
      ...base, id: `entry-${index}`, kind: "file" as const,
      name: `entry-${String(index).padStart(5, "0")}.txt`, path: `D:\\Projects\\Atlas\\entry-${index}.txt`
    })) };
    const matches = Object.fromEntries(tab.snapshot.entries.map((entry) => [entry.name, { matched: true, ranges: [] }]));
    state.quickFilter = { ...state.quickFilter, syntax: "regex", mode: "include", byPath: {
      [getPathComparisonKey(tab.snapshot.location.path)]: {
        text: "entry", appliedText: "entry", error: null,
        ...(committed ? { regexEvaluation: { text: "entry", matches } } : {})
      }
    } };
    const beforeProgram = resolvePanelQuickFilter(state, "panel-1");
    assert.ok(beforeProgram);
    const beforeRows = getFolderListingRows(tab, DEFAULT_FILE_VISIBILITY, beforeProgram, true);
    const beforeEntries = getFolderListingEntries(beforeRows);
    const selected = workspaceReducer(state, {
      type: "entrySelectionSet", payload: { panelId: "panel-1", tabId: tab.id, entryIds: [tab.snapshot.entries[500].id] }
    });
    const afterProgram = resolvePanelQuickFilter(selected, "panel-1");
    assert.strictEqual(afterProgram, beforeProgram, "selection must retain the regex program identity");
    const afterRows = getFolderListingRows(getActiveTab(selected.panels["panel-1"]), DEFAULT_FILE_VISIBILITY, afterProgram, true);
    assert.strictEqual(afterRows, beforeRows, "selection must retain the filtered row projection");
    assert.strictEqual(getFolderListingEntries(afterRows), beforeEntries, "selection must retain the mapped entry array");
    if (committed) {
      const draftState = { ...selected, quickFilter: applyQuickFilterText(selected.quickFilter,
        tab.snapshot.location.path, "new-uncommitted-draft") };
      const draftProgram = resolvePanelQuickFilter(draftState, "panel-1");
      assert.strictEqual(draftProgram, beforeProgram,
        "editing an uncommitted draft must retain the effective regex program");
      const draftRows = getFolderListingRows(getActiveTab(draftState.panels["panel-1"]),
        DEFAULT_FILE_VISIBILITY, draftProgram, true);
      assert.strictEqual(draftRows, beforeRows, "uncommitted draft edits must retain the visible rows");
      assert.strictEqual(getFolderListingEntries(draftRows), beforeEntries);
    }
    const changedMode = { ...selected, quickFilter: { ...selected.quickFilter, mode: "exclude" as const } };
    assert.notStrictEqual(resolvePanelQuickFilter(changedMode, "panel-1"), beforeProgram,
      "mode changes must invalidate the projection input");
    const pathKey = getPathComparisonKey(tab.snapshot.location.path);
    const oldEntry = selected.quickFilter.byPath[pathKey];
    const changedEvaluation = { ...selected, quickFilter: { ...selected.quickFilter, byPath: {
      ...selected.quickFilter.byPath,
      [pathKey]: { ...oldEntry, regexEvaluation: { text: "entry", matches: {} } }
    } } };
    const newProgram = resolvePanelQuickFilter(changedEvaluation, "panel-1");
    assert.notStrictEqual(newProgram, beforeProgram, "a new Worker evaluation must invalidate the program");
    assert.notStrictEqual(getFolderListingRows(getActiveTab(changedEvaluation.panels["panel-1"]),
      DEFAULT_FILE_VISIBILITY, newProgram, true), beforeRows,
    "a new Worker evaluation must invalidate the projected rows");
  }
});

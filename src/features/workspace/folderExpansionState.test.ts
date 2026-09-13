import assert from "node:assert/strict";
import { test } from "node:test";
import { createMockWorkspaceBootstrap } from "./mockData";
import { createWorkspaceState, workspaceReducer, type WorkspaceAction } from "./workspaceReducer";
import { getSelectedEntries } from "./workspaceControllerUtils";
import { expansionEntry, expansionFixture, expansionSnapshot } from "./folderExpansionTestSupport";
import type { DirectorySnapshot, EntryViewModel, TabState, WorkspaceState } from "./types";

function entry(parentPath: string, name: string, kind: EntryViewModel["kind"] = "folder"): EntryViewModel {
  const path = `${parentPath}\\${name}`;
  return { id: path, path, parentPath, name, kind, sizeLabel: "0", modifiedLabel: "", extension: "",
    attributes: [], accentColor: "", tags: [], description: "" };
}
const directory = "C:\\files";
const parent = entry(directory, "parent");
const sibling = entry(directory, "sibling");
const nested = entry(parent.path, "nested");
const child = entry(nested.path, "file.txt", "file");
function snapshot(path: string, entries: EntryViewModel[]): DirectorySnapshot {
  return { location: { path, label: path, kind: "local" }, breadcrumbs: [], entries };
}
function fixture() {
  const bootstrap = createMockWorkspaceBootstrap();
  bootstrap.settingsModel = { ...bootstrap.settingsModel, folderExpansionEnabled: true };
  bootstrap.panels["panel-1"].tabs[0].snapshot = snapshot(directory, [parent, sibling]);
  return createWorkspaceState(bootstrap);
}
function tab(state: WorkspaceState) { return state.panels["panel-1"].tabs[0]; }
type Branch = { path: string; status: string; entries: EntryViewModel[]; requestId?: number; errorMessage?: string };
function branches(tabState: TabState): Branch[] {
  return Object.values(Reflect.get(tabState, "folderExpansion") ?? {});
}
function reduce(state: WorkspaceState, type: string, payload: object = {}) {
  return workspaceReducer(state, { type, payload: { panelId: "panel-1", tabId: tab(state).id, ...payload } } as WorkspaceAction);
}
function toggle(state: WorkspaceState, path = parent.path) {
  return reduce(state, "folderExpansionToggled", { path });
}
function loaded(state: WorkspaceState, path: string, entries: EntryViewModel[], requestId = 1) {
  const rootSnapshot = tab(state).snapshot;
  state = reduce(state, "folderExpansionLoadStarted", { path, requestId, rootSnapshot });
  return reduce(state, "folderExpansionLoadSucceeded", { path, requestId, rootSnapshot, snapshot: snapshot(path, entries) });
}

test("expanding a folder creates tab-owned lazy state without changing location or navigation tree", () => {
  const state = fixture();
  const expanded = toggle(state);
  assert.equal(branches(tab(expanded)).length, 1);
  assert.equal(branches(tab(expanded))[0].status, "idle");
  assert.deepEqual(branches(tab(expanded))[0].entries, []);
  assert.equal(tab(expanded).snapshot, tab(state).snapshot);
  assert.deepEqual(tab(expanded).history, tab(state).history);
  assert.deepEqual(tab(expanded).expandedNodePaths, tab(state).expandedNodePaths);
  assert.deepEqual(branches(tab(toggle(expanded))), []);
});

test("collapsing a branch clears its descendants, hidden selection and inline edit", () => {
  let state = loaded(toggle(fixture()), parent.path, [nested]);
  state = loaded(toggle(state, nested.path), nested.path, [child], 2);
  state = reduce(state, "entrySelectionSet", { entryIds: [sibling.id, child.id] });
  state = reduce(state, "inlineEditStarted", { edit: { mode: "rename", entryId: child.id, originalPath: child.path,
    value: child.name, originalName: child.name, kind: "file", parentPath: nested.path } });
  const collapsed = tab(toggle(state));
  assert.deepEqual(branches(collapsed), []);
  assert.deepEqual(collapsed.selectedEntryIds, [sibling.id, parent.id]);
  assert.equal(collapsed.inlineEdit, undefined);
  assert.equal(collapsed.selectionAnchorId, null);
  assert.equal(collapsed.selectionCursorId, null);
});

test("collapse only falls back to the parent when the actual selected focus disappears", () => {
  const cases = [
    { selected: [child.id, sibling.id], cursor: null, anchor: null,
      expected: [sibling.id], expectedCursor: null, expectedAnchor: null },
    { selected: [sibling.id, child.id], cursor: sibling.id, anchor: child.id,
      expected: [sibling.id], expectedCursor: sibling.id, expectedAnchor: null },
    { selected: [child.id, sibling.id], cursor: child.id, anchor: sibling.id,
      expected: [sibling.id, parent.id], expectedCursor: null, expectedAnchor: sibling.id },
    { selected: [parent.id, sibling.id, child.id], cursor: null, anchor: null,
      expected: [sibling.id, parent.id], expectedCursor: null, expectedAnchor: null },
    { selected: [], cursor: child.id, anchor: child.id,
      expected: [], expectedCursor: null, expectedAnchor: null }
  ];
  for (const scenario of cases) {
    let state = loaded(toggle(fixture()), parent.path, [nested]);
    state = loaded(toggle(state, nested.path), nested.path, [child], 2);
    state = reduce(state, "entrySelectionSet", { entryIds: scenario.selected });
    tab(state).selectionCursorId = scenario.cursor;
    tab(state).selectionAnchorId = scenario.anchor;
    state = toggle(state);
    assert.deepEqual(tab(state).selectedEntryIds, scenario.expected, JSON.stringify(scenario));
    assert.equal(tab(state).selectionCursorId, scenario.expectedCursor);
    assert.equal(tab(state).selectionAnchorId, scenario.expectedAnchor);
    assert.deepEqual(new Set(getSelectedEntries(state, "panel-1").map((item) => item.id)), new Set(scenario.expected));
  }
});

test("collapse does not replace an already hidden selection with its visible ancestor", () => {
  let state = loaded(toggle(fixture()), parent.path, [nested]);
  state = loaded(toggle(state, nested.path), nested.path, [{ ...child, isHidden: true }], 2);
  state.fileVisibility = { ...state.fileVisibility, showHidden: true };
  state = reduce(state, "entrySelectionSet", { entryIds: [child.id] });
  state.fileVisibility = { ...state.fileVisibility, showHidden: false };
  assert.deepEqual(getSelectedEntries(state, "panel-1"), []);
  state = toggle(state);
  assert.deepEqual(tab(state).selectedEntryIds, []);
  assert.deepEqual(getSelectedEntries(state, "panel-1"), []);
});

test("expanded children participate in range and all-entry selection", () => {
  let state = loaded(toggle(fixture()), parent.path, [nested]);
  state = loaded(toggle(state, nested.path), nested.path, [child], 2);
  state = reduce(state, "allEntriesSelected");
  assert.deepEqual(tab(state).selectedEntryIds, [parent.id, nested.id, child.id, sibling.id]);
  state = reduce(state, "entryRangeSelected", { fromEntryId: nested.id, toEntryId: sibling.id,
    orderedEntryIds: [parent.id, nested.id, child.id, sibling.id] });
  assert.deepEqual(tab(state).selectedEntryIds, [nested.id, child.id, sibling.id]);
});

test("old branch requests cannot overwrite re-expansion or a refreshed root snapshot", () => {
  let state = toggle(fixture());
  const rootSnapshot = tab(state).snapshot;
  state = reduce(state, "folderExpansionLoadStarted", { path: parent.path, rootSnapshot, requestId: 1 });
  state = toggle(toggle(state));
  state = reduce(state, "folderExpansionLoadStarted", { path: parent.path, rootSnapshot, requestId: 2 });
  const stale = reduce(state, "folderExpansionLoadSucceeded", { path: parent.path, rootSnapshot, requestId: 1,
    snapshot: snapshot(parent.path, [nested]) });
  assert.equal(branches(tab(stale))[0]?.status, "loading");
  assert.deepEqual(branches(tab(stale))[0]?.entries, []);
  state = reduce(stale, "tabSnapshotCommitted", { snapshot: snapshot(directory, [parent, sibling]), pushHistory: false });
  state = reduce(state, "folderExpansionLoadSucceeded", { path: parent.path, rootSnapshot, requestId: 2,
    snapshot: snapshot(parent.path, [nested]) });
  assert.equal(branches(tab(state))[0]?.status, "idle");
  assert.deepEqual(branches(tab(state))[0]?.entries, []);
});

test("same-directory refresh keeps reachable expansions and removes deleted branches", () => {
  let state = loaded(toggle(fixture()), parent.path, [nested]);
  state = loaded(toggle(state, nested.path), nested.path, [child], 2);
  state = reduce(state, "entrySelectionSet", { entryIds: [child.id] });
  state = reduce(state, "tabSnapshotCommitted", { snapshot: snapshot(directory, [parent, sibling]), pushHistory: false });
  assert.deepEqual(branches(tab(state)).map((branch) => branch.status), ["idle", "idle"]);
  assert.deepEqual(tab(state).selectedEntryIds, [child.id]);
  state = loaded(state, parent.path, [], 3);
  assert.deepEqual(branches(tab(state)).map((branch) => branch.path), [parent.path]);
  assert.deepEqual(tab(state).selectedEntryIds, []);
});

test("directory navigation, icon mode and disabling the setting remove expanded state", () => {
  for (const action of ["navigate", "mode", "disable"] as const) {
    let state = loaded(toggle(fixture()), parent.path, [nested]);
    state = reduce(state, "entrySelectionSet", { entryIds: [nested.id] });
    if (action === "navigate") state = reduce(state, "tabSnapshotCommitted", { snapshot: snapshot("C:\\elsewhere", []), pushHistory: true });
    if (action === "mode") state = reduce(state, "tabViewModeSet", { viewMode: "large-icons" });
    if (action === "disable") state = workspaceReducer(state, { type: "settingsModelApplied",
      payload: { model: { ...state.settings.model, folderExpansionEnabled: false } } });
    assert.deepEqual(branches(tab(state)), [], action);
    assert.equal(tab(state).selectedEntryIds.includes(nested.id), false, action);
  }
});

test("failed navigation into an expanded remote descendant clears old branches before reconnect", () => {
  const f = expansionFixture("sftp");
  const leaf = expansionEntry(f.nested.path, "leaf.txt", "file");
  let state = createWorkspaceState(f.bootstrap);
  state = loaded(toggle(state, f.parent.path), f.parent.path, [f.nested, f.child]);
  state = loaded(toggle(state, f.nested.path), f.nested.path, [leaf], 2);
  state = reduce(state, "entrySelectionSet", { entryIds: [leaf.id] });
  state = reduce(state, "tabReconnectRequired", { path: f.parent.path, message: "connection refused" });
  assert.equal(tab(state).snapshot.location.path, f.parent.path);
  assert.deepEqual(branches(tab(state)), []);
  assert.deepEqual(tab(state).selectedEntryIds, []);
  assert.equal(tab(state).selectionAnchorId, null);
  state = reduce(state, "tabSnapshotCommitted", { snapshot: expansionSnapshot(f.parent.path, [f.nested, f.child]), pushHistory: false });
  assert.deepEqual(branches(tab(state)), []);
});

test("disabled, search results and virtual listings never expand folders", () => {
  for (const scenario of ["disabled", "search", "virtual"] as const) {
    const state = fixture();
    if (scenario === "disabled") state.settings.model.folderExpansionEnabled = false;
    if (scenario === "search") tab(state).kind = "search-results";
    if (scenario === "virtual") tab(state).snapshot.location.kind = "virtual";
    assert.deepEqual(branches(tab(toggle(state))), []);
  }
});

test("a failed refresh removes stale descendants and allows a retry without leaving the directory", () => {
  let state = loaded(toggle(fixture()), parent.path, [nested]);
  const rootSnapshot = tab(state).snapshot;
  state = reduce(state, "entrySelectionSet", { entryIds: [nested.id] });
  state = reduce(state, "folderExpansionLoadStarted", { path: parent.path, rootSnapshot, requestId: 2 });
  state = reduce(state, "folderExpansionLoadFailed", { path: parent.path, rootSnapshot, requestId: 2, errorMessage: "permission denied" });
  assert.equal(branches(tab(state))[0]?.status, "error");
  assert.deepEqual(branches(tab(state))[0]?.entries, []);
  assert.deepEqual(tab(state).selectedEntryIds, []);
  assert.equal(tab(state).snapshot, rootSnapshot);
  state = reduce(state, "folderExpansionRetryRequested", { path: parent.path });
  assert.equal(branches(tab(state))[0]?.status, "idle");
});

test("clicking an expansion control focuses its panel but background loading never steals focus", () => {
  const initial = fixture();
  initial.activePanelId = "panel-2";
  let state = toggle(initial);
  assert.equal(state.activePanelId, "panel-1");
  assert.deepEqual(tab(state).selectedEntryIds, tab(initial).selectedEntryIds);
  state.activePanelId = "panel-2";
  state = loaded(state, parent.path, [nested]);
  assert.equal(state.activePanelId, "panel-2");
});

test("retry only queues an errored branch and cannot restart an in-flight request", () => {
  let state = toggle(fixture());
  state = reduce(state, "folderExpansionLoadStarted", { path: parent.path, rootSnapshot: tab(state).snapshot, requestId: 5 });
  state = reduce(state, "folderExpansionRetryRequested", { path: parent.path });
  assert.equal(branches(tab(state))[0]?.status, "loading");
  assert.equal(branches(tab(state))[0]?.requestId, 5);
});

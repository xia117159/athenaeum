import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkspaceState, workspaceReducer, type WorkspaceAction } from "./workspaceReducer";
import { expansionEntry, expansionFixture, expansionSnapshot } from "./folderExpansionTestSupport";
import { getPathComparisonKey } from "./workspacePathRelations";
import type { InlineEditState, WorkspaceState } from "./types";

const f = expansionFixture();
const file = expansionEntry(f.path, "Report.txt", "file");
const active = (state: WorkspaceState) => state.panels["panel-1"].tabs.find(tab => tab.id === f.tabId)!;
const action = (state: WorkspaceState, type: WorkspaceAction["type"], payload: object = {}) =>
  workspaceReducer(state, { type, payload: { panelId: "panel-1", tabId: f.tabId, ...payload } } as WorkspaceAction);
const rename = (entry = file): InlineEditState => ({ mode: "rename", kind: entry.kind, entryId: entry.id, parentPath: entry.parentPath,
  originalPath: entry.path, originalName: entry.name, value: "unfinished draft" });
function fixture(edit = rename()) {
  const state = createWorkspaceState(structuredClone(f.bootstrap));
  active(state).snapshot.entries.push(file);
  return action(state, "inlineEditStarted", { edit });
}
const refresh = (state: WorkspaceState, entries = active(state).snapshot.entries, background = true, path = f.path) =>
  action(state, "tabSnapshotCommitted", { snapshot: expansionSnapshot(path, entries), pushHistory: false, activatePanel: !background });

test("same-directory background snapshots retain valid rename and ordinary create drafts", () => {
  for (const edit of [rename(), { mode: "create-file", kind: "file", parentPath: f.path, value: "notes.txt" },
    { mode: "create-folder", kind: "folder", parentPath: f.path, value: "New project" }] as InlineEditState[]) {
    const state = fixture(edit), next = refresh(state);
    assert.deepEqual(active(next).inlineEdit, edit);
    assert.equal(active(next).inlineEdit, active(state).inlineEdit, "valid edits retain their identity");
    assert.equal(active(refresh(next)).inlineEdit, active(state).inlineEdit);
  }
});

test("navigation, deleted targets, changed names or changed kinds end stale inline edits", () => {
  const state = fixture();
  assert.equal(active(refresh(state, [file], false)).inlineEdit, undefined, "explicit navigation keeps its existing semantics");
  assert.equal(active(refresh(state, [file], true, "C:\\elsewhere")).inlineEdit, undefined);
  assert.equal(active(refresh(state, [])).inlineEdit, undefined);
  assert.equal(active(refresh(state, [{ ...file, kind: "folder" }])).inlineEdit, undefined);
  assert.equal(active(refresh(state, [{ ...file, name: "External.txt", path: `${f.path}\\External.txt` }])).inlineEdit, undefined);
  const cancelled = action(state, "inlineEditCanceled");
  assert.equal(active(refresh(cancelled)).inlineEdit, undefined);
});

test("a background snapshot for another tab cannot affect this tab's draft", () => {
  const state = fixture(), other = state.panels["panel-2"].tabs[0];
  const next = workspaceReducer(state, { type: "tabSnapshotCommitted", payload: { panelId: "panel-2", tabId: other.id,
    snapshot: other.snapshot, pushHistory: false, activatePanel: false } });
  assert.equal(active(next).inlineEdit, active(state).inlineEdit);
});

test("expanded branch replies revalidate the rename target after a root refresh", () => {
  for (const outcome of ["unchanged", "deleted", "path-changed", "kind-changed", "cancelled"] as const) {
    let state = fixture(rename(f.child));
    active(state).folderExpansion = { [getPathComparisonKey(f.parent.path)]: { path: f.parent.path, status: "ready", entries: [f.child] } };
    state = refresh(state);
    assert.ok(active(state).inlineEdit, "root refresh retains the current branch until its reply arrives");
    const rootSnapshot = active(state).snapshot;
    const request = { path: f.parent.path, requestId: 1, rootSnapshot };
    state = action(state, "folderExpansionLoadStarted", request);
    if (outcome === "cancelled") state = action(state, "inlineEditCanceled");
    const entries = outcome === "deleted" ? [] : [{ ...f.child,
      ...(outcome === "path-changed" ? { path: `${f.parent.path}\\other.txt`, name: "other.txt" } : {}),
      ...(outcome === "kind-changed" ? { kind: "folder" as const } : {}) }];
    state = action(state, "folderExpansionLoadSucceeded", { ...request, snapshot: expansionSnapshot(f.parent.path, entries) });
    assert.equal(Boolean(active(state).inlineEdit), outcome === "unchanged", outcome);
  }
});

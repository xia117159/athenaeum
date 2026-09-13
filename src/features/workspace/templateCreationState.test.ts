import assert from "node:assert/strict";
import { createWorkspaceState, workspaceReducer } from "./workspaceReducer";
import { expansionEntry, expansionFixture } from "./folderExpansionTestSupport";
import { captureTemplateTarget, templateTargetMatches, type TemplateMenuState } from "./templateCreationState";
import { toPersistedSession } from "./workspaceSessionStore";
import { createNavigationTab } from "./workspaceTabs";
import type { OperationTaskSnapshot } from "../../app/types";

const fixture = expansionFixture();
const entry = expansionEntry(fixture.path, "new.txt", "file");
const state = createWorkspaceState(fixture.bootstrap);
state.panels["panel-1"].activeTabId = fixture.tabId;
const target = { panelId: "panel-1" as const, tabId: fixture.tabId, rootPath: fixture.path, selectionRevision: 0 };
const menu: TemplateMenuState = { id: "menu", target, settingsRoot: "", rootPath: "", levels: [{ relativePath: "", anchor: { x: 40, y: 50 } }], selected: [], directories: {} };
let next = workspaceReducer(state, { type: "templateMenuOpened", payload: menu });
assert.equal(next.templateMenu?.id, "menu");
assert.equal(workspaceReducer(next, { type: "contextMenuSet", payload: { panelId: "panel-1", tabId: fixture.tabId,
  mode: "custom", scope: "panel", x: 10, y: 20 } }).templateMenu, undefined, "a new context menu replaces the old template session");
next = workspaceReducer(next, { type: "templateMenuClosed", payload: { id: "menu" } });
next = workspaceReducer(next, { type: "templateDirectoryLoaded", payload: { id: "menu", listing: { rootPath: "C:\\Templates", relativePath: "", entries: [] } } });
assert.equal(next.templateMenu, undefined, "late catalog cannot reopen a closed menu");
const navigationStarted = { type: "templateTargetNavigationStarted" as const,
  payload: { panelId: target.panelId, tabId: target.tabId, requestId: 7 } };
const navigating = workspaceReducer(state, navigationStarted);
assert.equal(captureTemplateTarget(navigating, target.panelId, target.tabId), undefined, "pending navigation prevents a fresh capture");
assert.equal(templateTargetMatches(navigating, target), false, "navigation invalidates captures even without an existing menu");
assert.equal(workspaceReducer(navigating, { type: "templateMenuOpened", payload: menu }).templateMenu, undefined,
  "a queued menu action cannot reopen an obsolete target");
assert.equal(workspaceReducer(navigating, { type: "templateCreationStarted", payload: { requestId: "stale", target } }).templateCreation, undefined,
  "a queued creation action cannot claim an obsolete target");
assert.deepEqual(toPersistedSession(navigating), toPersistedSession(state), "navigation guards must remain transient");
const withHiddenNavigation = { ...navigating, panels: { ...navigating.panels,
  "panel-4": { ...navigating.panels["panel-4"], tabs: [createNavigationTab("hidden-navigation")], activeTabId: "hidden-navigation" } } };
const recovered = workspaceReducer(withHiddenNavigation, { type: "navigationTabOpened", payload: { panelId: "panel-1" } });
assert.equal(recovered.panels["panel-4"].tabs[0].pendingNavigationRequestId, undefined, "a fallback clone has no navigation request of its own");
assert.equal(recovered.panels["panel-1"].tabs.find(tab => tab.id === target.tabId)?.pendingNavigationRequestId, 7,
  "cloning must not clear the original tab's pending request");
const task: OperationTaskSnapshot = { taskId: "task", requestId: "create", kind: "copy", label: "新建项目", status: "succeeded", createdAt: "now", updatedAt: "now",
  sequence: 3, cancelable: false, undoable: true, completedEntries: 1, failedEntries: 0, affectedRoots: [],
  entryResults: [{ entryResultId: "created", kind: "created", source: { kind: "local", path: "C:\\Templates\\template.txt" }, destination: { kind: "local", path: entry.path } }] };
for (const scenario of ["normal", "new-selection", "intermediate-edit"] as const) {
  let next = workspaceReducer(structuredClone(state), { type: "templateCreationStarted", payload: { requestId: "create", target } });
  if (scenario === "new-selection") next = workspaceReducer(next, { type: "entrySelectionCleared", payload: { panelId: target.panelId, tabId: target.tabId } });
  if (scenario === "intermediate-edit") {
    next = workspaceReducer(next, { type: "inlineEditStarted", payload: { panelId: target.panelId, tabId: target.tabId,
      edit: { mode: "create-file", value: "other", kind: "file", parentPath: fixture.path } } });
    next = workspaceReducer(next, { type: "inlineEditCanceled", payload: { panelId: target.panelId, tabId: target.tabId } });
  }
  next = workspaceReducer(next, { type: "templateTaskCompleted", payload: { task } });
  const tab = next.panels["panel-1"].tabs.find(tab => tab.id === target.tabId)!;
  tab.snapshot.entries.push(entry);
  next = workspaceReducer(next, { type: "templateRefreshFinished", payload: { requestId: "create" } });
  assert.equal(next.templateCreation?.phase, scenario === "normal" ? "ready" : "manual", scenario);
  if (scenario === "normal") {
    assert.equal(next.templateCreation?.renameTarget?.entries[0].path, entry.path, "rename receives destination, never source");
    for (const action of [navigationStarted,
      { type: "entrySelectionCleared" as const, payload: { panelId: target.panelId, tabId: target.tabId } }]) {
      const invalidated = workspaceReducer(next, action);
      assert.equal(invalidated.templateCreation?.phase, "manual", "a ready result must lose its automatic edit when superseded");
      assert.equal(invalidated.templateCreation?.renameTarget, undefined, "invalidated completion cannot retain an editable target");
    }
  }
}
console.log("ok - template reducer isolates late catalog responses and creation rename intent");

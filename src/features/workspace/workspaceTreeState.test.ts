import assert from "node:assert/strict";
import { test } from "node:test";
import { createMockWorkspaceBootstrap, resolveMockDirectory } from "./mockData";
import { createTabFromSnapshot } from "./workspaceMappers";
import { createNavigationTab, createWorkspaceState, getActiveTab, workspaceReducer } from "./workspaceReducer";
import { mergeBootstrapWithSession } from "./workspaceBootstrapSession";
import { toPersistedSession } from "./workspaceSessionStore";
import { THIS_PC_PATH, type WorkspaceState } from "./types";

const tree = (state: WorkspaceState) => state.treeState;
const tab = (state: WorkspaceState) => getActiveTab(state.panels[state.activePanelId]);
const toggle = (state: WorkspaceState, path: string, expanded: boolean) => workspaceReducer(state, {
  type: "treeNodeExpansionSet", payload: { panelId: state.activePanelId, tabId: tab(state).id, path, expanded }
});
const follow = (state: WorkspaceState, enabled: boolean) => workspaceReducer(state, {
  type: "settingsModelApplied", payload: { model: { ...state.settings.model, ...{ treeAutoFollowEnabled: enabled } } }
});
const navigate = (state: WorkspaceState, path: string) => workspaceReducer(state, {
  type: "tabSnapshotCommitted", payload: { panelId: state.activePanelId, tabId: tab(state).id,
    snapshot: resolveMockDirectory(path), pushHistory: true }
});
const selectTree = (state: WorkspaceState, path: string) => workspaceReducer(state, {
  type: "treeNodeSelected", payload: { path }
});

test("default tree is collapsed and shared across focus, navigation and tab lifecycle", () => {
  let state = createWorkspaceState(createMockWorkspaceBootstrap());
  assert.deepEqual(tree(state), { activePath: "", expandedNodePaths: [] });
  state = selectTree(toggle(state, "D:\\", true), "D:\\");
  const visible = tree(state);
  const originalTabPaths = tab(state).expandedNodePaths;
  state = navigate(state, "C:\\Users\\Admin");
  assert.equal(tree(state), visible);
  assert.equal(tab(state).expandedNodePaths, originalTabPaths, "disabled navigation does not build hidden tracking state");
  const second = state.panels["panel-1"].tabs[1];
  state = workspaceReducer(state, { type: "tabActivated", payload: { panelId: "panel-1", tabId: second.id } });
  state = workspaceReducer(state, { type: "panelFocused", payload: { panelId: "panel-2" } });
  state = workspaceReducer(state, { type: "entrySelectionSet", payload: { panelId: "panel-2", tabId: tab(state).id, entryIds: [] } });
  state = workspaceReducer(state, { type: "tabOpened", payload: { panelId: "panel-2",
    tab: createTabFromSnapshot(resolveMockDirectory("E:\\Archive"), "new-tree-test") } });
  state = workspaceReducer(state, { type: "tabMoved", payload: { sourcePanelId: "panel-2", targetPanelId: "panel-1", tabId: "new-tree-test", targetIndex: 0 } });
  state = workspaceReducer(state, { type: "tabClosed", payload: { panelId: "panel-1", tabId: "new-tree-test" } });
  state = workspaceReducer(state, { type: "navigationTabOpened", payload: { panelId: "panel-1" } });
  assert.equal(tree(state), visible);
  state = toggle(state, "D:\\", false);
  assert.deepEqual(tree(state), { activePath: "D:\\", expandedNodePaths: [] }, "manual controls work on navigation tab");
});

test("enabling follows immediately; disabling freezes the visible state and late snapshots", () => {
  let state = navigate(createWorkspaceState(createMockWorkspaceBootstrap()), "C:\\Users\\Admin");
  state = follow(state, true);
  assert.equal(tree(state).activePath, "C:\\Users\\Admin");
  assert.ok(tree(state).expandedNodePaths.includes("C:\\Users"));
  state = workspaceReducer(state, { type: "panelFocused", payload: { panelId: "panel-2" } });
  assert.equal(tree(state).activePath, tab(state).snapshot.location.path);
  state = toggle(state, "D:\\", false);
  const frozen = tree(state);
  state = follow(state, false);
  assert.equal(tree(state), frozen);
  state = navigate(state, "E:\\Archive");
  assert.equal(tree(state), frozen);
  state = follow(state, true);
  assert.equal(tree(state).activePath, "E:\\Archive");
  const currentTree = tree(state);
  state = workspaceReducer(state, { type: "tabSnapshotCommitted", payload: { panelId: "panel-1",
    tabId: getActiveTab(state.panels["panel-1"]).id, snapshot: resolveMockDirectory("C:\\background"), pushHistory: false, activatePanel: false } });
  assert.equal(tree(state), currentTree, "background results cannot select the tree");
});

test("manual selection and expansions survive late tree success and errors", () => {
  let state = selectTree(createWorkspaceState(createMockWorkspaceBootstrap()), "D:\\Projects");
  assert.equal(tree(state)?.activePath, "D:\\Projects");
  state = toggle(state, "D:\\", true);
  state = toggle(state, "D:\\", false);
  const collapsed = tree(state);
  state = workspaceReducer(state, { type: "treeChildrenLoaded", payload: { path: "D:\\", children: [] } });
  assert.equal(tree(state), collapsed);
  state = toggle(state, "D:\\", true);
  const reopened = tree(state);
  state = workspaceReducer(state, { type: "treeNodeConnectionFailed", payload: { path: "D:\\", message: "late failure" } });
  assert.equal(tree(state), reopened);
});

test("local, FTP and SFTP navigation uses the same follow policy", () => {
  for (const path of ["D:\\Projects", "ftp://media@archive-server/shared", "sftp://deploy@edge-01/releases"]) {
    let state = createWorkspaceState(createMockWorkspaceBootstrap());
    const frozen = tree(state);
    state = navigate(state, path);
    assert.equal(tree(state), frozen);
    state = follow(state, true);
    assert.equal(tree(state).activePath, path);
    assert.ok(tree(state).expandedNodePaths.includes(path));
  }
});

test("session restores shared selection and empty expansion independently of active tab", async () => {
  const base = createMockWorkspaceBootstrap("mock");
  const state = selectTree(createWorkspaceState(base), "D:\\fixed");
  const session = toPersistedSession(state);
  const restored = createWorkspaceState(await mergeBootstrapWithSession(base, session, [], async path => resolveMockDirectory(path)));
  assert.deepEqual(tree(restored), { activePath: "D:\\fixed", expandedNodePaths: [] });
  Reflect.deleteProperty(session, "treeState");
  const migrated = createWorkspaceState(await mergeBootstrapWithSession(base, session, [], async path => resolveMockDirectory(path)));
  assert.deepEqual(tree(migrated), { activePath: tab(migrated).snapshot.location.path, expandedNodePaths: tab(migrated).expandedNodePaths });
});

test("Tauri setting wins over stale session; browser restores the saved preference", async () => {
  const session = toPersistedSession(follow(createWorkspaceState(createMockWorkspaceBootstrap()), true));
  for (const source of ["tauri", "mock"] as const) {
    const base = createMockWorkspaceBootstrap(source);
    const restored = await mergeBootstrapWithSession(base, session, [], async path => resolveMockDirectory(path));
    assert.equal(Reflect.get(restored.settingsModel, "treeAutoFollowEnabled"), source === "mock");
  }
});

test("restoring enabled mode on navigation tab preserves the saved visible tree", () => {
  const bootstrap = createMockWorkspaceBootstrap();
  bootstrap.settingsModel.treeAutoFollowEnabled = true;
  const navigation = createNavigationTab();
  const panel = bootstrap.panels[bootstrap.activePanelId];
  panel.tabs.push(navigation); panel.activeTabId = navigation.id;
  bootstrap.treeState = { activePath: "D:\\Projects", expandedNodePaths: ["D:\\"] };
  assert.deepEqual(tree(createWorkspaceState(bootstrap)), bootstrap.treeState);
});

test("search results and This PC retain the follow policy without tracking selected result paths", () => {
  for (const enabled of [false, true]) {
    let state = follow(createWorkspaceState(createMockWorkspaceBootstrap()), enabled);
    const frozen = tree(state);
    const search = { ...createTabFromSnapshot(resolveMockDirectory("C:\\Users"), "tree-search"), kind: "search-results" as const };
    state = workspaceReducer(state, { type: "tabOpened", payload: { panelId: state.activePanelId, tab: search } });
    if (enabled) assert.equal(tree(state).activePath, "C:\\Users"); else assert.equal(tree(state), frozen);
    state = workspaceReducer(state, { type: "entrySelectionSet", payload: { panelId: state.activePanelId, tabId: search.id, entryIds: ["different-result"] } });
    const snapshot = { location: { kind: "virtual" as const, path: THIS_PC_PATH, label: "此电脑" }, breadcrumbs: [], entries: [] };
    state = workspaceReducer(state, { type: "tabSnapshotCommitted", payload: { panelId: state.activePanelId, tabId: search.id, snapshot, pushHistory: true } });
    if (enabled) assert.equal(tree(state).activePath, snapshot.location.path); else assert.equal(tree(state), frozen);
  }
});

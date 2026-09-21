import assert from "node:assert/strict";
import { test } from "node:test";
import { getFolderListingRows, getTabSelectedEntries, supportsFolderExpansion } from "./folderExpansion";
import { expansionEntry, expansionFixture, quickFilterProgram } from "./folderExpansionTestSupport";
import { getSelectedEntries, getTabsForPaths } from "./workspaceControllerUtils";
import { getVisibleDirectoryRefreshTargets, getVisibleWatchRoots } from "./workspaceRefreshPlanner";
import { createWorkspaceState } from "./workspaceReducer";
import { getPathComparisonKey, getTopLevelPaths } from "./workspacePathRelations";
import { toPersistedSession } from "./workspaceSessionStore";
import { DEFAULT_FILE_VISIBILITY } from "./workspaceVisibility";
import type { TabState } from "./types";

function expandedFixture(kind: "local" | "ftp" | "sftp" = "local") {
  const fixture = expansionFixture(kind);
  const state = createWorkspaceState(fixture.bootstrap);
  const tab = state.panels["panel-1"].tabs[0];
  const leaf = expansionEntry(fixture.nested.path, "leaf.txt", "file");
  tab.folderExpansion = {
    [getPathComparisonKey(fixture.parent.path)]: { path: fixture.parent.path, entries: [fixture.child, fixture.nested], status: "ready" },
    [getPathComparisonKey(fixture.nested.path)]: { path: fixture.nested.path, entries: [leaf], status: "ready" }
  };
  return { ...fixture, state, tab, leaf };
}

test("tree rows sort siblings and preserve parent-child order and depth", () => {
  const { tab, parent, nested, child, leaf, sibling } = expandedFixture();
  assert.deepEqual(getFolderListingRows(tab).map(({ entry, depth }) => [entry.id, depth]),
    [[parent.id, 0], [nested.id, 1], [leaf.id, 2], [child.id, 1], [sibling.id, 0]]);
  tab.sort.direction = "desc";
  assert.deepEqual(getFolderListingRows(tab).map(({ entry }) => entry.id), [sibling.id, parent.id, nested.id, leaf.id, child.id]);
});

test("quick filtering retains loaded ancestors and hidden parents hide their entire branch", () => {
  const { tab, parent, nested, leaf } = expandedFixture();
  const keep = quickFilterProgram("leaf.txt");
  assert.deepEqual(getFolderListingRows(tab, DEFAULT_FILE_VISIBILITY, keep).map(({ entry }) => entry.id), [parent.id, nested.id, leaf.id]);
  parent.isHidden = true;
  assert.deepEqual(getFolderListingRows(tab, DEFAULT_FILE_VISIBILITY, keep), []);
  assert.equal(getFolderListingRows(tab, { ...DEFAULT_FILE_VISIBILITY, showHidden: true }, keep).length, 3);
});

test("expanded children are available to file actions and parent refresh planning", () => {
  const { state, tab, child, parent, path } = expandedFixture();
  tab.selectedEntryIds = [child.id];
  assert.deepEqual(getSelectedEntries(state, "panel-1").map((entry) => entry.path), [child.path]);
  assert.equal(getTabsForPaths(state, [parent.path]).some((target) => target.path === path), true);
  assert.equal(getVisibleDirectoryRefreshTargets(state, [parent.path]).some((target) => target.path === path), true);
});

test("visible local branches receive watch roots and collapse removes them", () => {
  const { state, tab, path, parent, nested } = expandedFixture();
  assert.deepEqual(getVisibleWatchRoots(state).directoryPaths, [path, parent.path, nested.path]);
  tab.folderExpansion = undefined;
  assert.deepEqual(getVisibleWatchRoots(state).directoryPaths, [path]);
  const remote = expandedFixture("sftp");
  assert.deepEqual(getVisibleWatchRoots(remote.state).directoryPaths, []);
});

test("watch root budget preserves all ordinary panel directories before expanded paths", () => {
  const { state, tab, path } = expandedFixture();
  state.layoutMode = "dual";
  const otherTab = state.panels["panel-2"].tabs[0];
  otherTab.snapshot.location.path = "Z:\\work";
  otherTab.snapshot.location.kind = "local";
  otherTab.kind = "directory";
  state.panels["panel-2"].activeTabId = otherTab.id;
  const folders = Array.from({ length: 300 }, (_, index) => expansionEntry(path, `a${index}`));
  tab.snapshot.entries = folders;
  tab.folderExpansion = Object.fromEntries(folders.map((entry) => [getPathComparisonKey(entry.path), { path: entry.path, status: "ready", entries: [] }]));
  const roots = getVisibleWatchRoots(state).directoryPaths;
  assert.equal(roots.length, 256);
  assert.equal(roots.includes(path), true);
  assert.equal(roots.includes("Z:\\work"), true);
});

test("operation sources include each selected subtree once and preserve remote case", () => {
  assert.deepEqual(getTopLevelPaths(["C:\\a\\child.txt", "c:\\a", "C:\\ab", "C:\\A"]), ["C:\\A", "C:\\ab"]);
  assert.deepEqual(getTopLevelPaths(["sftp://user@server/Dir/file", "sftp://user@server/Dir", "sftp://user@server/dir/file"]),
    ["sftp://user@server/Dir", "sftp://user@server/dir/file"]);
});

test("operation source normalization preserves the existing local path boundary and ignores empty input", () => {
  assert.deepEqual(getTopLevelPaths([" ", "", " \\\\?\\C:\\files\\parent ", "C:/files/parent/child.txt"]), ["C:\\files\\parent"]);
});

test("operation sources preserve UNC identity, including extended and slash variants", () => {
  const parent = "\\\\server\\share\\parent";
  assert.deepEqual(getTopLevelPaths([parent + "\\child.txt", parent]), [parent]);
  assert.deepEqual(getTopLevelPaths(["\\\\?\\UNC\\server\\share\\parent\\child.txt", parent]), [parent]);
  assert.deepEqual(getTopLevelPaths(["//server/share/parent/child.txt", parent]), [parent]);
  assert.deepEqual(getTopLevelPaths([parent, "\\server\\share\\parent"]), [parent, "\\server\\share\\parent"]);
  assert.deepEqual(getTopLevelPaths([parent + "\\child.txt", "\\\\server\\share"]), ["\\\\server\\share"]);
});

test("top-level source planning handles roots and large sibling/multi-level selections in input order", () => {
  assert.deepEqual(getTopLevelPaths(["C:\\one\\file.txt", "C:\\", "D:\\two\\file.txt"]), ["C:\\", "D:\\two\\file.txt"]);
  assert.deepEqual(getTopLevelPaths(["sftp://alice@server/home/child/file.txt", "sftp://alice@server/home/",
    "sftp://alice@server/home-other/file.txt"]), ["sftp://alice@server/home/", "sftp://alice@server/home-other/file.txt"]);
  const siblings = Array.from({ length: 3000 }, (_, index) => "C:\\bulk\\file" + index + ".txt");
  const parents = Array.from({ length: 100 }, (_, index) => "C:\\bulk\\folder" + index);
  const sources = [...siblings, ...parents.flatMap((path) => [path + "\\nested\\child.txt", path + "\\nested", path])];
  assert.deepEqual(getTopLevelPaths(sources), [...siblings, ...parents]);
});

test("excluded search views preserve duplicate-path result rows", () => {
  const { tab, child } = expandedFixture();
  tab.kind = "search-results";
  tab.snapshot.entries = [child, { ...child, id: "second-hit" }];
  assert.deepEqual(getFolderListingRows(tab).map((row) => row.entry.id), [child.id, "second-hit"]);
});

test("D21: excluding a branch from the listing does not remove its watch root", () => {
  const { state, parent, path, nested } = expandedFixture();
  assert.deepEqual(getVisibleWatchRoots(state).directoryPaths, [path, parent.path, nested.path],
    "precondition: both expanded branches are watched while unfiltered");

  // 排除过滤把**已展开的父文件夹本身**藏起来，其整棵子树随之消失。
  // 若 watch 根改用过滤后的投影推导，这两个根就会掉出集合：清除过滤后用户会看到陈旧内容（D21 要防的正是这一情形）。
  state.quickFilter = {
    mode: "exclude",
    syntax: "substring",
    byPath: {
      [getPathComparisonKey(state.panels["panel-1"].tabs[0].snapshot.location.path)]:
        { text: "parent", appliedText: "parent", error: null }
    }
  };
  assert.deepEqual(
    getFolderListingRows(state.panels["panel-1"].tabs[0], DEFAULT_FILE_VISIBILITY, quickFilterProgram("parent", "exclude"))
      .filter((row) => row.expansion).map((row) => row.entry.path),
    [],
    "precondition: the filtered projection exposes no expanded branch");

  assert.deepEqual(getVisibleWatchRoots(state).directoryPaths, [path, parent.path, nested.path],
    "D21: watch roots must be derived from the unfiltered projection");
});

test("expanded directory data is transient and is not serialized into the session", () => {
  const { state, child } = expandedFixture();
  const session = toPersistedSession(state);
  const json = JSON.stringify(session);
  assert.equal(json.includes('"folderExpansion":'), false);
  assert.equal(json.includes(child.path.replace(/\\/g, "\\\\")), false);
});

// ---------------------------------------------------------------------------
// D19：四种「展开不生效」的回退配置下，可见行集仍必须等于操作目标集
// ---------------------------------------------------------------------------

/**
 * D19 枚举的四种配置。四者的共同点是 `supportsFolderExpansion` 为假，
 * 因此都会走到"没有树"的那条分支 —— 这正是旧实现回退到未过滤 `snapshot.entries` 的入口。
 */
const D19_FALLBACK_CONFIGURATIONS: Array<{ name: string; enabled: boolean; apply: (tab: TabState) => void }> = [
  { name: "① 展开功能关闭（出厂默认）", enabled: false, apply: () => {} },
  { name: "② 磁贴视图（details 之外）", enabled: true, apply: (tab) => { tab.viewMode = "tiles"; } },
  { name: "③ 「此电脑」虚拟标签页", enabled: true, apply: (tab) => { tab.snapshot.location.kind = "virtual"; } },
  { name: "④ 搜索结果标签页", enabled: true, apply: (tab) => { tab.kind = "search-results"; } }
];

test("D19: every fallback configuration keeps the operation target set equal to the visible row set", () => {
  for (const configuration of D19_FALLBACK_CONFIGURATIONS) {
    const { tab, sibling, parent } = expandedFixture();
    configuration.apply(tab);
    assert.equal(supportsFolderExpansion(tab, configuration.enabled), false,
      `${configuration.name}: the fixture must exercise the no-tree branch`);

    // 先全选未过滤时的可见行集，模拟"用户全选后再输入过滤词"。
    tab.selectedEntryIds = getFolderListingRows(tab, DEFAULT_FILE_VISIBILITY, null, configuration.enabled)
      .map(({ entry }) => entry.id);
    assert.deepEqual([...tab.selectedEntryIds].sort(), [parent.id, sibling.id].sort(),
      `${configuration.name}: precondition is a full unfiltered selection`);

    const keep = quickFilterProgram("sibling");
    const visible = getFolderListingRows(tab, DEFAULT_FILE_VISIBILITY, keep, configuration.enabled)
      .map(({ entry }) => entry.id);
    assert.deepEqual(visible, [sibling.id],
      `${configuration.name}: only the matching row may stay visible`);

    // B23：操作目标集必须等于可见行集（顺序一致），不得回退到未过滤的 snapshot.entries。
    assert.deepEqual(
      getTabSelectedEntries(tab, DEFAULT_FILE_VISIBILITY, keep, configuration.enabled).map((entry) => entry.id),
      visible,
      `${configuration.name}: the operation target set must equal the visible row set`);
  }
});

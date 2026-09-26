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
  const descending = { ...tab, sort: { ...tab.sort, direction: "desc" as const } };
  assert.deepEqual(getFolderListingRows(descending).map(({ entry }) => entry.id), [sibling.id, parent.id, nested.id, leaf.id, child.id]);
});

test("quick filtering retains loaded ancestors and hidden parents hide their entire branch", () => {
  const { tab, parent, nested, leaf } = expandedFixture();
  const keep = quickFilterProgram("leaf.txt");
  assert.deepEqual(getFolderListingRows(tab, DEFAULT_FILE_VISIBILITY, keep).map(({ entry }) => entry.id), [parent.id, nested.id, leaf.id]);
  const hiddenParent = { ...parent, isHidden: true };
  const hiddenTab = { ...tab, snapshot: { ...tab.snapshot, entries: tab.snapshot.entries.map((entry) => entry.id === parent.id ? hiddenParent : entry) } };
  assert.deepEqual(getFolderListingRows(hiddenTab, DEFAULT_FILE_VISIBILITY, keep), []);
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

test("a flat 3k listing does not normalize paths just to project visible rows", () => {
  const { tab, child } = expandedFixture();
  tab.kind = "search-results";
  tab.viewMode = "list";
  let pathReads = 0;
  tab.snapshot = { ...tab.snapshot, entries: Array.from({ length: 3_000 }, (_, index) => {
    const entry = { ...child, id: `flat-${index}`, name: `flat-${index}.txt` };
    Object.defineProperty(entry, "path", { get() { pathReads++; return `${child.path}-${index}`; } });
    return entry;
  }) };
  assert.equal(getFolderListingRows(tab).length, 3_000);
  assert.equal(pathReads, 0, "flat projection needs no path comparison key");
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
// S-6：缓存必须识别投影输入的不可变更新
// ---------------------------------------------------------------------------

/**
 * 生产 reducer 与这些夹具都对投影输入使用不可变更新。
 * 选择状态变化则不改变投影行集，允许复用其数组与索引。
 */
test("S6: replacing snapshot.entries invalidates the projection", () => {
  const { tab, sibling } = expandedFixture();
  const beforeIds = getFolderListingRows(tab).map(({ entry }) => entry.id);
  assert.equal(beforeIds.includes("pushed"), false, "precondition: the pushed entry is not visible yet");

  const pushed = expansionEntry(tab.snapshot.location.path, "pushed.txt", "file", { id: "pushed" });
  tab.snapshot = { ...tab.snapshot, entries: [...tab.snapshot.entries, pushed] };

  assert.equal(getFolderListingRows(tab).map(({ entry }) => entry.id).includes("pushed"), true,
    "a new entry in the snapshot must appear in the projection");
  assert.ok(sibling.id.length > 0);
});

test("S6: immutable sort and visibility changes update the projection", () => {
  const { tab, parent } = expandedFixture();
  const ascending = getFolderListingRows(tab).map(({ entry }) => entry.id);
  const descending = getFolderListingRows({ ...tab, sort: { ...tab.sort, direction: "desc" as const } }).map(({ entry }) => entry.id);
  assert.notDeepEqual(descending, ascending, "a sort change must change the projection");
  // 顶层兄弟节点顺序反转，但子节点仍紧跟其父节点（树形投影的固有约束）。
  assert.deepEqual(descending, ["C:\\files\\sibling", "C:\\files\\parent", "C:\\files\\parent\\nested",
    "C:\\files\\parent\\nested\\leaf.txt", "C:\\files\\parent\\child.txt"]);
  // 替换父条目后，它的整棵子树必须消失。
  const withParentVisible = getFolderListingRows(tab, DEFAULT_FILE_VISIBILITY, quickFilterProgram("leaf.txt"));
  assert.equal(withParentVisible.length, 3);
  const hiddenParent = { ...parent, isHidden: true };
  const hiddenTab = { ...tab, snapshot: { ...tab.snapshot, entries: tab.snapshot.entries.map((entry) => entry.id === parent.id ? hiddenParent : entry) } };
  assert.deepEqual(getFolderListingRows(hiddenTab, DEFAULT_FILE_VISIBILITY, quickFilterProgram("leaf.txt")), [],
    "a changed parent visibility must remove the whole branch from the projection");
});

test("S6: replacing an expanded branch invalidates the projection", () => {
  const { tab, nested } = expandedFixture();
  const branchKey = getPathComparisonKey(nested.path);
  assert.deepEqual(getFolderListingRows(tab).map(({ entry }) => entry.id).includes("late-child"), false);

  const branch = tab.folderExpansion![branchKey];
  tab.folderExpansion = { ...tab.folderExpansion, [branchKey]: {
    ...branch, entries: [...branch.entries, expansionEntry(nested.path, "late-child.txt", "file", { id: "late-child" })]
  } };

  assert.equal(getFolderListingRows(tab).map(({ entry }) => entry.id).includes("late-child"), true,
    "a changed expansion branch must appear in the projection");
});

test("S6: identical calls produce equal rows (the projection stays deterministic)", () => {
  const { tab } = expandedFixture();
  const first = getFolderListingRows(tab);
  const second = getFolderListingRows(tab);
  assert.deepEqual(second.map(({ entry }) => entry.id), first.map(({ entry }) => entry.id));
  assert.equal(second, first, "identical immutable inputs reuse the memoized projection");
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

// ---------------------------------------------------------------------------
// S-7：`getTabSelectedEntries` 的索引路径必须与整趟投影逐项等价
// ---------------------------------------------------------------------------

/**
 * S-7 的缺陷：基线有一条 `!supportsFolderExpansion ⇒ tab.snapshot.entries` 的廉价分支，
 * 它**违反 B23**（忽略可见性与过滤）因而被删除；但删除后即使出厂默认（不展开、无过滤），
 * 每次调用也要整趟排序并逐条投影大小（2 万条目实测 284×–356× 回归）。
 *
 * 当前实现以可见投影行集建立 ID 索引，在选择改变时仅查找被选中的行。
 *
 * 下面这组用例把索引结果与"整趟投影后再按 id 过滤"
 * 的结果逐项对照。若将来有人改动其中任一侧的判定规则，这里会立刻变红。
 */
test("S7: indexed selection agrees with the full projection item for item", () => {
  const hidden = expansionEntry("C:\\files", "hidden.txt", "file", { id: "hidden", isHidden: true });
  const system = expansionEntry("C:\\files", "system.txt", "file", { id: "system", isSystem: true });
  const protectedOs = expansionEntry("C:\\files", "protected.txt", "file", { id: "protected", isProtectedOperatingSystem: true });

  for (const [name, visibility] of [
    ["出厂默认可见性", DEFAULT_FILE_VISIBILITY],
    ["显示隐藏项", { ...DEFAULT_FILE_VISIBILITY, showHidden: true }],
    ["显示系统项", { ...DEFAULT_FILE_VISIBILITY, showSystem: true }],
    ["同时显示隐藏与系统项", { ...DEFAULT_FILE_VISIBILITY, showHidden: true, showSystem: true }],
    ["显示受保护的系统文件", { ...DEFAULT_FILE_VISIBILITY, hideProtectedOperatingSystemFiles: false }]
  ] as const) {
    const { tab, parent, sibling } = expandedFixture();
    tab.snapshot.entries = [...tab.snapshot.entries, hidden, system, protectedOs];
    const allIds = tab.snapshot.entries.map((entry) => entry.id);

    // 覆盖多种选中组合：空、单个不可见项、混合、全选。
    for (const selected of [[], ["hidden"], ["protected"], [parent.id, "system"], allIds]) {
      tab.selectedEntryIds = selected;

      // 默认目录列表（enabled=false ⇒ 不展开；quickFilter=null ⇒ 无过滤）。
      const selectedEntries = getTabSelectedEntries(tab, visibility, null, false).map((entry) => entry.id);

      // 参照：整趟投影后按选中 id 过滤（即慢路径的语义）。
      const selectedSet = new Set(selected);
      const visibleIds = getFolderListingRows(tab, visibility, null, false).map(({ entry }) => entry.id);
      const reference = visibleIds.filter((id) => selectedSet.has(id));

      assert.deepEqual(selectedEntries, reference,
        `${name} / selected=${JSON.stringify(selected)}: indexed selection must equal the full projection`);
      // B23 回归守卫：目标集恒为可见行集的子集。
      const visibleSet = new Set(visibleIds);
      assert.ok(selectedEntries.every((id) => visibleSet.has(id)),
        `${name} / selected=${JSON.stringify(selected)}: every target must be a visible row`);
    }
    assert.ok(sibling.id.length > 0);
  }
});

test("S7: indexed selection preserves the details sort order", () => {
  const { tab, parent, sibling } = expandedFixture();
  tab.sort = { columnId: "size", direction: "desc" };
  tab.selectedEntryIds = tab.snapshot.entries.map((entry) => entry.id);

  const selectedEntries = getTabSelectedEntries(tab, DEFAULT_FILE_VISIBILITY, null, false).map((entry) => entry.id);
  const reference = getFolderListingRows(tab, DEFAULT_FILE_VISIBILITY, null, false).map(({ entry }) => entry.id);
  assert.deepEqual(selectedEntries, reference, "size-desc ordering must match between indexed selection and the full projection");
  assert.ok(selectedEntries.includes(parent.id) && selectedEntries.includes(sibling.id));
});

test("S7: indexed selection respects active filtering and expansion", () => {
  const { tab, parent, sibling, child } = expandedFixture();
  tab.selectedEntryIds = [parent.id, child.id, sibling.id];
  const keep = quickFilterProgram("sibling");

  // ① 有过滤：即使未展开，也必须按过滤后的可见行集取子集。
  const filtered = getTabSelectedEntries(tab, DEFAULT_FILE_VISIBILITY, keep, false).map((entry) => entry.id);
  assert.deepEqual(filtered, [sibling.id], "a filter must still restrict the target set when the tree is off");
  assert.deepEqual(filtered,
    getFolderListingRows(tab, DEFAULT_FILE_VISIBILITY, keep, false).map(({ entry }) => entry.id));

  // ② 展开启用且已加载：选中的展开子条目必须保留。
  tab.selectedEntryIds = [child.id];
  assert.deepEqual(getTabSelectedEntries(tab, DEFAULT_FILE_VISIBILITY, null, true).map((entry) => entry.id),
    [child.id], "a selected entry inside an expanded branch must survive");
});

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
// S-6：`getFolderListingRows` 必须保持纯函数（不得内置可能失效的缓存）
// ---------------------------------------------------------------------------

/**
 * 这一组用例锁定的是"投影**不**缓存"这条设计决定（规格 §3.7 与 §4.11）。
 *
 * 评审 S-6 的问题是真实的：同一帧内同一次投影会被重复计算。修复期曾**两次**尝试引入缓存
 * （第一次以输入引用为键放进本纯函数，第二次以 `WorkspaceState` 对象身份为令牌移到渲染层
 * 的 `listingProjection.ts`），两次都因同一原因被实测否决：投影读取的输入会被**就地修改**，
 * 缓存会返回陈旧行集，而陈旧行集喂给删除/复制就是**对错的文件执行破坏性操作**。
 *
 * 因此最终结论是：本函数保持**纯函数、无缓存**，重复投影改用参数复用与 S-7 的选中项快路径
 * 消除（`listingProjection.ts` 已删除）。下面每个场景都是"就地改夹具"的真实写法 ——
 * 若将来有人再把缓存塞回本函数，这些用例会立刻变红。
 */
test("S6: an in-place push onto snapshot.entries is reflected by the pure projection", () => {
  // `directorySizeAlignment.test.ts:70` 等 7 个测试文件都这样就地 push，不更换 snapshot 引用。
  const { tab, sibling } = expandedFixture();
  const beforeIds = getFolderListingRows(tab).map(({ entry }) => entry.id);
  assert.equal(beforeIds.includes("pushed"), false, "precondition: the pushed entry is not visible yet");

  const pushed = expansionEntry(tab.snapshot.location.path, "pushed.txt", "file", { id: "pushed" });
  tab.snapshot.entries.push(pushed);

  assert.equal(getFolderListingRows(tab).map(({ entry }) => entry.id).includes("pushed"), true,
    "an entry appended in place to snapshot.entries must appear in the projection");
  assert.ok(sibling.id.length > 0);
});

test("S6: in-place sort and visibility mutations are reflected by the pure projection", () => {
  // `folderExpansion.test.ts` 自身就用 `tab.sort.direction = "desc"` 这类就地写法。
  const { tab, parent } = expandedFixture();
  const ascending = getFolderListingRows(tab).map(({ entry }) => entry.id);
  tab.sort.direction = "desc";
  const descending = getFolderListingRows(tab).map(({ entry }) => entry.id);
  assert.notDeepEqual(descending, ascending, "an in-place sort change must change the projection");
  // 顶层兄弟节点顺序反转，但子节点仍紧跟其父节点（树形投影的固有约束）。
  assert.deepEqual(descending, ["C:\\files\\sibling", "C:\\files\\parent", "C:\\files\\parent\\nested",
    "C:\\files\\parent\\nested\\leaf.txt", "C:\\files\\parent\\child.txt"]);
  tab.sort.direction = "asc";

  // `parent.isHidden = true`（同一文件 :37 的写法）会让整棵子树消失。
  const withParentVisible = getFolderListingRows(tab, DEFAULT_FILE_VISIBILITY, quickFilterProgram("leaf.txt"));
  assert.equal(withParentVisible.length, 3);
  parent.isHidden = true;
  assert.deepEqual(getFolderListingRows(tab, DEFAULT_FILE_VISIBILITY, quickFilterProgram("leaf.txt")), [],
    "an in-place isHidden change must remove the whole branch from the projection");
});

test("S6: an in-place mutation inside a folderExpansion branch is reflected", () => {
  // 展开分支的条目存放在 `tab.folderExpansion[key].entries`，同样会被就地修改。
  const { tab, nested } = expandedFixture();
  const branchKey = getPathComparisonKey(nested.path);
  assert.deepEqual(getFolderListingRows(tab).map(({ entry }) => entry.id).includes("late-child"), false);

  tab.folderExpansion![branchKey].entries.push(expansionEntry(nested.path, "late-child.txt", "file", { id: "late-child" }));

  assert.equal(getFolderListingRows(tab).map(({ entry }) => entry.id).includes("late-child"), true,
    "an entry pushed into an expansion branch in place must appear in the projection");
});

test("S6: identical calls produce equal rows (the projection stays deterministic)", () => {
  const { tab } = expandedFixture();
  const first = getFolderListingRows(tab);
  const second = getFolderListingRows(tab);
  assert.deepEqual(second.map(({ entry }) => entry.id), first.map(({ entry }) => entry.id));
  assert.notEqual(second, first, "the pure projection deliberately returns a fresh array each call");
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
// S-7：`getTabSelectedEntries` 的选中项快路径必须与整趟投影**逐项等价**
// ---------------------------------------------------------------------------

/**
 * S-7 的缺陷：基线有一条 `!supportsFolderExpansion ⇒ tab.snapshot.entries` 的廉价分支，
 * 它**违反 B23**（忽略可见性与过滤）因而被删除；但删除后即使出厂默认（不展开、无过滤），
 * 每次调用也要整趟排序并逐条投影大小（2 万条目实测 284×–356× 回归）。
 *
 * 修复加入了一条**不恢复违规回退**的快路径：只在 `quickFilter === null` 且
 * `!supportsFolderExpansion` 时，把投影范围从"全部条目"缩小到"被选中的条目"，
 * 逐条套用与整趟投影完全相同的可见性判定，最后用同一个逐对比较器排序。
 *
 * 下面这组用例是该等价性的**机器化证明**：把快路径的结果与"整趟投影后再按 id 过滤"
 * 的结果逐项对照。若将来有人改动其中任一侧的判定规则，这里会立刻变红。
 */
test("S7: the selected-entry fast path agrees with the full projection item for item", () => {
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

      // 快路径（enabled=false ⇒ 不展开；quickFilter=null ⇒ 无过滤）。
      const fast = getTabSelectedEntries(tab, visibility, null, false).map((entry) => entry.id);

      // 参照：整趟投影后按选中 id 过滤（即慢路径的语义）。
      const selectedSet = new Set(selected);
      const visibleIds = getFolderListingRows(tab, visibility, null, false).map(({ entry }) => entry.id);
      const reference = visibleIds.filter((id) => selectedSet.has(id));

      assert.deepEqual(fast, reference,
        `${name} / selected=${JSON.stringify(selected)}: the fast path must equal the full projection`);
      // B23 回归守卫：目标集恒为可见行集的子集。
      const visibleSet = new Set(visibleIds);
      assert.ok(fast.every((id) => visibleSet.has(id)),
        `${name} / selected=${JSON.stringify(selected)}: every target must be a visible row`);
    }
    assert.ok(sibling.id.length > 0);
  }
});

test("S7: the fast path preserves the details sort order", () => {
  // 排序比较器是逐对的，因此"先筛后排"必须与"先排后筛"同序。用 size 列覆盖非名称排序。
  const { tab, parent, sibling } = expandedFixture();
  tab.sort = { columnId: "size", direction: "desc" };
  tab.selectedEntryIds = tab.snapshot.entries.map((entry) => entry.id);

  const fast = getTabSelectedEntries(tab, DEFAULT_FILE_VISIBILITY, null, false).map((entry) => entry.id);
  const reference = getFolderListingRows(tab, DEFAULT_FILE_VISIBILITY, null, false).map(({ entry }) => entry.id);
  assert.deepEqual(fast, reference, "size-desc ordering must match between the fast path and the full projection");
  assert.ok(fast.includes(parent.id) && fast.includes(sibling.id));
});

test("S7: the fast path is not taken while a filter or the tree is active", () => {
  // 快路径的两个前提任一不成立时，必须回落到整趟投影 —— 否则会忽略过滤/展开语义。
  const { tab, parent, sibling, child } = expandedFixture();
  tab.selectedEntryIds = [parent.id, child.id, sibling.id];
  const keep = quickFilterProgram("sibling");

  // ① 有过滤：即使未展开，也必须按过滤后的可见行集取子集。
  const filtered = getTabSelectedEntries(tab, DEFAULT_FILE_VISIBILITY, keep, false).map((entry) => entry.id);
  assert.deepEqual(filtered, [sibling.id], "a filter must still restrict the target set when the tree is off");
  assert.deepEqual(filtered,
    getFolderListingRows(tab, DEFAULT_FILE_VISIBILITY, keep, false).map(({ entry }) => entry.id));

  // ② 展开启用且已加载：选中的展开子条目必须保留（快路径不得吞掉它们）。
  tab.selectedEntryIds = [child.id];
  assert.deepEqual(getTabSelectedEntries(tab, DEFAULT_FILE_VISIBILITY, null, true).map((entry) => entry.id),
    [child.id], "a selected entry inside an expanded branch must survive");
});

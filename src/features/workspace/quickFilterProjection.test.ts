import assert from "node:assert/strict";
import { test } from "node:test";
import { getFolderListingRows, getTabSelectedEntries } from "./folderExpansion";
import { expansionEntry, expansionFixture, quickFilterProgram } from "./folderExpansionTestSupport";
import { createWorkspaceState, workspaceReducer, type WorkspaceAction } from "./workspaceReducer";
import { getSelectedEntries } from "./workspaceControllerUtils";
import { captureRenameTarget } from "./renameTarget";
import { getPathComparisonKey } from "./workspacePathRelations";
import { DEFAULT_FILE_VISIBILITY } from "./workspaceVisibility";
import type { QuickFilterMode, QuickFilterSyntax } from "./quickFilterTypes";
import type { TabState, WorkspaceState } from "./types";

/**
 * 分片 2 专项：行投影与 B23。
 *
 * 本文件是 spec §8 分片 2 点名的 `quickFilterProjection.test.ts`，锁定
 * 「可见行集 = 操作目标集」在**所有回退配置**与**所有模式/语法**下成立，
 * 并单独锁定 Ctrl+A（`allEntriesSelected`）这条**独立于** `getTabSelectedEntries` 的代码点。
 *
 * 必须独立成文件的原因：`allEntriesSelected` 自己调用 `getFolderListingRows`，
 * 与 `getTabSelectedEntries` 是两处 B23 代码点。若只锁后者，前者被改回
 * `snapshot.entries` 时不会被任何断言发现（评审 IRB-01）。
 */

type Configuration = {
  name: string;
  /** 传给行投影的 `enabled`；(tab, enabled) 共同决定 `supportsFolderExpansion`。 */
  enabled: boolean;
  /** 设置项取值；reducer 读的是 state，必须与 enabled 保持一致。 */
  settingEnabled: boolean;
  apply: (tab: TabState) => void;
};

/**
 * D19 枚举的四种「展开不生效」回退配置。四者都落到「没有树」的分支 ——
 * 也就是旧实现回退到未过滤 `snapshot.entries` 的入口。
 */
const FALLBACK_CONFIGURATIONS: Configuration[] = [
  // ① 出厂默认：设置项本身为 false（必须真正写 setting，否则测不到该路径）。
  { name: "① 展开功能关闭（出厂默认）", enabled: false, settingEnabled: false, apply: () => {} },
  // ②③④ 设置项为 true，但 viewMode / location.kind / kind 使其不生效。
  { name: "② 磁贴视图（details 之外）", enabled: true, settingEnabled: true, apply: (tab) => { tab.viewMode = "tiles"; } },
  { name: "③ 「此电脑」虚拟标签页", enabled: true, settingEnabled: true, apply: (tab) => { tab.snapshot.location.kind = "virtual"; } },
  { name: "④ 搜索结果标签页", enabled: true, settingEnabled: true, apply: (tab) => { tab.kind = "search-results"; } }
];

const MODES: QuickFilterMode[] = ["highlight", "include", "exclude"];
const SYNTAXES: QuickFilterSyntax[] = ["substring", "wildcard", "regex"];

function stateAndTab(settingEnabled: boolean) {
  const fixture = expansionFixture();
  const state = createWorkspaceState(fixture.bootstrap);
  // `expansionFixture()` 为其它测试方便强制 `folderExpansionEnabled: true`；
  // 这里显式对齐，使配置① 真正走「设置项关闭」的出厂默认路径。
  state.settings.model = { ...state.settings.model, folderExpansionEnabled: settingEnabled };
  return { fixture, state, tab: state.panels["panel-1"].tabs[0] };
}

function selectAll(state: WorkspaceState): WorkspaceState {
  const tab = state.panels["panel-1"].tabs[0];
  return workspaceReducer(state, {
    type: "allEntriesSelected",
    payload: { panelId: "panel-1", tabId: tab.id }
  } as WorkspaceAction);
}

/** 构造"该路径上已生效某过滤文本"的状态。 */
function withFilter(state: WorkspaceState, tab: TabState, text: string, mode: QuickFilterMode, syntax: QuickFilterSyntax): WorkspaceState {
  return {
    ...state,
    quickFilter: {
      mode, syntax,
      byPath: { [getPathComparisonKey(tab.snapshot.location.path)]: { text, appliedText: text, error: null } }
    }
  };
}

function idOf(tab: TabState, name: string) {
  return tab.snapshot.entries.find((entry) => entry.name === name)!.id;
}

// ---------------------------------------------------------------------------
// IRB-01：Ctrl+A 在过滤生效时只能选中可见行（B23 / spec §8 line 701）
// ---------------------------------------------------------------------------

test("B23: Ctrl+A under an active filter selects exactly the visible rows, in row order", () => {
  // 出厂默认（设置项关闭）正是 spec line 701 点名要求、而此前零覆盖的边界。
  for (const mode of MODES) {
    const { state, tab } = stateAndTab(false);
    tab.selectedEntryIds = tab.snapshot.entries.map((entry) => entry.id);
    const program = quickFilterProgram("sibling", mode);
    assert.ok(program, `${mode}: the fixture filter must compile`);

    const filtered = withFilter(state, tab, program.text, mode, "substring");
    const visible = getFolderListingRows(tab, DEFAULT_FILE_VISIBILITY, program, false).map(({ entry }) => entry.id);
    const selected = selectAll(filtered).panels["panel-1"].tabs[0].selectedEntryIds;

    assert.deepEqual(selected, visible, `${mode}: Ctrl+A must write exactly the visible row set in row order`);

    // 具体化断言，避免"两边同源即恒真"：任何不可见行都不得进入选中集。
    for (const id of tab.snapshot.entries.map((entry) => entry.id).filter((id) => !visible.includes(id))) {
      assert.equal(selected.includes(id), false, `${mode}: an invisible row must not be selected by Ctrl+A`);
    }

    // 模式专属健全性检查，确保上面的"不可见行"集合非空、断言不是空转。
    const parentId = idOf(tab, "parent");
    const siblingId = idOf(tab, "sibling");
    if (mode === "include") {
      assert.equal(visible.includes(parentId), false, "include: the non-matching parent is hidden");
      assert.equal(selected.includes(parentId), false, "include: Ctrl+A must not select the hidden parent");
    } else if (mode === "exclude") {
      assert.equal(visible.includes(siblingId), false, "exclude: the matching sibling is hidden");
      assert.equal(selected.includes(siblingId), false, "exclude: Ctrl+A must not select the hidden sibling");
      assert.equal(selected.includes(parentId), true, "exclude: the visible unmatched row stays selected");
    } else {
      assert.equal(visible.length, tab.snapshot.entries.length, "D7: highlight hides nothing");
    }
  }
});

test("B23: Ctrl+A never selects a row hidden by file visibility", () => {
  const { state, tab } = stateAndTab(false);
  const hidden = expansionEntry(tab.snapshot.location.path, "secret", "file", { isHidden: true });
  tab.snapshot.entries = [...tab.snapshot.entries, hidden];
  tab.selectedEntryIds = tab.snapshot.entries.map((entry) => entry.id);

  const selected = selectAll(state).panels["panel-1"].tabs[0].selectedEntryIds;
  assert.equal(selected.includes(hidden.id), false, "spec §8 line 701: 隐藏文件不可见时不选隐藏行");
  assert.deepEqual(selected,
    getFolderListingRows(tab, DEFAULT_FILE_VISIBILITY, null, false).map(({ entry }) => entry.id));
});

// ---------------------------------------------------------------------------
// IRB-03：四种回退配置 × 三种模式 × 三种语法的一致性与顺序
// ---------------------------------------------------------------------------

test("B23: every fallback configuration keeps the operation target set equal to the visible row set", () => {
  for (const configuration of FALLBACK_CONFIGURATIONS) {
    for (const mode of MODES) {
      for (const syntax of SYNTAXES) {
        const { state, tab } = stateAndTab(configuration.settingEnabled);
        configuration.apply(tab);
        const label = `${configuration.name} / ${mode} / ${syntax}`;

        // 以未过滤行集预置选择，再施加过滤。
        tab.selectedEntryIds = getFolderListingRows(tab, DEFAULT_FILE_VISIBILITY, null, configuration.enabled)
          .map(({ entry }) => entry.id);

        const program = quickFilterProgram("sibling", mode, syntax);
        const visible = getFolderListingRows(tab, DEFAULT_FILE_VISIBILITY, program, configuration.enabled)
          .map(({ entry }) => entry.id);

        // 顺序显式断言（spec line 705：不得依赖夹具巧合）。
        assert.deepEqual(
          getTabSelectedEntries(tab, DEFAULT_FILE_VISIBILITY, program, configuration.enabled).map((entry) => entry.id),
          visible, `${label}: getTabSelectedEntries must equal the visible row set in order`);

        // Ctrl+A 是第二处独立代码点，必须单独锁定。
        const filtered = withFilter(state, tab, program!.text, mode, syntax);
        assert.deepEqual(selectAll(filtered).panels["panel-1"].tabs[0].selectedEntryIds, visible,
          `${label}: Ctrl+A must equal the visible row set in order`);
      }
    }
  }
});

test("B23: highlight mode keeps every row and never rewrites the selection", () => {
  const { state, tab } = stateAndTab(false);
  tab.selectedEntryIds = tab.snapshot.entries.map((entry) => entry.id);
  const program = quickFilterProgram("sibling", "highlight");
  const rows = getFolderListingRows(tab, DEFAULT_FILE_VISIBILITY, program, false);
  assert.equal(rows.length, tab.snapshot.entries.length, "D7: highlight must not change the row set");
  // 与行集顺序比对（而非与 selectedEntryIds 的原始顺序比对）：筛选是保序的成员过滤。
  assert.deepEqual(
    getTabSelectedEntries(tab, DEFAULT_FILE_VISIBILITY, program, false).map((entry) => entry.id),
    rows.map(({ entry }) => entry.id),
    "every selected row stays operable under highlight, in row order");
  assert.equal(state.panels["panel-1"].tabs[0].selectedEntryIds.length, tab.snapshot.entries.length,
    "D7: highlight must not rewrite the selection either");
});

// ---------------------------------------------------------------------------
// B24：过滤不修剪选择；折叠才修剪
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// D24 连带语义：非焦点面板的操作目标集必须跟随它自己的过滤
// ---------------------------------------------------------------------------

test("D24: a displayed non-focused panel resolves its operation targets against its own filter", () => {
  // 构造双面板、两面板同在夹具路径，activePanelId 为 panel-1（panel-2 非焦点但显示）。
  const fixture = expansionFixture();
  const base = createWorkspaceState(fixture.bootstrap);
  base.settings.model = { ...base.settings.model, folderExpansionEnabled: false };
  const firstTab = base.panels["panel-1"].tabs[0];
  const secondTab: TabState = { ...firstTab, id: "panel-2-tab", selectedEntryIds: [...firstTab.selectedEntryIds] };
  const dual: WorkspaceState = {
    ...base,
    layoutMode: "dual",
    panels: {
      ...base.panels,
      // `id`/`label` 必须一并改写：直接展开会让 panel-2 带着 `id: "panel-1"`。
      "panel-2": { ...base.panels["panel-1"], id: "panel-2", label: "panel-2", tabs: [secondTab], activeTabId: "panel-2-tab" }
    }
  };
  assert.equal(dual.activePanelId, "panel-1", "precondition: panel-2 is displayed but not focused");

  // 两个面板的同路径标签页都全选，然后应用 include 过滤（只留命中行）。
  const allIds = firstTab.snapshot.entries.map((entry) => entry.id);
  const selected: WorkspaceState = {
    ...dual,
    panels: {
      ...dual.panels,
      "panel-1": { ...dual.panels["panel-1"], tabs: [{ ...firstTab, selectedEntryIds: allIds }] },
      "panel-2": { ...dual.panels["panel-2"], tabs: [{ ...secondTab, selectedEntryIds: allIds }] }
    }
  };
  const filtered = withFilter(selected, firstTab, "sibling", "include", "substring");

  const focusedTargets = getSelectedEntries(filtered, "panel-1").map((entry) => entry.id);
  const unfocusedTargets = getSelectedEntries(filtered, "panel-2").map((entry) => entry.id);

  // 非焦点面板必须解析出**同一份过滤后投影**，而不是"不过滤 = 全部已选项"。
  assert.deepEqual(unfocusedTargets, focusedTargets,
    "D24: the non-focused panel's operation targets must match its filtered projection");
  assert.equal(unfocusedTargets.length < allIds.length, true,
    "precondition: the filter really does hide selected rows");
  // 具体化：被 include 隐藏的行不得成为非焦点面板的操作目标（防止"两边同源即恒真"）。
  const siblingId = idOf(firstTab, "sibling");
  const parentId = idOf(firstTab, "parent");
  assert.equal(unfocusedTargets.includes(siblingId), true, "include: the matched row stays an operation target");
  assert.equal(unfocusedTargets.includes(parentId), false, "include: the hidden row must not be an operation target");

  // 切回 highlight（不改变行集）后，非焦点面板恢复为全部已选项。
  const highlighted = withFilter(selected, firstTab, "sibling", "highlight", "substring");
  assert.deepEqual(getSelectedEntries(highlighted, "panel-2").map((entry) => entry.id).sort(), [...allIds].sort(),
    "highlight mode hides nothing, so every selected row returns as an operation target");
});

test("B24: filtering never prunes selectedEntryIds even when a selected row becomes invisible", () => {
  const { state, tab } = stateAndTab(false);
  const originalSelection = tab.snapshot.entries.map((entry) => entry.id);
  tab.selectedEntryIds = originalSelection;
  const program = quickFilterProgram("sibling", "exclude")!;
  const filtered = withFilter(state, tab, program.text, "exclude", "substring");
  const filteredTab = filtered.panels["panel-1"].tabs[0];

  const visible = getFolderListingRows(filteredTab, DEFAULT_FILE_VISIBILITY, program, false).map(({ entry }) => entry.id);
  assert.equal(visible.length < originalSelection.length, true, "precondition: the filter does hide rows");

  // 过滤不修剪选择（B24）。
  assert.deepEqual(filteredTab.selectedEntryIds, originalSelection,
    "B24: filtering must not prune selectedEntryIds");
  // 排除模式下命中的 sibling 被隐藏，故它虽"已选"却不得成为操作目标；未命中的 parent 仍可见。
  const siblingId = idOf(tab, "sibling");
  const parentId = idOf(tab, "parent");
  assert.equal(visible.includes(siblingId), false, "precondition: the matched row is hidden by exclude");
  assert.equal(visible.includes(parentId), true, "precondition: the unmatched row stays visible");
  assert.deepEqual(getSelectedEntries(filtered, "panel-1").map((entry) => entry.id), [parentId],
    "B24: only visible selected rows are operation targets");
});

// ---------------------------------------------------------------------------
// IRB-02：行投影与"已选项尺寸投影"必须使用同一 sizeBarMode
// ---------------------------------------------------------------------------

test("B23: operation targets use the same size-bar mode as the rendered rows", () => {
  // 契约要求：渲染行（WorkspaceView 传 state.settings.model.sizeBarMode）与操作目标集
  // 必须同模式。此处对两种 mode 都断言，避免将来 sizeBarMode 影响排序时二者漂移。
  for (const sizeBarMode of ["folder-total", "folder-max"] as const) {
    const { state, tab } = stateAndTab(false);
    state.settings.model = { ...state.settings.model, sizeBarMode };
    tab.selectedEntryIds = getFolderListingRows(tab, DEFAULT_FILE_VISIBILITY, null, false, sizeBarMode)
      .map(({ entry }) => entry.id);

    const program = quickFilterProgram("sibling", "include")!;
    const filtered = withFilter(state, tab, program.text, "include", "substring");
    const visible = getFolderListingRows(tab, DEFAULT_FILE_VISIBILITY, program, false, sizeBarMode)
      .map(({ entry }) => entry.id);

    // getSelectedEntries 从 state 读取 sizeBarMode，必须与上面的投影一致。
    assert.deepEqual(getSelectedEntries(filtered, "panel-1").map((entry) => entry.id),
      visible.filter((id) => tab.selectedEntryIds.includes(id)),
      `${sizeBarMode}: operation targets must use the configured size projection`);
  }
});

// ---------------------------------------------------------------------------
// B22：批量重命名目标同样只含可见的已选项
// ---------------------------------------------------------------------------

test("B22: rename target under exclude mode only contains visible selected rows", () => {
  const { state, tab } = stateAndTab(false);
  tab.selectedEntryIds = tab.snapshot.entries.map((entry) => entry.id);
  const program = quickFilterProgram("parent", "exclude")!;
  const filtered = withFilter(state, tab, program.text, "exclude", "substring");

  const target = captureRenameTarget(filtered, "panel-1");
  assert.ok(target, "a rename target must still exist for the visible selected row");
  assert.deepEqual(target.entries.map((entry) => entry.name), ["sibling"],
    "B22: the excluded row must not appear in the rename target set");
  // 隐藏不得静默删除选择。
  assert.deepEqual(filtered.panels["panel-1"].tabs[0].selectedEntryIds,
    tab.snapshot.entries.map((entry) => entry.id));
});

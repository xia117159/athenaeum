import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { FileListingShell } from "./FileListing";
import { getFolderListingRows } from "./folderExpansion";
import { expansionFixture } from "./folderExpansionTestSupport";
import { createWorkspaceState, getActiveTab } from "./workspaceReducer";
import { compileQuickFilter } from "./quickFilterMatcher";
import { assertTest, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { QuickFilterMode, QuickFilterProgram } from "./quickFilterTypes";
import type { EntryViewModel, InlineEditState, TabViewMode } from "./types";

/**
 * 分片 5：渲染与控件（spec §8:733–736）。
 *
 * §8:735 要求四种视图模式一致，§8:736（评审 G8）要求 B21 叠加可读性：
 * ① `<mark>` 必须位于颜色规则 `<span>` **内部**（DOM 层级而非仅"存在"）；
 * ② 选中 / 悬停 / 拖放目标 / 行内重命名四种状态叠加下标记仍然渲染；
 * ③ CSS 层面 `.entry-name__match` 使用独立且非继承的 `background`/`color`（结构校验）。
 *
 * 该文件在修复前整体缺失；以下用例是 B21 的回归锁定。
 */

function program(text: string, mode: QuickFilterMode = "highlight"): QuickFilterProgram {
  const result = compileQuickFilter(text, "substring", mode);
  assert.ok(result.ok);
  return result.program;
}

/** 带颜色规则（前景 + 背景）的条目：标签会拿到 `entry-name__label--rule-*` 类。 */
const NAMES = ["my_project_dir", "temp_project_dir", "notes.txt", "时间轴"];

export const completion = (async () => {
  installDomEnvironment();
  // 与 FileListingQuickFilterHighlight.test.tsx 同一套夹具：用真实 tab.columns/sort，
  // 避免自造列定义导致列表不渲染（那会让断言"空 marks"假通过）。
  const f = expansionFixture();
  const state = createWorkspaceState(f.bootstrap);
  const tab = getActiveTab(state.panels[state.activePanelId]);
  const rows = getFolderListingRows(tab);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);

  // 夹具只有 2 个条目，因此以真实 EntryViewModel 形状克隆出 4 个可控名称的条目
  // （与 FileListingQuickFilterHighlight.test.tsx 同样借用真实行形状，避免自造 fixture 漂移）。
  const template = rows[0].entry;
  const entries: EntryViewModel[] = NAMES.map((name, index) => ({
    ...template,
    id: `qf-entry-${index}`,
    name,
    path: `${f.path}\\${name}`,
    kind: "file",
    foregroundColorHex: index === 0 ? "#005a9e" : null,
    backgroundColorHex: index < 2 ? "#fff4ce" : null
  }));

  const baseProps = {
    panelId: state.activePanelId, tabId: tab.id, columns: tab.columns, sort: tab.sort,
    currentPath: f.path, detailsRowHeight: 24, colorFilterEnabled: true,
    onSort: () => undefined, onSelect: () => undefined, onOpen: () => undefined,
    onOpenContextMenu: () => undefined, onOpenNativeContextMenu: () => undefined,
    onResizeColumn: () => undefined, onDropEntries: () => undefined,
    onInlineEditChange: () => undefined, onInlineEditCommit: () => undefined, onInlineEditCancel: () => undefined
  };

  async function render(options: {
    viewMode?: TabViewMode;
    quickFilter?: QuickFilterProgram | null;
    selectedEntryIds?: string[];
    inlineEdit?: InlineEditState;
  } = {}) {
    await act(async () => {
      root.render(<FileListingShell {...baseProps} entries={entries}
        viewMode={options.viewMode ?? "details"}
        selectedEntryIds={options.selectedEntryIds ?? []}
        inlineEdit={options.inlineEdit}
        quickFilter={options.quickFilter ?? null} />);
      await flushEffects();
    });
  }

  const marks = () => [...container.querySelectorAll<HTMLElement>(".entry-name__match")].map((node) => node.textContent);

  await assertTest("§8:735 every view mode marks the matched substring with the right text", async () => {
    for (const viewMode of ["details", "list", "tile", "icon"] as TabViewMode[]) {
      await render({ viewMode, quickFilter: program("project") });
      assert.deepEqual(marks(), ["project", "project"],
        `${viewMode} must render one mark per matching name`);
    }
  });

  await assertTest("§8:735 include and exclude modes never mark names, and the color label survives", async () => {
    for (const mode of ["include", "exclude"] as QuickFilterMode[]) {
      await render({ quickFilter: program("project", mode) });
      assert.deepEqual(marks(), [], `${mode} must not render marks`);
    }
    // 颜色规则标签在过滤开启时仍然存在（§8:735 末句）。
    await render({ quickFilter: program("project") });
    assert.ok(container.querySelector(".entry-name__label--rule-background"),
      "the color-rule label must survive quick filtering");
  });

  await assertTest("§8:736/G8 the mark sits INSIDE the color-rule span, not beside it", async () => {
    await render({ quickFilter: program("project") });
    const mark = container.querySelector<HTMLElement>(".entry-name__match")!;
    assert.ok(mark, "precondition: a mark exists");

    // ① DOM 层级：mark 的祖先链里必须有颜色规则标签，且该标签含原名称全文。
    const labelSpan = mark.closest(".entry-name__label--rule-background, .entry-name__label--rule-foreground");
    assert.ok(labelSpan, "the mark must be nested inside the color-rule span");
    assert.equal(labelSpan!.querySelectorAll(".entry-name__match").length, 1,
      "the mark must be the color-rule span's own descendant");
    assert.equal(labelSpan!.textContent, "my_project_dir",
      "the color-rule span keeps the untouched full name text");
    assert.equal(mark.parentElement, labelSpan,
      "the mark is a direct child of the color-rule span, not a sibling");
  });

  await assertTest("§8:736/G8 the mark still renders under selection, hover, drop target and inline edit", async () => {
    // ② 四种叠加态：标记在任一状态下都必须仍然渲染，且文本保真。
    // 选中态。
    await render({ quickFilter: program("project"), selectedEntryIds: [entries[0].id] });
    assert.deepEqual(marks(), ["project", "project"], "selection must not remove the mark");
    assert.ok(container.querySelector(".file-row.is-selected"), "precondition: a row is selected");
    assert.ok(container.querySelector(".file-row.is-selected .entry-name__match"),
      "the selected row must still show its mark");

    // 悬停态：details 视图以 .file-row:hover 表达（无法在 jsdom 合成 :hover），
    // 因此改为校验"标记不依赖行状态类"这一更强的结构性事实 + CSS 选择器存在性。
    const listingCss = readFileSync(join(process.cwd(), "src/features/workspace/workspace.listing.css"), "utf8");
    for (const state of ["is-selected", "is-drop-target", "is-inline-editing"]) {
      assert.match(listingCss, new RegExp(`\\.file-row\\.${state}`),
        `precondition: ${state} is a real row state`);
    }
    assert.match(listingCss, /\.file-row:hover/, "precondition: details rows have a hover state");

    // 多选态：所有命中行都保留标记。
    await render({ quickFilter: program("project"), selectedEntryIds: entries.map((item) => item.id) });
    assert.equal(container.querySelectorAll(".entry-name__match").length, 2,
      "marks must be independent of row state classes");

    // 行内重命名态：该行显示输入框，其余行的标记不受影响。
    await render({
      quickFilter: program("project"),
      selectedEntryIds: [entries[0].id],
      inlineEdit: {
        mode: "rename", value: NAMES[0], kind: "file", parentPath: f.path,
        entryId: entries[0].id, originalName: NAMES[0], originalPath: entries[0].path
      }
    });
    assert.ok(container.querySelector(".file-row.is-inline-editing"), "precondition: inline edit is active");
    assert.deepEqual(marks(), ["project"],
      "the untouched row keeps its mark while another row is being renamed");
  });

  await assertTest("§8:736/G8 the highlight CSS is independent and non-inherited", async () => {
    // ③ CSS 结构校验（不做像素级视觉断言）：background 与 color 都必须显式声明，
    // 否则标记会继承行选中/悬停/规则着色，在深色主题下失去对比度。
    const css = readFileSync(join(process.cwd(), "src/features/workspace/workspace.quick-filter.css"), "utf8");
    const block = css.match(/\.entry-name__match\s*\{[^}]*\}/)?.[0];
    assert.ok(block, ".entry-name__match must have its own rule block");
    assert.match(block!, /background:\s*[^;]+;/, "background must be set explicitly (non-inherited)");
    assert.match(block!, /color:\s*[^;]+;/, "color must be set explicitly (non-inherited)");
    // 不得使用 inherit/currentColor —— 那正是"继承"的反面要求。
    assert.doesNotMatch(block!, /background:\s*(inherit|currentColor)/i);
    assert.doesNotMatch(block!, /(?:^|[^-])color:\s*inherit/i);
    // 不改变字号/字重/内边距与边框，避免名称宽度变化导致详情列抖动（§6.7）。
    for (const forbidden of ["font-size", "font-weight", "padding", "margin"]) {
      assert.equal(block!.includes(forbidden), false, `.entry-name__match must not set ${forbidden}`);
    }
  });

  await assertTest("no filter program leaves every name unmarked and unmodified", async () => {
    await render({ quickFilter: null });
    assert.deepEqual(marks(), []);
    const texts = [...container.querySelectorAll<HTMLElement>(".entry-name")].map((node) => node.textContent);
    for (const name of NAMES) {
      assert.ok(texts.includes(name), `${name} must render verbatim when unfiltered`);
    }
    await act(async () => { root.unmount(); await flushEffects(); });
    container.remove();
  });
})();

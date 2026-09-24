import { compileQuickFilter } from "./quickFilterMatcher";
import { DEFAULT_QUICK_FILTER_ENTRY } from "./quickFilterTypes";
import { getPathComparisonKey } from "./workspacePathRelations";
import { isDirectoryLikeTab } from "./workspaceTabs";
import type {
  QuickFilterEntry,
  QuickFilterMode,
  QuickFilterProgram,
  QuickFilterState,
  QuickFilterSyntax
} from "./quickFilterTypes";
import type { PanelId, PanelState, WorkspaceState } from "./types";

/**
 * 快速过滤状态的读取与解析。
 *
 * 关键约束（spec B11 / D24）：过滤作用于**每个面板中处于显示状态的标签页**，
 * 即"该标签页是本面板的激活标签页"，**与面板是否持有焦点无关**。
 * 该规则必须由本模块的解析函数唯一表达，禁止在各调用点散落
 * `state.activePanelId === panelId ? … : null` 或 `isFocused ? … : null` 这类三元表达式 ——
 * 两套等价但会漂移的判定
 * 是"隐藏标签页被同路径缓存误伤"或"失焦即取消过滤"这类缺陷的温床。
 */

function getPanelActiveTab(panel: PanelState | undefined) {
  if (!panel) return undefined;
  return panel.tabs.find((tab) => tab.id === panel.activeTabId) ?? panel.tabs[0];
}

/** 该路径的条目（不存在时返回 undefined）。 */
export function getQuickFilterEntry(state: WorkspaceState, path: string): QuickFilterEntry | undefined {
  return state.quickFilter.byPath[getPathComparisonKey(path)];
}

/** 该路径的条目，缺失时返回默认值。 */
export function resolveQuickFilterEntry(state: WorkspaceState, path: string): QuickFilterEntry {
  return getQuickFilterEntry(state, path) ?? DEFAULT_QUICK_FILTER_ENTRY;
}

/**
 * Resolve the applied filter. Regex reads only committed Worker data; other
 * syntaxes compile synchronously. Empty input has no filtering program.
 */
export function resolveQuickFilterProgram(state: WorkspaceState, path: string): QuickFilterProgram | null {
  const entry = resolveQuickFilterEntry(state, path);
  if (entry.appliedText.trim() === "") return null;
  if (state.quickFilter.syntax === "regex") {
    const evaluation = entry.regexEvaluation;
    if (!evaluation || evaluation.text !== entry.appliedText) return {
      mode: state.quickFilter.mode, text: entry.appliedText,
      test: () => false, ranges: () => [], isPending: () => true
    };
    return {
      mode: state.quickFilter.mode,
      text: evaluation.text,
      test: (name) => Object.hasOwn(evaluation.matches, name) && evaluation.matches[name].matched,
      ranges: (name) => Object.hasOwn(evaluation.matches, name) ? evaluation.matches[name].ranges : [],
      isPending: (name) => !Object.hasOwn(evaluation.matches, name)
    };
  }
  const result = compileQuickFilter(entry.appliedText, state.quickFilter.syntax, state.quickFilter.mode);
  return result.ok ? result.program : null;
}

/**
 * 权威判定：当 `tabId` 是该面板的**激活（显示中）标签页**时返回其路径的程序。
 *
 * **与面板是否持有焦点无关**（D24）：同一路径的标签页在多个面板中同时显示时，
 * 任一标签页写入过滤，其它面板中同路径的显示中标签页同时生效；
 * 面板/标签页失去焦点也不取消已生效的过滤。
 * 隐藏标签页（非该面板激活标签页）与导航页恒为 null。
 * 注意判定基准是"正在被投影的那个标签页"，而不是"路径恰好相同"。
 */
export function resolveTabQuickFilter(state: WorkspaceState, panelId: PanelId, tabId: string): QuickFilterProgram | null {
  const panel = state.panels[panelId];
  if (!panel || panel.activeTabId !== tabId) return null;
  const tab = panel.tabs.find((candidate) => candidate.id === tabId);
  if (!tab || !isDirectoryLikeTab(tab)) return null;
  return resolveQuickFilterProgram(state, tab.snapshot.location.path);
}

/** 面板级便捷封装：对该面板的激活标签页调用 `resolveTabQuickFilter`。 */
export function resolvePanelQuickFilter(state: WorkspaceState, panelId: PanelId): QuickFilterProgram | null {
  const tab = getPanelActiveTab(state.panels[panelId]);
  if (!tab) return null;
  return resolveTabQuickFilter(state, panelId, tab.id);
}

/** 激活面板的激活标签页。reducer 中本就操作激活标签页的场景使用。 */
export function resolveActiveQuickFilterProgram(state: WorkspaceState): QuickFilterProgram | null {
  return resolvePanelQuickFilter(state, state.activePanelId);
}

/** 输入框需要展示的文本、诊断与当前模式/语法。 */
export function resolveQuickFilterInput(
  state: WorkspaceState,
  path: string
): { text: string; error: string | null; mode: QuickFilterMode; syntax: QuickFilterSyntax } {
  const entry = resolveQuickFilterEntry(state, path);
  return { text: entry.text, error: entry.error, mode: state.quickFilter.mode, syntax: state.quickFilter.syntax };
}

/** Conditions follow navigation history; filename data belongs only to active tabs.
 * Returning to a remembered path rebuilds its data in the Worker. Other panels
 * displaying that path retain the shared data regardless of keyboard focus. */
export function pruneQuickFilterCache(state: WorkspaceState): QuickFilterState {
  const current = state.quickFilter;
  const keys = Object.keys(current.byPath);
  if (keys.length === 0) return current;
  const live = new Set<string>();
  const evaluated = new Set<string>();
  for (const panel of Object.values(state.panels)) {
    for (const tab of panel.tabs) {
      if (!isDirectoryLikeTab(tab)) continue;
      live.add(getPathComparisonKey(tab.snapshot.location.path));
      if (tab.id === panel.activeTabId) evaluated.add(getPathComparisonKey(tab.snapshot.location.path));
      // 需求 6：标签页历史里的路径也算存活，返回上级时才不会丢过滤词。
      for (const historyPath of tab.history) {
        live.add(getPathComparisonKey(historyPath));
      }
    }
  }
  let removed = false;
  const byPath: Record<string, QuickFilterEntry> = {};
  for (const key of keys) {
    if (live.has(key)) {
      const entry = current.byPath[key];
      if (!evaluated.has(key) && (entry.regexEvaluation || entry.regexAttempt)) {
        byPath[key] = { text: entry.text, appliedText: entry.appliedText, error: entry.error };
        removed = true;
      } else byPath[key] = entry;
    } else {
      removed = true;
    }
  }
  // 无删除必须保持同一引用：调用方（与 memo）依赖这一点。
  return removed ? { ...current, byPath } : current;
}

// ---------------------------------------------------------------------------
// spec §5.7 状态机（纯函数，reducer 只做薄委派以控制行数预算）
// ---------------------------------------------------------------------------

function withEntry(current: QuickFilterState, path: string, entry: QuickFilterEntry, changed: boolean): QuickFilterState {
  if (!changed) return current;
  return { ...current, byPath: { ...current.byPath, [getPathComparisonKey(path)]: entry } };
}

function sameEntry(a: QuickFilterEntry, b: QuickFilterEntry) {
  return a.text === b.text && a.appliedText === b.appliedText && a.error === b.error;
}

/** 写入用户输入。空文本在**任意**语法下都无条件清空生效匹配与错误（评审 S3）。 */
export function applyQuickFilterText(state: QuickFilterState, path: string, text: string): QuickFilterState {
  const previous = state.byPath[getPathComparisonKey(path)] ?? DEFAULT_QUICK_FILTER_ENTRY;
  const entry: QuickFilterEntry =
    text.trim() === ""
      ? { text, appliedText: "", error: null }
      : state.syntax === "regex"
        // regex 可能编译失败，因此生效匹配要等 controller 派发 quickFilterEvaluationCommitted。
        ? { text, appliedText: previous.appliedText, error: previous.error, regexEvaluation: previous.regexEvaluation }
        // substring / wildcard 不可能失败，立即生效（D13/D22）。
        : { text, appliedText: text, error: null };
  return withEntry(state, path, entry, !sameEntry(previous, entry));
}

/** 模式不参与编译，因此只改会话偏好。 */
export function applyQuickFilterMode(state: QuickFilterState, mode: QuickFilterMode): QuickFilterState {
  return state.mode === mode ? state : { ...state, mode };
}

/**
 * 切换语法。语法是会话全局的，因此要作用于**每一个**已缓存路径：
 * - 切到非 regex：立即用当前文本重算（不可能失败），并清掉旧诊断；
 * - 切到 regex：把 `appliedText` 置空。旧语法下的"有效"文本在新语法下未必有效
 *   （`a(1` 在 substring 下合法、在 regex 下非法），沿用会让列表停在一个用新语法无法解释的结果上。
 */
export function applyQuickFilterSyntax(state: QuickFilterState, syntax: QuickFilterSyntax): QuickFilterState {
  if (state.syntax === syntax) return state;
  const byPath: Record<string, QuickFilterEntry> = {};
  for (const [key, entry] of Object.entries(state.byPath)) {
    byPath[key] = syntax === "regex"
      ? { text: entry.text, appliedText: "", error: null }
      : { text: entry.text, appliedText: entry.text.trim() ? entry.text : "", error: null };
  }
  return { ...state, syntax, byPath };
}

/** 清空某一路径的文本；模式与语法保留（B17）。 */
export function applyQuickFilterCleared(state: QuickFilterState, path: string): QuickFilterState {
  const previous = state.byPath[getPathComparisonKey(path)];
  if (!previous) return state;
  return withEntry(state, path, { text: "", appliedText: "", error: null }, true);
}


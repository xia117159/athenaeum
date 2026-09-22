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
 * 编译该路径当前生效的匹配程序。
 * `appliedText` 为空（不过滤）或在当前语法下无法编译时返回 null。
 */
export function resolveQuickFilterProgram(state: WorkspaceState, path: string): QuickFilterProgram | null {
  const entry = resolveQuickFilterEntry(state, path);
  if (entry.appliedText === "") return null;
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

/**
 * 缓存淘汰（D5 + 评审需求 6）。
 *
 * 存活键集合 = 所有面板 × 所有 `isDirectoryLikeTab` 标签页的
 * **当前路径 ∪ 该标签页 `history` 中的全部路径**。
 *
 * 只取"当前路径并集"会把需求 6 破坏掉：用户在某目录输入过滤词 → 进入子文件夹 →
 * 返回上级时过滤词被静默清空，因为原路径在进入子文件夹的那一刻就不再被任何标签页停留。
 * 加入 `history` 后，"返回上级"能恢复过滤词，而真正离场的路径照旧淘汰。
 *
 * 有界性：`history` 是标签页自身的导航栈（`workspaceReducer.ts:1657` 在导航时截断前向分支），
 * 标签页关闭即随之释放，因此不引入新的全局容器，长会话下不会无界增长。
 *
 * 无删除时返回**同一引用**，以免破坏下游 memo。
 */
export function pruneQuickFilterCache(state: WorkspaceState): QuickFilterState {
  const current = state.quickFilter;
  const keys = Object.keys(current.byPath);
  if (keys.length === 0) return current;
  const live = new Set<string>();
  for (const panel of Object.values(state.panels)) {
    for (const tab of panel.tabs) {
      if (!isDirectoryLikeTab(tab)) continue;
      live.add(getPathComparisonKey(tab.snapshot.location.path));
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
      byPath[key] = current.byPath[key];
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
    text === ""
      ? { text: "", appliedText: "", error: null }
      : state.syntax === "regex"
        // regex 可能编译失败，因此生效匹配要等 controller 派发 quickFilterApplied。
        ? { text, appliedText: previous.appliedText, error: previous.error }
        // substring / wildcard 不可能失败，立即生效（D13/D22）。
        : { text, appliedText: text, error: null };
  return withEntry(state, path, entry, !sameEntry(previous, entry));
}

/**
 * 应用编译结果。`text` 只用作**陈旧性守卫**：与条目当前 text 不一致则整条丢弃，
 * 因此 `error` 永远描述用户当下看到的文本（评审 S5）。
 */
export function applyQuickFilterApplied(
  state: QuickFilterState,
  path: string,
  payload: { text: string; ok: boolean; message: string | null }
): QuickFilterState {
  const key = getPathComparisonKey(path);
  const previous = state.byPath[key];
  if (!previous || previous.text !== payload.text) return state;
  const entry: QuickFilterEntry = payload.ok
    ? { text: previous.text, appliedText: payload.text, error: null }
    : // 失败时沿用上一次有效匹配（D12/B5）。
      { text: previous.text, appliedText: previous.appliedText, error: payload.message };
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
      : { text: entry.text, appliedText: entry.text, error: null };
  }
  return { ...state, syntax, byPath };
}

export interface QuickFilterCompileTask {
  /** 比较键，用作指纹表的键。 */
  key: string;
  /** 该路径的真实写法，用于派发 `quickFilterApplied`。 */
  path: string;
  text: string;
  fingerprint: string;
}

/**
 * 编译计划（§6.6）。作用域是**所有面板中全部目录类标签页的路径**，而不只是激活面板的路径。
 *
 * 语法是会话全局的：切到 regex 时 `applyQuickFilterSyntax` 会把**每一条**路径的 `appliedText`
 * 置空（旧语法下的有效文本在新语法下未必有效）。若只重算激活面板，其它**显示中**面板就会
 * 停在一个"文本还在、生效匹配为空"的状态——表现为"失去焦点即取消过滤"，正是 D24 ② 要消除的耦合。
 */
export function planQuickFilterCompilations(state: WorkspaceState): {
  tasks: QuickFilterCompileTask[];
  /** 已无待编译内容（文本为空或已生效）的存活路径，需清掉指纹以便日后重算。 */
  settled: string[];
  /** 全部存活路径的比较键，用于淘汰已离场路径的指纹。 */
  liveKeys: string[];
} {
  const tasks: QuickFilterCompileTask[] = [];
  const settled: string[] = [];
  const liveKeys: string[] = [];
  const seen = new Set<string>();
  for (const panel of Object.values(state.panels)) {
    for (const tab of panel.tabs) {
      if (!isDirectoryLikeTab(tab)) continue;
      const path = tab.snapshot.location.path;
      if (!path) continue;
      const key = getPathComparisonKey(path);
      if (seen.has(key)) continue;
      seen.add(key);
      liveKeys.push(key);
      const entry = state.quickFilter.byPath[key];
      const text = entry?.text ?? "";
      // `settled` 必须同时排除"还有陈旧诊断"的情形：regex 下文本回退到**上一次有效值**时
      // `text === appliedText` 成立，但 `error` 仍描述着中间那次非法输入。若在此跳过重编译，
      // `quickFilterApplied` 就永远不会派发，红框会一直留着（规格 §5.7：error 永远描述用户当下看到的文本）。
      if (text === "" || (text === entry?.appliedText && !entry?.error)) {
        settled.push(key);
        continue;
      }
      tasks.push({
        key,
        path,
        text,
        fingerprint: `${state.quickFilter.syntax}\u0000${state.quickFilter.mode}\u0000${text}`
      });
    }
  }
  return { tasks, settled, liveKeys };
}

/** 清空某一路径的文本；模式与语法保留（B17）。 */
export function applyQuickFilterCleared(state: QuickFilterState, path: string): QuickFilterState {
  const previous = state.byPath[getPathComparisonKey(path)];
  if (!previous) return state;
  return withEntry(state, path, { text: "", appliedText: "", error: null }, true);
}


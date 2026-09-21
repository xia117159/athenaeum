/**
 * 快速过滤的共享类型与常量。
 *
 * 该模块必须保持"纯类型 + 常量"，不含任何匹配逻辑，以便被渲染层、reducer 与测试同时引用
 * 而不引入循环依赖。
 */

/** 三种互斥模式（D7）。 */
export type QuickFilterMode = "highlight" | "include" | "exclude";

/** 三种匹配语法（D7）。拼音只叠加在 substring 上（D3）。 */
export type QuickFilterSyntax = "substring" | "wildcard" | "regex";

/** 半开区间，单位为 UTF-16 code unit，用于切片渲染。 */
export interface QuickFilterRange {
  start: number;
  end: number;
}

/**
 * 单个路径缓存的快速过滤文本状态。
 * 模式与语法是会话全局偏好（D4-R），因此不在此结构内。
 */
export interface QuickFilterEntry {
  /** 用户当前输入（输入框显示内容、键盘直输聚合目标）。 */
  text: string;
  /**
   * 最近一次"已生效"的过滤文本；空串表示当前不过滤。
   * regex 语法下 text 先写入、appliedText 待编译成功后跟进；编译失败时保持不变
   * （"沿用上一次有效匹配"）。详见 spec §5.7 的状态机表格。
   */
  appliedText: string;
  /** 当前 text 的编译诊断；null 表示无错误。 */
  error: string | null;
}

export interface QuickFilterState {
  /** 会话全局偏好，不属于路径缓存（D4-R）。 */
  mode: QuickFilterMode;
  syntax: QuickFilterSyntax;
  /** key = getPathComparisonKey(path)；只缓存过滤文本。 */
  byPath: Record<string, QuickFilterEntry>;
}

/**
 * 编译后的匹配程序。`test` 与 `ranges` 都只以 `entry.name` 为匹配源（D6）。
 */
export interface QuickFilterProgram {
  mode: QuickFilterMode;
  /** 生效的过滤文本；空串表示不过滤。 */
  text: string;
  /** 原始命中判定（与 mode 无关）。text 为空串时恒为 true。 */
  test(name: string): boolean;
  /** 命中区间，按 start 升序、互不重叠；text 为空串时恒为空。 */
  ranges(name: string): QuickFilterRange[];
}

export type QuickFilterCompileResult =
  | { ok: true; program: QuickFilterProgram }
  | { ok: false; message: string };

export const DEFAULT_QUICK_FILTER_MODE: QuickFilterMode = "highlight";
export const DEFAULT_QUICK_FILTER_SYNTAX: QuickFilterSyntax = "substring";

export const DEFAULT_QUICK_FILTER_ENTRY: QuickFilterEntry = { text: "", appliedText: "", error: null };

export const DEFAULT_QUICK_FILTER_STATE: QuickFilterState = {
  mode: DEFAULT_QUICK_FILTER_MODE,
  syntax: DEFAULT_QUICK_FILTER_SYNTAX,
  byPath: {}
};

/** 左键循环切换的固定顺序（B18）。 */
export const QUICK_FILTER_MODE_ORDER: readonly QuickFilterMode[] = ["highlight", "include", "exclude"];
export const QUICK_FILTER_SYNTAX_ORDER: readonly QuickFilterSyntax[] = ["substring", "wildcard", "regex"];

/** 键盘直输聚合超时（B15）。 */
export const QUICK_FILTER_TYPEAHEAD_TIMEOUT_MS = 1500;
/** regex 语法的输入防抖（D13）；切换语法不走防抖（spec §6.6）。 */
export const QUICK_FILTER_REGEX_DEBOUNCE_MS = 100;

export const QUICK_FILTER_MODE_LABELS: Record<QuickFilterMode, string> = {
  highlight: "高亮",
  include: "仅保留命中",
  exclude: "排除命中"
};

export const QUICK_FILTER_SYNTAX_LABELS: Record<QuickFilterSyntax, string> = {
  substring: "子串",
  wildcard: "通配符",
  regex: "正则表达式"
};

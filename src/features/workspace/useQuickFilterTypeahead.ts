import { useLayoutEffect, useRef } from "react";
import { QUICK_FILTER_TYPEAHEAD_TIMEOUT_MS } from "./quickFilterTypes";
import { resolveQuickFilterEntry } from "./quickFilterState";
import { isDirectoryLikeTab } from "./workspaceTabs";
import type { WorkspaceState } from "./types";

/** 事件目标只需要判定「是否可编辑」，因此用结构化类型而非 DOM 类型，便于纯函数矩阵测试。 */
export interface QuickFilterTypeaheadTarget {
  tagName?: string;
  isContentEditable?: boolean;
}

export interface QuickFilterTypeaheadInput {
  key: string;
  target?: QuickFilterTypeaheadTarget | null;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  repeat?: boolean;
  state: WorkspaceState;
  /** 激活面板激活标签页所在路径（B14）。 */
  activePath: string;
  now: number;
  /** 上次真实生效的直输时间；未知/已重置时为 0（B16）。 */
  lastAt: number;
}

export type QuickFilterTypeaheadDecision =
  /** 不消费该按键，交回既有快捷键语义。 */
  | { kind: "ignore" }
  /** B17：清空该路径的过滤文本（模式/语法保留）。 */
  | { kind: "clearFilter" }
  /** 写入聚合后的文本。 */
  | { kind: "type"; text: string; resetAt: number };

const IGNORE: QuickFilterTypeaheadDecision = { kind: "ignore" };
const CLEAR: QuickFilterTypeaheadDecision = { kind: "clearFilter" };

/** ASCII 可打印区间 `0x21`–`0x7E`；空格（`0x20`）留给「展开/折叠文件夹」快捷键（B14）。 */
const PRINTABLE_MIN = 0x21;
const PRINTABLE_MAX = 0x7e;

function getActiveTabOf(state: WorkspaceState) {
  const panel = state.panels[state.activePanelId];
  if (!panel) return undefined;
  return panel.tabs.find((tab) => tab.id === panel.activeTabId) ?? panel.tabs[0];
}

/** Reset on committed navigation/focus transitions, even if no key was pressed
 * at the intermediate target. Selection and same-path refresh keep the clock. */
export function useQuickFilterTypeaheadClock(state: WorkspaceState) {
  const tab = getActiveTabOf(state);
  const identity = `${state.activePanelId}\u0000${tab?.id ?? ""}\u0000${tab?.snapshot.location.path ?? ""}`;
  const clock = useRef({ target: identity, lastAt: 0 });
  useLayoutEffect(() => { clock.current = { target: identity, lastAt: 0 }; }, [identity]);
  return clock;
}

function isEditableTarget(target: QuickFilterTypeaheadTarget | null | undefined) {
  if (!target) return false;
  return target.isContentEditable === true || target.tagName === "INPUT"
    || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

/**
 * 键盘直输的纯判定与文本聚合（B14–B17）。dispatch 由 controller 完成，
 * 因此聚合、超时、字符集与优先级都能用纯函数矩阵覆盖。
 */
export function decideQuickFilterTypeahead(input: QuickFilterTypeaheadInput): QuickFilterTypeaheadDecision {
  const { state, activePath, now, lastAt } = input;

  // 就绪与标签页门槛：非激活面板、非文件列表标签页、未就绪或正在行内编辑时都不直输。
  const tab = getActiveTabOf(state);
  if (state.status !== "ready" || !tab || tab.status !== "ready" || tab.inlineEdit) return IGNORE;
  if (!isDirectoryLikeTab(tab)) return IGNORE;
  // 面板级遮挡：批量重命名、打开方式、菜单栏、右键菜单、模板菜单打开时不写入过滤文本。
  if (state.batchRename || state.openWithMenu || state.menuBar || state.contextMenu || state.templateMenu) return IGNORE;
  if (isEditableTarget(input.target)) return IGNORE;
  if (input.ctrlKey || input.altKey || input.metaKey) return IGNORE;
  if (input.isComposing || input.repeat) return IGNORE;

  // B17：Esc 的判定必须在字符集检查之前（`Escape` 不是可打印字符）。
  // 文本非空时清空该路径（模式/语法保留）；文本为空时不消费，沿用既有 clear-selection。
  if (input.key === "Escape" || input.key === "Esc") {
    return resolveQuickFilterEntry(state, activePath).text === "" ? IGNORE : CLEAR;
  }

  if (input.key.length !== 1) return IGNORE;
  const code = input.key.charCodeAt(0);
  if (code < PRINTABLE_MIN || code > PRINTABLE_MAX) return IGNORE;

  // B15：超过聚合超时按「新聚合」处理（替换）；否则追加。
  // lastAt === 0（会话开始或激活标签页/路径变化后的重置，B16）在真实时钟下必然超时，
  // 因此标签页切换后的首个按键总是替换而不是追加。
  const previous = resolveQuickFilterEntry(state, activePath).text;
  const restart = now - lastAt > QUICK_FILTER_TYPEAHEAD_TIMEOUT_MS;
  return { kind: "type", text: restart ? input.key : previous + input.key, resetAt: now };
}

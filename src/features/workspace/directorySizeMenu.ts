import type { DirectorySizeTabState } from "./directorySizeTypes";
import type { TabState } from "./types";
import { findAutoDirectorySizeRoot, normalizeAutoDirectorySizePath } from "./directorySizeAutoPaths";
import { currentDirectorySizes, hasVisibleSizeColumn } from "./directorySizes";

export type DirectorySizeMenuState = { kind: "calculate"; disabled: boolean; title?: string } | { kind: "retry" } | null;
export interface DirectorySizeAutoBadge { root: string; inherited: boolean; failed?: string }
export interface AutoDirectorySizeToggle { path: string; checked: boolean; inheritedFrom: string | null }

export const DIRECTORY_SIZE_MENU_LABELS = { calculate: "立即计算文件夹大小", retry: "重试自动计算" } as const;

/** One entry of the size header menu and the View menu. */
export interface DirectorySizeMenuAction { label: string; disabled: boolean; title?: string; onSelect(): void }

export function directorySizeMenuAction(menu: DirectorySizeMenuState, handlers: { calculate(): void; retry(): void }): DirectorySizeMenuAction | undefined {
  if (!menu) return undefined;
  return menu.kind === "retry" ? { label: DIRECTORY_SIZE_MENU_LABELS.retry, disabled: false, onSelect: handlers.retry }
    : { label: DIRECTORY_SIZE_MENU_LABELS.calculate, disabled: menu.disabled, title: menu.title, onSelect: handlers.calculate };
}

export function directorySizeBusy(sizes: DirectorySizeTabState | undefined) {
  return sizes?.pending === true || sizes?.snapshot?.phase === "queued" || sizes?.snapshot?.phase === "scanning";
}

function sizedDirectory(tab: TabState) {
  return tab.kind === "directory" && tab.snapshot.location.kind !== "virtual";
}

/** Only local directories (UNC and mapped drives included) can be automatic (D5, D17). */
function autoRoot(tab: TabState, autoList: readonly string[]) {
  return sizedDirectory(tab) && tab.snapshot.location.kind === "local"
    ? findAutoDirectorySizeRoot(tab.snapshot.location.path, autoList) : null;
}

function autoFailure(sizes: DirectorySizeTabState | undefined) {
  if (sizes?.autoPaused || sizes?.autoError) return sizes.autoError ?? "自动计算失败";
  return sizes?.snapshot?.phase === "failed" ? sizes.snapshot.reason ?? "自动计算失败" : undefined;
}

/** Header context menu and View menu entry (D8, D9, D16). */
export function directorySizeMenuState(tab: TabState, autoList: readonly string[]): DirectorySizeMenuState {
  if (!sizedDirectory(tab)) return null;
  const sizes = currentDirectorySizes(tab);
  if (autoRoot(tab, autoList)) return autoFailure(sizes) === undefined ? null : { kind: "retry" };
  if (!hasVisibleSizeColumn(tab)) return { kind: "calculate", disabled: true, title: "需要在详细信息视图中显示大小列" };
  if (tab.status !== "ready") return { kind: "calculate", disabled: true, title: "文件夹加载完成后才能计算大小" };
  return directorySizeBusy(sizes) ? { kind: "calculate", disabled: true, title: "正在计算文件夹大小" } : { kind: "calculate", disabled: false };
}

/** The header shows a badge instead of a button for automatic directories (D2, E3). */
export function directorySizeAutoBadge(tab: TabState, autoList: readonly string[]): DirectorySizeAutoBadge | undefined {
  const root = autoRoot(tab, autoList);
  if (!root) return undefined;
  const failed = autoFailure(currentDirectorySizes(tab));
  return failed === undefined ? { ...root } : { ...root, failed };
}

/**
 * Tab context menu checkbox; shown whether or not the size column is visible (D1, D13). It carries the saved form of
 * the path, so share roots are confirmed (E4) and a path the backend would reject never offers the command.
 */
export function autoDirectorySizeToggle(tab: TabState, autoList: readonly string[]): AutoDirectorySizeToggle | null {
  if (!sizedDirectory(tab) || tab.snapshot.location.kind !== "local") return null;
  const path = normalizeAutoDirectorySizePath(tab.snapshot.location.path);
  if (path === null) return null;
  const root = findAutoDirectorySizeRoot(path, autoList);
  return { path, checked: root !== null, inheritedFrom: root?.inherited ? root.root : null };
}

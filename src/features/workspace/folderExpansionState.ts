import { getExpandedFolderPaths, getFolderBranch, getFolderListingRows, getTabEntries, supportsFolderExpansion } from "./folderExpansion";
import { getPathComparisonKey, isSameOrDescendantPath, pathsEqual } from "./workspacePathRelations";
import type { DirectorySnapshot, FileVisibilityState, FolderExpansionBranch, PanelId, PanelState, SelectionPathReplacement, TabState } from "./types";

type BranchTarget = { panelId: PanelId; tabId: string; path: string };
type BranchRequest = BranchTarget & { rootSnapshot: DirectorySnapshot; requestId: number };
export type FolderExpansionAction =
  | { type: "folderExpansionRefreshFailed"; payload: { panelId: PanelId; tabId: string; rootSnapshot: DirectorySnapshot; errorMessage: string } }
  | { type: "folderExpansionToggled"; payload: BranchTarget }
  | { type: "folderExpansionRetryRequested"; payload: BranchTarget }
  | { type: "folderExpansionLoadStarted"; payload: BranchRequest & { expectedBranch?: FolderExpansionBranch } }
  | { type: "folderExpansionLoadSucceeded"; payload: BranchRequest & { snapshot: DirectorySnapshot } }
  | { type: "folderExpansionLoadFailed"; payload: BranchRequest & { errorMessage: string } };

function pruneBranches(tab: TabState): TabState["folderExpansion"] {
  const paths = getExpandedFolderPaths(tab);
  return paths.length ? Object.fromEntries(paths.map((path) => [getPathComparisonKey(path), getFolderBranch(tab, path)!])) : undefined;
}

/** Reconcile selection by identity, including a rename committed by an operation. */
export function reconcileFolderSelection(before: TabState, after: TabState, replacements: SelectionPathReplacement[] = []): TabState {
  const entries = getTabEntries(after);
  const nextIds = new Set(entries.map((entry) => entry.id));
  const idsByPath = new Map(entries.map((entry) => [getPathComparisonKey(entry.path), entry.id]));
  const previousEntries = new Map(getTabEntries(before).map((entry) => [entry.id, entry]));
  const replacementPaths = new Map(replacements.map((item) => [getPathComparisonKey(item.fromPath), item.toPath]));
  const selectedEntryIds: string[] = [];
  for (const id of before.selectedEntryIds) {
    const path = previousEntries.get(id)?.path ?? id;
    const replacement = replacementPaths.get(getPathComparisonKey(path));
    const nextId = (replacement ? idsByPath.get(getPathComparisonKey(replacement)) : undefined)
      ?? (nextIds.has(id) ? id : idsByPath.get(getPathComparisonKey(path)));
    if (nextId && !selectedEntryIds.includes(nextId)) selectedEntryIds.push(nextId);
  }
  const edit = after.inlineEdit;
  return {
    ...after,
    selectedEntryIds,
    selectionAnchorId: before.selectionAnchorId && nextIds.has(before.selectionAnchorId) ? before.selectionAnchorId : null,
    selectionCursorId: before.selectionCursorId && nextIds.has(before.selectionCursorId) ? before.selectionCursorId : null,
    inlineEdit: edit?.entryId && !nextIds.has(edit.entryId) ? undefined : edit
  };
}

export function clearFolderExpansion(tab: TabState): TabState {
  return tab.folderExpansion ? reconcileFolderSelection(tab, { ...tab, folderExpansion: undefined }) : tab;
}

export function clearPanelFolderExpansions(panels: Record<PanelId, PanelState>) {
  return Object.fromEntries(Object.entries(panels).map(([id, panel]) => [id, {
    ...panel, tabs: panel.tabs.map(clearFolderExpansion)
  }])) as Record<PanelId, PanelState>;
}

export function refreshFolderExpansion(tab: TabState, snapshot: DirectorySnapshot, replacements: SelectionPathReplacement[] = []): TabState {
  let next: TabState = { ...tab, snapshot };
  if (!pathsEqual(tab.snapshot.location.path, snapshot.location.path)) {
    next.folderExpansion = undefined;
  } else if (tab.folderExpansion) {
    next.folderExpansion = pruneBranches(next);
    if (next.folderExpansion) {
      next.folderExpansion = Object.fromEntries(Object.entries(next.folderExpansion).map(([key, branch]) => [key, {
        ...branch, status: "idle", requestId: undefined, errorMessage: undefined,
        selectionReplacements: [...(branch.selectionReplacements ?? []), ...replacements]
      }]));
    }
  }
  return reconcileFolderSelection(tab, next, replacements);
}

export function reduceFolderExpansion(
  tab: TabState, action: FolderExpansionAction, enabled: boolean, visibility: FileVisibilityState, filterText: string
): TabState {
  if (!supportsFolderExpansion(tab, enabled)) return tab;
  if (action.type === "folderExpansionRefreshFailed") {
    if (tab.snapshot !== action.payload.rootSnapshot || !tab.folderExpansion) return tab;
    const folderExpansion = Object.fromEntries(tab.snapshot.entries
      .filter((entry) => entry.kind === "folder" && getFolderBranch(tab, entry.path))
      .map((entry) => [getPathComparisonKey(entry.path), {
        path: entry.path, entries: [], status: "error" as const, errorMessage: action.payload.errorMessage
      }]));
    return reconcileFolderSelection(tab, { ...tab, folderExpansion });
  }
  const { path } = action.payload;
  const key = getPathComparisonKey(path);
  const branch = getFolderBranch(tab, path);
  if (action.type === "folderExpansionToggled") {
    const entry = getTabEntries(tab).find((candidate) => pathsEqual(candidate.path, path) && candidate.kind === "folder");
    if (!entry || entry.driveInfo) return tab;
    if (!branch) return { ...tab, folderExpansion: { ...tab.folderExpansion, [key]: { path: entry.path, entries: [], status: "idle" } } };
    const folderExpansion = Object.fromEntries(Object.entries(tab.folderExpansion ?? {}).filter(([, value]) => !isSameOrDescendantPath(path, value.path)));
    const next = reconcileFolderSelection(tab, { ...tab, folderExpansion: Object.keys(folderExpansion).length ? folderExpansion : undefined });
    const focusedId = tab.selectionCursorId && tab.selectedEntryIds.includes(tab.selectionCursorId)
      ? tab.selectionCursorId : tab.selectedEntryIds[tab.selectedEntryIds.length - 1];
    if (focusedId && !next.selectedEntryIds.includes(focusedId) &&
      getFolderListingRows(tab, visibility, filterText).some((row) => row.entry.id === focusedId)) {
      return { ...next, selectedEntryIds: [...next.selectedEntryIds.filter((id) => id !== entry.id), entry.id] };
    }
    return next;
  }
  if (!branch) return tab;
  if (action.type === "folderExpansionRetryRequested") {
    if (branch.status !== "error") return tab;
    return { ...tab, folderExpansion: { ...tab.folderExpansion, [key]: { ...branch, status: "idle", requestId: undefined, errorMessage: undefined } } };
  }
  if (tab.snapshot !== action.payload.rootSnapshot) return tab;
  if (action.type === "folderExpansionLoadStarted") {
    if (action.payload.expectedBranch && branch !== action.payload.expectedBranch) return tab;
    return { ...tab, folderExpansion: { ...tab.folderExpansion, [key]: {
      ...branch, status: "loading", requestId: action.payload.requestId, errorMessage: undefined
    } } };
  }
  if (branch.status !== "loading" || branch.requestId !== action.payload.requestId) return tab;
  if (action.type === "folderExpansionLoadSucceeded" && !pathsEqual(action.payload.snapshot.location.path, path)) return tab;
  const updatedBranch: FolderExpansionBranch = action.type === "folderExpansionLoadFailed"
    ? { path: branch.path, entries: [], status: "error", errorMessage: action.payload.errorMessage }
    : { path: branch.path, status: "ready", entries: action.payload.snapshot.entries.filter((entry) =>
        pathsEqual(entry.parentPath, path) && !pathsEqual(entry.path, path) && isSameOrDescendantPath(path, entry.path)) };
  let next: TabState = { ...tab, folderExpansion: { ...tab.folderExpansion, [key]: updatedBranch } };
  next = { ...next, folderExpansion: pruneBranches(next) };
  return reconcileFolderSelection(tab, next, branch.selectionReplacements);
}

import { getTabEntries, supportsFolderExpansion } from "./folderExpansion";
import { getPathComparisonKey, isRemotePath, isSameOrDescendantPath, pathsEqual } from "./workspacePathRelations";
import type { TabState, WorkspaceState } from "./types";
import type { WorkspaceAction } from "./workspaceReducer";

/** Consume only real listing entries; missing descendants are selected after lazy loading. */
export function restorePendingFolderSelection(tab: TabState): TabState {
  const pending = tab.selectionRestore;
  if (!pending) return tab;
  if (!pathsEqual(pending.rootPath, tab.snapshot.location.path)) return { ...tab, selectionRestore: undefined };
  const entries = getTabEntries(tab);
  const byPath = new Map(entries.map(entry => [getPathComparisonKey(entry.path), entry]));
  const selectedEntryIds: string[] = [], missing: string[] = [];
  for (const path of pending.paths) {
    const entry = byPath.get(getPathComparisonKey(path));
    if (entry) selectedEntryIds.push(entry.id); else missing.push(path);
  }
  let folderExpansion = tab.folderExpansion;
  if (missing.length && supportsFolderExpansion(tab)) {
    const rootKey = getPathComparisonKey(pending.rootPath), separator = isRemotePath(rootKey) ? "/" : "\\";
    for (const path of missing) {
      const key = getPathComparisonKey(path);
      if (!isSameOrDescendantPath(rootKey, key)) continue;
      for (let index = key.lastIndexOf(separator); index > rootKey.length; index = key.lastIndexOf(separator, index - 1)) {
        const parentKey = key.slice(0, index), parent = byPath.get(parentKey);
        if (parent?.kind === "folder" && !folderExpansion?.[parentKey]) {
          folderExpansion = { ...folderExpansion, [parentKey]: { path: parent.path, entries: [], status: "idle" } };
        }
      }
    }
  }
  return { ...tab, selectedEntryIds: [...new Set(selectedEntryIds)], selectionAnchorId: selectedEntryIds[0] ?? null,
    selectionCursorId: null, folderExpansion, selectionRestore: missing.length ? pending : undefined };
}

/** Explicit user interaction supersedes an earlier operation's deferred selection. */
export function prepareSelectionInteraction(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "entrySelectionChanged": case "entrySelectionSet": case "entryRangeSelected": case "allEntriesSelected":
    case "entrySelectionCleared": case "entryFocusMoved": case "entryRangeExtended": case "folderExpansionToggled":
    case "tabViewModeSet": case "tabSnapshotCommitted": {
      const { panelId, tabId } = action.payload;
      const panel = state.panels[panelId], tab = panel.tabs.find(tab => tab.id === tabId);
      if (!tab || (action.type === "tabSnapshotCommitted" && pathsEqual(tab.snapshot.location.path, action.payload.snapshot.location.path))) return state;
      return { ...state, panels: { ...state.panels, [panelId]: { ...panel, tabs: panel.tabs.map(current => current === tab
        ? { ...tab, selectionRestore: undefined, selectionRevision: (tab.selectionRevision ?? 0) + 1 } : current) } } };
    }
    default: return state;
  }
}

import type { RenameTarget } from "./batchRenameState";
import type { PanelId, WorkspaceState } from "./types";
import { getTabEntries, getTabSelectedEntries } from "./folderExpansion";
import { getPathComparisonKey } from "./workspacePathRelations";
import { resolveTabQuickFilter } from "./quickFilterState";

export function captureRenameTarget(state: WorkspaceState, panelId: PanelId,
  source: RenameTarget["source"] = "toolbar", tabId?: string, paths?: string[]): RenameTarget | undefined {
  const panel = state.panels[panelId];
  const tab = panel.tabs.find(tab => tab.id === (tabId ?? panel.activeTabId));
  if (tab?.kind !== "directory") return undefined;
  const all = getTabEntries(tab);
  const byPath = paths ? new Map(all.map(entry => [getPathComparisonKey(entry.path), entry])) : undefined;
  const entries = paths ? paths.map(path => byPath!.get(getPathComparisonKey(path)))
    : getTabSelectedEntries(tab, state.fileVisibility, resolveTabQuickFilter(state, panelId, tab.id),
      state.settings.model.folderExpansionEnabled === true, state.settings.model.sizeBarMode);
  if (entries.length === 0 || entries.some(entry => !entry)) return undefined;
  return { panelId, tabId: tab.id, rootPath: tab.snapshot.location.path, selectionRevision: tab.selectionRevision ?? 0, source, entries: entries.map(entry => {
    const { id, name, path, parentPath, kind } = entry!;
    return { id, name, path, parentPath, kind };
  }) };
}

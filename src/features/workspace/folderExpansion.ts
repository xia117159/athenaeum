import { sortEntries } from "./fileListingSort";
import { projectEntrySize } from "./directorySizes";
import { getPathComparisonKey } from "./workspacePathRelations";
import { DEFAULT_FILE_VISIBILITY, entryMatchesFileVisibility } from "./workspaceVisibility";
import type { EntryViewModel, FileVisibilityState, FolderExpansionBranch, SizeBarMode, TabState } from "./types";

export type FolderListingRow = { entry: EntryViewModel; depth: number; expansion?: FolderExpansionBranch };

export function supportsFolderExpansion(tab: TabState, enabled = true) {
  return enabled && tab.kind === "directory" && tab.viewMode === "details" && tab.snapshot.location.kind !== "virtual";
}

export function getFolderBranch(tab: TabState, path: string) {
  return tab.folderExpansion?.[getPathComparisonKey(path)];
}

export function entryMatchesQuickFilter(entry: EntryViewModel, text: string) {
  return !text || [entry.name, entry.path, entry.extension, entry.description, entry.tags.join(" ")]
    .join(" ").toLowerCase().includes(text);
}

/** Raw reachable entries for state reconciliation; collapsed branches are never included. */
export function getTabEntries(tab: TabState): EntryViewModel[] {
  if (!supportsFolderExpansion(tab) || !tab.folderExpansion) return tab.snapshot.entries;
  const result: EntryViewModel[] = [];
  const seen = new Set<string>();
  const visit = (entries: EntryViewModel[]) => {
    for (const entry of entries) {
      const key = getPathComparisonKey(entry.path);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(entry);
      if (entry.kind === "folder") visit(tab.folderExpansion?.[key]?.entries ?? []);
    }
  };
  visit(tab.snapshot.entries);
  return result;
}

export function getFolderListingRows(
  tab: TabState,
  visibility: FileVisibilityState = DEFAULT_FILE_VISIBILITY,
  filterText = "",
  enabled = true,
  sizeBarMode: SizeBarMode = "folder-total"
): FolderListingRow[] {
  if (tab.kind === "navigation") return [];
  const treeEnabled = supportsFolderExpansion(tab, enabled);
  const filter = filterText.trim().toLowerCase();
  const seen = new Set<string>();
  const visit = (entries: EntryViewModel[], depth: number): FolderListingRow[] => {
    const rows: FolderListingRow[] = [];
    for (const entry of sortEntries(entries.map((item) => projectEntrySize(tab, item, sizeBarMode)), tab.sort, tab.snapshot.location.path)) {
      const key = getPathComparisonKey(entry.path);
      if ((treeEnabled && seen.has(key)) || !entryMatchesFileVisibility(entry, visibility)) continue;
      seen.add(key);
      const expansion = treeEnabled && entry.kind === "folder" ? tab.folderExpansion?.[key] : undefined;
      const children = expansion ? visit(expansion.entries, depth + 1) : [];
      if (entryMatchesQuickFilter(entry, filter) || children.length > 0) {
        rows.push({ entry, depth, expansion }, ...children);
      }
    }
    return rows;
  };
  return visit(tab.snapshot.entries, 0);
}

export function getExpandedFolderPaths(tab: TabState) {
  if (!supportsFolderExpansion(tab) || !tab.folderExpansion) return [];
  return getTabEntries(tab).filter((entry) => entry.kind === "folder" && getFolderBranch(tab, entry.path)).map((entry) => entry.path);
}

/** File commands and the properties target must agree about visible selection and order. */
export function getTabSelectedEntries(tab: TabState, visibility: FileVisibilityState, filterText: string, enabled: boolean) {
  const entries = supportsFolderExpansion(tab, enabled)
    ? getFolderListingRows(tab, visibility, filterText).map((row) => row.entry)
    : tab.snapshot.entries;
  const selectedIds = new Set(tab.selectedEntryIds);
  return entries.filter((entry) => selectedIds.has(entry.id));
}

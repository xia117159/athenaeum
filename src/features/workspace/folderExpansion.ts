import { sortEntries } from "./fileListingSort";
import { createEntrySizeProjector } from "./directorySizes";
import { getPathComparisonKey } from "./workspacePathRelations";
import { DEFAULT_FILE_VISIBILITY, entryMatchesFileVisibility } from "./workspaceVisibility";
import type { QuickFilterProgram } from "./quickFilterTypes";
import type { EntryViewModel, FileVisibilityState, FolderExpansionBranch, SizeBarMode, TabState } from "./types";

export type FolderListingRow = { entry: EntryViewModel; depth: number; expansion?: FolderExpansionBranch };

type ProjectionCache = {
  snapshot: TabState["snapshot"];
  entries: EntryViewModel[];
  entryCount: number;
  sort: TabState["sort"];
  sortColumn: TabState["sort"]["columnId"];
  sortDirection: TabState["sort"]["direction"];
  folderExpansion: TabState["folderExpansion"];
  expansionEntryCount: number;
  expansionSignature: string;
  inlineEdit: TabState["inlineEdit"];
  directorySizes: TabState["directorySizes"];
  directorySizePresentation: TabState["directorySizePresentation"];
  columns: TabState["columns"];
  kind: TabState["kind"];
  viewMode: TabState["viewMode"];
  status: TabState["status"];
  visibility: FileVisibilityState;
  quickFilter: QuickFilterProgram | null;
  enabled: boolean;
  sizeBarMode: SizeBarMode;
  rows: FolderListingRow[];
};

// Selection changes clone TabState but keep the snapshot; retain a small set of
// projections per snapshot for tabs with different view settings.
const projectionCache = new WeakMap<TabState["snapshot"], ProjectionCache[]>();
const projectedEntriesCache = new WeakMap<FolderListingRow[], {
  entries: EntryViewModel[];
  indexesById: Map<string, number[]>;
}>();

function getProjectedEntriesCache(rows: FolderListingRow[]) {
  const cached = projectedEntriesCache.get(rows);
  if (cached) return cached;
  const entries: EntryViewModel[] = [];
  const indexesById = new Map<string, number[]>();
  for (const row of rows) {
    const index = entries.length;
    entries.push(row.entry);
    const indexes = indexesById.get(row.entry.id);
    if (indexes) indexes.push(index);
    else indexesById.set(row.entry.id, [index]);
  }
  const projection = { entries, indexesById };
  projectedEntriesCache.set(rows, projection);
  return projection;
}

export function getFolderListingEntries(rows: FolderListingRow[]): EntryViewModel[] {
  return getProjectedEntriesCache(rows).entries;
}

export function getSelectedEntriesFromRows(rows: FolderListingRow[], selectedEntryIds: string[]): EntryViewModel[] {
  if (selectedEntryIds.length === 0) return [];
  const { entries, indexesById } = getProjectedEntriesCache(rows);
  const selectedIds = new Set(selectedEntryIds);
  if (selectedIds.size > entries.length / 4) return entries.filter((entry) => selectedIds.has(entry.id));
  const indexes: number[] = [];
  for (const id of selectedIds) indexes.push(...(indexesById.get(id) ?? []));
  indexes.sort((left, right) => left - right);
  return indexes.map((index) => entries[index]);
}

export function supportsFolderExpansion(tab: TabState, enabled = true) {
  return enabled && tab.kind === "directory" && tab.viewMode === "details" && tab.snapshot.location.kind !== "virtual";
}

export function getFolderBranch(tab: TabState, path: string) {
  return tab.folderExpansion?.[getPathComparisonKey(path)];
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

/** Rows are shared while all projection inputs retain their immutable references. */
export function getFolderListingRows(
  tab: TabState,
  visibility: FileVisibilityState = DEFAULT_FILE_VISIBILITY,
  quickFilter: QuickFilterProgram | null = null,
  enabled = true,
  sizeBarMode: SizeBarMode = "folder-total"
): FolderListingRow[] {
  if (tab.kind === "navigation") return [];
  const candidates = projectionCache.get(tab.snapshot) ?? [];
  const expansionEntryCount = Object.values(tab.folderExpansion ?? {}).reduce((sum, branch) => sum + branch.entries.length, 0);
  const expansionSignature = Object.entries(tab.folderExpansion ?? {})
    .map(([key, branch]) => `${key}:${branch.status}:${branch.entries.length}:${branch.errorMessage ?? ""}`)
    .join("|");
  const cached = candidates.find((candidate) => candidate.snapshot === tab.snapshot && candidate.entries === tab.snapshot.entries && candidate.entryCount === tab.snapshot.entries.length &&
    candidate.sort === tab.sort && candidate.sortColumn === tab.sort.columnId && candidate.sortDirection === tab.sort.direction &&
    candidate.folderExpansion === tab.folderExpansion && candidate.expansionEntryCount === expansionEntryCount && candidate.expansionSignature === expansionSignature && candidate.inlineEdit === tab.inlineEdit &&
    candidate.directorySizes === tab.directorySizes && candidate.directorySizePresentation === tab.directorySizePresentation &&
    candidate.columns === tab.columns && candidate.kind === tab.kind && candidate.viewMode === tab.viewMode &&
    candidate.status === tab.status && candidate.visibility === visibility &&
    candidate.quickFilter === quickFilter && candidate.enabled === enabled && candidate.sizeBarMode === sizeBarMode);
  if (cached) {
    return cached.rows;
  }
  const treeEnabled = supportsFolderExpansion(tab, enabled);
  const seen = new Set<string>();
  const projectSize = createEntrySizeProjector(tab, sizeBarMode);
  const visit = (entries: EntryViewModel[], depth: number): FolderListingRow[] => {
    const rows: FolderListingRow[] = [];
    for (const entry of sortEntries(entries.map(projectSize), tab.sort, tab.snapshot.location.path)) {
      const key = treeEnabled ? getPathComparisonKey(entry.path) : "";
      const editing = tab.inlineEdit?.mode === "rename" && tab.inlineEdit.entryId === entry.id;
      if ((treeEnabled && seen.has(key)) || (!editing && !entryMatchesFileVisibility(entry, visibility))) continue;
      if (treeEnabled) seen.add(key);
      // 匹配源只有 entry.name（D6/B1）。路径片段不再产生命中，这正是「输入 TEST 不该命中
      // …\A-TEST\123456.txt」的修复点：匹配的是名称，而不是完整路径。
      const pending = quickFilter?.isPending?.(entry.name) === true;
      const matched = quickFilter && !pending ? quickFilter.test(entry.name) : false;
      // 排除过滤命中项时，整棵子树都必须消失（D17），因此要在递归之前就跳过。
      if (quickFilter?.mode === "exclude" && (matched || pending) && !editing) continue;
      const expansion = treeEnabled && entry.kind === "folder" ? tab.folderExpansion?.[key] : undefined;
      const children = expansion ? visit(expansion.entries, depth + 1) : [];
      // 高亮模式不改变行集（D7，着色由渲染层负责）；保留过滤额外保留命中行的祖先链；
      // 排除过滤只删命中行（命中行已在上方跳过）。
      const keep = editing || !quickFilter || quickFilter.mode !== "include" || matched || children.length > 0;
      if (keep) {
        rows.push({ entry, depth, expansion }, ...children);
      }
    }
    return rows;
  };
  const rows = visit(tab.snapshot.entries, 0);
  candidates.push({
    snapshot: tab.snapshot,
    entries: tab.snapshot.entries,
    entryCount: tab.snapshot.entries.length,
    sort: tab.sort,
    sortColumn: tab.sort.columnId,
    sortDirection: tab.sort.direction,
    folderExpansion: tab.folderExpansion,
    expansionEntryCount,
    expansionSignature,
    inlineEdit: tab.inlineEdit,
    directorySizes: tab.directorySizes,
    directorySizePresentation: tab.directorySizePresentation,
    columns: tab.columns,
    kind: tab.kind,
    viewMode: tab.viewMode,
    status: tab.status,
    visibility,
    quickFilter,
    enabled,
    sizeBarMode,
    rows
  });
  if (candidates.length > 4) candidates.shift();
  projectionCache.set(tab.snapshot, candidates);
  return rows;
}

export function getExpandedFolderPaths(tab: TabState) {
  if (!supportsFolderExpansion(tab) || !tab.folderExpansion) return [];
  return getTabEntries(tab).filter((entry) => entry.kind === "folder" && getFolderBranch(tab, entry.path)).map((entry) => entry.path);
}

/** File commands and the properties target must agree about visible selection and order. */
export function getTabSelectedEntries(
  tab: TabState,
  visibility: FileVisibilityState,
  quickFilter: QuickFilterProgram | null,
  enabled: boolean,
  sizeBarMode: SizeBarMode = "folder-total"
) {
  if (tab.kind === "navigation" || tab.selectedEntryIds.length === 0) return [];
  return getSelectedEntriesFromRows(getFolderListingRows(tab, visibility, quickFilter, enabled, sizeBarMode), tab.selectedEntryIds);
}

import { sortEntries } from "./fileListingSort";
import { createEntrySizeProjector } from "./directorySizes";
import { getPathComparisonKey } from "./workspacePathRelations";
import { DEFAULT_FILE_VISIBILITY, entryMatchesFileVisibility } from "./workspaceVisibility";
import type { QuickFilterProgram } from "./quickFilterTypes";
import type { EntryViewModel, FileVisibilityState, FolderExpansionBranch, SizeBarMode, TabState } from "./types";

export type FolderListingRow = { entry: EntryViewModel; depth: number; expansion?: FolderExpansionBranch };

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

export function getFolderListingRows(
  tab: TabState,
  visibility: FileVisibilityState = DEFAULT_FILE_VISIBILITY,
  quickFilter: QuickFilterProgram | null = null,
  enabled = true,
  sizeBarMode: SizeBarMode = "folder-total"
): FolderListingRow[] {
  if (tab.kind === "navigation") return [];
  const treeEnabled = supportsFolderExpansion(tab, enabled);
  const seen = new Set<string>();
  const projectSize = createEntrySizeProjector(tab, sizeBarMode);
  const visit = (entries: EntryViewModel[], depth: number): FolderListingRow[] => {
    const rows: FolderListingRow[] = [];
    for (const entry of sortEntries(entries.map(projectSize), tab.sort, tab.snapshot.location.path)) {
      const key = getPathComparisonKey(entry.path);
      const editing = tab.inlineEdit?.mode === "rename" && tab.inlineEdit.entryId === entry.id;
      if ((treeEnabled && seen.has(key)) || (!editing && !entryMatchesFileVisibility(entry, visibility))) continue;
      seen.add(key);
      // 匹配源只有 entry.name（D6/B1）。路径片段不再产生命中，这正是「输入 TEST 不该命中
      // …\A-TEST\123456.txt」的修复点：匹配的是名称，而不是完整路径。
      const matched = quickFilter ? quickFilter.test(entry.name) : false;
      // 排除过滤命中项时，整棵子树都必须消失（D17），因此要在递归之前就跳过。
      if (quickFilter?.mode === "exclude" && matched && !editing) continue;
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
  return visit(tab.snapshot.entries, 0);
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
  // B23：操作目标集恒等于可见行集。这里不再存在「文件夹展开未生效 ⇒ 退回未过滤 snapshot.entries」
  // 的分支，否则保留/排除过滤把行藏起来之后，Ctrl+A、删除、复制、批量重命名仍会作用到不可见的行。
  const entries = getFolderListingRows(tab, visibility, quickFilter, enabled, sizeBarMode).map((row) => row.entry);
  const selectedIds = new Set(tab.selectedEntryIds);
  return entries.filter((entry) => selectedIds.has(entry.id));
}

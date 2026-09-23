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

/**
 * 行投影（纯函数）。
 *
 * 评审 S-6 记录了"同一次投影在同一帧内被重复计算"的放大问题。这里**刻意不做全局记忆化**：
 * 投影结果直接决定操作目标集（B23：删除/复制/Ctrl+A 的作用范围），而投影读取的输入里
 * 有多处会被**就地修改**而不更换引用——`snapshot.entries.push(...)`（7 个测试文件如此，
 * 如 `directorySizeAlignment.test.ts:70`）、`tab.sort.direction = "desc"`
 * （`folderExpansion.test.ts:29`）、`parent.isHidden = true`（`folderExpansion.test.ts:37`），
 * 以及 `tab.folderExpansion[key].entries` 的内容。
 * 任何基于引用的缓存键都无法可靠察觉这些变更，一旦读到陈旧行集，
 * 用户就会对错的文件执行删除/复制。因此把"去重"放在**调用侧**（同一状态只投影一次），
 * 而不是在纯函数里放一个可能失效的缓存。
 */
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
  // B23：操作目标集恒等于可见行集子集。这里不再存在「文件夹展开未生效 ⇒ 退回未过滤
  // snapshot.entries」的分支，否则保留/排除过滤把行藏起来之后，Ctrl+A、删除、复制、
  // 批量重命名仍会作用到不可见的行。
  if (tab.kind === "navigation" || tab.selectedEntryIds.length === 0) return [];
  const selectedIds = new Set(tab.selectedEntryIds);

  // S-7 快路径：出厂默认（展开关闭）且无快速过滤时，"廉价情形必须廉价"。
  //
  // 缺陷背景：基线在这里有一条 `!supportsFolderExpansion ⇒ tab.snapshot.entries` 的廉价分支，
  // 它**违反 B23**（忽略可见性与过滤）因而被删除；但删除后即使不展开、无过滤，
  // 每次调用也要整趟排序并逐条投影大小（2 万条目实测 284×–356× 回归）。
  //
  // 本快路径**不**恢复那条违规分支：它逐条套用与 `getFolderListingRows` **完全相同**的
  // 判定（重命名中的行豁免可见性；`keep` 在 `quickFilter === null` 时恒真），只是把投影范围
  // 从"全部条目"缩小到"被选中的条目"。
  //
  // 为什么等价：
  // - 可见性是**逐条**谓词（`entryMatchesFileVisibility` 只读该条目自身），不含跨条目状态，
  //   因此"先选后判"与"先判后选"结果相同；
  // - `quickFilter === null` 时 `keep` 恒真，故行集就是全部通过可见性的条目；
  // - `sortEntries` 使用**逐对**比较器（不依赖数组其余元素），故"先排序再筛"与"先筛再排序"
  //   在选中项之间的相对顺序上完全一致；
  // - `!supportsFolderExpansion` ⇒ `treeEnabled` 为假 ⇒ 不启用 `seen` 去重、不递归展开分支，
  //   因此不存在"展开分支子条目"这一类需要保留的行。
  // 由 `folderExpansion.test.ts` 的等价性用例（与慢路径逐项对照）锁定。
  if (quickFilter === null && !supportsFolderExpansion(tab, enabled)) {
    const projectSize = createEntrySizeProjector(tab, sizeBarMode);
    const selected: EntryViewModel[] = [];
    for (const entry of tab.snapshot.entries) {
      if (!selectedIds.has(entry.id)) continue;
      const editing = tab.inlineEdit?.mode === "rename" && tab.inlineEdit.entryId === entry.id;
      if (!editing && !entryMatchesFileVisibility(entry, visibility)) continue;
      selected.push(projectSize(entry));
    }
    return sortEntries(selected, tab.sort, tab.snapshot.location.path);
  }

  const entries = getFolderListingRows(tab, visibility, quickFilter, enabled, sizeBarMode).map((row) => row.entry);
  return entries.filter((entry) => selectedIds.has(entry.id));
}

import type { DirectorySizeCache, DirectorySizeTabState, EntrySizeDisplay, RetainedEntrySize } from "./directorySizeTypes";
import type { EntryViewModel, SizeBarMode, TabState } from "./types";
import { getPathComparisonKey, pathsEqual } from "./workspacePathRelations";
import { currentListingSizeCache } from "./directorySizeCache";

/** 详情视图中可见的大小列；`supportsDirectorySizes` 在此基础上还要求列表已就绪。 */
function hasVisibleSizeColumn(tab: TabState) {
  return tab.kind === "directory" && tab.viewMode === "details" && tab.snapshot.location.kind !== "virtual" &&
    tab.columns.some((column) => column.id === "size" && column.visible);
}

export function supportsDirectorySizes(tab: TabState) {
  return tab.status === "ready" && hasVisibleSizeColumn(tab);
}

export function currentDirectorySizes(tab: TabState): DirectorySizeTabState | undefined {
  return tab.directorySizes && pathsEqual(tab.directorySizes.rootPath, tab.snapshot.location.path) ? tab.directorySizes : undefined;
}

export function decimalBytes(value: string | null | undefined): bigint | null {
  return value != null && /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n ? BigInt(value) : null;
}

export function formatDirectoryBytes(bytes: bigint): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB", "EB"];
  let unit = 0; let divisor = 1n;
  while (unit < units.length - 1 && bytes >= divisor * 1024n) { unit++; divisor *= 1024n; }
  const tenths = (bytes * 10n + divisor / 2n) / divisor;
  return `${tenths / 10n}${tenths % 10n ? `.${tenths % 10n}` : ""} ${units[unit]}`;
}

/** Never promote rounded labels or unsafe JS numbers to precise aggregate bytes. */
export function exactSizeBytes(entry: EntryViewModel): bigint | null {
  if (entry.kind === "folder" && !entry.driveInfo) {
    return entry.sizeDisplay && !entry.sizeDisplay.advisory && (entry.sizeDisplay.state === "complete" || entry.sizeDisplay.state === "partial" || entry.sizeDisplay.retained)
      ? decimalBytes(entry.sizeDisplay.bytes)
      : null;
  }
  return typeof entry.sizeBytes === "number" && Number.isSafeInteger(entry.sizeBytes) && entry.sizeBytes >= 0 ? BigInt(entry.sizeBytes) : null;
}

function recordMatchesEntry(entry: EntryViewModel, record: DirectorySizeTabState["records"][string] | undefined, local: boolean) {
  return !local || record?.createdAt == null || record.createdAt === entry.sizeCreatedAt;
}

function knownEntryBytes(entry: EntryViewModel, sizes: DirectorySizeTabState, local: boolean): bigint | null {
  if (entry.attributes.includes("L")) return null;
  if (entry.kind !== "folder" || entry.driveInfo) return exactSizeBytes(entry);
  const record = sizes.records[getPathComparisonKey(entry.path)];
  if (!record || !recordMatchesEntry(entry, record, local) || (record.state !== "complete" && record.state !== "partial")) return null;
  return decimalBytes(record.bytes);
}

export function ratioFromBigInt(numerator: bigint, denominator: bigint): number | null {
  if (denominator === 0n) return numerator === 0n ? 0 : null;
  if (numerator <= 0n) return 0;
  if (numerator >= denominator) return 1;
  const scale = 1_000_000n;
  return Number((numerator * scale) / denominator) / Number(scale);
}

export function listingSizeFingerprint(tab: TabState, path: string): string | null | undefined {
  if (pathsEqual(path, tab.snapshot.location.path)) return tab.snapshot.sizeFingerprint;
  const branch = tab.folderExpansion?.[getPathComparisonKey(path)];
  return branch?.status === "ready" ? branch.sizeFingerprint : undefined;
}

export function listingSizeIdentityIsReliable(tab: TabState, path: string): boolean {
  if (pathsEqual(path, tab.snapshot.location.path)) return tab.snapshot.sizeIdentityReliable !== false;
  return tab.folderExpansion?.[getPathComparisonKey(path)]?.sizeIdentityReliable !== false;
}

function branchDisplayCache(tab: TabState, branch: NonNullable<TabState["folderExpansion"]>[string], sizes: DirectorySizeTabState | undefined,
  branchRoot?: EntryViewModel) {
  const cache = branch.directorySizeCache;
  if (!cache) return undefined;
  const entries = new Map(branch.entries.filter((entry) => entry.kind === "folder" && !entry.attributes.includes("L"))
    .map((entry) => [getPathComparisonKey(entry.path), entry]));
  // The cache for an expanded listing also contains the listing root itself.
  // `branch.entries` starts below that root, so include the parent row when
  // validating a historical fallback; otherwise the root briefly loses its
  // scalar/bar during a live scan and can flicker back when the scan advances.
  if (branchRoot?.kind === "folder" && !branchRoot.attributes.includes("L") && pathsEqual(branchRoot.path, branch.path)) {
    entries.set(getPathComparisonKey(branchRoot.path), branchRoot);
  }
  const identityDirectories = cache.directories.filter((record) => record.cachedAt && record.createdAt &&
    entries.get(getPathComparisonKey(record.path))?.sizeCreatedAt === record.createdAt);
  if (cache.historical) return identityDirectories.length ? { ...cache, directories: identityDirectories } : undefined;
  const phase = sizes?.snapshot;
  const fence = sizes?.cacheFence;
  const live = sizes && pathsEqual(sizes.rootPath, tab.snapshot.location.path) && !sizes.paused && !sizes.forceRefresh &&
    phase && phase.artifactRevision === cache.artifactRevision &&
    cache.generation === phase.generation && cache.sequence <= phase.sequence &&
    ["queued", "complete", "partial"].includes(phase.phase) &&
    !(fence && (cache.generation < fence.generation || cache.generation === fence.generation && cache.sequence <= fence.sequence));
  if (live) return cache;
  const directories = cache.directories.filter((record) => record.cachedAt && record.createdAt &&
    entries.get(getPathComparisonKey(record.path))?.sizeCreatedAt === record.createdAt);
  return directories.length ? { ...cache, historical: true, directories } : undefined;
}

/** One denominator per listing projection, shared by roots and expanded rows. */
export function createCurrentSizeProjector(tab: TabState, mode: SizeBarMode = "folder-total") {
  const sizes = currentDirectorySizes(tab);
  const snapshot = sizes?.snapshot;
  const root = tab.snapshot.location.path;
  const local = tab.snapshot.location.kind === "local";
  const supported = supportsDirectorySizes(tab);
  const rootReliable = listingSizeIdentityIsReliable(tab, root);
  const parents = new Map<string, {
    reliable: boolean;
    fingerprint: string | null | undefined;
    record: DirectorySizeTabState["records"][string] | undefined;
  }>();
  const parentInfo = (path: string) => {
    const cached = parents.get(path);
    if (cached) return cached;
    const value = {
      reliable: path === root ? rootReliable : listingSizeIdentityIsReliable(tab, path),
      fingerprint: path === root ? tab.snapshot.sizeFingerprint : listingSizeFingerprint(tab, path),
      record: sizes?.records[getPathComparisonKey(path)]
    };
    parents.set(path, value);
    return value;
  };
  const rootRecord = sizes?.records[getPathComparisonKey(root)];
  const rootAligned = !tab.snapshot.sizeFingerprint || !rootRecord?.sizeFingerprint || tab.snapshot.sizeFingerprint === rootRecord.sizeFingerprint;
  const terminal = supported && !!sizes && !!snapshot && !sizes.paused && !sizes.pending && (snapshot.phase === "complete" || snapshot.phase === "partial");
  const denominatorReady = terminal && !!rootRecord && rootAligned && listingSizeIdentityIsReliable(tab, root);
  let denominator: bigint | null = null;
  if (denominatorReady) {
    denominator = 0n;
    for (const sibling of tab.snapshot.entries) {
      const bytes = knownEntryBytes(sibling, sizes, local);
      if (bytes !== null) denominator = mode === "folder-max" ? (bytes > denominator ? bytes : denominator) : denominator + bytes;
    }
  }
  const knownEntries = sizes ? tab.snapshot.entries.filter((entry) => entry.attributes.includes("L") ||
    knownEntryBytes(entry, sizes, local) !== null).length : 0;
  const denominatorAdvisory = denominatorReady && (knownEntries < tab.snapshot.entries.length || denominator === 0n);
  return (entry: EntryViewModel): EntrySizeDisplay => {
    const base: EntrySizeDisplay = {
      state: "unknown", bytes: null, share: null,
      label: entry.kind === "folder" ? "--" : entry.sizeLabel,
      title: "尚未计算目录大小"
    };
    const parent = parentInfo(entry.parentPath);
    if (!rootReliable || !parent.reliable) return { ...base, title: "列表路径无法可靠区分条目，目录大小不可用" };
    if (entry.attributes.includes("L")) return { ...base, state: "excluded", title: "链接不参与递归大小统计" };
    if (!supported || !sizes || !snapshot || sizes.paused || sizes.pending) return base;
    if (snapshot.phase !== "complete" && snapshot.phase !== "partial") {
      return { ...base, state: snapshot.phase === "stale" ? "stale" : "unknown", title: snapshot.reason ?? "目录大小尚未就绪" };
    }

    const fingerprint = parent.fingerprint;
    const parentRecord = parent.record;
    if (!parentRecord) return base;
    if (fingerprint && parentRecord.sizeFingerprint && fingerprint !== parentRecord.sizeFingerprint) {
      return { ...base, state: "stale", title: "列表与大小统计已过期" };
    }

    const record = entry.kind === "folder" ? sizes.records[getPathComparisonKey(entry.path)] : undefined;
    if (entry.kind === "folder" && !recordMatchesEntry(entry, record, local)) return base;
    const bytes = entry.kind === "folder" ? decimalBytes(record?.bytes) : exactSizeBytes(entry);
    if (bytes === null || (entry.kind === "folder" && record?.state === "unknown")) return base;

    const share = denominator === null ? null : denominator === 0n && bytes > 0n ? 1 : ratioFromBigInt(bytes, denominator);
    const partial = entry.kind === "folder" && record?.state === "partial";
    const suffix = snapshot.freshness === "snapshot" ? "（时间点快照）" : "";
    return {
      state: partial ? "partial" : "complete",
      bytes: String(bytes),
      share,
      provisional: denominatorAdvisory,
      label: partial ? `≥${formatDirectoryBytes(bytes)}` : entry.kind === "folder" ? formatDirectoryBytes(bytes) : entry.sizeLabel,
      title: `${bytes} 字节${share === null ? "，分母不完整" : denominatorAdvisory ? `，占已知大小 ${(share * 100).toFixed(2)}%` : `，占当前文件夹 ${(share * 100).toFixed(2)}%`}${partial ? "（统计不完整，下限）" : ""}${suffix}`
    };
  };
}

export function retainedSizeMatches(row: RetainedEntrySize, entry: EntryViewModel, requireIdentity = false) {
  return (!requireIdentity || typeof row.createdAt === "string" && row.createdAt.length > 0) && row.path === entry.path && row.kind === entry.kind &&
    row.createdAt === entry.sizeCreatedAt && !entry.attributes.includes("L");
}

export function createEntrySizeProjector(tab: TabState, mode: SizeBarMode = "folder-total") {
  if (!hasVisibleSizeColumn(tab)) return (entry: EntryViewModel): EntryViewModel =>
    entry.sizeDisplay ? { ...entry, sizeDisplay: undefined } : entry;
  const project = createCurrentSizeProjector(tab, mode);
  const view = tab.directorySizePresentation?.current;
  const root = tab.snapshot.location.path;
  const rows = view?.rootPath === root && view.locationKind === tab.snapshot.location.kind ? view.rows : undefined;
  const cache = currentListingSizeCache(tab.snapshot, currentDirectorySizes(tab));
  type SizeHint = NonNullable<typeof cache>["directories"][number] & { historical?: boolean };
  const hints = new Map<string, SizeHint>();
  const addHints = (source: DirectorySizeCache | undefined) => {
    for (const record of source?.directories ?? []) {
      hints.set(getPathComparisonKey(record.path), source?.historical ? { ...record, historical: true } : record);
    }
  };
  addHints(cache);
  const sizes = currentDirectorySizes(tab);
  const sizesSupported = supportsDirectorySizes(tab);
  const rootReliable = listingSizeIdentityIsReliable(tab, root);
  const parentReliability = new Map<string, boolean>();
  const reliableParent = (path: string) => {
    if (path === root) return rootReliable;
    const cached = parentReliability.get(path);
    if (cached !== undefined) return cached;
    const reliable = listingSizeIdentityIsReliable(tab, path);
    parentReliability.set(path, reliable);
    return reliable;
  };
  const parentHintPresence = new Map<string, boolean>();
  const hasParentHint = (path: string) => {
    if (hints.size === 0) return false;
    const cached = parentHintPresence.get(path);
    if (cached !== undefined) return cached;
    const present = hints.has(getPathComparisonKey(path));
    parentHintPresence.set(path, present);
    return present;
  };
  const branchRoots = new Map<string, EntryViewModel>([
    ...tab.snapshot.entries,
    ...Object.values(tab.folderExpansion ?? {}).flatMap((branch) => branch.entries)
  ].filter((entry) => entry.kind === "folder" && !entry.attributes.includes("L"))
    .map((entry) => [getPathComparisonKey(entry.path), entry]));
  for (const branch of Object.values(tab.folderExpansion ?? {})) {
    addHints(branchDisplayCache(tab, branch, sizes, branchRoots.get(getPathComparisonKey(branch.path))));
  }
  const displayCache = new WeakMap<EntryViewModel, EntrySizeDisplay>();
  const computeRawDisplay = (entry: EntryViewModel): EntrySizeDisplay => {
    const current = project(entry);
    let display = current;
    const hint = entry.kind === "folder" ? hints.get(getPathComparisonKey(entry.path)) : undefined;
    const hintBytes = decimalBytes(hint?.bytes);
    if (display.bytes === null && hintBytes !== null && hint?.state !== "unknown" && entry.kind === "folder" &&
      !entry.attributes.includes("L") && sizesSupported && rootReliable) {
      const phase = sizes?.snapshot;
      const status = sizes?.paused || phase?.phase === "cancelled" ? "已取消刷新"
        : phase?.phase === "failed" ? `刷新失败：${phase.reason ?? "未知错误"}`
        : phase?.phase === "complete" || phase?.phase === "partial" ? "统计已结束，此项暂无新结果"
        : "后台刷新中";
      const captured = hint?.cachedAt ? new Date(hint.cachedAt).toLocaleString() : "未知时间";
      display = { state: "stale", bytes: String(hintBytes), share: null, advisory: true,
        label: `${hint?.state === "partial" ? "≥" : ""}${formatDirectoryBytes(hintBytes)}`,
        title: hint?.historical ? `上次结果（${captured}，${status}）；${hintBytes} 字节` : `上次结果（等待目录身份校验）；${hintBytes} 字节` };
    }
    const old = rows?.[entry.path];
    if (old && (old.total.share !== null ? display.share === null || display.provisional === true && !old.total.advisory : current.bytes === null) && retainedSizeMatches(old, entry) &&
      rootReliable && reliableParent(entry.parentPath)) {
      const saved = mode === "folder-max" ? old.max : old.total;
      const phase = sizes?.snapshot;
      const reason = phase?.phase === "failed" ? `刷新失败：${phase.reason ?? "未知错误"}`
        : phase?.phase === "cancelled" ? "已取消刷新" : "等待刷新结果";
      display = { ...saved, state: "stale", retained: true,
        label: entry.kind === "folder" ? saved.label : entry.sizeLabel,
        title: `上次结果（${reason}）；${saved.title}` };
    }
    const livePhase = sizes?.snapshot?.phase;
    const allowFileFallback = livePhase == null || !["complete", "partial"].includes(livePhase);
    const branchCacheProvidesParent = hasParentHint(entry.parentPath);
    if ((allowFileFallback || branchCacheProvidesParent) && display.bytes === null && entry.kind !== "folder" && !entry.attributes.includes("L") &&
      rootReliable && reliableParent(entry.parentPath)) {
      const bytes = exactSizeBytes(entry);
      if (bytes !== null) display = { state: "stale", bytes: String(bytes), share: null, provisional: true, label: entry.sizeLabel,
        title: branchCacheProvidesParent ? `${bytes} 字节（展开目录缓存已提供父级范围）` : `${bytes} 字节` };
    }
    return display;
  };
  const rawDisplay = (entry: EntryViewModel): EntrySizeDisplay => {
    const cached = displayCache.get(entry);
    if (cached) return cached;
    const display = computeRawDisplay(entry);
    displayCache.set(entry, display);
    return display;
  };
  let denominator = 0n;
  let known = 0;
  const canUseAdvisory = !sizes;
  for (const sibling of tab.snapshot.entries) {
    if (sibling.attributes.includes("L")) continue;
    const display = rawDisplay(sibling);
    const bytes = decimalBytes(display.bytes) ?? (sibling.kind !== "folder" ? exactSizeBytes(sibling) : null);
    if (bytes === null) continue;
    known++;
    denominator = mode === "folder-max" ? (bytes > denominator ? bytes : denominator) : denominator + bytes;
  }
  const incomplete = known < tab.snapshot.entries.filter((entry) => !entry.attributes.includes("L")).length;
  return (entry: EntryViewModel): EntryViewModel => {
    let display = rawDisplay(entry);
    if ((canUseAdvisory || display.advisory || display.provisional) && display.bytes !== null && display.share === null) {
      const bytes = decimalBytes(display.bytes);
      if (bytes !== null) {
        const share = denominator === 0n && bytes > 0n ? 1 : ratioFromBigInt(bytes, denominator);
        if (share !== null) display = { ...display, share, provisional: display.provisional || incomplete,
          title: `${display.title}；${denominator === 0n && bytes > 0n ? "暂无其他已知大小，占已知大小 100%" : `占已知大小 ${(share * 100).toFixed(2)}%`}${incomplete ? "（列表尚未全部完成）" : ""}` };
      }
    }
    return { ...entry, sizeLabel: display.label, sizeDisplay: display };
  };
}

export function projectEntrySize(tab: TabState, entry: EntryViewModel, mode: SizeBarMode = "folder-total"): EntryViewModel {
  return createEntrySizeProjector(tab, mode)(entry);
}

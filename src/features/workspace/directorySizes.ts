import type { DirectorySizeTabState, EntrySizeDisplay } from "./directorySizeTypes";
import type { EntryViewModel, SizeBarMode, TabState } from "./types";
import { getPathComparisonKey, pathsEqual } from "./workspacePathRelations";

export function supportsDirectorySizes(tab: TabState) {
  return tab.kind === "directory" && tab.status === "ready" && tab.viewMode === "details" &&
    tab.snapshot.location.kind !== "virtual" && tab.columns.some((column) => column.id === "size" && column.visible);
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
    return entry.sizeDisplay && (entry.sizeDisplay.state === "complete" || entry.sizeDisplay.state === "partial")
      ? decimalBytes(entry.sizeDisplay.bytes)
      : null;
  }
  return typeof entry.sizeBytes === "number" && Number.isSafeInteger(entry.sizeBytes) && entry.sizeBytes >= 0 ? BigInt(entry.sizeBytes) : null;
}

function knownEntryBytes(entry: EntryViewModel, sizes: DirectorySizeTabState): bigint | null {
  if (entry.attributes.includes("L")) return null;
  if (entry.kind !== "folder" || entry.driveInfo) return exactSizeBytes(entry);
  const record = sizes.records[getPathComparisonKey(entry.path)];
  if (!record || (record.state !== "complete" && record.state !== "partial")) return null;
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

function sizeDisplay(tab: TabState, entry: EntryViewModel, mode: SizeBarMode): EntrySizeDisplay {
  const sizes = currentDirectorySizes(tab);
  const snapshot = sizes?.snapshot;
  const base: EntrySizeDisplay = {
    state: "unknown", bytes: null, share: null,
    label: entry.kind === "folder" ? "--" : entry.sizeLabel,
    title: "尚未计算目录大小"
  };
  if (!listingSizeIdentityIsReliable(tab, entry.parentPath)) return { ...base, title: "列表路径无法可靠区分条目，目录大小不可用" };
  if (entry.attributes.includes("L")) return { ...base, state: "excluded", title: "链接不参与递归大小统计" };
  if (!sizes || !snapshot || sizes.paused || sizes.pending) return base;
  if (snapshot.phase !== "complete" && snapshot.phase !== "partial") {
    return { ...base, state: snapshot.phase === "stale" ? "stale" : "unknown", title: snapshot.reason ?? "目录大小尚未就绪" };
  }

  const fingerprint = listingSizeFingerprint(tab, entry.parentPath);
  const parentRecord = sizes.records[getPathComparisonKey(entry.parentPath)];
  if (fingerprint && parentRecord?.sizeFingerprint && fingerprint !== parentRecord.sizeFingerprint) {
    return { ...base, state: "stale", title: "列表与大小统计已过期" };
  }

  const record = sizes.records[getPathComparisonKey(entry.path)];
  const bytes = entry.kind === "folder" ? decimalBytes(record?.bytes) : exactSizeBytes(entry);
  if (bytes === null || (entry.kind === "folder" && record?.state === "unknown")) return base;

  const rootEntries = tab.snapshot.entries;
  const knownSizes = rootEntries
    .map((sibling) => knownEntryBytes(sibling, sizes))
    .filter((value): value is bigint => value !== null);
  const denominator = mode === "folder-max"
    ? knownSizes.reduce((max, value) => value > max ? value : max, 0n)
    : knownSizes.reduce((sum, value) => sum + value, 0n);
  const share = ratioFromBigInt(bytes, denominator);
  const partial = entry.kind === "folder" && record?.state === "partial";
  const suffix = snapshot.freshness === "snapshot" ? "（时间点快照）" : "";
  return {
    state: partial ? "partial" : "complete",
    bytes: String(bytes),
    share,
    label: partial ? `≥${formatDirectoryBytes(bytes)}` : entry.kind === "folder" ? formatDirectoryBytes(bytes) : entry.sizeLabel,
    title: `${bytes} 字节${share === null ? "，分母不完整" : `，占当前文件夹 ${(share * 100).toFixed(2)}%`}${partial ? "（统计不完整，下限）" : ""}${suffix}`
  };
}

export function projectEntrySize(tab: TabState, entry: EntryViewModel, mode: SizeBarMode = "folder-total"): EntryViewModel {
  if (!supportsDirectorySizes(tab)) return entry.sizeDisplay ? { ...entry, sizeDisplay: undefined } : entry;
  const display = sizeDisplay(tab, entry, mode);
  return { ...entry, sizeLabel: display.label, sizeDisplay: display };
}

import type { DirectorySizeLookup, DirectorySizeSnapshot, DirectorySizeTabState } from "./directorySizeTypes";
import type { SizeAlignmentTarget } from "./directorySizeAlignmentRequest";
import type { DirectorySnapshot, FolderExpansionBranch, PanelId, TabState } from "./types";
import { currentDirectorySizes } from "./directorySizes";
import { alignFolderListing } from "./folderExpansionState";
import { getPathComparisonKey, isSameOrDescendantPath, pathsEqual } from "./workspacePathRelations";

type Target = { panelId: PanelId; tabId: string; rootPath: string };
export type DirectorySizeLeaseTarget = Target & { consumerId: string; requestVersion: number };
type LeaseTarget = DirectorySizeLeaseTarget;
export type DirectorySizeAction =
  | { type: "directorySizeRequested"; payload: Target & { intent: "calculate" | "cancel" | "refresh" } }
  | { type: "directorySizeLeaseStarted"; payload: LeaseTarget }
  | { type: "directorySizeReleased"; payload: LeaseTarget }
  | { type: "directorySizeSnapshotReceived"; payload: LeaseTarget & { snapshot: DirectorySizeSnapshot } }
  | { type: "directorySizeLookupReceived"; payload: LeaseTarget & { lookup: DirectorySizeLookup } }
  | { type: "directorySizeFailed"; payload: LeaseTarget & { message: string } }
  | { type: "directorySizeListingAlignmentFailed"; payload: SizeAlignmentTarget & { message: string } }
  | { type: "directorySizeListingAligned"; payload: LeaseTarget & { generation: number; snapshot: DirectorySnapshot; expectedRoot: DirectorySnapshot; expectedBranch?: FolderExpansionBranch } };

function initialSizes(rootPath: string): DirectorySizeTabState {
  return { rootPath, requestVersion: 0, requested: false, paused: false, manualStarted: false, pending: false, records: {} };
}

function unavailable(sizes: DirectorySizeTabState, phase: "cancelled" | "failed" | "stale", reason: string): DirectorySizeSnapshot {
  return { consumerId: sizes.consumerId ?? "", generation: 0, sequence: 0, knownBytes: "0", files: 0, directories: 0,
    skippedLinks: 0, skippedSpecial: 0, errors: 0, freshness: "snapshot", ...sizes.snapshot, phase, totalBytes: null, reason };
}

export function reduceDirectorySizes(tab: TabState, action: DirectorySizeAction): TabState {
  const payload = action.payload;
  if (tab.id !== payload.tabId || tab.kind !== "directory" || !pathsEqual(tab.snapshot.location.path, payload.rootPath)) return tab;
  const sizes = currentDirectorySizes(tab) ?? initialSizes(payload.rootPath);
  if (action.type === "directorySizeRequested") {
    const { intent } = action.payload;
    if (intent === "refresh" && tab.snapshot.location.kind !== "local" && !sizes.manualStarted) return tab;
    const cancel = intent === "cancel";
    const forceRefresh = !cancel && (intent === "refresh" || tab.snapshot.location.kind === "local" || sizes.manualStarted || sizes.paused);
    return { ...tab, directorySizes: { ...sizes, requestVersion: sizes.requestVersion + 1, requested: !cancel,
      paused: cancel, pending: !cancel, forceRefresh, consumerId: undefined, records: {},
      manualStarted: sizes.manualStarted || (!cancel && tab.snapshot.location.kind !== "local"),
      snapshot: cancel ? unavailable(sizes, "cancelled", "已取消大小计算") : undefined } };
  }
  if (sizes.requestVersion !== action.payload.requestVersion) return tab;
  if (action.type === "directorySizeLeaseStarted") {
    if (sizes.paused) return tab;
    return { ...tab, directorySizes: { ...sizes, consumerId: action.payload.consumerId, pending: true, requested: true,
      forceRefresh: false, snapshot: undefined, records: {} } };
  }
  if (!sizes.consumerId || sizes.consumerId !== action.payload.consumerId) return tab;
  if (action.type === "directorySizeReleased") {
    return { ...tab, directorySizes: { ...sizes, consumerId: undefined, pending: false, requested: false, records: {},
      snapshot: sizes.paused ? sizes.snapshot : unavailable(sizes, "stale", "视图已离开或刷新，请重新计算大小") } };
  }
  if (sizes.paused) return tab;
  if (action.type === "directorySizeFailed") {
    return { ...tab, directorySizes: { ...sizes, pending: false, paused: true, requested: false, records: {},
      snapshot: unavailable(sizes, "failed", action.payload.message) } };
  }
  if (action.type === "directorySizeSnapshotReceived") {
    const snapshot = action.payload.snapshot;
    const previous = sizes.snapshot;
    if (snapshot.consumerId !== sizes.consumerId || previous && (snapshot.generation < previous.generation ||
      snapshot.generation === previous.generation && snapshot.sequence <= previous.sequence)) return tab;
    const keepRecords = snapshot.generation === previous?.generation && (snapshot.phase === "complete" || snapshot.phase === "partial");
    return { ...tab, directorySizes: { ...sizes, pending: false, snapshot, records: keepRecords ? sizes.records : {} } };
  }
  const snapshot = sizes.snapshot;
  if (!snapshot || (snapshot.phase !== "complete" && snapshot.phase !== "partial")) return tab;
  if (action.type === "directorySizeLookupReceived") {
    const { lookup } = action.payload;
    if (lookup.consumerId !== sizes.consumerId || lookup.generation !== snapshot.generation || lookup.sequence !== snapshot.sequence) return tab;
    if (lookup.stale) return { ...tab, directorySizes: { ...sizes, records: {}, snapshot: unavailable(sizes, "stale", "大小统计缓存已失效，请重新计算") } };
    const records = { ...sizes.records };
    for (const record of lookup.directories) {
      if (isSameOrDescendantPath(sizes.rootPath, record.path)) records[getPathComparisonKey(record.path)] = record;
    }
    return { ...tab, directorySizes: { ...sizes, records } };
  }
  if (snapshot.generation !== action.payload.generation || tab.status !== "ready") return tab;
  if (action.type === "directorySizeListingAlignmentFailed") {
    const { expectedRoot, expectedBranch, path } = action.payload;
    if (tab.snapshot !== expectedRoot || (expectedBranch
      ? tab.folderExpansion?.[getPathComparisonKey(path)] !== expectedBranch
      : !pathsEqual(path, tab.snapshot.location.path))) return tab;
    return reduceDirectorySizes(tab, { type: "directorySizeFailed", payload: action.payload });
  }
  return alignFolderListing(tab, action.payload.snapshot, action.payload.expectedRoot, action.payload.expectedBranch);
}

import type { DirectorySizeIntent, DirectorySizeLeaseMode, DirectorySizeLookup, DirectorySizeSnapshot, DirectorySizeTabState } from "./directorySizeTypes";
import type { SizeAlignmentTarget } from "./directorySizeAlignmentRequest";
import type { DirectorySnapshot, FolderExpansionBranch, PanelId, TabState } from "./types";
import { currentDirectorySizes } from "./directorySizes";
import { reconcileListingSizeCache } from "./directorySizeCache";
import { alignFolderListing } from "./folderExpansionState";
import { getPathComparisonKey, isSameOrDescendantPath, pathsEqual } from "./workspacePathRelations";
import { enrichDirectorySizes, type DirectorySizeCacheReceived } from "./directorySizeEnrichment";
import { matchesDirectorySizeLookupListing, type DirectorySizeLookupListing } from "./directorySizeLookupFence";

type Target = { panelId: PanelId; tabId: string; rootPath: string };
export type DirectorySizeLeaseTarget = Target & { consumerId: string; requestVersion: number };
type LeaseTarget = DirectorySizeLeaseTarget;
export type DirectorySizeAction =
  | DirectorySizeCacheReceived
  | { type: "directorySizeRequested"; payload: Target & { intent: "calculate" | "cancel"; requestedAt?: number } }
  | { type: "directorySizeLeaseStarted"; payload: LeaseTarget & { mode: DirectorySizeLeaseMode; attemptVersion?: number } }
  | { type: "directorySizeLeaseFailed"; payload: LeaseTarget & { mode: DirectorySizeLeaseMode; attemptVersion?: number; message: string } }
  | { type: "directorySizeAutoRetried"; payload: Target }
  | { type: "directorySizeReleased"; payload: LeaseTarget }
  | { type: "directorySizeSnapshotReceived"; payload: LeaseTarget & { snapshot: DirectorySizeSnapshot } }
  | { type: "directorySizeLookupReceived"; payload: LeaseTarget & DirectorySizeLookupListing & { lookup: DirectorySizeLookup } }
  | { type: "directorySizeFailed"; payload: LeaseTarget & { message: string; lookupFence?: DirectorySizeLookupListing & { generation: number; sequence: number } } }
  | { type: "directorySizeListingAlignmentFailed"; payload: SizeAlignmentTarget & { message: string } }
  | { type: "directorySizeListingAligned"; payload: LeaseTarget & { generation: number; snapshot: DirectorySnapshot; expectedRoot: DirectorySnapshot; expectedBranch?: FolderExpansionBranch } };

let requestOrder = 0;
/** Monotonic order of explicit calculations; the newest background manual leases are kept. */
export function nextDirectorySizeRequestOrder() { return ++requestOrder; }

/** Remote work is shared on the first explicit calculate; later calculates force a new generation (SPEC-029). */
export function manualSubscribeIntent(sizes: DirectorySizeTabState, remote: boolean): DirectorySizeIntent {
  if (!sizes.forceRefresh) return "resume";
  return remote && !sizes.manualStarted ? "start" : "calculate";
}

const readablePhase = (snapshot: DirectorySizeSnapshot | undefined) => snapshot !== undefined &&
  (snapshot.phase === "complete" || snapshot.phase === "partial" || snapshot.phase === "stale" && snapshot.staleReadable === true);

function initialSizes(rootPath: string): DirectorySizeTabState {
  return { rootPath, requestVersion: 0, requested: false, paused: false, manualStarted: false, pending: false, records: {} };
}

function unavailable(sizes: DirectorySizeTabState, phase: "cancelled" | "failed" | "stale", reason: string): DirectorySizeSnapshot {
  return { consumerId: sizes.consumerId ?? "", generation: 0, sequence: 0, knownBytes: "0", files: 0, directories: 0,
    skippedLinks: 0, skippedSpecial: 0, errors: 0, freshness: "snapshot", ...sizes.snapshot, phase, totalBytes: null, reason };
}

export function reduceDirectorySizes(tab: TabState, action: DirectorySizeAction): TabState {
  let next = reduceDirectorySizeState(tab, action);
  if (next === tab) return next;
  const sizes = next.directorySizes;
  const phase = sizes?.snapshot;
  const invalidated = action.type === "directorySizeRequested" || action.type === "directorySizeReleased" ||
    phase && ["stale", "failed", "cancelled", "scanning"].includes(phase.phase);
  if (sizes && invalidated) {
    const versions = [sizes.cacheFence, phase, tab.directorySizes?.snapshot, tab.snapshot.directorySizeCache].filter((value) => value !== undefined);
    const cacheFence = versions.sort((a, b) => b.generation - a.generation || b.sequence - a.sequence)[0];
    if (cacheFence) next = { ...next, directorySizes: { ...sizes, cacheFence: { generation: cacheFence.generation, sequence: cacheFence.sequence } } };
  }
  const snapshot = reconcileListingSizeCache(next.snapshot, next.directorySizes);
  return snapshot === next.snapshot ? next : { ...next, snapshot };
}

function reduceDirectorySizeState(tab: TabState, action: DirectorySizeAction): TabState {
  if (action.type === "directorySizeCacheReceived") return enrichDirectorySizes(tab, action);
  const payload = action.payload;
  if (tab.id !== payload.tabId || tab.kind !== "directory" || !pathsEqual(tab.snapshot.location.path, payload.rootPath)) return tab;
  const sizes = currentDirectorySizes(tab) ?? initialSizes(payload.rootPath);
  if (action.type === "directorySizeRequested") {
    const { intent, requestedAt } = action.payload;
    const cancel = intent === "cancel";
    return { ...tab, directorySizes: { ...sizes, requestVersion: sizes.requestVersion + 1, requested: !cancel,
      paused: cancel, pending: !cancel, forceRefresh: !cancel, consumerId: undefined, mode: undefined, records: {},
      requestedAt: cancel ? sizes.requestedAt : requestedAt ?? sizes.requestedAt,
      snapshot: cancel ? unavailable(sizes, "cancelled", "已取消大小计算") : undefined } };
  }
  if (action.type === "directorySizeAutoRetried") {
    const retry = { ...sizes, autoPaused: false, autoError: undefined, autoAttempted: false, attemptVersion: (sizes.attemptVersion ?? 0) + 1 };
    // A live manual fallback keeps running; only the replacement attempt advances (V22-002).
    if (sizes.consumerId && sizes.mode !== "auto") return { ...tab, directorySizes: retry };
    return { ...tab, directorySizes: { ...retry, requestVersion: sizes.requestVersion + 1, consumerId: undefined, mode: undefined,
      pending: false, records: {}, snapshot: undefined } };
  }
  if (sizes.requestVersion !== action.payload.requestVersion) return tab;
  if (action.type === "directorySizeLeaseStarted" || action.type === "directorySizeLeaseFailed") {
    const auto = action.payload.mode === "auto";
    if (auto && (action.payload.attemptVersion ?? 0) !== (sizes.attemptVersion ?? 0)) return tab;
    if (action.type === "directorySizeLeaseFailed") {
      // A failed replacement never clears the authorization of a live lease of the other mode (READY-006).
      const failed = sizes.consumerId ? {} : { pending: false, records: {}, snapshot: unavailable(sizes, "failed", action.payload.message) };
      return { ...tab, directorySizes: auto
        ? { ...sizes, ...failed, autoPaused: true, autoError: action.payload.message, autoAttempted: true }
        : { ...sizes, ...failed, paused: true, requested: false, pending: sizes.consumerId ? sizes.pending : false } };
    }
    if (auto ? sizes.autoPaused : sizes.paused) return tab;
    const remote = tab.snapshot.location.kind !== "local";
    return { ...tab, directorySizes: { ...sizes, consumerId: action.payload.consumerId, mode: action.payload.mode, pending: true,
      forceRefresh: false, snapshot: undefined, records: {},
      ...(auto ? { requested: false, paused: false, autoAttempted: true } : { manualStarted: sizes.manualStarted || remote }) } };
  }
  if (!sizes.consumerId || sizes.consumerId !== action.payload.consumerId) return tab;
  if (action.type === "directorySizeReleased") {
    const keep = sizes.paused || sizes.autoPaused && sizes.snapshot?.phase === "failed";
    return { ...tab, directorySizes: { ...sizes, consumerId: undefined, mode: undefined, pending: false, forceRefresh: false, records: {},
      snapshot: keep ? sizes.snapshot : unavailable(sizes, "stale", "视图已离开，返回后恢复显示") } };
  }
  if (sizes.paused) return tab;
  if (action.type === "directorySizeFailed") {
    const fence = action.payload.lookupFence;
    if (fence && (!matchesDirectorySizeLookupListing(tab, fence) || sizes.snapshot?.generation !== fence.generation ||
      sizes.snapshot?.sequence !== fence.sequence)) return tab;
    const snapshot = unavailable(sizes, "failed", action.payload.message);
    if (sizes.mode === "auto") return { ...tab, directorySizes: { ...sizes, pending: false, records: {}, snapshot,
      autoPaused: true, autoError: action.payload.message, autoAttempted: true } };
    return { ...tab, directorySizes: { ...sizes, pending: false, paused: true, requested: false, records: {}, snapshot } };
  }
  if (action.type === "directorySizeSnapshotReceived") {
    const snapshot = action.payload.snapshot;
    const previous = sizes.snapshot;
    if (snapshot.consumerId !== sizes.consumerId || previous && (snapshot.generation < previous.generation ||
      snapshot.generation === previous.generation && snapshot.sequence <= previous.sequence)) return tab;
    const revisionChanged = previous !== undefined && snapshot.invalidationRevision !== previous.invalidationRevision;
    const keepRecords = !revisionChanged && snapshot.generation === previous?.generation &&
      snapshot.artifactRevision === previous?.artifactRevision && readablePhase(snapshot);
    const next: DirectorySizeTabState = { ...sizes, pending: false, snapshot, records: keepRecords ? sizes.records : {} };
    // Listing caches up to this version may still carry values that the revision invalidated (SPEC-012).
    const fence = sizes.cacheFence;
    if (revisionChanged && (!fence || fence.generation < snapshot.generation ||
      fence.generation === snapshot.generation && fence.sequence < snapshot.sequence)) {
      next.cacheFence = { generation: snapshot.generation, sequence: snapshot.sequence };
    }
    if (sizes.mode === "auto" && snapshot.phase === "failed") {
      Object.assign(next, { autoPaused: true, autoError: snapshot.reason ?? "自动计算失败", autoAttempted: true });
    }
    return { ...tab, directorySizes: next };
  }
  const snapshot = sizes.snapshot;
  if (!snapshot || !readablePhase(snapshot)) return tab;
  if (action.type === "directorySizeLookupReceived") {
    const { lookup } = action.payload;
    if (!matchesDirectorySizeLookupListing(tab, action.payload)) return tab;
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

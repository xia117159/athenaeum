import type { DirectorySizeCache, DirectorySizeTabState } from "./directorySizeTypes";
import type { DirectorySnapshot } from "./types";
import { getPathComparisonKey, pathsEqual } from "./workspacePathRelations";

/** Apply the same cache fence when receiving size events, installing a listing,
 * and projecting a row. Navigation request IDs do not fence size generations. */
export function currentListingSizeCache(snapshot: DirectorySnapshot, sizes?: DirectorySizeTabState): DirectorySizeCache | undefined {
  const cache = snapshot.directorySizeCache;
  if (!cache || !sizes || !pathsEqual(sizes.rootPath, snapshot.location.path)) return cache;
  const phase = sizes.snapshot;
  const fence = sizes.cacheFence;
  if (sizes.paused || sizes.forceRefresh || fence && (cache.generation < fence.generation ||
    cache.generation === fence.generation && cache.sequence <= fence.sequence) || phase &&
    (phase.generation !== cache.generation || !["queued", "complete", "partial"].includes(phase.phase))) return undefined;
  const directories = cache.directories.filter((record) => !sizes.records[getPathComparisonKey(record.path)]);
  if (!directories.length) return undefined;
  return directories.length === cache.directories.length ? cache : { ...cache, directories };
}

export function reconcileListingSizeCache(snapshot: DirectorySnapshot, sizes?: DirectorySizeTabState): DirectorySnapshot {
  const cache = currentListingSizeCache(snapshot, sizes);
  return cache === snapshot.directorySizeCache ? snapshot : { ...snapshot, directorySizeCache: cache };
}

import type { DirectorySizeCache, DirectorySizeTabState } from "./directorySizeTypes";
import type { DirectorySnapshot } from "./types";
import { getPathComparisonKey, pathsEqual } from "./workspacePathRelations";

/** Apply the same cache fence when receiving size events, installing a listing,
 * and projecting a row. Navigation request IDs do not fence size generations. */
export function currentListingSizeCache(snapshot: DirectorySnapshot, sizes?: DirectorySizeTabState): DirectorySizeCache | undefined {
  const cache = snapshot.directorySizeCache;
  // Historical display is independent from this process's live result fences.
  // Its path/type/creation evidence is checked when a current listing is mapped.
  if (cache?.historical) return cache;
  if (!cache || !sizes || !pathsEqual(sizes.rootPath, snapshot.location.path)) return cache;
  const phase = sizes.snapshot;
  const fence = sizes.cacheFence;
  if (sizes.paused || sizes.forceRefresh || phase && phase.artifactRevision !== cache.artifactRevision || fence && (cache.generation < fence.generation ||
    cache.generation === fence.generation && cache.sequence <= fence.sequence) || phase &&
    (phase.generation !== cache.generation || !["queued", "complete", "partial"].includes(phase.phase))) {
    // Invalidating live proof must not erase the last displayed scalar. Retain
    // only records tied to an ordinary directory in this authoritative listing.
    const entries = new Map(snapshot.entries.filter((entry) => entry.kind === "folder" && !entry.attributes.includes("L"))
      .map((entry) => [getPathComparisonKey(entry.path), entry]));
    const directories = cache.directories.filter((record) => record.cachedAt && record.createdAt &&
      entries.get(getPathComparisonKey(record.path))?.sizeCreatedAt === record.createdAt);
    return directories.length ? { ...cache, historical: true, directories } : undefined;
  }
  const directories = cache.directories.filter((record) => !sizes.records[getPathComparisonKey(record.path)]);
  if (!directories.length) return undefined;
  return directories.length === cache.directories.length ? cache : { ...cache, directories };
}

export function reconcileListingSizeCache(snapshot: DirectorySnapshot, sizes?: DirectorySizeTabState): DirectorySnapshot {
  const cache = currentListingSizeCache(snapshot, sizes);
  return cache === snapshot.directorySizeCache ? snapshot : { ...snapshot, directorySizeCache: cache };
}

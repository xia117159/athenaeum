import type { DirectorySizeCacheLookup } from "./directorySizeCacheTypes";
import type { DirectorySnapshot, PanelId, TabState } from "./types";
import { getPathComparisonKey, pathsEqual } from "./workspacePathRelations";

export type DirectorySizeCacheReceived = {
  type: "directorySizeCacheReceived";
  payload: { panelId: PanelId; tabId: string; rootPath: string; expectedEntries: DirectorySnapshot["entries"]; lookup: DirectorySizeCacheLookup };
};
export function enrichDirectorySizes(tab: TabState, action: DirectorySizeCacheReceived): TabState {
  const { payload } = action;
  if (tab.id !== payload.tabId || tab.kind !== "directory" || tab.snapshot.location.kind !== "local" ||
      tab.snapshot.entries !== payload.expectedEntries || !pathsEqual(tab.snapshot.location.path, payload.rootPath) ||
      !pathsEqual(payload.lookup.path, payload.rootPath)) return tab;
  const entries = new Map(tab.snapshot.entries.filter((entry) => entry.kind === "folder" && !entry.attributes.includes("L"))
    .map((entry) => [getPathComparisonKey(entry.path), entry]));
  const existing = tab.snapshot.directorySizeCache;
  const revision = (value?: string) => value && /^\d{1,20}$/.test(value) ? BigInt(value) : null;
  const received = revision(payload.lookup.revision);
  if (received === null || [existing?.revision, tab.directorySizes?.snapshot?.cacheRevision]
    .some((value) => { const known = revision(value); return known !== null && received < known; })) return tab;
  const records = new Map(existing?.directories.map((record) => [getPathComparisonKey(record.path), record]));
  let changed = false;
  for (const hit of payload.lookup.entries) {
    const record = hit.record;
    if (hit.status !== "hit" || !record?.createdAt || !record.cachedAt || record.bytes === null || !pathsEqual(hit.path, record.path)) continue;
    const key = getPathComparisonKey(record.path); const entry = entries.get(key);
    if (!entry || entry.sizeCreatedAt !== record.createdAt) continue;
    // A current live result always outranks an advisory read from disk.
    if (records.has(key) && !existing?.historical) continue;
    const previous = records.get(key);
    if (previous?.bytes === record.bytes && previous.createdAt === record.createdAt && previous.cachedAt === record.cachedAt) continue;
    records.set(key, { ...record, path: entry.path, sizeFingerprint: null }); changed = true;
  }
  return !changed ? tab : { ...tab, snapshot: { ...tab.snapshot, directorySizeCache: {
    generation: 0, sequence: 0, historical: true, revision: payload.lookup.revision, directories: [...records.values()]
  } } };
}

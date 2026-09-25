import type { DirectorySnapshot, TabState } from "./types";

export type DirectorySizeLookupListing = {
  expectedRoot: DirectorySnapshot;
  expectedExpansion: TabState["folderExpansion"];
};

/** Metadata alignment and consumed hints can replace containers while keeping
 * the same immutable entries. A fresh listing with new objects must be fenced. */
export function matchesDirectorySizeLookupListing(tab: TabState, fence: DirectorySizeLookupListing): boolean {
  const before = fence.expectedRoot.entries;
  const after = tab.snapshot.entries;
  if (before !== after && (before.length !== after.length || before.some((entry, index) => entry !== after[index]))) return false;
  if (tab.folderExpansion === fence.expectedExpansion) return true;
  for (const [key, branch] of Object.entries(fence.expectedExpansion ?? {})) {
    const current = tab.folderExpansion?.[key];
    if (branch === current || branch.entries === current?.entries || !branch.entries.length) continue;
    if (!current) return false;
    const entries = new Set(current.entries);
    if (branch.entries.some((entry) => !entries.has(entry))) return false;
  }
  // Newly expanded rows were not queried by the old batch; the controller will
  // discover their paths without rejecting outstanding root/directory results.
  return true;
}

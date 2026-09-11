import { expansionEntry, expansionFixture } from "./folderExpansionTestSupport";
import { createWorkspaceState } from "./workspaceReducer";
import { getPathComparisonKey } from "./workspacePathRelations";
import type { DirectorySizeRecord, DirectorySizeSnapshot, DirectorySizeTabState } from "./directorySizeTypes";

export function sizeSnapshot(override: Partial<DirectorySizeSnapshot> = {}): DirectorySizeSnapshot {
  return { consumerId: "size-test", generation: 1, sequence: 2, phase: "complete", totalBytes: "100", knownBytes: "100", files: 3,
    directories: 2, skippedLinks: 0, skippedSpecial: 0, errors: 0, freshness: "monitored", reason: null, ...override };
}
export function sizeRecord(path: string, bytes: string | null, sizeFingerprint = "stamp", state: DirectorySizeRecord["state"] = "complete"): DirectorySizeRecord {
  return { path, bytes, state, sizeFingerprint };
}
export function sizeFixture(kind: "local" | "ftp" | "sftp" = "local") {
  const fixture = expansionFixture(kind);
  const state = createWorkspaceState(fixture.bootstrap);
  const tab = state.panels["panel-1"].tabs[0];
  tab.kind = "directory"; tab.viewMode = "details";
  tab.snapshot.sizeFingerprint = "root-stamp";
  const a = expansionEntry(fixture.path, "a.txt", "file", { sizeBytes: 30, sizeLabel: "30 B" });
  const b = expansionEntry(fixture.path, "b.txt", "file", { sizeBytes: 10, sizeLabel: "10 B" });
  const child = expansionEntry(fixture.parent.path, "child.txt", "file", { sizeBytes: 60, sizeLabel: "60 B" });
  tab.snapshot.entries = [fixture.parent, a, b];
  tab.folderExpansion = { [getPathComparisonKey(fixture.parent.path)]: {
    path: fixture.parent.path, entries: [child], status: "ready", sizeFingerprint: "parent-stamp"
  } };
  const sizes: DirectorySizeTabState = { rootPath: fixture.path, requestVersion: 0, requested: true, paused: false,
    manualStarted: kind !== "local", pending: false, consumerId: "size-test", snapshot: sizeSnapshot(), records: {
      [getPathComparisonKey(fixture.path)]: sizeRecord(fixture.path, "100", "root-stamp"),
      [getPathComparisonKey(fixture.parent.path)]: sizeRecord(fixture.parent.path, "60", "parent-stamp")
    } };
  tab.directorySizes = sizes;
  return { ...fixture, state, tab, sizes, a, b, child };
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { currentDirectorySizes, formatDirectoryBytes, projectEntrySize, supportsDirectorySizes } from "./directorySizes";
import { getFolderListingRows } from "./folderExpansion";
import { sortEntries } from "./fileListingSort";
import { getPathComparisonKey } from "./workspacePathRelations";
import { DEFAULT_FILE_VISIBILITY } from "./workspaceVisibility";
import { expansionEntry } from "./folderExpansionTestSupport";
import { sizeFixture, sizeRecord } from "./directorySizeTestSupport";
import { buildThisPcSnapshot } from "./workspaceDirectoryGateway";

test("size shares keep one root denominator for 60/30/10 and expanded descendants", () => {
  const { tab, parent, a, b, child } = sizeFixture();
  assert.equal(supportsDirectorySizes(tab), true);
  assert.equal(currentDirectorySizes(tab), tab.directorySizes);
  assert.deepEqual([parent, a, b, child].map((entry) => projectEntrySize(tab, entry).sizeDisplay?.share), [.6, .3, .1, .6]);
  assert.equal(projectEntrySize(tab, parent).sizeDisplay?.label, "60 B");
  assert.equal(projectEntrySize(tab, a).sizeLabel, "30 B");
  assert.deepEqual(getFolderListingRows(tab).map(({ entry }) => entry.sizeDisplay?.share), [.6, .6, .3, .1]);
  assert.deepEqual(getFolderListingRows(tab, DEFAULT_FILE_VISIBILITY, "child").map(({ entry }) => entry.sizeDisplay?.share), [.6, .6]);
  tab.folderExpansion = undefined;
  assert.equal(projectEntrySize(tab, parent).sizeDisplay?.share, .6);
});

test("old listing sizes below the total still need independent parent fingerprint pairing", () => {
  const { tab, a, child } = sizeFixture();
  tab.snapshot.sizeFingerprint = "old-root";
  assert.equal(projectEntrySize(tab, a).sizeDisplay?.state, "stale");
  assert.equal(projectEntrySize(tab, a).sizeDisplay?.share, null);
  assert.equal(projectEntrySize(tab, child).sizeDisplay?.share, .6, "the expanded parent's own listing can be independently verified");
  Object.values(tab.folderExpansion!)[0].sizeFingerprint = "old-parent";
  assert.equal(projectEntrySize(tab, child).sizeDisplay?.share, null);
});

test("partial stale cancelled and unknown totals never look like exact shares", () => {
  const { tab, sizes, parent, a } = sizeFixture();
  sizes.snapshot!.phase = "partial"; sizes.snapshot!.totalBytes = null;
  sizes.records[getPathComparisonKey(parent.path)] = sizeRecord(parent.path, "40", "parent-stamp", "partial");
  assert.equal(projectEntrySize(tab, parent).sizeDisplay?.label, "≥40 B");
  assert.equal(projectEntrySize(tab, parent).sizeDisplay?.share, null);
  for (const phase of ["queued", "scanning", "failed", "stale", "cancelled"] as const) {
    sizes.snapshot!.phase = phase;
    assert.equal(projectEntrySize(tab, a).sizeDisplay?.share, null, phase);
  }
  sizes.records = {};
  assert.equal(projectEntrySize(tab, parent).sizeDisplay?.label, "--");
});

test("incomplete legacy remote metadata can show lower bounds without a verified denominator", () => {
  const { tab, sizes, parent } = sizeFixture("ftp");
  sizes.snapshot!.phase = "partial"; sizes.snapshot!.totalBytes = null;
  tab.snapshot.sizeFingerprint = null;
  sizes.records[getPathComparisonKey(parent.path)] = sizeRecord(parent.path, "40", "", "partial");
  assert.equal(projectEntrySize(tab, parent).sizeDisplay?.label, "≥40 B");
  assert.equal(projectEntrySize(tab, parent).sizeDisplay?.share, null);
});

test("empty directories zero files unsafe numbers and numerator overflow have honest presentation", () => {
  const { tab, sizes, parent, a } = sizeFixture();
  sizes.snapshot!.totalBytes = "0";
  sizes.records[getPathComparisonKey(parent.path)].bytes = "0";
  a.sizeBytes = 0; a.sizeLabel = "0 B";
  assert.equal(projectEntrySize(tab, parent).sizeDisplay?.label, "0 B");
  assert.equal(projectEntrySize(tab, parent).sizeDisplay?.share, 0);
  assert.equal(projectEntrySize(tab, a).sizeDisplay?.share, 0);
  a.sizeBytes = 1;
  assert.equal(projectEntrySize(tab, a).sizeDisplay?.state, "stale");
  a.sizeBytes = Number.MAX_SAFE_INTEGER + 1;
  sizes.snapshot!.totalBytes = "18446744073709551615";
  assert.equal(projectEntrySize(tab, a).sizeDisplay?.share, null);
  assert.equal(formatDirectoryBytes(1024n), "1 KB");
  assert.match(formatDirectoryBytes(18446744073709551615n), /EB$/);
});

test("link rows and excluded contexts never receive directory aggregates or bars", () => {
  const { tab, parent } = sizeFixture();
  parent.attributes = ["L"];
  assert.equal(projectEntrySize(tab, parent).sizeDisplay?.state, "excluded");
  assert.equal(projectEntrySize(tab, parent).sizeDisplay?.share, null);
  for (const kind of ["search-results", "navigation"] as const) {
    assert.equal(projectEntrySize({ ...tab, kind }, parent).sizeDisplay, undefined);
  }
  assert.equal(projectEntrySize({ ...tab, viewMode: "list" }, parent).sizeDisplay, undefined);
  assert.equal(supportsDirectorySizes({ ...tab, snapshot: { ...tab.snapshot, location: { ...tab.snapshot.location, kind: "virtual" } } }), false);
  assert.equal(supportsDirectorySizes({ ...tab, columns: tab.columns.map((column) => column.id === "size" ? { ...column, visible: false } : column) }), false);
});

test("size sorting uses exact folder bytes and raw file bytes before rounded labels", () => {
  const { tab, path, sizes } = sizeFixture();
  const small = expansionEntry(path, "z-small"); const large = expansionEntry(path, "a-large"); const unknown = expansionEntry(path, "unknown");
  sizes.records[getPathComparisonKey(small.path)] = sizeRecord(small.path, "9007199254740992");
  sizes.records[getPathComparisonKey(large.path)] = sizeRecord(large.path, "9007199254740993");
  sizes.snapshot!.totalBytes = "18014398509481985";
  tab.snapshot.entries = [large, small, unknown]; tab.folderExpansion = undefined;
  tab.sort = { columnId: "size", direction: "asc" };
  assert.deepEqual(getFolderListingRows(tab).map(({ entry }) => entry.name), [small.name, large.name, unknown.name]);
  assert.deepEqual(getFolderListingRows({ ...tab, sort: { columnId: "size", direction: "desc" } }).map(({ entry }) => entry.name),
    [large.name, small.name, unknown.name]);
  const a = expansionEntry(path, "a", "file", { sizeBytes: 1030, sizeLabel: "1 KB" });
  const b = expansionEntry(path, "z", "file", { sizeBytes: 1025, sizeLabel: "1 KB" });
  assert.deepEqual(sortEntries([a, b], tab.sort, path).map((entry) => entry.name), ["z", "a"]);
});

test("excluded This PC drives keep raw capacity sorting without statistics or bars", () => {
  const { tab } = sizeFixture();
  tab.snapshot = buildThisPcSnapshot([
    { path: "A:\\", label: "A large drive", driveType: "local", totalBytes: 900_000_000_000, availableBytes: 300_000_000_000 },
    { path: "Z:\\", label: "Z small drive", driveType: "local", totalBytes: 100_000_000_000, availableBytes: 30_000_000_000 },
    { path: "M:\\", label: "M unknown drive", driveType: "network", totalBytes: null, availableBytes: null }
  ]);
  tab.folderExpansion = undefined; tab.directorySizes = undefined;
  assert.equal(supportsDirectorySizes(tab), false);
  assert.equal(currentDirectorySizes(tab), undefined);
  for (const direction of ["asc", "desc"] as const) {
    tab.sort = { columnId: "size", direction };
    const rows = getFolderListingRows(tab);
    assert.deepEqual(rows.map(({ entry }) => entry.name), direction === "asc"
      ? ["Z small drive", "A large drive", "M unknown drive"]
      : ["A large drive", "Z small drive", "M unknown drive"]);
    assert.ok(rows.every(({ entry }) => entry.sizeDisplay === undefined));
  }
});

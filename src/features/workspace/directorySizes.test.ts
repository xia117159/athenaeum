import assert from "node:assert/strict";
import { test } from "node:test";
import { currentDirectorySizes, formatDirectoryBytes, projectEntrySize, supportsDirectorySizes } from "./directorySizes";
import { getFolderListingRows } from "./folderExpansion";
import { sortEntries } from "./fileListingSort";
import { getPathComparisonKey } from "./workspacePathRelations";
import { DEFAULT_FILE_VISIBILITY } from "./workspaceVisibility";
import { expansionEntry, quickFilterProgram } from "./folderExpansionTestSupport";
import { sizeFixture, sizeRecord, sizeSnapshot } from "./directorySizeTestSupport";
import { buildThisPcSnapshot } from "./workspaceDirectoryGateway";

test("size shares keep one root denominator for 60/30/10 and expanded descendants", () => {
  const { tab, parent, a, b, child } = sizeFixture();
  assert.equal(supportsDirectorySizes(tab), true);
  assert.equal(currentDirectorySizes(tab), tab.directorySizes);
  assert.deepEqual([parent, a, b, child].map((entry) => projectEntrySize(tab, entry).sizeDisplay?.share), [.6, .3, .1, .6]);
  assert.equal(projectEntrySize(tab, parent).sizeDisplay?.label, "60 B");
  assert.equal(projectEntrySize(tab, a).sizeLabel, "30 B");
  assert.deepEqual(getFolderListingRows(tab).map(({ entry }) => entry.sizeDisplay?.share), [.6, .6, .3, .1]);
  assert.deepEqual(getFolderListingRows(tab, DEFAULT_FILE_VISIBILITY, quickFilterProgram("child")).map(({ entry }) => entry.sizeDisplay?.share), [.6, .6]);
  tab.folderExpansion = undefined;
  assert.equal(projectEntrySize(tab, parent).sizeDisplay?.share, .6);
});

test("first listing file sizes and cached folder sizes share a known-size denominator before a lease", () => {
  const { tab, parent, a, b } = sizeFixture();
  tab.directorySizes = undefined;
  tab.snapshot.directorySizeCache = { generation: 0, sequence: 0, historical: true, directories: [
    { ...sizeRecord(parent.path, "60"), createdAt: parent.sizeCreatedAt, cachedAt: "2026-09-25T00:00:00Z" }
  ] };
  const rows = [parent, a, b].map((entry) => projectEntrySize(tab, entry));
  assert.deepEqual(rows.map((entry) => entry.sizeDisplay?.share), [.6, .3, .1]);
  assert.ok(rows.every((entry) => entry.sizeDisplay?.title.includes("已知")));
  assert.equal(projectEntrySize(tab, parent, "folder-max").sizeDisplay?.share, 1);
  assert.equal(projectEntrySize(tab, a, "folder-max").sizeDisplay?.share, .5);
});

test("known-size bars survive incomplete siblings and positive expanded rows with a zero root", () => {
  const { tab, sizes, parent, a, child } = sizeFixture();
  sizes.records = { [getPathComparisonKey(tab.snapshot.location.path)]: sizeRecord(tab.snapshot.location.path, "100", "root-stamp"),
    [getPathComparisonKey(parent.path)]: sizeRecord(parent.path, "60", "parent-stamp") };
  tab.snapshot.entries.push(expansionEntry(tab.snapshot.location.path, "unknown", "folder"));
  assert.equal(projectEntrySize(tab, parent).sizeDisplay?.share, .6);
  assert.match(projectEntrySize(tab, parent).sizeDisplay!.title, /已知/);
  tab.snapshot.entries = [expansionEntry(tab.snapshot.location.path, "zero", "file", { sizeBytes: 0, sizeLabel: "0 B" })];
  assert.equal(projectEntrySize(tab, child).sizeDisplay?.share, 1);
  assert.match(projectEntrySize(tab, child).sizeDisplay!.title, /已知/);
  assert.equal(projectEntrySize(tab, a).sizeDisplay?.share, 1);
});

test("expanded branch cache immediately supplies descendant folder sizes and bars", () => {
  const { tab, parent } = sizeFixture();
  const nested = expansionEntry(parent.path, "nested-folder", "folder", { sizeCreatedAt: "nested-created" });
  const child = expansionEntry(parent.path, "child.txt", "file", { sizeBytes: 40, sizeLabel: "40 B" });
  const branch = tab.folderExpansion![getPathComparisonKey(parent.path)];
  branch.entries = [nested, child];
  branch.directorySizeCache = { generation: 1, sequence: 2, directories: [
    { ...sizeRecord(nested.path, "20", "nested-stamp"), createdAt: "nested-created", cachedAt: "2026-09-25T00:00:00Z" }
  ] };
  const row = getFolderListingRows(tab).find(({ entry }) => entry.path === nested.path)?.entry;
  assert.equal(row?.sizeLabel, "20 B");
  assert.equal(row?.sizeDisplay?.share, .2);
  assert.equal(row?.sizeDisplay?.advisory, true);
  const file = getFolderListingRows(tab).find(({ entry }) => entry.path === child.path)?.entry;
  assert.equal(file?.sizeLabel, "40 B");
  assert.equal(file?.sizeDisplay?.share, .4);
});

test("expanded branch root cache keeps its size and bar while live statistics are scanning", () => {
  const { tab, parent } = sizeFixture();
  const branch = tab.folderExpansion![getPathComparisonKey(parent.path)];
  parent.sizeCreatedAt = "parent-created";
  branch.directorySizeCache = { generation: 1, sequence: 2, directories: [
    { ...sizeRecord(parent.path, "60", "parent-stamp"), createdAt: "parent-created", cachedAt: "2026-09-25T00:00:00Z" }
  ] };
  tab.directorySizes!.records = {};
  for (const phase of ["scanning", "complete", "scanning"] as const) {
    tab.directorySizes!.snapshot = sizeSnapshot({ generation: 2, sequence: phase === "scanning" ? 3 : 4, phase });
    const row = getFolderListingRows(tab).find(({ entry }) => entry.path === parent.path)?.entry;
    assert.equal(row?.sizeLabel, "60 B", phase);
    assert.equal(row?.sizeDisplay?.share, .6, phase);
  }
});

test("expanded branch cache stays visible while the branch listing refreshes", () => {
  const { tab, parent } = sizeFixture();
  const nested = expansionEntry(parent.path, "nested-folder", "folder", { sizeCreatedAt: "nested-created" });
  const branch = tab.folderExpansion![getPathComparisonKey(parent.path)];
  branch.entries = [nested];
  branch.directorySizeCache = { generation: 1, sequence: 2, directories: [
    { ...sizeRecord(nested.path, "20", "nested-stamp"), createdAt: "nested-created", cachedAt: "2026-09-25T00:00:00Z" }
  ] };
  for (const status of ["ready", "loading", "idle", "ready"] as const) {
    branch.status = status;
    const row = getFolderListingRows(tab).find(({ entry }) => entry.path === nested.path)?.entry;
    assert.equal(row?.sizeLabel, "20 B", status);
    assert.equal(row?.sizeDisplay?.share, .2, status);
  }
});

test("expanded branch cache treats an artifact revision change as historical", () => {
  const { tab, parent } = sizeFixture();
  const branch = tab.folderExpansion![getPathComparisonKey(parent.path)];
  parent.sizeCreatedAt = "parent-created";
  branch.directorySizeCache = { generation: 1, sequence: 2, artifactRevision: "old-artifact", directories: [
    { ...sizeRecord(parent.path, "60", "parent-stamp"), createdAt: "parent-created", cachedAt: "2026-09-25T00:00:00Z" }
  ] };
  tab.directorySizes!.records = {};
  tab.directorySizes!.snapshot = sizeSnapshot({ generation: 1, sequence: 3, phase: "complete", artifactRevision: "new-artifact" });
  const row = getFolderListingRows(tab).find(({ entry }) => entry.path === parent.path)?.entry;
  assert.match(row?.sizeDisplay?.title ?? "", /统计已结束/);
});

test("expanded historical cache rejects a replaced branch entry", () => {
  const { tab, parent } = sizeFixture();
  const branch = tab.folderExpansion![getPathComparisonKey(parent.path)];
  const nested = expansionEntry(parent.path, "nested-folder", "folder", { sizeCreatedAt: "new-created" });
  branch.entries = [nested];
  branch.directorySizeCache = { generation: 0, sequence: 0, historical: true, directories: [
    { ...sizeRecord(nested.path, "20", "nested-stamp"), createdAt: "old-created", cachedAt: "2026-09-25T00:00:00Z" }
  ] };
  const row = getFolderListingRows(tab).find(({ entry }) => entry.path === nested.path)?.entry;
  assert.equal(row?.sizeLabel, "--");
  assert.equal(row?.sizeDisplay?.share, null);
});

test("size-bar modes use the current listing root and exclude links or unknown values", () => {
  const { tab, sizes, parent, a, b, child } = sizeFixture();
  const link = expansionEntry(parent.path, "link", "file", { sizeBytes: 900, attributes: ["L"] });
  const unknown = expansionEntry(parent.path, "unknown", "file", { sizeBytes: null });
  tab.folderExpansion![getPathComparisonKey(parent.path)].entries = [child, link, unknown];
  assert.equal(projectEntrySize(tab, parent, "folder-max").sizeDisplay?.share, 1);
  assert.equal(projectEntrySize(tab, a, "folder-max").sizeDisplay?.share, .5);
  assert.ok(Math.abs((projectEntrySize(tab, b, "folder-max").sizeDisplay?.share ?? 0) - 1 / 6) < 1e-6);
  assert.equal(projectEntrySize(tab, child, "folder-total").sizeDisplay?.share, .6);
  assert.equal(projectEntrySize(tab, child, "folder-max").sizeDisplay?.share, 1);
  sizes.snapshot!.phase = "partial";
  sizes.snapshot!.totalBytes = null;
  sizes.records[getPathComparisonKey(tab.snapshot.location.path)]!.sizeFingerprint = null;
  assert.equal(projectEntrySize(tab, a, "folder-total").sizeDisplay?.share, .3);
});

test("old listing sizes below the total still need parent fingerprint pairing", () => {
  const { tab, a, child } = sizeFixture();
  tab.snapshot.sizeFingerprint = "old-root";
  assert.equal(projectEntrySize(tab, a).sizeDisplay?.state, "stale");
  assert.equal(projectEntrySize(tab, a).sizeDisplay?.share, null);
  assert.equal(projectEntrySize(tab, child).sizeDisplay?.share, null, "new branch shares also await a consistent root denominator");
  assert.equal(projectEntrySize(tab, child).sizeDisplay?.label, "60 B", "known branch bytes remain available");
  Object.values(tab.folderExpansion!)[0].sizeFingerprint = "old-parent";
  assert.equal(projectEntrySize(tab, child).sizeDisplay?.share, null);
});

test("partial stale cancelled and unknown totals never look like exact shares", () => {
  const { tab, sizes, parent, a } = sizeFixture();
  sizes.snapshot!.phase = "partial"; sizes.snapshot!.totalBytes = null;
  sizes.records[getPathComparisonKey(parent.path)] = sizeRecord(parent.path, "40", "parent-stamp", "partial");
  assert.equal(projectEntrySize(tab, parent).sizeDisplay?.label, "≥40 B");
  assert.equal(projectEntrySize(tab, parent).sizeDisplay?.share, .5);
  for (const phase of ["queued", "scanning", "failed", "stale", "cancelled"] as const) {
    sizes.snapshot!.phase = phase;
    assert.equal(projectEntrySize(tab, a).sizeDisplay?.provisional, true, phase);
    assert.notEqual(projectEntrySize(tab, a).sizeDisplay?.share, null, phase);
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
  assert.equal(projectEntrySize(tab, parent).sizeDisplay?.share, .5);
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
  assert.equal(projectEntrySize(tab, a).sizeDisplay?.state, "complete");
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

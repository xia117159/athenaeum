import assert from "node:assert/strict";
import { test } from "node:test";
import type { DirectoryListing, EntryViewModel as BackendEntry } from "../../app/types";
import { controllerFixture } from "./directorySizeControllerTestSupport";
import { mapDirectoryListingToSnapshot } from "./workspaceMappers";
import { toBackendRemoteProfile } from "./workspaceBackendDtos";
import { directorySizeContext, directorySizeLookupPaths } from "./directorySizePlanning";
import { projectEntrySize } from "./directorySizes";
import { sizeRecord, sizeSnapshot } from "./directorySizeTestSupport";
import { getPathComparisonKey } from "./workspacePathRelations";
import { getFolderListingRows } from "./folderExpansion";
import { expansionEntry } from "./folderExpansionTestSupport";

function fixture(kind: "local" | "ftp" | "sftp", root?: string, names = ["folder", "folder "]) {
  const f = controllerFixture(kind); const path = root ?? (kind === "local" ? "C:\\data" : "/home");
  const raw: DirectoryListing = { location: { kind, path, connectionId: kind === "local" ? null : "remote-size" },
    sizeFingerprint: "root-stamp", canGoUp: false,
    entries: names.map((name): BackendEntry => {
      const child = `${path}${kind === "local" ? "\\" : "/"}${name}`;
      return { path: child, name, kind: "directory", isHidden: false, isSystem: false, isProtectedOperatingSystem: false,
        isReadOnly: false, isSymlink: false, location: { kind, path: child, connectionId: "remote-size" }, decoration: { tags: [] } };
    }) };
  f.tab.snapshot = mapDirectoryListingToSnapshot(raw, f.state.remoteProfiles.map(toBackendRemoteProfile));
  f.tab.folderExpansion = undefined;
  const mappedRoot = f.tab.snapshot.location.path;
  f.tab.directorySizes = { rootPath: mappedRoot, requested: true, paused: false, pending: false, manualStarted: kind !== "local",
    requestVersion: 0, consumerId: "size-test", snapshot: sizeSnapshot(), records: {
      [getPathComparisonKey(mappedRoot)]: sizeRecord(mappedRoot, "100", "root-stamp"),
      [getPathComparisonKey(f.tab.snapshot.entries[0]?.path ?? mappedRoot)]: sizeRecord(f.tab.snapshot.entries[0]?.path ?? mappedRoot, "10")
    } };
  return f;
}

for (const kind of ["ftp", "sftp"] as const) for (const partial of [false, true]) {
  test(`${kind} lossy sibling paths cannot borrow another folder's ${partial ? "partial lower bound" : "complete size"}`, () => {
    const f = fixture(kind); const sizes = f.tab.directorySizes!;
    if (partial) {
      sizes.snapshot!.phase = "partial"; sizes.snapshot!.totalBytes = null;
      for (const record of Object.values(sizes.records)) record.state = "partial";
    }
    for (const entry of f.tab.snapshot.entries) {
      const display = projectEntrySize(f.tab, entry).sizeDisplay!;
      assert.equal(display.bytes, null);
      assert.equal(display.share, null);
      assert.equal(display.label, "--");
      assert.match(display.title, /路径/);
    }
    for (const expansion of [false, true]) {
      assert.ok(getFolderListingRows(f.tab, undefined, "", expansion).every(({ entry }) => entry.sizeDisplay?.bytes == null));
    }
    assert.deepEqual(directorySizeLookupPaths(f.state, "panel-1", f.tab), [], "no wrong-target aggregate lookup");
  });
}

for (const kind of ["ftp", "sftp"] as const) test(`${kind} ambiguous roots and returned paths are not silently trimmed for sizing`, () => {
  const root = fixture(kind, "/home/trailing ", []);
  assert.throws(() => directorySizeContext(root.tab, root.state.remoteProfiles), /路径/);
  const f = fixture(kind, "/home", ["a folder"]);
  const context = directorySizeContext(f.tab, f.state.remoteProfiles);
  assert.equal(context.toBackendPath(f.tab.snapshot.entries[0].path), "/home/a folder");
  assert.throws(() => context.toBackendPath(`${f.tab.snapshot.location.path}/folder `), /路径/);
  assert.throws(() => context.fromBackendPath("/home/folder "), /路径/);
});

test("local casefold-colliding rows are identity-unverified, not partial aggregates borrowed from a sibling", () => {
  for (const names of [["Foo", "foo"], ["İ", "i\u0307"]]) {
    const f = fixture("local", undefined, names);
    assert.deepEqual(directorySizeLookupPaths(f.state, "panel-1", f.tab), []);
    for (const entry of f.tab.snapshot.entries) assert.equal(projectEntrySize(f.tab, entry).sizeDisplay?.bytes, null);
  }
});

test("raw hidden and filtered folders remain directory-size lookup targets", () => {
  const f = fixture("local", undefined, ["visible"]);
  const hidden = expansionEntry(f.tab.snapshot.location.path, "hidden-folder", "folder", { isHidden: true });
  f.tab.snapshot.entries = [...f.tab.snapshot.entries, hidden];
  f.state.fileVisibility = { ...f.state.fileVisibility, showHidden: false };
  f.state.search.filterText = "visible-name-that-cannot-match";
  assert.ok(directorySizeLookupPaths(f.state, "panel-1", f.tab).includes(hidden.path));
});

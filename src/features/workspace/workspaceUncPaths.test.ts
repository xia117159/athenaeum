import assert from "node:assert/strict";
import { test } from "node:test";
import { getParentLocationPath, normalizeLocationPath } from "./mockData";
import { mapDirectoryListingToSnapshot } from "./workspaceMappers";
import { getPathComparisonKey, getTopLevelPaths, isSameOrDescendantPath } from "./workspacePathRelations";
import { resolveWorkspaceDirectory } from "./workspaceDirectoryGateway";
import type { DirectoryListing } from "../../app/types";
import type { WorkspaceInvoke } from "./workspaceIpc";

const share = "\\\\server\\share";
const folder = share + "\\Docs";
const raw = "\\\\?\\UNC\\server\\share\\Docs";
const listing: DirectoryListing = {
  location: { kind: "local", path: raw }, parent: "\\\\?\\UNC\\server\\share\\", canGoUp: true,
  sizeFingerprint: "root-stamp", entries: [{
    name: "child", path: raw + "\\child", kind: "directory", isHidden: false, isSystem: false,
    isProtectedOperatingSystem: false, isReadOnly: false, isSymlink: false,
    location: { kind: "local", path: raw }, decoration: { tags: [] }
  }]
};

test("UNC normalization preserves namespace and is idempotent across ordinary, extended and slash paths", () => {
  for (const input of [folder, raw, "//server/share/Docs/", "\\\\server\\\\share\\\\Docs\\", "//?/UNC/server/share/Docs"]) {
    assert.equal(normalizeLocationPath(input), folder, input);
    assert.equal(normalizeLocationPath(normalizeLocationPath(input)), folder);
    assert.equal(getPathComparisonKey(input), folder.toLowerCase());
  }
  assert.notEqual(getPathComparisonKey("\\server\\share\\Docs"), getPathComparisonKey(folder));
  assert.equal(normalizeLocationPath("\\\\?\\C:\\Docs\\"), "C:\\Docs");
  assert.equal(normalizeLocationPath("C:\\"), "C:\\");
  assert.equal(normalizeLocationPath("sftp://user@host//Docs/"), "sftp://user@host/Docs/");
});

test("UNC navigation stops at the share and breadcrumbs never produce drive-relative paths", () => {
  assert.equal(getParentLocationPath(folder), share);
  assert.equal(getParentLocationPath(share), null);
  assert.equal(getParentLocationPath("\\\\?\\UNC\\server\\share\\"), null);
  const snapshot = mapDirectoryListingToSnapshot(listing);
  assert.equal(snapshot.location.path, folder);
  assert.equal(snapshot.entries[0].path, folder + "\\child");
  assert.equal(snapshot.entries[0].parentPath, folder);
  assert.equal(snapshot.sizeIdentityReliable, true);
  assert.equal(snapshot.sizeFingerprint, "root-stamp");
  assert.deepEqual(snapshot.breadcrumbs.map((crumb) => crumb.path), [share, folder]);
  assert.deepEqual(mapDirectoryListingToSnapshot({ ...listing, location: { kind: "local", path: share }, entries: [] })
    .breadcrumbs.map((crumb) => crumb.path), [share]);
});

test("UNC directory gateway sends an absolute share path and keeps it through the returned listing", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const invoke: WorkspaceInvoke = async <T>(command: string, args: Record<string, unknown>) => {
    calls.push([command, args]); return listing as T;
  };
  const snapshot = await resolveWorkspaceDirectory(raw, [], { invoke, runtimeHost: { isTauri: true } });
  assert.deepEqual(calls, [["list_directory", { path: folder }]]);
  assert.equal(snapshot.location.path, folder);
  assert.equal(snapshot.sizeIdentityReliable, true);
});

test("UNC operation paths retain two leading separators and preserve share/descendant boundaries", () => {
  assert.deepEqual(getTopLevelPaths([raw + "\\child", folder, share + "2\\Docs", "\\server\\share\\Docs"]),
    [folder, share + "2\\Docs", "\\server\\share\\Docs"]);
  assert.equal(isSameOrDescendantPath(share, raw), true);
  assert.equal(isSameOrDescendantPath(share, share + "2"), false);
  assert.equal(isSameOrDescendantPath(share, "\\server\\share\\Docs"), false);
});

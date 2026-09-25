import assert from "node:assert/strict";
import { test } from "node:test";
import type { DirectoryListing } from "../../app/types";
import { controllerFixture } from "./directorySizeControllerTestSupport";
import { mapDirectoryListingToSnapshot } from "./workspaceMappers";
import { workspaceReducer } from "./workspaceReducer";
import { exactSizeBytes, projectEntrySize } from "./directorySizes";
import { sizeRecord, sizeSnapshot } from "./directorySizeTestSupport";

function fixture() {
  const f = controllerFixture();
  const path = "C:\\data\\parent";
  const raw = { location: { kind: "local", path }, canGoUp: true, sizeFingerprint: "parent-stamp",
    entries: [{ path: `${path}\\deep`, name: "deep", kind: "directory", isHidden: false,
      isSystem: false, isProtectedOperatingSystem: false, isReadOnly: false, isSymlink: false,
      location: { kind: "local", path: `${path}\\deep` }, decoration: { tags: [] } }],
    directorySizeCache: { generation: 7, sequence: 9, directories: [
      sizeRecord(path, "60", "parent-stamp"), sizeRecord(`${path}\\deep`, "60", "deep-stamp")
    ] }
  } satisfies DirectoryListing & { directorySizeCache: unknown };
  const commit = () => workspaceReducer(f.state, { type: "tabSnapshotCommitted", payload: {
    panelId: "panel-1", tabId: f.tab.id, snapshot: mapDirectoryListingToSnapshot(raw), pushHistory: true
  } }).panels["panel-1"].tabs[0];
  return { f, raw, commit, path };
}

test("navigation's first committed listing displays cached grandchildren before any subscription or lookup", () => {
  const { commit } = fixture(); const tab = commit();
  assert.equal(tab.directorySizes, undefined);
  const row = projectEntrySize(tab, tab.snapshot.entries[0]);
  assert.equal(row.sizeLabel, "60 B");
  assert.equal(row.sizeDisplay?.state, "stale");
  assert.equal(row.sizeDisplay?.share, 1, "a cached scalar draws an advisory bar on the first listing");
  assert.equal(exactSizeBytes(row), null, "unverified hints cannot drive precise sorting");
  assert.notEqual(row.sizeDisplay?.retained, true);
});

test("a new tab retains an identified listing hint while a new scan starts, fails or is cancelled", () => {
  for (const phase of ["scanning", "failed", "cancelled", "stale", "queued"] as const) {
    const f = fixture();
    const createdAt = "2026-06-10T15:46:28.468277800Z";
    Object.assign(f.raw.entries[0], { createdAt });
    Object.assign(f.raw.directorySizeCache.directories[1], { createdAt, cachedAt: "2026-09-24T12:00:00Z" });
    const tab = f.commit();
    f.f.state.panels["panel-1"].tabs[0] = tab;
    const payload = { panelId: "panel-1" as const, tabId: tab.id, rootPath: f.path, consumerId: "next", requestVersion: 0 };
    let state = workspaceReducer(f.f.state, { type: "directorySizeLeaseStarted", payload });
    state = workspaceReducer(state, { type: "directorySizeSnapshotReceived", payload: { ...payload,
      snapshot: sizeSnapshot({ consumerId: "next", generation: 8, sequence: 1, phase, totalBytes: null }) } });
    const next = state.panels["panel-1"].tabs[0];
    const row = projectEntrySize(next, next.snapshot.entries[0]);
    assert.equal(row.sizeLabel, "60 B", phase);
    assert.equal(row.sizeDisplay?.share, 1, "display history gets an advisory known-size denominator");
    assert.equal(exactSizeBytes(row), null);
  }
});

test("an identified first-listing hint survives an ordinary refresh without a cache payload, but never object replacement", () => {
  const f = fixture();
  const createdAt = "2026-06-10T15:46:28.468277800Z";
  Object.assign(f.raw.entries[0], { createdAt });
  Object.assign(f.raw.directorySizeCache.directories[1], { createdAt, cachedAt: "2026-09-24T12:00:00Z" });
  let state = workspaceReducer(f.f.state, { type: "tabSnapshotCommitted", payload: {
    panelId: "panel-1", tabId: f.f.tab.id, snapshot: mapDirectoryListingToSnapshot(f.raw), pushHistory: true
  } });
  for (const replaced of [false, true]) {
    const raw: DirectoryListing = { ...f.raw, directorySizeCache: undefined,
      entries: f.raw.entries.map((entry) => ({ ...entry, createdAt: replaced ? "2026-09-25T00:00:00Z" : createdAt })) };
    state = workspaceReducer(state, { type: "tabSnapshotCommitted", payload: {
      panelId: "panel-1", tabId: f.f.tab.id, snapshot: mapDirectoryListingToSnapshot(raw), pushHistory: false
    } });
    const tab = state.panels["panel-1"].tabs[0];
    const row = projectEntrySize(tab, tab.snapshot.entries[0]);
    assert.equal(row.sizeLabel, replaced ? "--" : "60 B");
    assert.equal(exactSizeBytes(row), null);
    assert.equal(row.sizeDisplay?.share, replaced ? null : 1);
  }
});

test("cache hints reject mismatched fingerprints and unreliable listing identity", () => {
  for (const change of ["fingerprint", "identity"] as const) {
    const f = fixture();
    if (change === "fingerprint") f.raw.sizeFingerprint = "changed";
    else f.raw.entries[0].path += " ";
    const tab = f.commit();
    assert.equal(projectEntrySize(tab, tab.snapshot.entries[0]).sizeLabel, "--");
  }
});

test("stale or incompatible generation clears a hint so it cannot return on a later lease", () => {
  for (const snapshot of [sizeSnapshot({ generation: 7, phase: "stale" }), sizeSnapshot({ generation: 8, phase: "queued" })]) {
    const f = fixture(); const tab = f.commit();
    f.f.state.panels["panel-1"].tabs[0] = tab;
    const payload = { panelId: "panel-1" as const, tabId: tab.id, rootPath: f.path, consumerId: snapshot.consumerId, requestVersion: 0 };
    let state = workspaceReducer(f.f.state, { type: "directorySizeLeaseStarted", payload });
    state = workspaceReducer(state, { type: "directorySizeSnapshotReceived", payload: { ...payload, snapshot } });
    state = workspaceReducer(state, { type: "directorySizeLeaseStarted", payload: { ...payload, consumerId: "later" } });
    const next = state.panels["panel-1"].tabs[0];
    assert.equal(projectEntrySize(next, next.snapshot.entries[0]).sizeLabel, "--");
  }
});

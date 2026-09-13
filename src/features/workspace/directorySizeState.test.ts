import assert from "node:assert/strict";
import { test } from "node:test";
import { reduceDirectorySizes } from "./directorySizeState";
import { sizeFixture, sizeRecord, sizeSnapshot } from "./directorySizeTestSupport";
import { expansionEntry } from "./folderExpansionTestSupport";
import { getPathComparisonKey } from "./workspacePathRelations";
import { workspaceReducer } from "./workspaceReducer";
import type { DirectorySizeLookup } from "./directorySizeTypes";

function target() {
  const fixture = sizeFixture();
  return { ...fixture, payload: { panelId: "panel-1" as const, tabId: fixture.tab.id, rootPath: fixture.path,
    consumerId: "size-test", requestVersion: 0 } };
}

test("first remote calculate joins shared work while recalculate forces a new generation", () => {
  const fixture = sizeFixture("ftp");
  const tab = { ...fixture.tab, directorySizes: undefined };
  const payload = { panelId: "panel-1" as const, tabId: tab.id, rootPath: fixture.path, intent: "calculate" as const };
  const first = reduceDirectorySizes(tab, { type: "directorySizeRequested", payload });
  assert.equal(first.directorySizes?.requested, true);
  assert.equal(first.directorySizes?.forceRefresh, false);
  assert.equal(first.directorySizes?.manualStarted, true);
  const again = reduceDirectorySizes(first, { type: "directorySizeRequested", payload });
  assert.equal(again.directorySizes?.forceRefresh, true);
});

test("size cancel clears exact data and pauses until a new explicit request", () => {
  const { tab, payload } = target();
  const cancelled = reduceDirectorySizes(tab, { type: "directorySizeRequested", payload: { ...payload, intent: "cancel" } });
  assert.equal(cancelled.directorySizes?.paused, true);
  assert.equal(cancelled.directorySizes?.requested, false);
  assert.deepEqual(cancelled.directorySizes?.records, {});
  assert.equal(cancelled.directorySizes?.snapshot?.phase, "cancelled");
  assert.equal(reduceDirectorySizes(cancelled, { type: "directorySizeSnapshotReceived", payload: { ...payload, snapshot: sizeSnapshot() } }), cancelled);
  const retried = reduceDirectorySizes(cancelled, { type: "directorySizeRequested", payload: { ...payload, intent: "calculate" } });
  assert.equal(retried.directorySizes?.paused, false);
  assert.equal(retried.directorySizes?.requested, true);
  assert.equal(retried.directorySizes?.forceRefresh, true);
  assert.equal(retried.directorySizes?.requestVersion, 2);
});

test("lease and snapshot fences reject another consumer root request or out of order return", () => {
  const { tab, payload } = target();
  const newer = sizeSnapshot({ generation: 4, sequence: 10, totalBytes: "160" });
  const updated = reduceDirectorySizes(tab, { type: "directorySizeSnapshotReceived", payload: { ...payload, snapshot: newer } });
  assert.equal(updated.directorySizes?.snapshot, newer);
  assert.deepEqual(updated.directorySizes?.records, {});
  for (const patch of [{ consumerId: "other" }, { rootPath: "C:\\other" }, { requestVersion: 1 }, { tabId: "other" }]) {
    assert.equal(reduceDirectorySizes(updated, { type: "directorySizeSnapshotReceived", payload: { ...payload, ...patch, snapshot: sizeSnapshot({ sequence: 100 }) } }), updated);
  }
  for (const snapshot of [sizeSnapshot({ phase: "queued" }), sizeSnapshot({ generation: 4, sequence: 9 }), sizeSnapshot({ generation: 4, sequence: 10, phase: "queued" })]) {
    assert.equal(reduceDirectorySizes(updated, { type: "directorySizeSnapshotReceived", payload: { ...payload, snapshot } }), updated);
  }
  assert.equal(reduceDirectorySizes(updated, { type: "directorySizeSnapshotReceived", payload: { ...payload, snapshot: { ...newer, consumerId: "other", sequence: 100 } } }), updated);
});

test("lookups only populate matching terminal generation and sequence, stale is not an empty folder", () => {
  const { tab, payload, parent } = target();
  const lookup: DirectorySizeLookup = { consumerId: payload.consumerId, generation: 1, sequence: 2, stale: false,
    directories: [sizeRecord(parent.path, "75")] };
  const updated = reduceDirectorySizes(tab, { type: "directorySizeLookupReceived", payload: { ...payload, lookup } });
  assert.equal(updated.directorySizes?.records[getPathComparisonKey(parent.path)].bytes, "75");
  for (const patch of [{ generation: 2 }, { sequence: 1 }, { sequence: 3 }, { consumerId: "other" }]) {
    assert.equal(reduceDirectorySizes(updated, { type: "directorySizeLookupReceived", payload: { ...payload, lookup: { ...lookup, ...patch } } }), updated);
  }
  const stale = reduceDirectorySizes(updated, { type: "directorySizeLookupReceived", payload: { ...payload, lookup: { ...lookup, stale: true, directories: [] } } });
  assert.equal(stale.directorySizes?.snapshot?.phase, "stale");
  assert.equal(stale.directorySizes?.snapshot?.totalBytes, null);
  assert.deepEqual(stale.directorySizes?.records, {});
});

test("release is fenced, remote visibility does not grant another recursive scan, F5 is explicit", () => {
  const { tab, payload } = target();
  const local = reduceDirectorySizes(tab, { type: "directorySizeReleased", payload });
  assert.equal(local.directorySizes?.consumerId, undefined);
  assert.equal(local.directorySizes?.requested, false);
  assert.equal(local.directorySizes?.paused, false);
  assert.deepEqual(local.directorySizes?.records, {});
  const remote = sizeFixture("sftp").tab;
  const remotePayload = { ...payload, rootPath: remote.snapshot.location.path, tabId: remote.id };
  const released = reduceDirectorySizes(remote, { type: "directorySizeReleased", payload: remotePayload });
  assert.equal(released.directorySizes?.manualStarted, true);
  assert.equal(released.directorySizes?.requested, false);
  const refreshed = reduceDirectorySizes(released, { type: "directorySizeRequested", payload: { ...remotePayload, intent: "refresh" } });
  assert.equal(refreshed.directorySizes?.requested, true);
  assert.equal(reduceDirectorySizes(refreshed, { type: "directorySizeReleased", payload: remotePayload }), refreshed);
  const untouched = { ...remote, directorySizes: undefined };
  assert.equal(reduceDirectorySizes(untouched, { type: "directorySizeRequested", payload: { ...remotePayload, intent: "refresh" } }), untouched);
});

test("failed listeners and commands expose a terminal reason without an automatic retry loop", () => {
  const { tab, payload } = target();
  const failed = reduceDirectorySizes(tab, { type: "directorySizeFailed", payload: { ...payload, message: "无法监听大小统计" } });
  assert.equal(failed.directorySizes?.snapshot?.phase, "failed");
  assert.equal(failed.directorySizes?.snapshot?.reason, "无法监听大小统计");
  assert.equal(failed.directorySizes?.paused, true);
  assert.deepEqual(failed.directorySizes?.records, {});
});

test("navigation clears transient size intent including cancelled roots, not only the lookup key", () => {
  const { state, tab, payload } = target();
  tab.directorySizes!.paused = true;
  const away = workspaceReducer(state, { type: "tabSnapshotCommitted", payload: { panelId: payload.panelId, tabId: tab.id,
    snapshot: { ...tab.snapshot, location: { ...tab.snapshot.location, path: "C:\\different" } }, pushHistory: true } });
  assert.equal(away.panels["panel-1"].tabs[0].directorySizes, undefined);
  const back = workspaceReducer(away, { type: "tabSnapshotCommitted", payload: { panelId: payload.panelId, tabId: tab.id, snapshot: tab.snapshot, pushHistory: true } });
  assert.equal(back.panels["panel-1"].tabs[0].directorySizes, undefined);
});

test("one-layer root alignment keeps ready branches and only reschedules in-flight branches", () => {
  const { tab, parent, payload } = target();
  const ready = tab.folderExpansion![getPathComparisonKey(parent.path)];
  const loadingEntry = expansionEntry(tab.snapshot.location.path, "loading");
  tab.snapshot.entries.push(loadingEntry);
  tab.folderExpansion![getPathComparisonKey(loadingEntry.path)] = { path: loadingEntry.path, entries: [], status: "loading", requestId: 3 };
  const snapshot = { ...tab.snapshot, sizeFingerprint: "aligned" };
  const updated = reduceDirectorySizes(tab, { type: "directorySizeListingAligned", payload: { ...payload, generation: 1, snapshot, expectedRoot: tab.snapshot } });
  assert.equal(updated.snapshot, snapshot);
  assert.equal(updated.folderExpansion![getPathComparisonKey(parent.path)], ready);
  assert.equal(updated.folderExpansion![getPathComparisonKey(loadingEntry.path)].status, "idle");
  assert.equal(reduceDirectorySizes(updated, { type: "directorySizeListingAligned", payload: { ...payload, generation: 1, snapshot: tab.snapshot, expectedRoot: tab.snapshot } }), updated);
});

test("branch alignment prunes removed descendants and selection/edit without clearing siblings", () => {
  const { tab, parent, child, payload } = target();
  const branch = tab.folderExpansion![getPathComparisonKey(parent.path)];
  tab.selectedEntryIds = [child.id]; tab.selectionCursorId = child.id;
  tab.inlineEdit = { mode: "rename", entryId: child.id, value: child.name, kind: "file", parentPath: parent.path };
  const snapshot = { ...tab.snapshot, location: { ...tab.snapshot.location, path: parent.path }, entries: [], sizeFingerprint: "empty" };
  const action = { type: "directorySizeListingAligned" as const, payload: { ...payload, generation: 1, snapshot, expectedRoot: tab.snapshot, expectedBranch: branch } };
  const updated = reduceDirectorySizes(tab, action);
  assert.equal(updated.snapshot, tab.snapshot);
  assert.deepEqual(updated.folderExpansion![getPathComparisonKey(parent.path)].entries, []);
  assert.equal(updated.folderExpansion![getPathComparisonKey(parent.path)].sizeFingerprint, "empty");
  assert.deepEqual(updated.selectedEntryIds, []);
  assert.equal(updated.inlineEdit, undefined);
  assert.equal(updated.selectionCursorId, null);
  assert.equal(reduceDirectorySizes(updated, action), updated);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { workspaceReducer, type WorkspaceAction } from "./workspaceReducer";
import { projectEntrySize } from "./directorySizes";
import { getFolderListingRows } from "./folderExpansion";
import { controllerFixture } from "./directorySizeControllerTestSupport";
import { sizeFixture, sizeRecord, sizeSnapshot } from "./directorySizeTestSupport";
import { expansionEntry, expansionSnapshot } from "./folderExpansionTestSupport";
import { getPathComparisonKey } from "./workspacePathRelations";
import { toPersistedSession } from "./workspaceSessionStore";
import type { DirectorySnapshot, EntryViewModel } from "./types";

function retainedFixture(kind: "local" | "ftp" | "sftp" = "local") {
  const f = controllerFixture(kind);
  f.tab.directorySizes = sizeFixture(kind).sizes;
  let state = f.state;
  const payload = { panelId: "panel-1" as const, tabId: f.tab.id, rootPath: f.path, consumerId: "size-test", requestVersion: 0 };
  const send = (action: WorkspaceAction) => { state = workspaceReducer(state, action); };
  return { ...f, payload, send, get state() { return state; }, get current() { return state.panels["panel-1"].tabs[0]; },
    stale() { send({ type: "directorySizeSnapshotReceived", payload: { ...payload, snapshot: sizeSnapshot({ phase: "stale", generation: 2 }) } }); },
    navigate(snapshot: DirectorySnapshot) { send({ type: "tabSnapshotCommitted", payload: { panelId: "panel-1", tabId: f.tab.id, snapshot, pushHistory: false } }); },
    display(entry = f.parent) { return projectEntrySize(state.panels["panel-1"].tabs[0], entry).sizeDisplay!; }
  };
}

test("successful removal, replacement identity, links and ambiguous listings reject retained rows", () => {
  for (const scenario of ["removed", "replaced", "link", "ambiguous"] as const) {
    const h = retainedFixture(); h.stale();
    let parent: EntryViewModel = h.parent;
    if (scenario === "removed") h.navigate({ ...h.tab.snapshot, entries: [h.a, h.b] });
    if (scenario === "replaced") parent = { ...h.parent, sizeCreatedAt: "2026-09-18T13:02:00.123456Z" };
    if (scenario === "link") parent = { ...h.parent, attributes: ["L"] };
    h.navigate({ ...h.tab.snapshot, entries: [parent, h.a, h.b], sizeIdentityReliable: scenario !== "ambiguous" });
    assert.equal(h.display(parent).share, null, scenario);
    assert.equal(h.display(parent).label, "--", scenario);
  }
});

test("retained directory sizes remain sortable, partial and zero are not erased", () => {
  const h = retainedFixture();
  h.tab.sort = { columnId: "size", direction: "asc" };
  h.tab.snapshot.entries = [h.parent, expansionEntry(h.path, "a-unknown"), h.a];
  h.tab.directorySizes!.records[getPathComparisonKey(`${h.path}\\a-unknown`)] = sizeRecord(`${h.path}\\a-unknown`, null, "", "unknown");
  h.stale();
  assert.deepEqual(getFolderListingRows(h.current).filter((row) => row.depth === 0).map(({ entry }) => entry.name), ["parent", "a-unknown", "a.txt"]);
  for (const bytes of ["0", "40"]) {
    const p = retainedFixture();
    p.tab.directorySizes!.snapshot = sizeSnapshot({ phase: "partial", totalBytes: null });
    p.tab.directorySizes!.records[getPathComparisonKey(p.parent.path)] = sizeRecord(p.parent.path, bytes, "parent-stamp", "partial");
    p.stale();
    assert.equal(p.display().label, `≥${bytes} B`);
    assert.notEqual(p.display().share, null);
  }
});

test("historical values cannot be overwritten by stale consumers or generations", () => {
  const h = retainedFixture(); h.stale();
  const before = h.current;
  for (const patch of [{ consumerId: "another" }, { requestVersion: 9 }, { rootPath: "C:\\another" }]) {
    h.send({ type: "directorySizeSnapshotReceived", payload: { ...h.payload, ...patch, snapshot: sizeSnapshot({ generation: 100 }) } });
    assert.equal(h.current.directorySizePresentation, before.directorySizePresentation);
    assert.equal(h.current.directorySizes, before.directorySizes);
  }
  h.send({ type: "directorySizeSnapshotReceived", payload: { ...h.payload, snapshot: sizeSnapshot({ generation: 1, sequence: 100 }) } });
  assert.equal(h.current.directorySizePresentation, before.directorySizePresentation);
  assert.equal(h.current.directorySizes, before.directorySizes);
  assert.equal(h.display().label, "60 B");
});

for (const kind of ["ftp", "sftp"] as const) test(`${kind} partial null fingerprints replace history and changed profiles invalidate it`, () => {
  const h = retainedFixture(kind); h.stale();
  h.navigate({ ...h.tab.snapshot, sizeFingerprint: null });
  h.send({ type: "directorySizeSnapshotReceived", payload: { ...h.payload,
    snapshot: sizeSnapshot({ generation: 2, sequence: 3, phase: "partial", totalBytes: null, freshness: "snapshot" }) } });
  h.send({ type: "directorySizeLookupReceived", payload: { ...h.payload, expectedRoot: h.current.snapshot, expectedExpansion: h.current.folderExpansion, lookup: {
    consumerId: "size-test", generation: 2, sequence: 3, stale: false, directories: [
      { ...sizeRecord(h.path, "80", "", "partial"), sizeFingerprint: null },
      { ...sizeRecord(h.parent.path, "40", "", "partial"), sizeFingerprint: null }
    ]
  } } });
  assert.equal(h.display().label, "≥40 B");
  assert.equal(h.display().share, .5);
  assert.match(h.display().title, /时间点快照/);
  h.send({ type: "remoteProfilesUpdated", payload: h.state.remoteProfiles.map((profile) => ({ ...profile, rootPath: "/different" })) });
  assert.equal(h.display().share, null);
  assert.equal(h.current.directorySizes, undefined);
});

test("remote reconnect placeholders and failed branches retain history until a successful listing confirms deletion", () => {
  const h = retainedFixture("sftp"); h.stale();
  h.send({ type: "tabReconnectRequired", payload: { panelId: "panel-1", tabId: h.tab.id, path: h.path, message: "offline" } });
  assert.equal(h.current.snapshot.entries.length, 0);
  h.navigate(h.tab.snapshot);
  assert.equal(h.display().label, "60 B");
  assert.equal(h.display(h.child).share, .6);

  const key = getPathComparisonKey(h.parent.path);
  if (!h.current.folderExpansion?.[key]) h.send({ type: "folderExpansionToggled", payload: { panelId: "panel-1", tabId: h.tab.id, path: h.parent.path } });
  const rootSnapshot = h.current.snapshot;
  h.send({ type: "folderExpansionLoadStarted", payload: { panelId: "panel-1", tabId: h.tab.id, path: h.parent.path, rootSnapshot, requestId: 1 } });
  h.send({ type: "folderExpansionLoadFailed", payload: { panelId: "panel-1", tabId: h.tab.id, path: h.parent.path, rootSnapshot, requestId: 1, errorMessage: "denied" } });
  h.send({ type: "folderExpansionLoadStarted", payload: { panelId: "panel-1", tabId: h.tab.id, path: h.parent.path, rootSnapshot, requestId: 2 } });
  h.send({ type: "folderExpansionLoadSucceeded", payload: { panelId: "panel-1", tabId: h.tab.id, path: h.parent.path, rootSnapshot, requestId: 2,
    snapshot: { ...expansionSnapshot(h.parent.path, [h.child]), sizeFingerprint: "parent-stamp" } } });
  assert.equal(h.current.folderExpansion?.[key].status, "ready");
  assert.equal(h.display(h.child).share, .6);
});

test("history is bounded and excluded from persisted sessions", () => {
  const h = retainedFixture(); h.stale();
  for (let index = 0; index < 12; index++) {
    const path = `C:\\history-${index}`;
    const child = expansionEntry(path, "file.txt", "file", { sizeBytes: 10, sizeLabel: "10 B" });
    h.navigate({ ...expansionSnapshot(path, [child]), sizeFingerprint: "stamp" });
    const payload = { ...h.payload, rootPath: path };
    h.send({ type: "directorySizeLeaseStarted", payload });
    h.send({ type: "directorySizeSnapshotReceived", payload: { ...payload, snapshot: sizeSnapshot() } });
    h.send({ type: "directorySizeLookupReceived", payload: { ...payload, expectedRoot: h.current.snapshot, expectedExpansion: h.current.folderExpansion, lookup: { consumerId: "size-test", generation: 1, sequence: 2, stale: false,
      directories: [sizeRecord(path, "10", "stamp")] } } });
  }
  assert.ok(h.current.directorySizePresentation!.history.length <= 7);
  assert.ok(h.current.directorySizePresentation!.history.reduce((count, view) => count + Object.keys(view.rows).length, 0) <= 20000);
  assert.equal(JSON.stringify(toPersistedSession(h.state)).includes("directorySizePresentation"), false);
});

test("large active listings retain values but do not become unbounded historical roots", () => {
  const h = retainedFixture();
  h.tab.folderExpansion = undefined;
  h.tab.snapshot.entries = Array.from({ length: 20001 }, (_, index) => expansionEntry(h.path, `file-${index}`, "file", { sizeBytes: 1, sizeLabel: "1 B" }));
  h.stale();
  assert.equal(Object.keys(h.current.directorySizePresentation!.current!.rows).length, 20001);
  h.navigate(expansionSnapshot("C:\\different", []));
  assert.equal(h.current.directorySizePresentation!.history.length, 0);
});

test("deleting a folder invalidates previously visited descendant views", () => {
  const h = retainedFixture();
  h.navigate({ ...expansionSnapshot(h.parent.path, [h.child]), sizeFingerprint: "parent-stamp" });
  const payload = { ...h.payload, rootPath: h.parent.path };
  h.send({ type: "directorySizeLeaseStarted", payload });
  h.send({ type: "directorySizeSnapshotReceived", payload: { ...payload, snapshot: sizeSnapshot() } });
  h.send({ type: "directorySizeLookupReceived", payload: { ...payload, expectedRoot: h.current.snapshot, expectedExpansion: h.current.folderExpansion, lookup: { consumerId: "size-test", generation: 1, sequence: 2, stale: false,
    directories: [sizeRecord(h.parent.path, "60", "parent-stamp")] } } });
  h.navigate(h.tab.snapshot);
  h.navigate({ ...h.tab.snapshot, entries: [h.a, h.b] });
  h.navigate({ ...expansionSnapshot(h.parent.path, [h.child]), sizeFingerprint: "parent-stamp" });
  assert.equal(h.display(h.child).share, null, "a recreated path cannot resurrect a deleted descendant's cached proportion");
});

test("deleting an unknown-sized parent also invalidates retained descendant rows", () => {
  const h = retainedFixture();
  const childRecord = sizeRecord(h.child.path, "60", "child-stamp");
  h.tab.directorySizes!.records[getPathComparisonKey(h.parent.path)] = sizeRecord(h.parent.path, null, "parent-stamp", "unknown");
  h.tab.directorySizes!.records[getPathComparisonKey(h.child.path)] = childRecord;
  h.navigate({ ...h.tab.snapshot, sizeFingerprint: "root-stamp" });
  assert.equal(h.current.directorySizePresentation!.current!.rows[h.parent.path], undefined);
  assert.ok(h.current.directorySizePresentation!.current!.rows[h.child.path]);

  h.navigate({ ...h.tab.snapshot, entries: [h.a, h.b], sizeFingerprint: "root-stamp" });
  assert.equal(h.current.directorySizePresentation!.current!.rows[h.child.path], undefined,
    "the successful root listing must remove the detached descendant history");
  h.navigate({ ...h.tab.snapshot, entries: [h.parent, h.a, h.b], sizeFingerprint: "root-stamp" });
  const rootSnapshot = h.current.snapshot;
  h.send({ type: "folderExpansionToggled", payload: { panelId: "panel-1", tabId: h.tab.id, path: h.parent.path } });
  const branch = h.current.folderExpansion![getPathComparisonKey(h.parent.path)];
  h.send({ type: "folderExpansionLoadStarted", payload: { panelId: "panel-1", tabId: h.tab.id, path: h.parent.path,
    rootSnapshot, requestId: 1, expectedBranch: branch } });
  h.send({ type: "folderExpansionLoadSucceeded", payload: { panelId: "panel-1", tabId: h.tab.id, path: h.parent.path,
    rootSnapshot, requestId: 1, snapshot: expansionSnapshot(h.parent.path, [h.child]) } });
  assert.notEqual(h.display(h.child).retained, true, "a recreated parent must not inherit its old descendant result");
});

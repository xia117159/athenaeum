import assert from "node:assert/strict";
import { test } from "node:test";
import { controllerFixture } from "./directorySizeControllerTestSupport";
import { mapDirectoryListingToSnapshot } from "./workspaceMappers";
import { workspaceReducer, type WorkspaceAction } from "./workspaceReducer";
import { exactSizeBytes, projectEntrySize } from "./directorySizes";
import { sizeRecord, sizeSnapshot } from "./directorySizeTestSupport";

const createdAt = "2026-09-20T00:00:00Z";
const cachedAt = "2026-09-23T12:00:00Z";
function fixture() {
  const f = controllerFixture();
  const path = f.path;
  const child = `${path}\\cached`;
  const raw = { location: { kind: "local" as const, path }, canGoUp: true, sizeFingerprint: "new-contents",
    entries: [{ path: child, name: "cached", kind: "directory" as const, createdAt, isHidden: false,
      isSystem: false, isProtectedOperatingSystem: false, isReadOnly: false, isSymlink: false,
      location: { kind: "local" as const, path: child }, decoration: { tags: [] } }],
    directorySizeCache: { generation: 0, sequence: 0, historical: true, directories: [
      { ...sizeRecord(child, "60", "old-contents"), cachedAt, createdAt }
    ] }
  };
  f.state.panels["panel-1"].tabs[0] = { ...f.tab, snapshot: mapDirectoryListingToSnapshot(raw), directorySizes: undefined };
  const payload = { panelId: "panel-1" as const, tabId: f.tab.id, rootPath: path, consumerId: "history", requestVersion: 0 };
  const display = () => {
    const tab = f.state.panels["panel-1"].tabs[0];
    return projectEntrySize(tab, tab.snapshot.entries[0]);
  };
  const send = (action: WorkspaceAction) => { f.state = workspaceReducer(f.state, action); };
  return { f, raw, path, child, payload, display, send };
}

test("restart history displays before subscribe despite changed contents and survives background lifecycle", () => {
  const h = fixture();
  assert.equal(h.display().sizeLabel, "60 B");
  assert.equal(h.display().sizeDisplay?.share, 1);
  assert.equal(exactSizeBytes(h.display()), null, "historical display never certifies a live result");
  assert.match(h.display().sizeDisplay!.title, /2026/);
  h.send({ type: "directorySizeLeaseStarted", payload: h.payload });
  for (const [sequence, phase] of [[1, "queued"], [2, "scanning"], [3, "stale"], [4, "failed"]] as const) {
    h.send({ type: "directorySizeSnapshotReceived", payload: { ...h.payload,
      snapshot: sizeSnapshot({ consumerId: "history", generation: 1, sequence, phase, reason: "test failure" }) } });
    assert.equal(h.display().sizeLabel, "60 B", phase);
    assert.equal(h.display().sizeDisplay?.share, 1, phase);
  }
  assert.match(h.display().sizeDisplay!.title, /失败/);
  h.send({ type: "directorySizeRequested", payload: { ...h.payload, intent: "cancel" } });
  assert.equal(h.display().sizeLabel, "60 B");
  assert.match(h.display().sizeDisplay!.title, /取消/);
});

test("current exact bytes supersede history even before the ratio denominator arrives", () => {
  const h = fixture();
  h.send({ type: "directorySizeLeaseStarted", payload: h.payload });
  h.send({ type: "directorySizeSnapshotReceived", payload: { ...h.payload,
    snapshot: sizeSnapshot({ consumerId: "history", generation: 1, sequence: 1 }) } });
  h.send({ type: "directorySizeLookupReceived", payload: { ...h.payload, expectedRoot: h.f.state.panels["panel-1"].tabs[0].snapshot, expectedExpansion: h.f.state.panels["panel-1"].tabs[0].folderExpansion, lookup: {
    consumerId: "history", generation: 1, sequence: 1, stale: false, directories: [
      sizeRecord(h.path, "80", "new-contents"), sizeRecord(h.child, "80", "new-child")
    ] } } });
  assert.equal(h.display().sizeLabel, "80 B");
  assert.equal(h.display().sizeDisplay?.state, "complete");
  h.send({ type: "directorySizeSnapshotReceived", payload: { ...h.payload,
    snapshot: sizeSnapshot({ consumerId: "history", generation: 2, sequence: 2, phase: "scanning" }) } });
  assert.equal(h.display().sizeLabel, "80 B", "refresh retains the newer live value instead of reverting to disk history");
});

test("history never attaches to a replaced directory or a link", () => {
  for (const replacement of ["created", "link"] as const) {
    const h = fixture();
    if (replacement === "created") h.raw.entries[0].createdAt = "2026-09-24T00:00:00Z";
    else h.raw.entries[0].isSymlink = true;
    h.f.state.panels["panel-1"].tabs[0].snapshot = mapDirectoryListingToSnapshot(h.raw);
    assert.equal(h.display().sizeLabel, "--");
  }
});

test("successive bounded refreshes retain a complete size/bar pair until sibling details arrive", () => {
  const h = fixture();
  const tab = h.f.state.panels["panel-1"].tabs[0];
  const sibling = `${h.path}\\sibling`;
  tab.snapshot.entries.push({ ...tab.snapshot.entries[0], path: sibling, id: sibling, name: "sibling" });
  h.send({ type: "directorySizeLeaseStarted", payload: h.payload });
  for (const generation of [1, 2]) {
    h.send({ type: "directorySizeSnapshotReceived", payload: { ...h.payload,
      snapshot: sizeSnapshot({ consumerId: "history", generation, sequence: 1 }) } });
    h.send({ type: "directorySizeLookupReceived", payload: { ...h.payload, expectedRoot: h.f.state.panels["panel-1"].tabs[0].snapshot, expectedExpansion: h.f.state.panels["panel-1"].tabs[0].folderExpansion, lookup: {
      consumerId: "history", generation, sequence: 1, stale: false, directories: [
        sizeRecord(h.path, "100", "new-contents"), sizeRecord(h.child, generation === 1 ? "80" : "90", "child"),
        ...(generation === 1 ? [sizeRecord(sibling, "20", "sibling")] : [])
      ] } } });
    assert.equal(h.display().sizeLabel, "80 B");
    assert.equal(h.display().sizeDisplay?.share, .8);
  }
  h.send({ type: "directorySizeSnapshotReceived", payload: { ...h.payload,
    snapshot: sizeSnapshot({ consumerId: "history", generation: 3, sequence: 1, phase: "scanning" }) } });
  assert.equal(h.display().sizeLabel, "80 B");
  assert.equal(h.display().sizeDisplay?.share, .8, "keep the previous numerator and proportion together while refreshing");
  h.send({ type: "directorySizeSnapshotReceived", payload: { ...h.payload,
    snapshot: sizeSnapshot({ consumerId: "history", generation: 3, sequence: 2 }) } });
  h.send({ type: "directorySizeLookupReceived", payload: { ...h.payload, expectedRoot: h.f.state.panels["panel-1"].tabs[0].snapshot, expectedExpansion: h.f.state.panels["panel-1"].tabs[0].folderExpansion, lookup: {
    consumerId: "history", generation: 3, sequence: 2, stale: false, directories: [
      sizeRecord(h.path, "100", "new-contents"), sizeRecord(h.child, "90", "child"), sizeRecord(sibling, "10", "sibling")
    ] } } });
  assert.equal(h.display().sizeLabel, "90 B");
  assert.equal(h.display().sizeDisplay?.share, .9, "aligned new results replace both parts together");
});

test("a scalar with no previous proportion may update while sibling details are still missing", () => {
  const h = fixture();
  const tab = h.f.state.panels["panel-1"].tabs[0];
  tab.snapshot.entries.push({ ...tab.snapshot.entries[0], path: `${h.path}\\missing`, id: "missing", name: "missing" });
  h.send({ type: "directorySizeLeaseStarted", payload: h.payload });
  h.send({ type: "directorySizeSnapshotReceived", payload: { ...h.payload,
    snapshot: sizeSnapshot({ consumerId: "history", generation: 1, sequence: 1 }) } });
  h.send({ type: "directorySizeLookupReceived", payload: { ...h.payload, expectedRoot: h.f.state.panels["panel-1"].tabs[0].snapshot, expectedExpansion: h.f.state.panels["panel-1"].tabs[0].folderExpansion, lookup: {
    consumerId: "history", generation: 1, sequence: 1, stale: false,
    directories: [sizeRecord(h.path, "100", "new-contents"), sizeRecord(h.child, "80", "child")]
  } } });
  assert.equal(h.display().sizeLabel, "80 B");
  assert.equal(h.display().sizeDisplay?.share, 1);
});

test("history tooltip distinguishes a finished scan with missing details from a running refresh", () => {
  const h = fixture();
  h.send({ type: "directorySizeLeaseStarted", payload: h.payload });
  h.send({ type: "directorySizeSnapshotReceived", payload: { ...h.payload,
    snapshot: sizeSnapshot({ consumerId: "history", generation: 1, sequence: 1 }) } });
  assert.equal(h.display().sizeLabel, "60 B");
  assert.doesNotMatch(h.display().sizeDisplay!.title, /后台刷新中/);
});

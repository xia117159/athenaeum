import assert from "node:assert/strict";
import { test } from "node:test";
import { workspaceReducer } from "./workspaceReducer";
import { projectEntrySize } from "./directorySizes";
import { getFolderListingRows } from "./folderExpansion";
import { sizeFixture, sizeRecord, sizeSnapshot } from "./directorySizeTestSupport";
import { expansionSnapshot } from "./folderExpansionTestSupport";
import { getPathComparisonKey } from "./workspacePathRelations";
import type { DirectorySizeAction } from "./directorySizeState";
import type { EntryViewModel } from "./types";

function fixture() {
  const f = sizeFixture();
  let state = f.state;
  const payload = { panelId: "panel-1" as const, tabId: f.tab.id, rootPath: f.path, consumerId: "size-test", requestVersion: 0 };
  return { ...f, payload, get current() { return state.panels["panel-1"].tabs[0]; },
    send(action: Parameters<typeof workspaceReducer>[1]) { state = workspaceReducer(state, action); },
    size(type: DirectorySizeAction["type"], extra: object = {}) {
      state = workspaceReducer(state, { type, payload: { ...payload, ...extra } } as DirectorySizeAction);
    },
    display(entry = f.parent, mode: "folder-total" | "folder-max" = "folder-total") {
      return projectEntrySize(state.panels["panel-1"].tabs[0], entry, mode).sizeDisplay!;
    }
  };
}

test("known folder values and all bars survive release, resubscribe and split cached lookup", () => {
  const h = fixture();
  const unchanged = () => {
    assert.equal(h.display().label, "60 B");
    assert.equal(h.display().share, .6);
    assert.equal(h.display(h.a).share, .3);
  };
  h.size("directorySizeReleased"); unchanged();
  h.payload.consumerId = "next-consumer";
  h.size("directorySizeLeaseStarted"); unchanged();
  h.size("directorySizeSnapshotReceived", { snapshot: sizeSnapshot({ consumerId: h.payload.consumerId, phase: "queued" }) }); unchanged();
  h.size("directorySizeSnapshotReceived", { snapshot: sizeSnapshot({ consumerId: h.payload.consumerId, sequence: 3 }) }); unchanged();
  const lookup = { consumerId: h.payload.consumerId, generation: 1, sequence: 3, stale: false };
  h.size("directorySizeLookupReceived", { lookup: { ...lookup, directories: [sizeRecord(h.path, "120", "root-stamp")] } }); unchanged();
  h.size("directorySizeLookupReceived", { lookup: { ...lookup, directories: [sizeRecord(h.parent.path, "80", "parent-stamp")] } });
  assert.equal(h.display().label, "80 B");
  assert.equal(h.display().share, .666666);
  assert.equal(h.display(h.a).share, .25);
});

test("filesystem invalidation, cancel and failures retain known values and both bar modes", () => {
  for (const reason of ["cancel", "failed", "stale", "scanning"] as const) {
    const h = fixture();
    if (reason === "cancel") h.size("directorySizeRequested", { intent: "cancel" });
    else if (reason === "failed") h.size("directorySizeFailed", { message: "permission denied" });
    else h.size("directorySizeSnapshotReceived", { snapshot: sizeSnapshot({ generation: 2, phase: reason }) });
    assert.equal(h.display().label, "60 B", reason);
    assert.equal(h.display().share, .6, reason);
    assert.equal(h.display(h.a, "folder-max").share, .5, reason);
    assert.equal(h.display().state, "stale");
    assert.match(h.display().title, /上次/);
    if (reason === "failed") assert.match(h.display().title, /permission denied/);
    if (reason === "cancel") assert.match(h.display().title, /取消/);
  }
});

test("returning to a previously displayed directory reuses its own values without active statistics", () => {
  const h = fixture();
  h.send({ type: "tabSnapshotCommitted", payload: { panelId: "panel-1", tabId: h.tab.id,
    snapshot: expansionSnapshot("C:\\elsewhere", []), pushHistory: true } });
  assert.equal(h.current.directorySizes, undefined);
  h.send({ type: "tabSnapshotCommitted", payload: { panelId: "panel-1", tabId: h.tab.id, snapshot: h.tab.snapshot, pushHistory: true } });
  assert.equal(h.display().label, "60 B");
  assert.equal(h.display(h.a).share, .3);
  assert.equal(h.current.directorySizes, undefined, "historical display must not create a valid lease or statistics");
});

test("a first lookup batch does not publish file-only proportions while folders are still missing", () => {
  const { tab, a, parent, sizes, path } = sizeFixture();
  sizes.records = { [getPathComparisonKey(path)]: sizeRecord(path, "100", "root-stamp") };
  assert.equal(projectEntrySize(tab, a).sizeDisplay?.share, null);
  sizes.records[getPathComparisonKey(parent.path)] = { ...sizeRecord(parent.path, null, "", "unknown"), sizeFingerprint: null };
  assert.equal(projectEntrySize(tab, a).sizeDisplay?.share, .75, "an explicit unknown response completes lookup but adds no bytes");
});

test("one listing projection reads file sizes linearly rather than once per sibling per row", () => {
  const { tab, a } = sizeFixture();
  tab.folderExpansion = undefined;
  const count = 500;
  let reads = 0;
  tab.snapshot.entries = Array.from({ length: count }, (_, index): EntryViewModel => ({ ...a,
    id: `${a.id}-${index}`, name: `${index}.txt`, path: `${a.path}-${index}`,
    get sizeBytes() { reads++; return index + 1; }
  }));
  assert.equal(getFolderListingRows(tab).length, count);
  assert.ok(reads < count * 20, `size reads ${reads} should be proportional to ${count} rows`);
});

test("ordinary file text updates while its old proportion remains until aligned statistics arrive", () => {
  const h = fixture();
  h.size("directorySizeSnapshotReceived", { snapshot: sizeSnapshot({ generation: 2, phase: "stale" }) });
  const file = { ...h.a, sizeBytes: 50, sizeLabel: "50 B" };
  h.send({ type: "tabSnapshotCommitted", payload: { panelId: "panel-1", tabId: h.tab.id, pushHistory: false,
    snapshot: { ...h.tab.snapshot, entries: [h.parent, file, h.b], sizeFingerprint: "new-root" } } });
  assert.equal(h.display(file).label, "50 B");
  assert.equal(h.display(file).share, .3);
  h.size("directorySizeSnapshotReceived", { snapshot: sizeSnapshot({ generation: 2, sequence: 3 }) });
  h.size("directorySizeLookupReceived", { lookup: { consumerId: h.payload.consumerId, generation: 2, sequence: 3, stale: false,
    directories: [sizeRecord(h.path, "140", "matched-root"), sizeRecord(h.parent.path, "80", "parent-stamp")] } });
  assert.equal(h.display().label, "60 B", "old folder value survives fingerprint alignment");
  const expectedRoot = h.current.snapshot;
  h.size("directorySizeListingAligned", { generation: 2, expectedRoot, snapshot: { ...expectedRoot, sizeFingerprint: "matched-root" } });
  assert.equal(h.display().label, "80 B");
  assert.equal(h.display(file).share, .357142);
});

test("a newly known folder size survives invalidation before the remaining lookup batches arrive", () => {
  const h = fixture();
  h.tab.snapshot.entries.push({ ...h.parent, id: "missing", name: "missing", path: `${h.path}\\missing` });
  assert.equal(h.display().label, "60 B");
  assert.equal(h.display().share, null);
  h.size("directorySizeSnapshotReceived", { snapshot: sizeSnapshot({ generation: 2, phase: "stale" }) });
  assert.equal(h.display().label, "60 B");
  assert.equal(h.display().share, null);
});

test("a terminal unknown result retains its old row without entering the new denominator", () => {
  const h = fixture();
  h.size("directorySizeSnapshotReceived", { snapshot: sizeSnapshot({ generation: 2, sequence: 3 }) });
  h.size("directorySizeLookupReceived", { lookup: {
    consumerId: h.payload.consumerId, generation: 2, sequence: 3, stale: false,
    directories: [
      sizeRecord(h.path, null, "root-stamp", "unknown"),
      sizeRecord(h.parent.path, null, "parent-stamp", "unknown")
    ]
  } });
  assert.equal(h.display().label, "60 B");
  assert.equal(h.display().share, .6);
  assert.equal(h.display().retained, true);
  assert.equal(h.display(h.a).share, .75, "unknown folder bytes are excluded from the new file denominator");
});

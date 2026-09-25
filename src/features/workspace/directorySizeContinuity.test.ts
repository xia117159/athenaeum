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
  for (const entry of [...f.tab.snapshot.entries, f.child]) entry.sizeCreatedAt = "2026-09-20T00:00:00Z";
  let state = f.state;
  const payload = { panelId: "panel-1" as const, tabId: f.tab.id, rootPath: f.path, consumerId: "size-test", requestVersion: 0 };
  return { ...f, payload, get current() { return state.panels["panel-1"].tabs[0]; },
    send(action: Parameters<typeof workspaceReducer>[1]) { state = workspaceReducer(state, action); },
    size(type: DirectorySizeAction["type"], extra: object = {}) {
      const tab = state.panels["panel-1"].tabs[0];
      const listing = type === "directorySizeLookupReceived" ? { expectedRoot: tab.snapshot, expectedExpansion: tab.folderExpansion } : {};
      state = workspaceReducer(state, { type, payload: { ...payload, ...listing, ...extra } } as DirectorySizeAction);
    },
    display(entry = f.parent, mode: "folder-total" | "folder-max" = "folder-total") {
      return projectEntrySize(state.panels["panel-1"].tabs[0], entry, mode).sizeDisplay!;
    }
  };
}

for (const identity of [undefined, null, ""] as const) for (const refresh of [false, true]) test(`unknown creation identity (${String(identity)}, refresh: ${refresh}) cannot cross a new listing`, () => {
  const h = fixture(); h.parent.sizeCreatedAt = identity as string | undefined; // Rust Option is null on the wire.
  if (refresh) h.size("directorySizeRequested", { intent: "refresh" });
  assert.equal(h.display().label, "60 B"); assert.equal(h.display().share, .6);
  const replacement = { ...h.parent };
  h.send({ type: "tabSnapshotCommitted", payload: { panelId: "panel-1", tabId: h.tab.id, pushHistory: false,
    snapshot: { ...h.tab.snapshot, entries: [replacement, h.a, h.b], sizeFingerprint: "new-listing" } } });
  assert.equal(h.display(replacement).bytes, null, "undefined creation times cannot prove this is the previous directory object");
  assert.equal(h.display(replacement).share, null);
});

for (const staleFirst of [false, true]) test(`replaced local objects cannot recapture old live sizes (stale first: ${staleFirst})`, () => {
  const h = fixture();
  h.tab.directorySizes!.records[getPathComparisonKey(h.parent.path)].createdAt = h.parent.sizeCreatedAt;
  const stale = () => h.size("directorySizeSnapshotReceived", { snapshot: sizeSnapshot({ phase: "stale", generation: 2, sequence: 3 }) });
  if (staleFirst) stale();
  const replacement = { ...h.parent, sizeCreatedAt: "2026-09-25T00:00:00Z" };
  h.send({ type: "tabSnapshotCommitted", payload: { panelId: "panel-1", tabId: h.tab.id, pushHistory: false,
    snapshot: { ...h.tab.snapshot, entries: [replacement, h.a, h.b] } } });
  assert.equal(h.display(replacement).bytes, null, "same name/fingerprint must not re-certify another object's old size");
  assert.equal(h.display(replacement).share, null);
  if (!staleFirst) {
    h.size("directorySizeLookupReceived", { lookup: { consumerId: "size-test", generation: 1, sequence: 2, stale: false,
      directories: [{ ...sizeRecord(h.parent.path, "60", "parent-stamp"), createdAt: h.parent.sizeCreatedAt }] } });
    assert.equal(h.display(replacement).bytes, null, "a delayed old-object lookup must remain rejected");
  }
  if (!staleFirst) stale();
  assert.equal(h.display(replacement).bytes, null); assert.equal(h.display(replacement).share, null);
});

for (const createdAt of [null, "2026-09-25T00:00:00Z"]) test(`late lookup without identity is fenced by its listing (${String(createdAt)})`, () => {
  const h = fixture(); h.parent.sizeCreatedAt = null;
  h.tab.directorySizes!.records[getPathComparisonKey(h.parent.path)].createdAt = null;
  const expectedRoot = h.tab.snapshot; const expectedExpansion = h.tab.folderExpansion;
  const replacement = { ...h.parent, sizeCreatedAt: createdAt };
  h.send({ type: "tabSnapshotCommitted", payload: { panelId: "panel-1", tabId: h.tab.id, pushHistory: false,
    snapshot: { ...h.tab.snapshot, entries: [replacement, h.a, h.b] } } });
  assert.equal(h.display(replacement).bytes, null);
  h.size("directorySizeLookupReceived", { expectedRoot, expectedExpansion,
    lookup: { consumerId: "size-test", generation: 1, sequence: 2, stale: false,
      directories: [{ ...sizeRecord(h.parent.path, "60", "parent-stamp"), createdAt: null }] } });
  assert.equal(h.display(replacement).bytes, null); assert.equal(h.display(replacement).share, null);
  h.size("directorySizeSnapshotReceived", { snapshot: sizeSnapshot({ phase: "stale", generation: 2, sequence: 3 }) });
  assert.equal(h.display(replacement).bytes, null);
});

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

test("refresh listings with advisory cache hints preserve the displayed size and both bar modes", () => {
  const h = fixture();
  const createdAt = "2026-09-20T00:00:00Z";
  h.parent.sizeCreatedAt = createdAt;
  h.size("directorySizeRequested", { intent: "refresh" });
  h.send({ type: "tabSnapshotCommitted", payload: { panelId: "panel-1", tabId: h.tab.id, pushHistory: false,
    snapshot: { ...h.tab.snapshot, directorySizeCache: { generation: 0, sequence: 0, historical: true, directories: [
      { ...sizeRecord(h.parent.path, "65", "parent-stamp"), createdAt, cachedAt: "2026-09-24T00:00:00Z" }
    ] } } } });
  assert.equal(h.display().label, "60 B", "a scalar-only hint must not replace a complete display pair");
  assert.equal(h.display().share, .6);
  assert.equal(h.display(h.parent, "folder-max").share, 1);
  assert.equal(h.display(h.a, "folder-max").share, .5);
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

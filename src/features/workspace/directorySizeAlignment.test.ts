import assert from "node:assert/strict";
import { act } from "react";
import { controllerFixture, mountSizes, sizeTransport } from "./directorySizeControllerTestSupport";
import { sizeRecord, sizeSnapshot } from "./directorySizeTestSupport";
import { getFolderListingRows } from "./folderExpansion";
import { expansionEntry, expansionSnapshot } from "./folderExpansionTestSupport";
import { getPathComparisonKey } from "./workspacePathRelations";
import { assertTest, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { DirectorySizeLookup } from "./directorySizeTypes";
import type { DirectorySnapshot } from "./types";

export const completion = (async () => {
  const dom = installDomEnvironment();
  try {
    await assertTest("mismatched root/parent listings align once per generation, deduplicated across two panels without branch fan-out", async () => {
      const f = controllerFixture(); const wire = sizeTransport();
      f.tab.snapshot.sizeFingerprint = "old-root";
      f.tab.folderExpansion![getPathComparisonKey(f.parent.path)].sizeFingerprint = "old-parent";
      const other = { ...f.tab, id: "size-second", snapshot: { ...f.tab.snapshot }, folderExpansion: { ...f.tab.folderExpansion } };
      f.state.panels["panel-2"] = { ...f.state.panels["panel-2"], tabs: [other], activeTabId: other.id };
      f.state.layoutMode = "dual";
      const h = await mountSizes(f.state, wire.gateway, { expansions: true, resolveDirectory: async (path) =>
        path === f.path ? { ...f.tab.snapshot, sizeFingerprint: "root-stamp" } : {
          ...expansionSnapshot(f.parent.path, [f.child]), sizeFingerprint: "parent-stamp"
        } });
      try {
        assert.deepEqual(h.interactions.resolvedPaths, [f.path, f.parent.path]);
        for (const panelId of ["panel-1", "panel-2"] as const) {
          assert.deepEqual(getFolderListingRows(h.state.panels[panelId].tabs[0]).map(({ entry }) => entry.sizeDisplay?.share), [.6, .6, .3, .1]);
        }
        assert.equal(wire.subscribed.length, 2, "only the two leases; alignment never resubscribes");
      } finally { await h.close(); }
    });

    await assertTest("a still-mismatched refresh stays non-exact across later events and filters, with no refresh/scan loop", async () => {
      const f = controllerFixture(); const wire = sizeTransport(); f.tab.snapshot.sizeFingerprint = "old";
      const h = await mountSizes(f.state, wire.gateway, { resolveDirectory: async () => ({ ...f.tab.snapshot, sizeFingerprint: "still-old" }) });
      try {
        assert.deepEqual(h.interactions.resolvedPaths, [f.path]);
        assert.equal(getFolderListingRows(h.tab).find(({ entry }) => entry.id === f.a.id)?.entry.sizeDisplay?.share, null);
        await act(async () => { wire.emit(sizeSnapshot({ consumerId: wire.subscribed[0].consumerId, sequence: 3 })); await flushEffects(); });
        await h.change((state) => ({ ...state, search: { ...state.search, filterText: "a" } }));
        assert.deepEqual(h.interactions.resolvedPaths, [f.path]);
        assert.equal(wire.subscribed.length, 1);
      } finally { await h.close(); }
    });

    await assertTest("directory lookups are chunked to 256 with two physically in-flight calls and no file paths", async () => {
      const f = controllerFixture(); const wire = sizeTransport();
      f.tab.snapshot.entries = Array.from({ length: 700 }, (_, index) => expansionEntry(f.path, `folder${index}`));
      f.tab.folderExpansion = undefined;
      const pending: Array<{ paths: string[]; finish: (value: DirectorySizeLookup) => void; consumerId: string; generation: number }> = [];
      wire.gateway.lookup = (request) => new Promise((finish) => { pending.push({ ...request, finish }); });
      const h = await mountSizes(f.state, wire.gateway);
      try {
        assert.equal(pending.length, 2); assert.equal(pending.every((call) => call.paths.length === 256), true);
        await act(async () => { pending[0].finish({ ...pending[0], stale: false, sequence: 2, directories: pending[0].paths.map((path) => sizeRecord(path, "0", "root-stamp")) }); await flushEffects(); });
        assert.equal(pending.length, 3); assert.equal(pending[2].paths.length, 189);
        await h.request("cancel"); await h.request("calculate");
        assert.equal(pending.length, 3, "obsolete blocked lookups still occupy their two slots");
        await act(async () => { pending[1].finish({ ...pending[1], stale: true, sequence: 2, directories: [] }); await flushEffects(); });
        assert.equal(pending.length, 4, "exactly one slot becomes available for the new lease");
        await act(async () => { pending.forEach((call) => call.finish({ ...call, stale: true, sequence: 2, directories: [] })); await flushEffects(); });
      } finally { await h.close(); }
    });

    await assertTest("size alignment shares the listing budget with folder expansion and ignores late results after navigation", async () => {
      const f = controllerFixture(); const wire = sizeTransport(); f.tab.snapshot.sizeFingerprint = "old";
      const folders = Array.from({ length: 5 }, (_, index) => expansionEntry(f.path, `expanded${index}`));
      f.tab.snapshot.entries.push(...folders);
      for (const folder of folders) f.tab.folderExpansion![getPathComparisonKey(folder.path)] = { path: folder.path, entries: [], status: "idle" };
      const pending: Array<{ path: string; finish: (snapshot: DirectorySnapshot) => void }> = [];
      const h = await mountSizes(f.state, wire.gateway, { expansions: true,
        resolveDirectory: (path) => new Promise((finish) => { pending.push({ path, finish }); }) });
      try {
        assert.equal(pending.length, 4, "all listing work shares the existing four-read budget");
        await h.dispatch({ type: "tabSnapshotCommitted", payload: { panelId: "panel-1", tabId: f.tab.id,
          snapshot: { ...expansionSnapshot("C:\\elsewhere", []), sizeFingerprint: "root-stamp" }, pushHistory: true } });
        await act(async () => { pending.forEach(({ path, finish }) => finish({ ...expansionSnapshot(path, []), sizeFingerprint: "root-stamp" })); await flushEffects(); });
        assert.equal(h.tab.snapshot.location.path, "C:\\elsewhere");
        assert.equal(h.tab.folderExpansion, undefined);
      } finally { await h.close(); }
    });
  } finally { dom.window.close(); }
})();

import assert from "node:assert/strict";
import { act } from "react";
import type { DirectoryListing } from "../../app/types";
import { controllerFixture, mountSizes, sizeTransport } from "./directorySizeControllerTestSupport";
import { sizeRecord, sizeSnapshot } from "./directorySizeTestSupport";
import { mapDirectoryListingToSnapshot } from "./workspaceMappers";
import { workspaceReducer } from "./workspaceReducer";
import { exactSizeBytes, projectEntrySize } from "./directorySizes";
import { assertTest, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { DirectorySizeLookup, LookupDirectorySizesRequest } from "./directorySizeTypes";
import type { DirectorySnapshot } from "./types";

function cachedListing(count: number) {
  const f = controllerFixture();
  const path = `${f.path}\\cached`;
  const entries = Array.from({ length: count }, (_, index) => {
    const name = `d${String(index).padStart(3, "0")}`;
    return { path: `${path}\\${name}`, name, kind: "directory" as const, isHidden: false, isSystem: false,
      isProtectedOperatingSystem: false, isReadOnly: false, isSymlink: false,
      location: { kind: "local" as const, path: `${path}\\${name}` }, decoration: { tags: [] } };
  });
  const raw: DirectoryListing = { location: { kind: "local", path }, canGoUp: true, entries, sizeFingerprint: "root-stamp",
    directorySizeCache: { generation: 7, sequence: 9, directories: [sizeRecord(path, String(count * 60), "root-stamp"),
      ...entries.map((entry) => sizeRecord(entry.path, "60", "child-stamp"))] } };
  const snapshot = mapDirectoryListingToSnapshot(raw);
  const state = workspaceReducer(f.state, { type: "tabSnapshotCommitted", payload: {
    panelId: "panel-1", tabId: f.tab.id, snapshot, pushHistory: true
  } });
  const wire = sizeTransport({ subscribe: async (request) => sizeSnapshot({ consumerId: request.consumerId, generation: 7,
    sequence: 9, totalBytes: String(count * 60), knownBytes: String(count * 60) }) });
  return { f, path, state, raw, snapshot, wire };
}

export const completion = (async () => {
  const dom = installDomEnvironment();
  try {
    for (const first of [0, 1]) await assertTest(`cache hints survive outstanding lookup chunks when chunk ${first} finishes first`, async () => {
      const t = cachedListing(300);
      const calls: Array<{ request: LookupDirectorySizesRequest; finish: (result: DirectorySizeLookup) => void }> = [];
      t.wire.gateway.lookup = (request) => new Promise((finish) => calls.push({ request, finish }));
      const h = await mountSizes(t.state, t.wire.gateway);
      try {
        assert.equal(calls.length, 2);
        const lastPath = calls[1 - first].request.paths.find((path) => path !== t.path)!;
        const display = () => projectEntrySize(h.tab, h.tab.snapshot.entries.find((entry) => entry.path === lastPath)!);
        assert.equal(display().sizeLabel, "60 B");
        const reply = async (index: number) => act(async () => {
          const { request, finish } = calls[index];
          finish({ ...request, sequence: 9, stale: false, directories: request.paths.map((path) =>
            sizeRecord(path, path === t.path ? "18000" : "60", path === t.path ? "root-stamp" : "child-stamp")) });
          await flushEffects();
        });
        await reply(first);
        assert.equal(display().sizeLabel, "60 B", "an outstanding chunk retains its first-frame value");
        assert.equal(display().sizeDisplay?.state, "stale");
        assert.equal(display().sizeDisplay?.share, null);
        assert.equal(exactSizeBytes(display()), null);
        await reply(1 - first);
        assert.equal(display().sizeDisplay?.state, "complete");
        assert.equal(exactSizeBytes(display()), 60n);
        assert.equal(h.tab.snapshot.directorySizeCache, undefined);
      } finally { await h.close(); }
    });
    await assertTest("recalculation fences consumed hints while the replacement subscription is pending", async () => {
      const t = cachedListing(1);
      t.wire.gateway.lookup = async (request) => ({ ...request, sequence: 9, stale: false, directories:
        request.paths.map((path) => sizeRecord(path, "60", path === t.path ? "root-stamp" : "child-stamp")) });
      const h = await mountSizes(t.state, t.wire.gateway);
      try {
        assert.equal(h.tab.snapshot.directorySizeCache, undefined);
        t.wire.gateway.subscribe = () => new Promise(() => undefined);
        await h.request("calculate");
        await h.dispatch({ type: "tabSnapshotCommitted", payload: { panelId: "panel-1", tabId: h.tab.id,
          snapshot: mapDirectoryListingToSnapshot(t.raw), pushHistory: false } });
        assert.equal(h.tab.snapshot.directorySizeCache, undefined, "the previous accepted version remains fenced after consumer replacement");
      } finally { await h.close(); }
    });
    for (const phase of ["stale", "failed", "cancelled", "queued"] as const) {
      await assertTest(`a pending same-path listing cannot reinstall cache hints after ${phase} invalidation`, async () => {
        const t = cachedListing(1);
        t.wire.gateway.lookup = () => new Promise(() => undefined);
        const h = await mountSizes(t.state, t.wire.gateway);
        try {
          let finish!: (snapshot: DirectorySnapshot) => void;
          const listing = new Promise<DirectorySnapshot>((resolve) => { finish = resolve; });
          const committed = listing.then((snapshot) => h.dispatch({ type: "tabSnapshotCommitted", payload: {
            panelId: "panel-1", tabId: h.tab.id, snapshot, pushHistory: false
          } }));
          await act(async () => {
            t.wire.emit(sizeSnapshot({ consumerId: h.tab.directorySizes!.consumerId!, generation: 8, sequence: 1, phase, totalBytes: null }));
            await flushEffects();
          });
          assert.equal(h.tab.snapshot.directorySizeCache, undefined);
          finish(mapDirectoryListingToSnapshot(t.raw));
          await committed;
          assert.equal(h.tab.snapshot.directorySizeCache, undefined, "commit rejects an already invalidated generation");
          const row = projectEntrySize(h.tab, h.tab.snapshot.entries[0]);
          assert.equal(row.sizeLabel, "--");
          assert.equal(exactSizeBytes(row), null);
        } finally { await h.close(); }
      });
    }
  } finally { dom.window.close(); }
})();

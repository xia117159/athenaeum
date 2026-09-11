import assert from "node:assert/strict";
import { act } from "react";
import { controllerFixture, mountSizes, sizeTransport } from "./directorySizeControllerTestSupport";
import { sizeRecord } from "./directorySizeTestSupport";
import { expansionEntry, expansionSnapshot } from "./folderExpansionTestSupport";
import { getFolderListingRows } from "./folderExpansion";
import { getPathComparisonKey } from "./workspacePathRelations";
import { assertTest, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { DirectorySizeLookup, LookupDirectorySizesRequest } from "./directorySizeTypes";
import type { DirectorySnapshot } from "./types";

async function batchFixture(rootState: "old" | "matched" | "partial" = "old", expandBeforeLookup = false) {
  const f = controllerFixture(); const wire = sizeTransport();
  const branchKey = getPathComparisonKey(f.parent.path);
  f.tab.snapshot.sizeFingerprint = rootState === "matched" ? "root-stamp" : "old-root";
  f.tab.snapshot.entries.push(...Array.from({ length: 260 }, (_, index) => expansionEntry(f.path, `folder${String(index).padStart(3, "0")}`)));
  f.tab.folderExpansion![branchKey] = { ...f.tab.folderExpansion![branchKey], sizeFingerprint: "old-parent",
    status: expandBeforeLookup ? "idle" : "ready", entries: expandBeforeLookup ? [] : [f.child] };
  const originalSubscribe = wire.gateway.subscribe;
  if (rootState === "partial") wire.gateway.subscribe = async (request) => ({
    ...await originalSubscribe(request), phase: "partial", totalBytes: null
  });
  const lookups: Array<{ request: LookupDirectorySizesRequest; finish: (result: DirectorySizeLookup) => void; fail: (error: Error) => void }> = [];
  wire.gateway.lookup = (request) => new Promise((finish, fail) => { lookups.push({ request, finish, fail }); });
  const listings: Array<{ path: string; finish: (result: DirectorySnapshot) => void }> = [];
  const h = await mountSizes(f.state, wire.gateway, { expansions: true,
    resolveDirectory: (path) => new Promise((finish) => { listings.push({ path, finish }); }) });
  assert.deepEqual(lookups.map(({ request }) => request.paths.length), [256, 6]);
  assert.ok(lookups[0].request.paths.includes(f.path));
  assert.ok(!lookups[0].request.paths.includes(f.parent.path));
  assert.ok(lookups[1].request.paths.includes(f.parent.path));
  return { f, wire, h, branchKey, lookups, listings,
    async replyLookup(index: number, error?: Error) { await act(async () => {
      const call = lookups[index];
      if (error) call.fail(error);
      else call.finish({ ...call.request, sequence: 2, stale: false, directories: call.request.paths.map((path) => {
        if (path === f.path) return rootState === "partial"
          ? { ...sizeRecord(path, "100", "unused", "partial"), sizeFingerprint: null }
          : sizeRecord(path, "100", "root-stamp");
        return path === f.parent.path ? sizeRecord(path, "60", "parent-stamp") : sizeRecord(path, "0", "empty-stamp");
      }) });
      await flushEffects();
    }); },
    async replyListing(path: string) { await act(async () => {
      const call = listings.find((listing) => listing.path === path); assert.ok(call);
      call.finish(path === f.path ? { ...f.tab.snapshot, sizeFingerprint: "root-stamp" } :
        { ...expansionSnapshot(f.parent.path, [f.child]), sizeFingerprint: "parent-stamp" });
      await flushEffects();
    }); }
  };
}

export const completion = (async () => {
  const dom = installDomEnvironment();
  try {
    for (const order of ["root batch last", "root listing last", "root batch and listing first"]) {
      await assertTest(`split lookups await root readiness: ${order}`, async () => {
        const t = await batchFixture(); const { h, f } = t;
        try {
          if (order === "root batch last") {
            await t.replyLookup(1);
            assert.equal(t.listings.length, 0, "a branch record cannot establish whether the root needs alignment");
            await t.replyLookup(0);
          } else await t.replyLookup(0);
          assert.deepEqual(t.listings.map(({ path }) => path), [f.path]);
          if (order === "root listing last") await t.replyLookup(1);
          assert.deepEqual(t.listings.map(({ path }) => path), [f.path]);
          await t.replyListing(f.path);
          if (order === "root batch and listing first") {
            assert.equal(t.listings.length, 1); await t.replyLookup(1);
          }
          assert.deepEqual(t.listings.map(({ path }) => path), [f.path, f.parent.path]);
          await t.replyListing(f.parent.path);
          assert.equal(h.tab.snapshot.sizeFingerprint, "root-stamp");
          assert.equal(h.tab.folderExpansion![t.branchKey].sizeFingerprint, "parent-stamp");
          assert.equal(getFolderListingRows(h.tab).find(({ entry }) => entry.id === f.child.id)?.entry.sizeDisplay?.share, .6);
          await h.change((state) => ({ ...state, search: { ...state.search, filterText: "child" } }));
          assert.equal(t.listings.length, 2); assert.equal(t.lookups.length, 2); assert.equal(t.wire.subscribed.length, 1);
        } finally { await h.close(); }
      });
    }
    for (const rootState of ["matched", "partial"] as const) await assertTest(`a received ${rootState} root permits branch work without unnecessary root I/O`, async () => {
      const t = await batchFixture(rootState); const { h, f } = t;
      try {
        await t.replyLookup(1); assert.equal(t.listings.length, 0);
        await t.replyLookup(0);
        assert.deepEqual(t.listings.map(({ path }) => path), [f.parent.path]);
        await t.replyListing(f.parent.path);
        assert.equal(h.tab.snapshot, f.tab.snapshot);
        assert.equal(h.tab.folderExpansion![t.branchKey].sizeFingerprint, "parent-stamp");
        assert.equal(h.tab.directorySizes?.snapshot?.phase, rootState === "partial" ? "partial" : "complete");
        assert.equal(getFolderListingRows(h.tab).find(({ entry }) => entry.id === f.child.id)?.entry.sizeDisplay?.share, .6);
        assert.equal(getFolderListingRows(h.tab).find(({ entry }) => entry.id === f.a.id)?.entry.sizeDisplay?.share, .3);
        assert.equal(t.listings.length, 1); assert.equal(t.lookups.length, 2); assert.equal(t.wire.subscribed.length, 1);
      } finally { await h.close(); }
    });
    await assertTest("a failed root lookup does not release queued branch alignment or start a retry loop", async () => {
      const t = await batchFixture(); const { h } = t;
      try {
        await t.replyLookup(1); assert.equal(t.listings.length, 0);
        await t.replyLookup(0, new Error("root lookup denied"));
        assert.equal(h.tab.directorySizes?.snapshot?.phase, "failed");
        assert.match(h.tab.directorySizes?.snapshot?.reason ?? "", /root lookup denied/);
        await h.change((state) => ({ ...state, search: { ...state.search, filterText: "child" } }));
        assert.equal(t.listings.length, 0); assert.equal(t.wire.subscribed.length, 1);
      } finally { await h.close(); }
    });
    await assertTest("cancel while awaiting root metadata prevents later lookup results from starting alignment", async () => {
      const t = await batchFixture(); const { h } = t;
      try {
        await t.replyLookup(1); assert.equal(t.listings.length, 0);
        await h.request("cancel"); await t.replyLookup(0);
        assert.equal(h.tab.directorySizes?.snapshot?.phase, "cancelled");
        assert.equal(t.listings.length, 0); assert.equal(t.wire.subscribed.length, 1);
      } finally { await h.close(); }
    });
    await assertTest("waiting for root statistics does not block ordinary folder expansion", async () => {
      const t = await batchFixture("old", true); const { h, f } = t;
      try {
        assert.deepEqual(t.listings.map(({ path }) => path), [f.parent.path]);
        await t.replyLookup(1); await t.replyListing(f.parent.path);
        assert.ok(getFolderListingRows(h.tab).some(({ entry }) => entry.id === f.child.id));
        assert.equal(t.listings.length, 1, "normal expansion is allowed while the root lookup is still pending");
        await t.replyLookup(0); await t.replyListing(f.path);
        assert.equal(getFolderListingRows(h.tab).find(({ entry }) => entry.id === f.child.id)?.entry.sizeDisplay?.share, .6);
        assert.equal(t.listings.length, 2); assert.equal(t.wire.subscribed.length, 1);
      } finally { await h.close(); }
    });
  } finally { dom.window.close(); }
})();

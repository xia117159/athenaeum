import assert from "node:assert/strict";
import { act } from "react";
import { controllerFixture, mountSizes, sizeTransport } from "./directorySizeControllerTestSupport";
import { expansionEntry, expansionSnapshot } from "./folderExpansionTestSupport";
import { getFolderListingRows } from "./folderExpansion";
import { getPathComparisonKey } from "./workspacePathRelations";
import { assertTest, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { DirectorySizeLookup, LookupDirectorySizesRequest } from "./directorySizeTypes";
import type { DirectorySnapshot, PanelId } from "./types";

async function orderingFixture(oldPanel: PanelId = "panel-1") {
  const f = controllerFixture(); const wire = sizeTransport();
  const branchKey = getPathComparisonKey(f.parent.path);
  f.tab.snapshot.sizeFingerprint = oldPanel === "panel-1" ? "old-root" : "root-stamp";
  f.tab.folderExpansion![branchKey].sizeFingerprint = "old-parent";
  const other = { ...f.tab, id: "size-second", snapshot: { ...f.tab.snapshot,
    sizeFingerprint: oldPanel === "panel-2" ? "old-root" : "root-stamp" },
    folderExpansion: { [branchKey]: { ...f.tab.folderExpansion![branchKey] } } };
  f.state.layoutMode = "dual";
  f.state.panels["panel-2"] = { ...f.state.panels["panel-2"], tabs: [other], activeTabId: other.id };
  const lookups: Array<{ request: LookupDirectorySizesRequest; finish: (result: DirectorySizeLookup) => void }> = [];
  const originalLookup = wire.gateway.lookup;
  wire.gateway.lookup = (request) => new Promise((finish) => { lookups.push({ request, finish }); });
  const listings: Array<{ path: string; finish: (result: DirectorySnapshot) => void; fail: (error: Error) => void }> = [];
  const h = await mountSizes(f.state, wire.gateway, { expansions: true,
    resolveDirectory: (path) => new Promise((finish, fail) => { listings.push({ path, finish, fail }); }) });
  return { f, wire, h, other, branchKey, lookups, listings,
    async replyLookup(index: number) { await act(async () => {
      const call = lookups[index]; call.finish(await originalLookup(call.request)); await flushEffects();
    }); },
    async replyListing(path: string, result?: DirectorySnapshot | Error) { await act(async () => {
      const call = listings.find((listing) => listing.path === path);
      assert.ok(call, "the expected ordinary listing was scheduled");
      if (result instanceof Error) call.fail(result);
      else call.finish(result ?? (path === f.path ? { ...f.tab.snapshot, sizeFingerprint: "root-stamp" } :
        { ...expansionSnapshot(f.parent.path, [f.child]), sizeFingerprint: "parent-stamp" }));
      await flushEffects();
    }); }
  };
}

export const completion = (async () => {
  const dom = installDomEnvironment();
  try {
    for (const oldPanel of ["panel-1", "panel-2"] as const) for (const firstLookup of [0, 1]) {
      for (const secondBeforeRoot of [true, false]) {
        await assertTest(`shared root precedes branches: old ${oldPanel}, lookup ${firstLookup} first, second ${secondBeforeRoot ? "before root" : "after branch"}`, async () => {
          const t = await orderingFixture(oldPanel); const { h, f } = t;
          const matchedPanel = oldPanel === "panel-1" ? "panel-2" : "panel-1";
          const matchedRoot = h.state.panels[matchedPanel].tabs[0].snapshot;
          try {
            assert.equal(t.lookups.length, 2); assert.equal(t.listings.length, 0);
            await t.replyLookup(firstLookup);
            assert.deepEqual(t.listings.map(({ path }) => path), [f.path], "a matched consumer's fingerprint also identifies the other root's mismatch");
            if (secondBeforeRoot) await t.replyLookup(1 - firstLookup);
            assert.deepEqual(t.listings.map(({ path }) => path), [f.path], "no branch captures a root that is being aligned");
            await t.replyListing(f.path);
            assert.deepEqual(t.listings.map(({ path }) => path), [f.path, f.parent.path]);
            await t.replyListing(f.parent.path);
            if (!secondBeforeRoot) await t.replyLookup(1 - firstLookup);
            for (const panelId of ["panel-1", "panel-2"] as const) {
              assert.deepEqual(getFolderListingRows(h.state.panels[panelId].tabs[0]).map(({ entry }) => entry.sizeDisplay?.share), [.6, .6, .3, .1]);
            }
            assert.equal(h.state.panels[matchedPanel].tabs[0].snapshot, matchedRoot);
            await h.change((state) => ({ ...state, search: { ...state.search, filterText: "child" } }));
            assert.equal(t.listings.length, 2); assert.equal(t.wire.subscribed.length, 2);
          } finally { await h.close(); }
        });
      }
    }
    for (const failed of [true, false]) await assertTest(`a ${failed ? "failed" : "still mismatched"} root attempt does not strand another panel's branch`, async () => {
      const t = await orderingFixture(); const { h, f } = t;
      try {
        await t.replyLookup(0); await t.replyLookup(1);
        assert.deepEqual(t.listings.map(({ path }) => path), [f.path]);
        await t.replyListing(f.path, failed ? new Error("root alignment denied") : { ...f.tab.snapshot, sizeFingerprint: "still-old" });
        assert.deepEqual(t.listings.map(({ path }) => path), [f.path, f.parent.path]);
        await t.replyListing(f.parent.path);
        assert.equal(h.tab.directorySizes?.snapshot?.phase, failed ? "failed" : "complete");
        assert.equal(getFolderListingRows(h.tab).find(({ entry }) => entry.id === f.a.id)?.entry.sizeDisplay?.share, null);
        assert.equal(getFolderListingRows(h.tab).find(({ entry }) => entry.id === f.child.id)?.entry.sizeDisplay?.share, failed ? null : .6);
        const matched = h.state.panels["panel-2"].tabs[0];
        assert.equal(matched.snapshot, t.other.snapshot);
        assert.equal(matched.directorySizes?.snapshot?.phase, "complete");
        assert.deepEqual(getFolderListingRows(matched).map(({ entry }) => entry.sizeDisplay?.share), [.6, .6, .3, .1]);
        assert.equal(t.listings.length, 2);
      } finally { await h.close(); }
    });
    for (const failed of [false, true]) await assertTest(`root-first scheduling rejects an obsolete root ${failed ? "failure" : "result"} and preserves the other branch`, async () => {
      const t = await orderingFixture(); const { h, f } = t;
      try {
        await t.replyLookup(0); await t.replyLookup(1);
        const file = expansionEntry(f.path, "newer.txt", "file", { sizeBytes: 80, sizeLabel: "80 B" });
        const newer = { ...expansionSnapshot(f.path, [file]), sizeFingerprint: "newer-root" };
        await h.dispatch({ type: "tabSnapshotCommitted", payload: { panelId: "panel-1", tabId: f.tab.id, snapshot: newer, pushHistory: false } });
        await h.dispatch({ type: "entrySelectionSet", payload: { panelId: "panel-1", tabId: f.tab.id, entryIds: [file.id] } });
        await t.replyListing(f.path, failed ? new Error("obsolete root denied") : undefined);
        await t.replyListing(f.parent.path);
        assert.equal(h.tab.snapshot, newer); assert.equal(h.tab.folderExpansion, undefined);
        assert.deepEqual(h.tab.selectedEntryIds, [file.id]);
        assert.equal(h.tab.directorySizes?.snapshot?.phase, "complete");
        assert.equal(getFolderListingRows(h.tab)[0].entry.sizeDisplay?.share, null);
        assert.deepEqual(getFolderListingRows(h.state.panels["panel-2"].tabs[0]).map(({ entry }) => entry.sizeDisplay?.share), [.6, .6, .3, .1]);
        assert.equal(t.listings.length, 2); assert.equal(t.wire.subscribed.length, 2);
      } finally { await h.close(); }
    });
    await assertTest("a consumer arriving during root alignment cannot inherit its result but may join the later branch read", async () => {
      const t = await orderingFixture(); const { h, f } = t;
      try {
        await t.replyLookup(0); await t.replyLookup(1);
        const late = { ...h.tab, id: "late-root-consumer", directorySizes: undefined, snapshot: { ...h.tab.snapshot } };
        await h.change((state) => ({ ...state, panels: { ...state.panels, "panel-1": { ...state.panels["panel-1"], tabs: [late], activeTabId: late.id } } }));
        assert.equal(t.lookups.length, 3); await t.replyLookup(2);
        assert.deepEqual(t.listings.map(({ path }) => path), [f.path]);
        await t.replyListing(f.path); await t.replyListing(f.parent.path);
        assert.equal(h.tab.snapshot, late.snapshot);
        assert.equal(getFolderListingRows(h.tab).find(({ entry }) => entry.id === f.a.id)?.entry.sizeDisplay?.share, null);
        assert.equal(getFolderListingRows(h.tab).find(({ entry }) => entry.id === f.child.id)?.entry.sizeDisplay?.share, .6);
        assert.deepEqual(getFolderListingRows(h.state.panels["panel-2"].tabs[0]).map(({ entry }) => entry.sizeDisplay?.share), [.6, .6, .3, .1]);
        assert.equal(t.listings.length, 2); assert.equal(t.wire.subscribed.length, 3);
      } finally { await h.close(); }
    });
  } finally { dom.window.close(); }
})();

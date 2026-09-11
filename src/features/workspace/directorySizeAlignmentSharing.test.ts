import assert from "node:assert/strict";
import { act } from "react";
import { controllerFixture, mountSizes, sizeTransport } from "./directorySizeControllerTestSupport";
import { expansionEntry, expansionSnapshot } from "./folderExpansionTestSupport";
import { getFolderListingRows } from "./folderExpansion";
import { getPathComparisonKey } from "./workspacePathRelations";
import { assertTest, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { DirectorySizeLookup, LookupDirectorySizesRequest } from "./directorySizeTypes";
import type { DirectorySnapshot } from "./types";

type Scope = "root" | "branch";
async function sharingFixture(scope: Scope, secondMatched = false) {
  const f = controllerFixture(); const wire = sizeTransport();
  const branchKey = getPathComparisonKey(f.parent.path);
  f.tab.snapshot.sizeFingerprint = scope === "root" ? "old-root" : "root-stamp";
  if (scope === "root") f.tab.folderExpansion = undefined;
  else f.tab.folderExpansion![branchKey].sizeFingerprint = "old-parent";
  const other = { ...f.tab, id: "size-second", snapshot: { ...f.tab.snapshot },
    folderExpansion: f.tab.folderExpansion && Object.fromEntries(Object.entries(f.tab.folderExpansion).map(([key, branch]) => [key, { ...branch }])) };
  if (secondMatched) {
    if (scope === "root") other.snapshot.sizeFingerprint = "root-stamp";
    else other.folderExpansion![branchKey].sizeFingerprint = "parent-stamp";
  }
  f.state.layoutMode = "dual";
  f.state.panels["panel-2"] = { ...f.state.panels["panel-2"], tabs: [other], activeTabId: other.id };
  const lookups: Array<{ request: LookupDirectorySizesRequest; finish: (result: DirectorySizeLookup) => void }> = [];
  const originalLookup = wire.gateway.lookup;
  wire.gateway.lookup = (request) => new Promise((finish) => { lookups.push({ request, finish }); });
  const listings: Array<{ path: string; finish: (result: DirectorySnapshot) => void; fail: (error: Error) => void }> = [];
  const h = await mountSizes(f.state, wire.gateway, { expansions: true,
    resolveDirectory: (path) => new Promise((finish, fail) => { listings.push({ path, finish, fail }); }) });
  const aligned = scope === "root" ? { ...f.tab.snapshot, sizeFingerprint: "root-stamp" } :
    { ...expansionSnapshot(f.parent.path, [f.child]), sizeFingerprint: "parent-stamp" };
  return { f, wire, h, other, branchKey, lookups, listings, aligned,
    async replyLookup(index: number) { await act(async () => {
      const call = lookups[index]; call.finish(await originalLookup(call.request)); await flushEffects();
    }); },
    async replyListing(failed = false) { await act(async () => {
      if (failed) listings[0].fail(new Error("shared alignment denied"));
      else listings[0].finish(aligned);
      await flushEffects();
    }); }
  };
}

export const completion = (async () => {
  const dom = installDomEnvironment();
  try {
    for (const scope of ["root", "branch"] as const) for (const lookupBeforeListing of [true, false]) {
      await assertTest("original panels share one " + scope + " alignment when the second lookup returns " +
        (lookupBeforeListing ? "before" : "after") + " the listing", async () => {
        const t = await sharingFixture(scope); const { h } = t;
        try {
          assert.equal(t.lookups.length, 2); assert.equal(t.listings.length, 0);
          await t.replyLookup(0); assert.equal(t.listings.length, 1);
          if (lookupBeforeListing) await t.replyLookup(1);
          await t.replyListing();
          if (!lookupBeforeListing) await t.replyLookup(1);
          for (const panelId of ["panel-1", "panel-2"] as const) {
            assert.deepEqual(getFolderListingRows(h.state.panels[panelId].tabs[0]).map(({ entry }) => entry.sizeDisplay?.share),
              scope === "root" ? [.6, .3, .1] : [.6, .6, .3, .1]);
          }
          assert.equal(t.listings.length, 1); assert.equal(t.wire.subscribed.length, 2);
        } finally { await h.close(); }
      });
    }
    for (const scope of ["root", "branch"] as const) for (const failed of [false, true]) {
      await assertTest("an already matched " + scope + " stays untouched by another panel's " + (failed ? "failure" : "alignment"), async () => {
        const t = await sharingFixture(scope, true); const { h } = t;
        try {
          await t.replyLookup(0); await t.replyListing(failed); await t.replyLookup(1);
          const other = h.state.panels["panel-2"].tabs[0];
          assert.equal(other.snapshot, t.other.snapshot);
          assert.equal(other.folderExpansion?.[t.branchKey], t.other.folderExpansion?.[t.branchKey]);
          assert.equal(other.directorySizes?.snapshot?.phase, "complete");
          assert.deepEqual(getFolderListingRows(other).map(({ entry }) => entry.sizeDisplay?.share),
            scope === "root" ? [.6, .3, .1] : [.6, .6, .3, .1]);
          assert.equal(t.listings.length, 1);
        } finally { await h.close(); }
      });
    }
    for (const scope of ["root", "branch"] as const) for (const failed of [false, true]) {
      await assertTest("captured second-panel " + scope + " replacements reject the old shared " + (failed ? "failure" : "result"), async () => {
        const t = await sharingFixture(scope); const { h, f } = t;
        try {
          await t.replyLookup(0);
          const path = scope === "root" ? f.path : f.parent.path;
          const newerFile = expansionEntry(path, "newer.txt", "file", { sizeBytes: 80, sizeLabel: "80 B" });
          const newer = { ...expansionSnapshot(path, [newerFile]), sizeFingerprint: "newer" };
          if (scope === "root") {
            await h.dispatch({ type: "tabSnapshotCommitted", payload: { panelId: "panel-2", tabId: t.other.id, snapshot: newer, pushHistory: false } });
          } else {
            const toggle = { type: "folderExpansionToggled", payload: { panelId: "panel-2", tabId: t.other.id, path } } as const;
            await h.dispatch(toggle); await h.dispatch(toggle);
            assert.equal(t.listings.length, 2);
            await act(async () => { t.listings[1].finish(newer); await flushEffects(); });
          }
          const before = h.state.panels["panel-2"].tabs[0];
          await h.dispatch({ type: "entrySelectionSet", payload: { panelId: "panel-2", tabId: t.other.id, entryIds: [newerFile.id] } });
          await t.replyLookup(1); await t.replyListing(failed);
          const after = h.state.panels["panel-2"].tabs[0];
          assert.equal(after.snapshot, before.snapshot);
          assert.equal(after.folderExpansion?.[t.branchKey], before.folderExpansion?.[t.branchKey]);
          assert.deepEqual(after.selectedEntryIds, [newerFile.id]);
          assert.equal(after.directorySizes?.snapshot?.phase, "complete");
          assert.equal(getFolderListingRows(after).find(({ entry }) => entry.id === newerFile.id)?.entry.sizeDisplay?.share, null);
          assert.equal(t.wire.subscribed.length, 2);
        } finally { await h.close(); }
      });
    }
    await assertTest("a genuinely late consumer cannot inherit an older shared alignment", async () => {
      const t = await sharingFixture("root"); const { h } = t;
      try {
        await t.replyLookup(0);
        const late = { ...t.other, id: "late-consumer", snapshot: { ...t.other.snapshot } };
        await h.change((state) => ({ ...state, panels: { ...state.panels, "panel-2": { ...state.panels["panel-2"],
          tabs: [late], activeTabId: late.id } } }));
        await t.replyLookup(1);
        assert.equal(t.lookups.length, 3);
        await t.replyLookup(2); await t.replyListing();
        const other = h.state.panels["panel-2"].tabs[0];
        assert.equal(other.snapshot, late.snapshot);
        assert.ok(getFolderListingRows(other).every(({ entry }) => entry.sizeDisplay?.share === null));
        assert.equal(t.listings.length, 1);
      } finally { await h.close(); }
    });
  } finally { dom.window.close(); }
})();

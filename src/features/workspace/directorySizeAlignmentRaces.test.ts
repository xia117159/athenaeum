import assert from "node:assert/strict";
import { act } from "react";
import { controllerFixture, mountSizes, sizeTransport } from "./directorySizeControllerTestSupport";
import { expansionEntry, expansionSnapshot } from "./folderExpansionTestSupport";
import { getFolderListingRows } from "./folderExpansion";
import { getPathComparisonKey } from "./workspacePathRelations";
import { assertTest, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { DirectorySnapshot } from "./types";

export const completion = (async () => {
  const dom = installDomEnvironment();
  try {
    await assertTest("a late root alignment cannot replace a newer same-path ordinary refresh", async () => {
      const f = controllerFixture(); const wire = sizeTransport(); f.tab.snapshot.sizeFingerprint = "old-root";
      let finish!: (value: DirectorySnapshot) => void;
      const h = await mountSizes(f.state, wire.gateway, { resolveDirectory: () => new Promise((resolve) => { finish = resolve; }) });
      try {
        const file = expansionEntry(f.path, "newer.txt", "file", { sizeBytes: 80, sizeLabel: "80 B" });
        const newer = { ...expansionSnapshot(f.path, [file]), sizeFingerprint: "newer-root" };
        await h.dispatch({ type: "tabSnapshotCommitted", payload: { panelId: "panel-1", tabId: f.tab.id, snapshot: newer, pushHistory: false } });
        await h.change((state) => ({ ...state, panels: { ...state.panels, "panel-1": { ...state.panels["panel-1"],
          tabs: [{ ...h.tab, selectedEntryIds: [file.id] }]
        } } }));
        await act(async () => { finish({ ...f.tab.snapshot, sizeFingerprint: "root-stamp" }); await flushEffects(); });
        assert.equal(h.tab.snapshot, newer);
        assert.deepEqual(h.tab.selectedEntryIds, [file.id]);
        assert.equal(getFolderListingRows(h.tab)[0].entry.sizeDisplay?.share, null);
        assert.equal(wire.subscribed.length, 1);
        assert.deepEqual(h.interactions.resolvedPaths, [f.path]);
      } finally { await h.close(); }
    });

    await assertTest("a remote branch alignment cannot resurrect old rows after collapse and re-expansion", async () => {
      const f = controllerFixture("sftp"); const wire = sizeTransport();
      const key = getPathComparisonKey(f.parent.path);
      f.tab.folderExpansion![key].sizeFingerprint = "old-parent";
      const pending: Array<(value: DirectorySnapshot) => void> = [];
      const h = await mountSizes(f.state, wire.gateway, { expansions: true,
        resolveDirectory: () => new Promise((resolve) => { pending.push(resolve); }) });
      try {
        await h.request("calculate"); assert.equal(pending.length, 1);
        const toggle = { type: "folderExpansionToggled", payload: { panelId: "panel-1", tabId: f.tab.id, path: f.parent.path } } as const;
        await h.dispatch(toggle); await h.dispatch(toggle); assert.equal(pending.length, 2);
        const file = expansionEntry(f.parent.path, "newer-child.txt", "file", { sizeBytes: 80, sizeLabel: "80 B" });
        await act(async () => { pending[1]({ ...expansionSnapshot(f.parent.path, [file]), sizeFingerprint: "newer-parent" }); await flushEffects(); });
        const branch = h.tab.folderExpansion![key];
        await h.change((state) => ({ ...state, panels: { ...state.panels, "panel-1": { ...state.panels["panel-1"],
          tabs: [{ ...h.tab, selectedEntryIds: [file.id] }]
        } } }));
        await act(async () => { pending[0]({ ...expansionSnapshot(f.parent.path, [f.child]), sizeFingerprint: "parent-stamp" }); await flushEffects(); });
        assert.equal(h.tab.folderExpansion![key], branch);
        assert.deepEqual(h.tab.selectedEntryIds, [file.id]);
        assert.ok(!getFolderListingRows(h.tab).some(({ entry }) => entry.id === f.child.id));
        assert.equal(getFolderListingRows(h.tab).find(({ entry }) => entry.id === file.id)?.entry.sizeDisplay?.share, null);
        assert.equal(wire.subscribed.length, 1); assert.equal(pending.length, 2);
      } finally { await h.close(); }
    });
    for (const replaced of [false, true]) await assertTest(`alignment errors ${replaced ? "ignore replaced lists" : "remain visible for current lists"}`, async () => {
      const f = controllerFixture(); const wire = sizeTransport(); f.tab.snapshot.sizeFingerprint = "old-root";
      let fail!: (error: Error) => void;
      const h = await mountSizes(f.state, wire.gateway, { resolveDirectory: () => new Promise((_, reject) => { fail = reject; }) });
      try {
        if (replaced) await h.dispatch({ type: "tabSnapshotCommitted", payload: { panelId: "panel-1", tabId: f.tab.id,
          snapshot: { ...f.tab.snapshot, sizeFingerprint: "newer-root" }, pushHistory: false } });
        await act(async () => { fail(new Error("test alignment read denied")); await flushEffects(); });
        assert.equal(h.tab.directorySizes?.snapshot?.phase, replaced ? "complete" : "failed");
        if (!replaced) assert.match(h.tab.directorySizes?.snapshot?.reason ?? "", /test alignment read denied/);
      } finally { await h.close(); }
    });
  } finally { dom.window.close(); }
})();

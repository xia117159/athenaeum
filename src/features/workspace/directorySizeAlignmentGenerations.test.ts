import assert from "node:assert/strict";
import { act } from "react";
import { controllerFixture, mountSizes, sizeTransport } from "./directorySizeControllerTestSupport";
import { sizeSnapshot } from "./directorySizeTestSupport";
import { getFolderListingRows } from "./folderExpansion";
import { assertTest, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { DirectorySnapshot } from "./types";

export const completion = (async () => {
  const dom = installDomEnvironment();
  try {
    // Deliberately inject a terminal-generation skew; normal coordinator ordering
    // publishes scanning to every lease first. This is robustness, not a claim
    // that ordinary desktop event delivery produces the synthetic sequence.
    for (const firstResult of [0, 1]) await assertTest(`generation-skew hardening keeps one root attempt per generation, result ${firstResult} first`, async () => {
      const f = controllerFixture(); const wire = sizeTransport();
      f.tab.snapshot.sizeFingerprint = "old-root"; f.tab.folderExpansion = undefined;
      const other = { ...f.tab, id: "size-second", snapshot: { ...f.tab.snapshot } };
      f.state.layoutMode = "dual";
      f.state.panels["panel-2"] = { ...f.state.panels["panel-2"], tabs: [other], activeTabId: other.id };
      const pending: Array<(snapshot: DirectorySnapshot) => void> = [];
      const h = await mountSizes(f.state, wire.gateway, { resolveDirectory: () => new Promise((finish) => { pending.push(finish); }) });
      try {
        assert.equal(pending.length, 1);
        const firstConsumer = h.tab.directorySizes!.consumerId!;
        const secondConsumer = h.state.panels["panel-2"].tabs[0].directorySizes!.consumerId!;
        await act(async () => { wire.emit(sizeSnapshot({ consumerId: firstConsumer, generation: 2 })); await flushEffects(); });
        assert.equal(h.tab.directorySizes?.snapshot?.generation, 2);
        assert.equal(h.state.panels["panel-2"].tabs[0].directorySizes?.snapshot?.generation, 1);
        assert.equal(pending.length, 2, "two retained generations must not delete each other's attempted maps");
        await h.change((state) => ({ ...state, search: { ...state.search, filterText: "a" } }));
        assert.equal(pending.length, 2, "rerenders do not create replacement physical reads");
        const aligned = { ...f.tab.snapshot, sizeFingerprint: "root-stamp" };
        await act(async () => { pending[firstResult](aligned); await flushEffects(); });
        await act(async () => { pending[1 - firstResult](aligned); await flushEffects(); });
        await act(async () => { wire.emit(sizeSnapshot({ consumerId: secondConsumer, generation: 2 })); await flushEffects(); });
        for (const panelId of ["panel-1", "panel-2"] as const) {
          const tab = h.state.panels[panelId].tabs[0];
          assert.equal(tab.directorySizes?.snapshot?.generation, 2);
          assert.deepEqual(getFolderListingRows(tab).map(({ entry }) => entry.sizeDisplay?.share), [.6, .3, .1]);
        }
        assert.equal(pending.length, 2); assert.equal(wire.subscribed.length, 2);
      } finally { await h.close(); }
    });
  } finally { dom.window.close(); }
})();

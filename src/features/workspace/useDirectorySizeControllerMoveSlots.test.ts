import assert from "node:assert/strict";
import { mountSizes, sizeTransport } from "./directorySizeControllerTestSupport";
import { gateReplacement, movedTab, moveFixture, moveRight } from "./directorySizeMoveTestSupport";
import { assertTest, installDomEnvironment } from "./workspaceControllerTestHarness";

export const completion = (async () => {
  const dom = installDomEnvironment();
  try {
    for (const end of ["accept", "fail", "move-back", "navigate"] as const) await assertTest(`source auto slot waits until the moved consumer is safe: ${end}`, async () => {
      const f = moveFixture(true, true), wire = sizeTransport(), gate = gateReplacement(wire, true);
      const h = await mountSizes(f.state, wire.gateway);
      try {
        const old = wire.subscribed[0].consumerId;
        await h.dispatch(moveRight(f.tab.id));
        assert.equal(wire.subscribed.length, 1, "destination listen is blocked; source B must wait before subscribing");
        assert.equal(wire.released.includes(old), false, "A still holds its only backend lease");
        const tab = movedTab(h.state, f.path);
        if (end === "move-back") await h.dispatch({ type: "tabMoved", payload: {
          sourcePanelId: "panel-2", targetPanelId: "panel-1", tabId: tab.id, targetIndex: 0
        } });
        if (end === "navigate") await h.dispatch({ type: "tabSnapshotCommitted", payload: { panelId: "panel-2", tabId: tab.id, pushHistory: true,
          snapshot: { ...tab.snapshot, location: { ...tab.snapshot.location, path: "C:\\elsewhere" }, entries: [] } } });
        await gate.finish(end === "fail" ? "listen failed" : undefined);
        if (end === "accept") {
          assert.deepEqual(wire.subscribed.map((request) => request.target.path), [f.path, f.path, "C:\\stay"]);
          assert.equal(movedTab(h.state, f.path).directorySizes?.consumerId, wire.subscribed[1].consumerId);
          assert.equal(wire.released.includes(old), true);
        } else if (end === "move-back") {
          assert.equal(wire.subscribed.filter((request) => request.target.path === "C:\\stay").length, 0);
          assert.equal(movedTab(h.state, f.path).directorySizes?.mode, "auto");
          // A subsequent move must not be stuck behind the cancelled destination wait.
          await h.dispatch(moveRight(movedTab(h.state, f.path).id));
          assert.equal(movedTab(h.state, "C:\\stay").directorySizes?.mode, "auto");
        } else {
          assert.equal(movedTab(h.state, "C:\\stay").directorySizes?.mode, "auto", "source is unblocked after failure/navigation");
          assert.equal(wire.released.includes(old), true);
          if (end === "fail") assert.equal(movedTab(h.state, f.path).directorySizes?.autoPaused, true);
        }
      } finally { await h.close(); }
    });
  } finally { dom.window.close(); }
})();

import assert from "node:assert/strict";
import { act } from "react";
import { controllerFixture, mountSizes, sizeTransport } from "./directorySizeControllerTestSupport";
import { assertTest, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { DirectorySizeViewsFlushRequested, UpdateDirectorySizeViewsRequest } from "./directorySizeViewsTypes";

export const completion = (async () => {
  const dom = installDomEnvironment();
  try {
    await assertTest("shutdown publishes all latest tabs through the real hook and freezes workspace structure", async () => {
      const requests: UpdateDirectorySizeViewsRequest[] = [];
      let flush!: (event: DirectorySizeViewsFlushRequested) => void; let disposed = false;
      const wire = sizeTransport({
        listenViewsFlush: async (listener) => { flush = listener; return () => { disposed = true; }; },
        updateViews: async (request) => { requests.push(request); return { acceptedRevision: request.revision, ownerEpoch: "7", truncated: false }; }
      });
      const h = await mountSizes(controllerFixture().state, wire.gateway);
      try {
        await h.change((state) => {
          const panel = state.panels["panel-1"];
          const tab = { ...panel.tabs[0], id: "just-created", snapshot: { ...panel.tabs[0].snapshot,
            location: { ...panel.tabs[0].snapshot.location, path: "D:\\latest" } } };
          return { ...state, panels: { ...state.panels, "panel-1": { ...panel, tabs: [...panel.tabs, tab] } } };
        });
        await act(async () => { flush({ nonce: "exit", ownerEpoch: "7" }); await flushEffects(); });
        assert.equal(requests.at(-1)?.shutdownNonce, "exit");
        assert.ok(requests.at(-1)?.scopes.some((scope) => scope.path === "D:\\latest"));
        assert.equal(h.state.directorySizeViewsFrozen, true);
        const before = h.state;
        await h.dispatch({ type: "tabActivated", payload: { panelId: "panel-1", tabId: "just-created" } });
        assert.equal(h.state, before, "late structural actions cannot change the frozen manifest");
      } finally { await h.close(); }
      assert.equal(disposed, true);
    });
  } finally { dom.window.close(); }
})();

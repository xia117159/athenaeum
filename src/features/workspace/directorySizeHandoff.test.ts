import assert from "node:assert/strict";
import { controllerFixture, mountSizes, sizeTransport } from "./directorySizeControllerTestSupport";
import { sizeSnapshot } from "./directorySizeTestSupport";
import { assertTest, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { SubscribeDirectorySizesRequest } from "./directorySizeTypes";

export const completion = (async () => {
  const dom = installDomEnvironment();
  try {
    await assertTest("switching same-path tabs hands off the running subscription before releasing its last lease", async () => {
      const f = controllerFixture();
      const calls: SubscribeDirectorySizesRequest[] = []; const released: string[] = [];
      let previousAlive = false;
      const wire = sizeTransport({
        subscribe: async (request) => {
          if (calls.length) {
            previousAlive = !released.includes(calls[0].consumerId);
          }
          calls.push(request);
          return sizeSnapshot({ consumerId: request.consumerId, phase: "scanning", totalBytes: null });
        },
        release: async (consumer) => { released.push(consumer); }
      });
      const h = await mountSizes(f.state, wire.gateway);
      try {
        await h.change((state) => {
          const panel = state.panels["panel-1"];
          const tab = { ...panel.tabs[0], id: "new-same-path", directorySizes: undefined };
          return { ...state, panels: { ...state.panels, "panel-1": { ...panel, activeTabId: tab.id, tabs: [tab] } } };
        });
        assert.equal(calls.length, 2);
        assert.equal(previousAlive, true, "old lease must still be alive at replacement");
        assert.equal("handoffFrom" in calls[1] && calls[1].handoffFrom, calls[0].consumerId);
        assert.equal(h.tab.directorySizes?.snapshot?.phase, "scanning");
      } finally { await h.close(); }
      assert.equal(wire.listeners.size, 0);
    });
  } finally { dom.window.close(); }
})();

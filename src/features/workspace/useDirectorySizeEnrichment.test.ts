import assert from "node:assert/strict";
import { act } from "react";
import { controllerFixture, mountSizes, sizeTransport } from "./directorySizeControllerTestSupport";
import { assertTest, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { DirectorySizeCacheUpdated, LookupDirectorySizeCacheRequest, DirectorySizeCacheLookup } from "./directorySizeCacheTypes";

export const completion = (async () => {
  const dom = installDomEnvironment();
  try {
    await assertTest("cache events and navigation retain a two-invoke limit across effects", async () => {
      const f = controllerFixture();
      f.tab.snapshot.entries.forEach((entry) => { entry.sizeCreatedAt = "2026-01-01T00:00:00Z"; });
      let event!: (event: DirectorySizeCacheUpdated) => void;
      const pending: Array<{ request: LookupDirectorySizeCacheRequest; resolve: (value: DirectorySizeCacheLookup) => void }> = [];
      let outstanding = 0; let peak = 0;
      const wire = sizeTransport({ listenCache: async (handler) => { event = handler; return () => {}; },
        lookupCache: (request) => new Promise((resolve) => {
          outstanding++; peak = Math.max(peak, outstanding);
          pending.push({ request, resolve: (value) => { outstanding--; resolve(value); } });
        }) });
      const h = await mountSizes(f.state, wire.gateway);
      let closed = false;
      try {
        for (let index = 0; index < 8; index++) {
          await act(async () => { event({ path: f.path, revision: String(index + 1), ownerEpoch: "1" }); await flushEffects(); });
          await h.change((state) => {
            const panel = state.panels["panel-1"]; const tab = panel.tabs[0];
            return { ...state, panels: { ...state.panels, "panel-1": { ...panel, tabs: [{ ...tab,
              snapshot: { ...tab.snapshot, entries: [...tab.snapshot.entries] } }] } } };
          });
        }
        assert.ok(peak <= 2, `actual invokes grew to ${peak}`);
        const old = pending.splice(0);
        await act(async () => {
          for (const call of old) call.resolve({ path: call.request.path, requestVersion: call.request.requestVersion, revision: "1", entries: [] });
          await flushEffects();
        });
        assert.ok(pending.length > 0, "completing old invokes must run the latest listing intent");
        await h.close(); closed = true;
        const count = pending.length;
        await act(async () => {
          for (const call of pending.slice()) call.resolve({ path: call.request.path, requestVersion: call.request.requestVersion, revision: "2", entries: [] });
          await flushEffects();
        });
        assert.equal(pending.length, count, "unmount must never start queued work");
      } finally { if (!closed) await h.close(); }
    });
  } finally { dom.window.close(); }
})();

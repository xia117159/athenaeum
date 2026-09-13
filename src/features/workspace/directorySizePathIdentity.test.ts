import assert from "node:assert/strict";
import { directorySizeContext } from "./directorySizePlanning";
import { controllerFixture, mountSizes, sizeTransport } from "./directorySizeControllerTestSupport";
import { assertTest, installDomEnvironment } from "./workspaceControllerTestHarness";

export const completion = (async () => {
  const dom = installDomEnvironment();
  try {
    await assertTest("distinct Unicode and case-sensitive local roots have distinct statistics identities", async () => {
      const f = controllerFixture();
      const context = (path: string) => directorySizeContext({ ...f.tab,
        snapshot: { ...f.tab.snapshot, location: { ...f.tab.snapshot.location, path } } }, []);
      assert.notEqual(context("C:\\data\\İ").identity, context("C:\\data\\i\u0307").identity);
      assert.notEqual(context("C:\\data\\Foo").identity, context("C:\\data\\foo").identity);
      assert.equal(context("C:\\data\\İ").target.kind, "local");
    });

    await assertTest("changing to a Unicode-casefold-colliding root releases the old lease and subscribes the actual new path", async () => {
      const f = controllerFixture(); const wire = sizeTransport();
      const first = "C:\\data\\İ"; const second = "C:\\data\\i\u0307";
      f.tab.snapshot = { ...f.tab.snapshot, location: { ...f.tab.snapshot.location, path: first }, entries: [] };
      f.tab.folderExpansion = undefined;
      const h = await mountSizes(f.state, wire.gateway);
      try {
        await h.change((state) => ({ ...state, panels: { ...state.panels, "panel-1": { ...state.panels["panel-1"],
          tabs: [{ ...h.tab, snapshot: { ...h.tab.snapshot, location: { ...h.tab.snapshot.location, path: second } } }]
        } } }));
        assert.deepEqual(wire.subscribed.map((request) => request.target), [{ kind: "local", path: first }, { kind: "local", path: second }]);
        assert.equal(wire.released.includes(wire.subscribed[0].consumerId), true);
      } finally { await h.close(); }
    });
  } finally { dom.window.close(); }
})();

import assert from "node:assert/strict";
import { act } from "react";
import { mountSizes, sizeTransport } from "./directorySizeControllerTestSupport";
import { emitSize, gateReplacement, movedTab, moveFixture, moveRight } from "./directorySizeMoveTestSupport";
import { sizeSnapshot } from "./directorySizeTestSupport";
import { getPathComparisonKey } from "./workspacePathRelations";
import { assertTest, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";

export const completion = (async () => {
  const dom = installDomEnvironment();
  try {
    for (const auto of [false, true]) await assertTest(`pending ${auto ? "auto" : "manual"} move routes old events to the renamed tab and fences them after acceptance`, async () => {
      const f = moveFixture(auto), wire = sizeTransport(), gate = gateReplacement(wire);
      const h = await mountSizes(f.state, wire.gateway);
      try {
        if (!auto) await h.request("calculate");
        const old = wire.subscribed[0].consumerId;
        await h.dispatch(moveRight(f.tab.id));
        assert.notEqual(movedTab(h.state, f.path).id, f.tab.id);
        await emitSize(wire, sizeSnapshot({ consumerId: old, generation: 4, sequence: 3, phase: "scanning" }));
        assert.equal(movedTab(h.state, f.path).directorySizes?.snapshot?.generation, 4);
        assert.equal(h.state.panels["panel-2"].tabs[0].directorySizes, undefined, "the colliding tab stays untouched");
        assert.equal(wire.subscribed.length, 2, "rendering old results must not restart the replacement");
        await gate.finish();
        const current = wire.subscribed[1].consumerId;
        await emitSize(wire, sizeSnapshot({ consumerId: current, generation: 5 }));
        await emitSize(wire, sizeSnapshot({ consumerId: old, generation: 99 }));
        assert.equal(movedTab(h.state, f.path).directorySizes?.snapshot?.generation, 5);
        assert.equal(wire.released.includes(old), true);
      } finally { await h.close(); }
    });

    await assertTest("a refused manual move keeps the old authorization and updates without retrying the transfer", async () => {
      const f = moveFixture(), wire = sizeTransport(), gate = gateReplacement(wire);
      const h = await mountSizes(f.state, wire.gateway);
      try {
        await h.request("calculate"); const old = wire.subscribed[0].consumerId;
        await h.dispatch(moveRight(f.tab.id)); await gate.finish("交接失败");
        await emitSize(wire, sizeSnapshot({ consumerId: old, generation: 7 }));
        await h.change((state) => ({ ...state, panels: { ...state.panels } }));
        const sizes = movedTab(h.state, f.path).directorySizes!;
        assert.equal(sizes.consumerId, old); assert.equal(sizes.requested, true); assert.equal(sizes.paused, false);
        assert.equal(sizes.snapshot?.generation, 7); assert.equal(wire.released.includes(old), false);
        assert.equal(wire.subscribed.length, 2);
        // Keeping the old lease does not swallow a failure from that lease itself.
        wire.gateway.lookup = async () => { throw new Error("旧订阅查询失败"); };
        await emitSize(wire, sizeSnapshot({ consumerId: old, generation: 8 }));
        assert.equal(movedTab(h.state, f.path).directorySizes?.snapshot?.phase, "failed");
        assert.match(movedTab(h.state, f.path).directorySizes?.snapshot?.reason ?? "", /旧订阅查询失败/);
      } finally { await h.close(); }
    });

    for (const staleListing of [false, true]) await assertTest(`lookup begun before a move follows its consumer; changed listing=${staleListing}`, async () => {
      const f = moveFixture(), wire = sizeTransport(), gate = gateReplacement(wire);
      const lookup = wire.gateway.lookup;
      const replies: Array<() => void> = [];
      wire.gateway.lookup = (request) => new Promise((resolve) => { replies.push(() => { void lookup(request).then(resolve); }); });
      const h = await mountSizes(f.state, wire.gateway);
      try {
        await h.request("calculate"); assert.equal(replies.length, 1);
        await h.dispatch(moveRight(f.tab.id));
        if (staleListing) await h.change((state) => ({ ...state, panels: { ...state.panels, "panel-2": {
          ...state.panels["panel-2"], tabs: state.panels["panel-2"].tabs.map((tab) => tab.snapshot.location.path !== f.path ? tab : {
            ...tab, snapshot: { ...tab.snapshot, entries: tab.snapshot.entries.map((entry) => ({ ...entry })) }
          })
        } } }));
        await act(async () => { replies.shift()!(); await flushEffects(); });
        const sizes = movedTab(h.state, f.path).directorySizes!;
        assert.equal(sizes.records[getPathComparisonKey(f.parent.path)]?.bytes, staleListing ? undefined : "60");
        await gate.finish();
      } finally { await h.close(); }
    });

    await assertTest("a failed automatic move pauses the moved tab, clears busy state and waits for explicit retry", async () => {
      const f = moveFixture(true), wire = sizeTransport(), gate = gateReplacement(wire);
      const h = await mountSizes(f.state, wire.gateway);
      try {
        const old = wire.subscribed[0].consumerId;
        await emitSize(wire, sizeSnapshot({ consumerId: old, generation: 2, phase: "scanning" }));
        await h.dispatch(moveRight(f.tab.id)); await gate.finish("自动交接失败");
        const tab = movedTab(h.state, f.path), sizes = tab.directorySizes!;
        assert.equal(sizes.autoPaused, true); assert.equal(sizes.consumerId, undefined);
        assert.notEqual(sizes.snapshot?.phase, "scanning"); assert.equal(sizes.pending, false);
        assert.match(sizes.autoError ?? "", /自动交接失败/);
        await h.change((state) => ({ ...state, panels: { ...state.panels } }));
        assert.equal(wire.subscribed.length, 2);
        await h.dispatch({ type: "directorySizeAutoRetried", payload: { panelId: "panel-2", tabId: tab.id, rootPath: f.path } });
        assert.equal(wire.subscribed.length, 3); assert.equal(wire.subscribed[2].retryFailed, true);
      } finally { await h.close(); }
    });
  } finally { dom.window.close(); }
})();

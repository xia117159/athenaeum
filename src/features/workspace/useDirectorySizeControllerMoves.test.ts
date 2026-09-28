import assert from "node:assert/strict";
import { act } from "react";
import { controllerFixture, mountSizes, sizeTransport } from "./directorySizeControllerTestSupport";
import { sizeSnapshot } from "./directorySizeTestSupport";
import { assertTest, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { DirectorySizeSnapshot } from "./directorySizeTypes";
import type { TabState, WorkspaceState } from "./types";

type Fixture = ReturnType<typeof controllerFixture>;
const tabOf = (state: WorkspaceState, id: string) => Object.values(state.panels).flatMap((panel) => panel.tabs).find((tab) => tab.id === id);
function plainTab(f: Fixture, id: string, path: string): TabState {
  return { ...f.tab, id, folderExpansion: undefined, directorySizes: undefined,
    snapshot: { ...f.tab.snapshot, location: { ...f.tab.snapshot.location, path }, entries: [] } };
}
function dualPanels(f: Fixture) {
  f.state.layoutMode = "dual";
  f.state.panels["panel-1"].tabs.push(plainTab(f, "stay", "C:\\stay"));
  f.state.panels["panel-2"] = { ...f.state.panels["panel-1"], id: "panel-2", tabs: [plainTab(f, "right", "C:\\right")], activeTabId: "right" };
}
/** Subscriptions after the first wait for `open()`, so a swap can be observed before it is accepted. */
function gatedAfterFirst(wire: ReturnType<typeof sizeTransport>) {
  const subscribe = wire.gateway.subscribe; const gates: Array<() => void> = [];
  wire.gateway.subscribe = (request) => {
    const value = subscribe(request);
    if (wire.subscribed.length === 1) return value;
    return new Promise<DirectorySizeSnapshot>((resolve) => { gates.push(() => void value.then(resolve)); });
  };
  return { async open() { await act(async () => { gates.shift()?.(); await flushEffects(); }); } };
}

export const completion = (async () => {
  const dom = installDomEnvironment();
  try {
    for (const mode of ["manual", "auto"] as const) await assertTest(`moving a tab to the other panel keeps its ${mode} lease until the moved lease is accepted`, async () => {
      const f = controllerFixture("local", { auto: mode === "auto" }); dualPanels(f);
      const wire = sizeTransport(); const gate = gatedAfterFirst(wire);
      const h = await mountSizes(f.state, wire.gateway);
      try {
        if (mode === "manual") await h.request("calculate");
        assert.equal(wire.subscribed.length, 1);
        const first = wire.subscribed[0].consumerId;
        await h.dispatch({ type: "tabMoved", payload: { sourcePanelId: "panel-1", targetPanelId: "panel-2", tabId: f.tab.id, targetIndex: 1 } });
        const moved = h.state.panels["panel-2"].tabs.find((tab) => tab.snapshot.location.path === f.path)!;
        assert.equal(wire.subscribed.length, 2, "the moved tab subscribes in its new panel");
        assert.equal(wire.subscribed[1].intent, mode === "auto" ? "auto" : "resume");
        if (mode === "auto") assert.equal(wire.subscribed[1].retryFailed, false);
        assert.deepEqual(wire.released, [], "the running calculation is never left without a lease");
        assert.equal(moved.directorySizes?.consumerId, first);
        await gate.open();
        assert.deepEqual(wire.released, [first]);
        const after = tabOf(h.state, moved.id)!;
        assert.equal(after.directorySizes?.consumerId, wire.subscribed[1].consumerId);
        assert.equal(after.directorySizes?.mode, mode);
        if (mode === "manual") assert.equal(after.directorySizes?.requested, true);
        await act(async () => { wire.emit(sizeSnapshot({ consumerId: wire.subscribed[1].consumerId, generation: 4, sequence: 2 })); await flushEffects(); });
        assert.equal(tabOf(h.state, moved.id)!.directorySizes?.snapshot?.generation, 4);
      } finally { await h.close(); }
    });

    await assertTest("an automatic replacement rejected twice never disturbs the manual lease that keeps receiving results (V22-002)", async () => {
      const f = controllerFixture("local", { auto: false }); const wire = sizeTransport();
      const subscribe = wire.gateway.subscribe;
      wire.gateway.subscribe = async (request) => { const value = await subscribe(request); if (request.intent === "auto") throw new Error("交接超时"); return value; };
      const h = await mountSizes(f.state, wire.gateway);
      try {
        await h.request("calculate");
        const manual = wire.subscribed[0].consumerId;
        const started = () => wire.subscribed.length;
        await h.change((state) => ({ ...state, settings: { ...state.settings, model: { ...state.settings.model, autoDirectorySizePaths: [f.path] } } }));
        assert.equal(started(), 2);
        for (const [attempt, generation] of [[1, 5], [2, 6]] as const) {
          await act(async () => { wire.emit(sizeSnapshot({ consumerId: manual, generation, sequence: 1 })); await flushEffects(); });
          const sizes = h.tab.directorySizes!;
          assert.equal(sizes.consumerId, manual, `attempt ${attempt}: the manual lease stays committed`);
          assert.equal(sizes.mode, "manual");
          assert.equal(sizes.requested, true);
          assert.equal(sizes.snapshot?.generation, generation, "manual results keep arriving");
          assert.equal(sizes.autoPaused, true);
          assert.match(sizes.autoError ?? "", /交接超时/);
          assert.equal(wire.released.includes(manual), false);
          if (attempt === 1) {
            await h.dispatch({ type: "directorySizeAutoRetried", payload: { panelId: "panel-1", tabId: f.tab.id, rootPath: f.path } });
            assert.equal(started(), 3, "only an explicit retry subscribes again");
            assert.equal(wire.subscribed[2].retryFailed, true);
          }
        }
        assert.equal(started(), 3, "no automatic retry loop after the second rejection");
        assert.equal(wire.subscribed.filter((request) => request.intent !== "auto").length, 1, "the manual lease is never subscribed twice");
      } finally { await h.close(); }
    });
  } finally { dom.window.close(); }
})();

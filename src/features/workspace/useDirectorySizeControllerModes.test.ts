import assert from "node:assert/strict";
import { act } from "react";
import { controllerFixture, mountSizes, sizeTransport, windowSwitch } from "./directorySizeControllerTestSupport";
import { sizeRecord, sizeSnapshot } from "./directorySizeTestSupport";
import { getFolderListingRows } from "./folderExpansion";
import { assertTest, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { DirectorySizeSnapshot, DirectorySizeTabState } from "./directorySizeTypes";
import type { TabState, WorkspaceState } from "./types";

type Fixture = ReturnType<typeof controllerFixture>;
function tabAt(f: Fixture, id: string, path: string, sizes?: Partial<DirectorySizeTabState>): TabState {
  return { ...f.tab, id, folderExpansion: undefined, snapshot: { ...f.tab.snapshot, location: { ...f.tab.snapshot.location, path }, entries: [] },
    directorySizes: sizes && { rootPath: path, requestVersion: 1, requested: true, paused: false, manualStarted: false, pending: false, records: {}, ...sizes } };
}
const tabOf = (state: WorkspaceState, id: string) => Object.values(state.panels).flatMap((panel) => panel.tabs).find((tab) => tab.id === id)!;
const activate = (tabId: string, panelId: "panel-1" | "panel-2" = "panel-1") => ({ type: "tabActivated" as const, payload: { panelId, tabId } });
/** Automatic subscriptions wait for `open()`; each one resolves or rejects by the next outcome. */
function gatedAuto(wire: ReturnType<typeof sizeTransport>, outcomes: Array<"resolve" | "reject"> = []) {
  const subscribe = wire.gateway.subscribe; const gates: Array<() => void> = [];
  wire.gateway.subscribe = (request) => {
    const value = subscribe(request);
    if (request.intent !== "auto") return value;
    const outcome = outcomes.shift() ?? "resolve";
    return new Promise<DirectorySizeSnapshot>((resolve, reject) => {
      gates.push(() => outcome === "resolve" ? void value.then(resolve) : reject(new Error("交接超时")));
    });
  };
  return { async open() { await act(async () => { gates.shift()?.(); await flushEffects(); }); } };
}

export const completion = (async () => {
  const dom = installDomEnvironment();
  try {
    await assertTest("a shown size column is not a request; manual leases survive tab switches and end on navigation", async () => {
      const f = controllerFixture("local", { auto: false }); const wire = sizeTransport();
      f.state.panels["panel-1"].tabs.push(tabAt(f, "other", "C:\\other"));
      const h = await mountSizes(f.state, wire.gateway);
      try {
        assert.equal(wire.subscribed.length, 0, "browsing never scans");
        await h.request("calculate");
        assert.equal(wire.subscribed.length, 1);
        assert.equal(wire.subscribed[0].intent, "calculate");
        const consumer = wire.subscribed[0].consumerId;
        assert.equal(h.tab.directorySizes?.consumerId, consumer);
        assert.equal(h.tab.directorySizes?.mode, "manual");
        await h.dispatch(activate("other"));
        assert.deepEqual(wire.released, [], "a background manual calculation keeps running");
        assert.equal(h.tab.directorySizes?.consumerId, consumer, "no release is committed for the background tab");
        await h.dispatch(activate(f.tab.id));
        assert.equal(wire.subscribed.length, 1);
        await h.dispatch({ type: "tabSnapshotCommitted", payload: { panelId: "panel-1", tabId: f.tab.id, pushHistory: true,
          snapshot: { ...f.tab.snapshot, location: { ...f.tab.snapshot.location, path: "C:\\elsewhere" }, entries: [] } } });
        assert.deepEqual(wire.released, [consumer]);
        assert.equal(h.tab.directorySizes, undefined);
        assert.equal(wire.subscribed.length, 1);
      } finally { await h.close(); }
    });

    await assertTest("remote first calculate starts shared work and a later calculate recalculates", async () => {
      const f = controllerFixture("sftp"); const wire = sizeTransport();
      const h = await mountSizes(f.state, wire.gateway);
      try {
        await h.request("calculate");
        await h.request("calculate");
        assert.deepEqual(wire.subscribed.map((request) => request.intent), ["start", "calculate"]);
      } finally { await h.close(); }
    });

    await assertTest("automatic roots cover descendants, replace a manual request, pause while the window is inactive and resume without retrying", async () => {
      const f = controllerFixture("local", { auto: false }); const wire = sizeTransport(); const win = windowSwitch();
      f.state.settings.model.autoDirectorySizePaths = ["C:\\"];
      f.tab.directorySizes = { rootPath: f.path, requestVersion: 0, requested: true, paused: false, manualStarted: false, pending: false, records: {} };
      const h = await mountSizes(f.state, wire.gateway, { windowActivity: win.gateway });
      try {
        assert.equal(wire.subscribed.length, 1);
        assert.equal(wire.subscribed[0].intent, "auto");
        assert.equal(wire.subscribed[0].retryFailed, true);
        assert.equal(h.tab.directorySizes?.mode, "auto");
        assert.equal(h.tab.directorySizes?.requested, false, "automatic coverage replaces the manual request");
        await act(async () => { win.set(false); await flushEffects(); });
        assert.deepEqual(wire.released, [wire.subscribed[0].consumerId]);
        assert.equal(wire.subscribed.length, 1);
        await act(async () => { win.set(true); await flushEffects(); });
        assert.equal(wire.subscribed.length, 2);
        assert.equal(wire.subscribed[1].intent, "auto");
        assert.equal(wire.subscribed[1].retryFailed, false);
      } finally { await h.close(); }
    });

    await assertTest("at most four background manual leases keep the newest requests; a returning tab resumes", async () => {
      const f = controllerFixture("local", { auto: false }); const wire = sizeTransport();
      const order = [6, 1, 2, 3, 4, 5];
      const tabs = order.map((requestedAt, index) => tabAt(f, `t${index}`, `C:\\t${index}`, { requestedAt }));
      f.state.panels["panel-1"] = { ...f.state.panels["panel-1"], tabs, activeTabId: "t0" };
      const h = await mountSizes(f.state, wire.gateway);
      try {
        const paths = () => wire.subscribed.map((request) => request.target.kind === "local" ? request.target.path : "");
        assert.deepEqual(paths().sort(), ["C:\\t0", "C:\\t2", "C:\\t3", "C:\\t4", "C:\\t5"]);
        assert.ok(wire.subscribed.every((request) => request.intent === "resume"));
        const t2 = tabOf(h.state, "t2").directorySizes!.consumerId!;
        await h.dispatch(activate("t1"));
        assert.equal(paths()[5], "C:\\t1");
        assert.equal(wire.subscribed[5].intent, "resume");
        assert.deepEqual(wire.released, [t2], "the oldest background request yields its lease");
        assert.equal(tabOf(h.state, "t2").directorySizes?.requested, true, "a released background request is kept");
      } finally { await h.close(); }
    });

    await assertTest("enabling automatic sizing replaces a running manual lease only after the automatic lease is accepted", async () => {
      const f = controllerFixture("local", { auto: false }); const wire = sizeTransport(); const gate = gatedAuto(wire);
      const h = await mountSizes(f.state, wire.gateway);
      try {
        await h.request("calculate");
        const manual = wire.subscribed[0].consumerId;
        await h.change((state) => ({ ...state, settings: { ...state.settings, model: { ...state.settings.model, autoDirectorySizePaths: [f.path] } } }));
        assert.equal(wire.subscribed.length, 2);
        assert.equal(wire.subscribed[1].intent, "auto");
        assert.deepEqual(wire.released, [], "no last-lease-left moment during the swap");
        assert.equal(h.tab.directorySizes?.consumerId, manual);
        await gate.open();
        assert.deepEqual(wire.released, [manual]);
        assert.equal(h.tab.directorySizes?.consumerId, wire.subscribed[1].consumerId);
        assert.equal(h.tab.directorySizes?.mode, "auto");
        assert.equal(h.tab.directorySizes?.snapshot?.phase, "complete", "the buffered snapshot is applied after commit");
      } finally { await h.close(); }
    });

    await assertTest("background manual leases never enter the panel slot while automatic tabs hand off through it", async () => {
      const f = controllerFixture("local", { auto: false }); const wire = sizeTransport();
      f.state.settings.model.autoDirectorySizePaths = ["C:\\auto-b", "C:\\auto-c"];
      f.state.panels["panel-1"].tabs.push(tabAt(f, "b", "C:\\auto-b"), tabAt(f, "c", "C:\\auto-c"));
      const h = await mountSizes(f.state, wire.gateway);
      try {
        await h.request("calculate");
        const manual = wire.subscribed[0].consumerId;
        await h.dispatch(activate("b"));
        assert.equal(wire.subscribed[1].intent, "auto");
        assert.equal(wire.subscribed[1].handoffFrom, undefined, "the manual lease is not the slot occupant");
        await h.dispatch(activate("c"));
        assert.equal(wire.subscribed[2].handoffFrom, wire.subscribed[1].consumerId);
        assert.deepEqual(wire.released, [wire.subscribed[1].consumerId]);
        assert.equal(h.tab.directorySizes?.consumerId, manual);
        await h.dispatch({ type: "tabSnapshotCommitted", payload: { panelId: "panel-1", tabId: f.tab.id, pushHistory: true,
          snapshot: { ...f.tab.snapshot, location: { ...f.tab.snapshot.location, path: "C:\\elsewhere" }, entries: [] } } });
        assert.equal(wire.released.includes(manual), true);
      } finally { await h.close(); }
    });

    await assertTest("a rejected automatic replacement keeps the manual lease; an explicit retry replaces it", async () => {
      const f = controllerFixture("local", { auto: false }); const wire = sizeTransport(); const gate = gatedAuto(wire, ["reject", "resolve"]);
      const h = await mountSizes(f.state, wire.gateway);
      try {
        await h.request("calculate");
        const manual = wire.subscribed[0].consumerId;
        await h.change((state) => ({ ...state, settings: { ...state.settings, model: { ...state.settings.model, autoDirectorySizePaths: [f.path] } } }));
        await gate.open();
        assert.equal(h.tab.directorySizes?.consumerId, manual);
        assert.equal(h.tab.directorySizes?.mode, "manual");
        assert.equal(h.tab.directorySizes?.requested, true);
        assert.equal(h.tab.directorySizes?.autoPaused, true);
        assert.match(h.tab.directorySizes?.autoError ?? "", /交接超时/);
        assert.equal(wire.subscribed.length, 2, "no automatic retry loop");
        assert.deepEqual(wire.released.includes(manual), false);
        await h.dispatch({ type: "directorySizeAutoRetried", payload: { panelId: "panel-1", tabId: f.tab.id, rootPath: f.path } });
        assert.equal(wire.subscribed.length, 3);
        assert.equal(wire.subscribed[2].intent, "auto");
        assert.equal(wire.subscribed[2].retryFailed, true);
        assert.equal(wire.released.includes(manual), false);
        await gate.open();
        assert.equal(wire.released.includes(manual), true);
        assert.equal(h.tab.directorySizes?.mode, "auto");
      } finally { await h.close(); }
    });

    for (const failure of ["scan", "subscribe"] as const) await assertTest(`an automatic ${failure} failure stays paused across window, tab and column changes until retried`, async () => {
      const f = controllerFixture(); const wire = sizeTransport(); const win = windowSwitch();
      f.state.panels["panel-1"].tabs.push(tabAt(f, "other", "C:\\other"));
      if (failure === "subscribe") {
        const subscribe = wire.gateway.subscribe;
        wire.gateway.subscribe = async (request) => { const value = await subscribe(request); if (wire.subscribed.length === 1) throw new Error("拒绝访问"); return value; };
      }
      const h = await mountSizes(f.state, wire.gateway, { windowActivity: win.gateway });
      try {
        if (failure === "scan") await act(async () => {
          wire.emit(sizeSnapshot({ consumerId: wire.subscribed[0].consumerId, generation: 1, sequence: 9, phase: "failed", totalBytes: null, reason: "拒绝访问" }));
          await flushEffects();
        });
        assert.equal(h.tab.directorySizes?.autoPaused, true);
        assert.equal(h.tab.directorySizes?.snapshot?.phase, "failed");
        assert.match(h.tab.directorySizes?.autoError ?? "", /拒绝访问/);
        const count = wire.subscribed.length;
        await act(async () => { win.set(false); await flushEffects(); win.set(true); await flushEffects(); });
        await h.dispatch(activate("other")); await h.dispatch(activate(f.tab.id));
        await h.change((state) => ({ ...state, panels: { ...state.panels, "panel-1": { ...state.panels["panel-1"], tabs: state.panels["panel-1"].tabs.map((tab) =>
          tab.id === f.tab.id ? { ...tab, columns: tab.columns.map((column) => ({ ...column, visible: column.id !== "size" })) } : tab) } } }));
        await h.change((state) => ({ ...state, panels: { ...state.panels, "panel-1": { ...state.panels["panel-1"], tabs: state.panels["panel-1"].tabs.map((tab) =>
          tab.id === f.tab.id ? { ...tab, columns: f.tab.columns } : tab) } } }));
        assert.equal(wire.subscribed.length, count, "no new scan without an explicit retry");
        assert.equal(h.tab.directorySizes?.snapshot?.phase, "failed");
        await h.dispatch({ type: "directorySizeAutoRetried", payload: { panelId: "panel-1", tabId: f.tab.id, rootPath: f.path } });
        assert.equal(wire.subscribed.length, count + 1);
        assert.equal(wire.subscribed[count].retryFailed, true);
      } finally { await h.close(); }
    });

    await assertTest("background leases do not look up sizes until their tab is visible again", async () => {
      const f = controllerFixture("local", { auto: false }); const wire = sizeTransport();
      f.state.panels["panel-1"].tabs.push(tabAt(f, "other", "C:\\other"));
      const h = await mountSizes(f.state, wire.gateway);
      try {
        await h.request("calculate");
        assert.equal(wire.lookedUp.length, 1);
        const consumer = wire.subscribed[0].consumerId;
        await h.dispatch(activate("other"));
        await act(async () => { wire.emit(sizeSnapshot({ consumerId: consumer, generation: 2, sequence: 3 })); await flushEffects(); });
        assert.equal(tabOf(h.state, f.tab.id).directorySizes?.snapshot?.generation, 2);
        assert.equal(wire.lookedUp.length, 1);
        await h.dispatch(activate(f.tab.id));
        assert.equal(wire.lookedUp.length, 2);
        assert.equal(wire.lookedUp[1].generation, 2);
      } finally { await h.close(); }
    });

    for (const readable of [true, false]) await assertTest(`a resumed ${readable ? "readable" : "unreadable"} stale result ${readable ? "shows old values grey" : "is never looked up"}`, async () => {
      const f = controllerFixture("local", { auto: false });
      f.tab.directorySizes = { rootPath: f.path, requestVersion: 1, requested: true, paused: false, manualStarted: false, pending: false, records: {} };
      const wire = sizeTransport({
        subscribe: async (request) => {
          wire.subscribed.push(request);
          return sizeSnapshot({ consumerId: request.consumerId, phase: "stale", staleReadable: readable, invalidated: true, totalBytes: null,
            invalidationRevision: "1", reason: "实时监控不可用，结果可能已过期，可重新计算" });
        },
        lookup: async (request) => {
          wire.lookedUp.push(request);
          return { ...request, sequence: 2, stale: false, directories: request.paths.map((path) =>
            /[\\/]parent$/.test(path) ? sizeRecord(path, "60", "parent-stamp", "stale") : sizeRecord(path, "100", "root-stamp", "stale")) };
        }
      });
      const h = await mountSizes(f.state, wire.gateway);
      try {
        assert.equal(wire.subscribed[0].intent, "resume");
        assert.equal(h.tab.directorySizes?.snapshot?.phase, "stale");
        const parent = getFolderListingRows(h.tab).find(({ entry }) => entry.path === f.parent.path)!.entry.sizeDisplay;
        if (readable) {
          assert.equal(wire.lookedUp.length, 1);
          assert.equal(parent?.invalidated, true);
          assert.equal(parent?.bytes, "60");
          assert.equal(parent?.share, null);
        } else {
          assert.equal(wire.lookedUp.length, 0);
          assert.equal(parent?.invalidated, undefined);
        }
      } finally { await h.close(); }
    });

    await assertTest("two panels calculating the same folder hold independent leases for the same target", async () => {
      const f = controllerFixture("local", { auto: false }); const wire = sizeTransport();
      f.state.layoutMode = "dual";
      f.state.panels["panel-2"] = { ...f.state.panels["panel-1"], id: "panel-2", tabs: [tabAt(f, "second", f.path)], activeTabId: "second" };
      const h = await mountSizes(f.state, wire.gateway);
      try {
        await h.request("calculate", "panel-1");
        await h.request("calculate", "panel-2", "second");
        assert.equal(wire.subscribed.length, 2);
        assert.deepEqual(wire.subscribed[0].target, wire.subscribed[1].target);
        assert.notEqual(wire.subscribed[0].consumerId, wire.subscribed[1].consumerId);
        assert.equal(tabOf(h.state, "second").directorySizes?.consumerId, wire.subscribed[1].consumerId);
      } finally { await h.close(); }
    });
  } finally { dom.window.close(); }
})();

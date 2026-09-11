import assert from "node:assert/strict";
import { act } from "react";
import { controllerFixture, mountSizes, sizeTransport } from "./directorySizeControllerTestSupport";
import { sizeSnapshot } from "./directorySizeTestSupport";
import { getFolderListingRows } from "./folderExpansion";
import { assertTest, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { WorkspaceState } from "./types";
import type { DirectorySizeSnapshot, SubscribeDirectorySizesRequest } from "./directorySizeTypes";

function changeTab(state: WorkspaceState, patch: Partial<WorkspaceState["panels"]["panel-1"]["tabs"][0]>) {
  const panel = state.panels["panel-1"];
  return { ...state, panels: { ...state.panels, "panel-1": { ...panel, tabs: [{ ...panel.tabs[0], ...patch }] } } };
}

export const completion = (async () => {
  const dom = installDomEnvironment();
  try {
    await assertTest("local Details automatically calculates once; sorting filtering and expansion only use cached directory lookups", async () => {
      const f = controllerFixture(); const wire = sizeTransport();
      const h = await mountSizes(f.state, wire.gateway);
      try {
        assert.equal(wire.subscribed.length, 1);
        assert.deepEqual(wire.subscribed[0].target, { kind: "local", path: f.path });
        assert.equal(wire.subscribed[0].refresh, false);
        assert.equal(getFolderListingRows(h.tab)[0].entry.sizeDisplay?.share, .6);
        assert.equal(wire.lookedUp.flatMap((request) => request.paths).some((path) => path.endsWith(".txt")), false);
        await h.change((state) => ({ ...changeTab(state, { sort: { columnId: "size", direction: "desc" } }), search: { ...state.search, filterText: "child" } }));
        await h.change((state) => changeTab(state, { folderExpansion: undefined }));
        assert.equal(wire.subscribed.length, 1);
        assert.deepEqual(h.interactions.resolvedPaths, []);
        await h.request("cancel");
        assert.equal(wire.released.length, 1);
        assert.equal(h.tab.directorySizes?.paused, true);
        await h.change((state) => ({ ...state, search: { ...state.search, filterText: "" } }));
        assert.equal(wire.subscribed.length, 1);
        await h.request("calculate");
        assert.equal(wire.subscribed.length, 2);
        assert.equal(wire.subscribed[1].refresh, true);
      } finally { await h.close(); }
      assert.equal(wire.listeners.size, 0);
      assert.equal(wire.released.length, 2);
    });

    for (const kind of ["ftp", "sftp"] as const) await assertTest(`${kind} is manual, maps only bounded remote paths, and never resumes recursion on view changes`, async () => {
      const f = controllerFixture(kind); const wire = sizeTransport();
      const h = await mountSizes(f.state, wire.gateway);
      try {
        assert.equal(wire.subscribed.length, 0);
        await h.request("refresh"); assert.equal(wire.subscribed.length, 0);
        await h.request("calculate"); assert.equal(wire.subscribed.length, 1);
        assert.deepEqual(wire.subscribed[0].target, { kind: "remote", profileId: "remote-size", path: "/home" });
        assert.equal(JSON.stringify(wire.subscribed).includes("must-not-be-sent"), false);
        assert.deepEqual(wire.lookedUp[0].paths, ["/home", "/home/parent"]);
        assert.equal(getFolderListingRows(h.tab)[0].entry.sizeDisplay?.share, .6);
        await h.change((state) => changeTab(state, { viewMode: "list" }));
        assert.equal(wire.released.length, 1);
        await h.change((state) => changeTab(state, { viewMode: "details" }));
        assert.equal(wire.subscribed.length, 1);
        await h.request("refresh"); assert.equal(wire.subscribed.length, 2);
        await act(async () => { wire.emit(sizeSnapshot({ consumerId: wire.subscribed[1].consumerId, generation: 2, sequence: 3, phase: "stale", totalBytes: null })); await flushEffects(); });
        assert.equal(wire.subscribed.length, 2);
        assert.equal(h.tab.directorySizes?.snapshot?.phase, "stale");
        await h.change((state) => ({ ...state, remoteProfiles: state.remoteProfiles.map((profile) => ({ ...profile, commandTimeoutSecs: 45 })) }));
        assert.equal(wire.subscribed.length, 2, "profile replacement must await manual intent");
        assert.equal(wire.released.length, 2);
      } finally { await h.close(); }
    });

    await assertTest("settings-only role, inactive tabs, hidden columns and non-directory views do not acquire leases", async () => {
      const f = controllerFixture(); const wire = sizeTransport();
      const settings = await mountSizes(f.state, wire.gateway, { enabled: false });
      assert.equal(wire.subscribed.length, 0); await settings.close();
      for (const patch of [{ kind: "navigation" as const }, { kind: "search-results" as const }, { viewMode: "tiles" as const },
        { snapshot: { ...f.tab.snapshot, location: { ...f.tab.snapshot.location, kind: "virtual" as const } } },
        { columns: f.tab.columns.map((column) => ({ ...column, visible: column.id !== "size" })) }]) {
        const h = await mountSizes(changeTab(f.state, patch), wire.gateway);
        assert.equal(wire.subscribed.length, 0); await h.close();
      }
      const h = await mountSizes(f.state, wire.gateway);
      try {
        const first = wire.subscribed[0].consumerId;
        await h.change((state) => changeTab(state, { columns: h.tab.columns.map((column) => ({ ...column, visible: column.id !== "size" })) }));
        assert.equal(wire.released.includes(first), true);
        await h.change((state) => changeTab(state, { columns: f.tab.columns }));
        assert.equal(wire.subscribed.length, 2);
      } finally { await h.close(); }
    });

    await assertTest("a failed listener is visible once and never silently starts scans or retries", async () => {
      let attempts = 0;
      const wire = sizeTransport({ listen: async () => { attempts++; throw new Error("listener unavailable"); } });
      const f = controllerFixture(); const h = await mountSizes(f.state, wire.gateway);
      try {
        assert.equal(h.tab.directorySizes?.snapshot?.phase, "failed");
        assert.match(h.tab.directorySizes?.snapshot?.reason ?? "", /listener unavailable/);
        await h.change((state) => ({ ...state, search: { ...state.search, filterText: "a" } }));
        assert.equal(attempts, 1); assert.equal(wire.subscribed.length, 0);
      } finally { await h.close(); }
    });

    await assertTest("inactive tabs and hidden panels release only their own size leases", async () => {
      const f = controllerFixture(); const wire = sizeTransport();
      const panel = f.state.panels["panel-1"];
      const inactive = { ...panel.tabs[0], id: "inactive-size-tab" };
      panel.tabs.push(inactive);
      f.state.panels["panel-2"] = { ...panel, id: "panel-2", tabs: [{ ...inactive, id: "hidden-size-tab" }], activeTabId: "hidden-size-tab" };
      const h = await mountSizes(f.state, wire.gateway);
      try {
        assert.equal(wire.subscribed.length, 1);
        const first = wire.subscribed[0].consumerId;
        await h.dispatch({ type: "tabActivated", payload: { panelId: "panel-1", tabId: inactive.id } });
        assert.deepEqual(wire.released, [first]);
        assert.equal(wire.subscribed.length, 2);
        const active = wire.subscribed[1].consumerId;
        await h.dispatch({ type: "layoutModeSet", payload: "dual" });
        assert.equal(wire.subscribed.length, 3);
        const secondary = wire.subscribed[2].consumerId;
        await h.dispatch({ type: "layoutModeSet", payload: "single" });
        assert.equal(wire.released.includes(secondary), true);
        assert.equal(wire.released.includes(active), false);
        assert.equal(wire.subscribed.length, 3);
      } finally { await h.close(); }
    });

    await assertTest("navigation releases a slow subscription and its late result cannot populate the new root", async () => {
      const f = controllerFixture();
      const requests: SubscribeDirectorySizesRequest[] = [];
      let finishOld!: (snapshot: DirectorySizeSnapshot) => void;
      const wire = sizeTransport({ subscribe: async (request) => {
        requests.push(request);
        if (requests.length === 1) return new Promise((resolve) => { finishOld = resolve; });
        return sizeSnapshot({ consumerId: request.consumerId, generation: 2 });
      } });
      const h = await mountSizes(f.state, wire.gateway);
      try {
        const oldConsumer = requests[0].consumerId;
        const destination = { ...f.tab.snapshot, location: { ...f.tab.snapshot.location, path: "C:\\next-root" }, entries: [] };
        await h.dispatch({ type: "tabSnapshotCommitted", payload: { panelId: "panel-1", tabId: f.tab.id, snapshot: destination, pushHistory: true } });
        assert.equal(requests.length, 2);
        assert.equal(wire.released.includes(oldConsumer), true);
        await act(async () => {
          const late = sizeSnapshot({ consumerId: oldConsumer, generation: 999, totalBytes: "999" });
          wire.emit(late); finishOld(late); await flushEffects();
        });
        assert.equal(h.tab.snapshot.location.path, destination.location.path);
        assert.equal(h.tab.directorySizes?.consumerId, requests[1].consumerId);
        assert.equal(h.tab.directorySizes?.snapshot?.totalBytes, "100");
        assert.equal(wire.released.filter((id) => id === oldConsumer).length, 2);
      } finally { await h.close(); }
    });
  } finally { dom.window.close(); }
})();

import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { useWorkspaceController } from "./useWorkspaceController";
import { controllerFixture, sizeTransport } from "./directorySizeControllerTestSupport";
import { expansionEntry, expansionInteractions } from "./folderExpansionTestSupport";
import { sizeRecord } from "./directorySizeTestSupport";
import { getFolderListingRows } from "./folderExpansion";
import { assertTest, createTestGateway, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { DirectorySnapshot } from "./types";

async function mount(kind: "local" | "sftp", role: "workspace" | "settings" = "workspace",
  configure?: (fixture: ReturnType<typeof controllerFixture>, wire: ReturnType<typeof sizeTransport>) => void) {
  const f = controllerFixture(kind); const wire = sizeTransport();
  configure?.(f, wire);
  f.bootstrap.panels = f.state.panels; f.bootstrap.remoteProfiles = f.state.remoteProfiles;
  let finish: ((snapshot: DirectorySnapshot) => void) | undefined;
  const gateway = createTestGateway(() => undefined, expansionInteractions(), { loadBootstrap: () => f.bootstrap,
    resolveDirectory: () => new Promise((resolve) => { finish = resolve; }) });
  gateway.directorySizes = wire.gateway;
  let current!: ReturnType<typeof useWorkspaceController>;
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  function Harness() { current = useWorkspaceController(gateway, { role }); return React.createElement("div"); }
  await act(async () => { root.render(React.createElement(Harness)); await flushEffects(); });
  return { f, wire, get current() { return current; }, get tab() { return current.state.panels["panel-1"].tabs[0]; },
    async calculate() {
      const action = Reflect.get(current.actions, "requestDirectorySizes");
      assert.equal(typeof action, "function");
      await act(async () => { action("panel-1", f.tab.id, "calculate"); await flushEffects(); });
    },
    async refresh() { await act(async () => { current.actions.refreshPanel("panel-1"); await flushEffects(); }); },
    async finishRefresh() { await act(async () => { assert.equal(typeof finish, "function"); finish!({ ...f.tab.snapshot }); await flushEffects(); }); },
    async close() { await act(async () => { root.unmount(); await flushEffects(); }); container.remove(); }
  };
}

export const completion = (async () => {
  const dom = installDomEnvironment();
  try {
    await assertTest("workspace owns local automatic sizing, settings controller role never scans", async () => {
      const main = await mount("local");
      try { assert.equal(main.wire.subscribed.length, 1); } finally { await main.close(); }
      const settings = await mount("local", "settings");
      try { assert.equal(settings.wire.subscribed.length, 0); } finally { await settings.close(); }
    });
    await assertTest("explicit F5 invalidates local sizes and preserves remote manual refresh through the loading/release race", async () => {
      const local = await mount("local");
      try {
        await local.refresh(); await local.finishRefresh();
        assert.equal(local.wire.subscribed.length, 2);
        assert.equal(local.wire.subscribed[1].refresh, true);
      } finally { await local.close(); }
      const remote = await mount("sftp");
      try {
        await remote.refresh(); await remote.finishRefresh();
        assert.equal(remote.wire.subscribed.length, 0);
        await remote.calculate(); assert.equal(remote.wire.subscribed.length, 1);
        await remote.refresh();
        assert.equal(remote.tab.status, "loading");
        assert.equal(remote.wire.subscribed.length, 1);
        await remote.finishRefresh();
        assert.equal(remote.wire.subscribed.length, 2);
        assert.equal(remote.wire.subscribed[1].refresh, true);
      } finally { await remote.close(); }
    });
    await assertTest("keyboard selection uses exact folder-size ordering even when inline expansion is disabled", async () => {
      const h = await mount("local", "workspace", (f, wire) => {
        f.bootstrap.settingsModel = { ...f.bootstrap.settingsModel, folderExpansionEnabled: false };
        const large = expansionEntry(f.path, "a-large");
        f.tab.snapshot.entries = [large, f.parent];
        f.tab.folderExpansion = undefined;
        f.tab.sort = { columnId: "size", direction: "asc" };
        wire.gateway.lookup = async (request) => ({ ...request, sequence: 2, stale: false,
          directories: request.paths.map((path) => sizeRecord(path, path === f.path ? "100" : path === f.parent.path ? "20" : "80", "root-stamp")) });
      });
      try {
        const rows = getFolderListingRows(h.tab, h.current.state.fileVisibility, "", false);
        assert.deepEqual(rows.map((row) => row.entry.name), ["parent", "a-large"]);
        await act(async () => { window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Home", bubbles: true })); await flushEffects(); });
        assert.deepEqual(h.tab.selectedEntryIds, [rows[0].entry.id]);
        await act(async () => { window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true })); await flushEffects(); });
        assert.deepEqual(h.tab.selectedEntryIds, rows.map((row) => row.entry.id));
      } finally { await h.close(); }
    });
  } finally { dom.window.close(); }
})();

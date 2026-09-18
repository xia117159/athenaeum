import assert from "node:assert/strict";
import React, { act, useReducer } from "react";
import ReactDOM from "react-dom/client";
import { useDirectorySizeController } from "./useDirectorySizeController";
import { workspaceReducer, type WorkspaceAction } from "./workspaceReducer";
import { controllerFixture, sizeTransport } from "./directorySizeControllerTestSupport";
import { createTestGateway, assertTest, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import { expansionInteractions } from "./folderExpansionTestSupport";
import { sizeRecord, sizeSnapshot } from "./directorySizeTestSupport";
import { getFolderListingRows } from "./folderExpansion";
import { SizeShareCell } from "./SizeShareCell";
import type { DirectorySizeLookup, LookupDirectorySizesRequest } from "./directorySizeTypes";

export const completion = (async () => {
  const dom = installDomEnvironment();
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  const f = controllerFixture(); const wire = sizeTransport();
  const gateway = createTestGateway(() => undefined, expansionInteractions()); gateway.directorySizes = wire.gateway;
  const originalLookup = wire.gateway.lookup;
  let hold = false;
  let pending: { request: LookupDirectorySizesRequest; resolve: (value: DirectorySizeLookup) => void; reject: (error: Error) => void } | undefined;
  wire.gateway.lookup = (request) => hold ? new Promise((resolve, reject) => { pending = { request, resolve, reject }; }) : originalLookup(request);
  let dispatch!: React.Dispatch<WorkspaceAction>;
  function Harness() {
    const [state, send] = useReducer(workspaceReducer, f.state); dispatch = send;
    useDirectorySizeController({ state, dispatch: send, workspaceGateway: gateway });
    const tab = state.panels["panel-1"].tabs.find((candidate) => candidate.id === state.panels["panel-1"].activeTabId)!;
    return <div>{getFolderListingRows(tab).map(({ entry }) => <div key={entry.id} data-name={entry.name}><SizeShareCell entry={entry} /></div>)}</div>;
  }
  const row = (name: string) => [...container.querySelectorAll<HTMLElement>("[data-name]")].find((node) => node.dataset.name === name)!;
  const run = async (action: () => void) => act(async () => { action(); await flushEffects(); });
  try {
    await assertTest("live controller refresh keeps size bar DOM nodes and replaces values only when the complete batch arrives", async () => {
      await run(() => root.render(<Harness />));
      assert.equal(row("parent").textContent, "60 B");
      const parentBar = row("parent").querySelector<HTMLElement>(".size-share-bar")!;
      const fileBar = row("a.txt").querySelector<HTMLElement>(".size-share-bar")!;
      const consumerId = wire.subscribed[0].consumerId;
      hold = true;
      for (const [sequence, phase] of [[1, "stale"], [2, "scanning"], [3, "complete"]] as const) {
        await run(() => wire.emit(sizeSnapshot({ consumerId, generation: 2, sequence, phase })));
        assert.equal(row("parent").textContent, "60 B");
        assert.equal(row("parent").querySelector(".size-share-bar"), parentBar);
        assert.equal(row("a.txt").querySelector(".size-share-bar"), fileBar);
        assert.equal(parentBar.style.getPropertyValue("--size-share"), "60%");
      }
      assert.ok(pending);
      await run(() => pending!.resolve({ ...pending!.request, sequence: 3, stale: false, directories: [
        sizeRecord(f.path, "120", "root-stamp"), sizeRecord(f.parent.path, "80", "parent-stamp")
      ] }));
      assert.equal(row("parent").textContent, "80 B");
      assert.equal(row("parent").querySelector(".size-share-bar"), parentBar);
      assert.equal(fileBar.style.getPropertyValue("--size-share"), "25%");

      await run(() => dispatch({ type: "directorySizeRequested", payload: { panelId: "panel-1", tabId: f.tab.id, rootPath: f.path, intent: "cancel" } }));
      assert.equal(row("parent").querySelector(".size-share-bar"), parentBar);
      assert.match(row("parent").querySelector(".size-share-value")!.getAttribute("title")!, /上次.*取消/);
      await run(() => dispatch({ type: "directorySizeRequested", payload: { panelId: "panel-1", tabId: f.tab.id, rootPath: f.path, intent: "calculate" } }));
      await run(() => pending!.reject(new Error("lookup unavailable")));
      assert.equal(row("parent").textContent, "80 B");
      assert.equal(row("parent").querySelector(".size-share-bar"), parentBar);
      assert.match(row("parent").querySelector(".size-share-value")!.getAttribute("title")!, /lookup unavailable/);
    });
  } finally { await run(() => root.unmount()); container.remove(); dom.window.close(); }
})();

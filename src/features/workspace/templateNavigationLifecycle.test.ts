import assert from "node:assert/strict";
import React, { act } from "react";
import { useWorkspaceController } from "./useWorkspaceController";
import { expansionFixture, expansionInteractions } from "./folderExpansionTestSupport";
import { createTestGateway, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { PanelId } from "./types";

export const completion = (async () => {
  installDomEnvironment();
  const ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  for (const scenario of ["moved", "id-collision", "newer-request", "returned-before", "returned-after", "reordered"]) {
    const f = expansionFixture();
    f.bootstrap.layoutMode = "dual";
    f.bootstrap.settingsModel.templateRoot = "C:\\Templates";
    const original = f.bootstrap.panels["panel-1"].tabs[0];
    f.bootstrap.panels["panel-1"].tabs.push({ ...original, id: "source-spare" });
    if (scenario === "id-collision") f.bootstrap.panels["panel-2"].tabs.push({ ...original });
    const gateway = createTestGateway(() => {}, expansionInteractions(), { loadBootstrap: () => f.bootstrap });
    gateway.templates.list = async () => ({ rootPath: "C:\\Templates", relativePath: "", entries: [] });
    const baseResolve = gateway.resolveDirectory;
    type Resolved = Awaited<ReturnType<typeof baseResolve>>;
    const pending = new Map<string, (snapshot: Resolved) => void>();
    const firstPath = "C:\\moving-first", secondPath = "C:\\moving-second";
    gateway.resolveDirectory = async path => [firstPath, secondPath].includes(path)
      ? new Promise<Resolved>(resolve => pending.set(path, resolve)) : baseResolve(path);
    let controller!: ReturnType<typeof useWorkspaceController>;
    function Harness() { controller = useWorkspaceController(gateway); return null; }
    const root = ReactDOM.createRoot(document.getElementById("root")!);
    const tick = async (fn: () => void) => act(async () => { fn(); await flushEffects(); await flushEffects(); });
    const finish = async (path: string) => {
      const resolve = pending.get(path)!; pending.delete(path);
      const snapshot = await baseResolve(path);
      await tick(() => resolve(snapshot));
    };
    let panelId: PanelId = "panel-1", tabId = f.tabId;
    const currentTab = () => controller.state.panels[panelId].tabs.find(tab => tab.id === tabId)!;
    const move = async (targetPanelId: PanelId, index = 0) => {
      await tick(() => controller.actions.moveTab(panelId, targetPanelId, tabId, index));
      panelId = targetPanelId; tabId = controller.state.panels[panelId].activeTabId;
    };
    try {
      await tick(() => root.render(React.createElement(Harness)));
      await tick(() => controller.actions.navigateToPath(panelId, firstPath));
      const firstRequest = currentTab().pendingNavigationRequestId!;
      assert.equal(typeof firstRequest, "number");
      await move(scenario === "reordered" ? "panel-1" : "panel-2", scenario === "reordered" ? 2 : 0);
      if (scenario === "id-collision") assert.notEqual(tabId, f.tabId, "destination collision changes the moved tab ID");
      if (scenario === "returned-before") await move("panel-1");
      await tick(() => controller.actions.openTemplateMenu(panelId, tabId, { x: 60, y: 80 }));
      assert.equal(controller.state.templateMenu, undefined, "moving a tab does not prematurely release its navigation guard");
      if (scenario === "newer-request") {
        await tick(() => controller.actions.navigateToPath(panelId, secondPath));
        const latestRequest = currentTab().pendingNavigationRequestId!;
        assert.ok(latestRequest > firstRequest);
        await finish(firstPath);
        assert.equal(currentTab().pendingNavigationRequestId, latestRequest, "an older owner cannot release a newer request");
        await tick(() => controller.actions.openTemplateMenu(panelId, tabId, { x: 60, y: 80 }));
        assert.equal(controller.state.templateMenu, undefined);
        await finish(secondPath);
        assert.equal(currentTab().snapshot.location.path, secondPath);
      } else await finish(firstPath);
      if (scenario === "returned-after") await move("panel-1");
      assert.equal(currentTab().pendingNavigationRequestId, undefined, `${scenario}: completion must find the current owner`);
      await tick(() => controller.actions.openTemplateMenu(panelId, tabId, { x: 60, y: 80 }));
      assert.ok(controller.state.templateMenu, `${scenario}: stable moved tab can create templates again`);
      console.log(`ok - template navigation lifecycle: ${scenario}`);
    } finally {
      for (const path of [...pending.keys()]) await finish(path);
      await tick(() => root.unmount());
    }
  }
})();

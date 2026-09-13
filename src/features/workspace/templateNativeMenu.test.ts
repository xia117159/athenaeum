import assert from "node:assert/strict";
import React, { act } from "react";
import { useWorkspaceController } from "./useWorkspaceController";
import { expansionFixture, expansionInteractions } from "./folderExpansionTestSupport";
import { createTestGateway, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { NativeBackgroundContextMenuResult } from "./types";

export const completion = (async () => {
  installDomEnvironment();
  const ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  for (const scenario of ["normal", "complete", "pending", "failed", "return", "overlap"]) {
    const f = expansionFixture(); f.bootstrap.settingsModel.templateRoot = "C:\\Templates";
    const gateway = createTestGateway(() => {}, expansionInteractions(), { loadBootstrap: () => f.bootstrap });
    let resolve!: (result: NativeBackgroundContextMenuResult) => void;
    gateway.showNativeBackgroundContextMenu = async () => new Promise(done => { resolve = done; });
    gateway.templates.list = async () => ({ rootPath: "C:\\Templates", relativePath: "", entries: [] });
    const baseResolve = gateway.resolveDirectory;
    type Resolved = Awaited<ReturnType<typeof baseResolve>>;
    const pending = new Map<string, { resolve: (value: Resolved) => void; reject: (error: Error) => void }>();
    const firstPath = "C:\\deferred-B", secondPath = "C:\\deferred-C";
    gateway.resolveDirectory = async path => [firstPath, secondPath].includes(path)
      ? new Promise<Resolved>((resolve, reject) => pending.set(path, { resolve, reject })) : baseResolve(path);
    let controller!: ReturnType<typeof useWorkspaceController>;
    function Harness() { controller = useWorkspaceController(gateway); return null; }
    const root = ReactDOM.createRoot(document.getElementById("root")!);
    const tick = async (fn: () => void) => act(async () => { fn(); await flushEffects(); await flushEffects(); });
    const finishNavigation = async (path: string, fail = false) => {
      const request = pending.get(path)!; pending.delete(path);
      const value = fail ? undefined : await baseResolve(path);
      await tick(() => { if (fail) request.reject(new Error("navigation failed")); else request.resolve(value!); });
    };
    try {
      await tick(() => root.render(React.createElement(Harness)));
      await tick(() => controller.actions.openNativeContextMenu({ panelId: "panel-1", tabId: f.tabId, target: "background", paths: [],
        directoryPath: f.path, clientX: 60, clientY: 80, screenX: 300, screenY: 400 }));
      if (scenario !== "normal") await tick(() => controller.actions.navigateToPath("panel-1", firstPath));
      if (["complete", "return", "failed"].includes(scenario)) await finishNavigation(firstPath, scenario === "failed");
      if (scenario === "return") await tick(() => controller.actions.navigateToPath("panel-1", f.path));
      if (scenario === "overlap") {
        await tick(() => controller.actions.navigateToPath("panel-1", secondPath));
        await finishNavigation(firstPath);
      }
      if (["pending", "overlap"].includes(scenario)) {
        await tick(() => controller.actions.openTemplateMenu("panel-1", f.tabId, { x: 60, y: 80 }));
        assert.equal(controller.state.templateMenu, undefined, `${scenario}: cannot open a fresh template menu while navigation is pending`);
      }
      await tick(() => resolve({ opened: true, action: { type: "createTemplate" } }));
      if (scenario !== "normal") assert.equal(controller.state.templateMenu, undefined, `${scenario}: native reply must not revive an invalidated target`);
      else {
        assert.equal(controller.state.templateMenu?.target.rootPath, f.path);
        assert.deepEqual(controller.state.templateMenu?.levels[0].anchor, { x: 60, y: 80 });
      }
      for (const path of [...pending.keys()]) await finishNavigation(path);
      await tick(() => controller.actions.openTemplateMenu("panel-1", f.tabId, { x: 60, y: 80 }));
      assert.ok(controller.state.templateMenu, `${scenario}: a new capture works after navigation settles`);
      console.log(`ok - native template transfer (${scenario})`);
    } finally {
      for (const path of [...pending.keys()]) await finishNavigation(path);
      await tick(() => root.unmount());
    }
  }
})();

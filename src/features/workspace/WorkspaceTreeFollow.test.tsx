import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { createMockWorkspaceBootstrap } from "./mockData";
import { getActiveTab } from "./workspaceReducer";
import { expansionInteractions } from "./folderExpansionTestSupport";
import { assertTest, createTestGateway, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { DirectoryNode } from "./types";

export const completion = (async () => {
  const dom = installDomEnvironment();
  globalThis.Element = dom.window.Element;
  const module = require("./useWorkspaceController") as typeof import("./useWorkspaceController");
  const original = module.useWorkspaceController;
  const { WorkspaceView } = require("./WorkspaceView") as typeof import("./WorkspaceView");
  const tick = async (fn: () => void) => act(async () => { fn(); await flushEffects(); });
  for (const lateFailure of [false, true]) {
    await assertTest(`real tree remains fixed across tabs, navigation, settings sync and late ${lateFailure ? "failure" : "success"}`, async () => {
      const bootstrap = createMockWorkspaceBootstrap("tauri");
      bootstrap.settingsModel.treeAutoFollowEnabled = false;
      bootstrap.treeState = { activePath: "D:\\", expandedNodePaths: [] };
      bootstrap.activePanelId = "panel-1";
      bootstrap.layoutMode = "dual";
      bootstrap.directoryTree = [ { id: "D:\\", path: "D:\\", label: "D", kind: "drive", expandable: true, loaded: false, children: [] } ];
      const interactions = expansionInteractions();
      let resolve!: (children: DirectoryNode[]) => void;
      let reject!: (error: Error) => void;
      const gateway = createTestGateway(() => undefined, interactions, { loadBootstrap: () => bootstrap,
        loadTreeChildren: () => new Promise<DirectoryNode[]>((yes, no) => { resolve = yes; reject = no; }) });
      let settingsChanged: Parameters<typeof gateway.listenSettingsChanged>[0] | undefined;
      gateway.listenSettingsChanged = async handler => { settingsChanged = handler; return () => undefined; };
      let controller!: ReturnType<typeof original>;
      module.useWorkspaceController = () => { controller = original(gateway); return controller; };
      const container = document.createElement("div"); document.body.appendChild(container);
      const root = ReactDOM.createRoot(container);
      const treeMarkup = () => container.querySelector(".tree-pane")?.innerHTML;
      try {
        await tick(() => root.render(<WorkspaceView />));
        assert.equal(controller.state.status, "ready");
        assert.deepEqual(interactions.treeLoadPaths, [], "collapsed shared tree must ignore tab expansion memories");
        const frozen = treeMarkup();
        const second = controller.state.panels["panel-1"].tabs[1];
        await tick(() => controller.actions.activateTab("panel-1", second.id));
        await tick(() => controller.actions.focusPanel("panel-2"));
        await tick(() => controller.actions.submitAddress("panel-2", "C:\\Users\\Admin"));
        await tick(() => controller.actions.navigateHistory("panel-2", -1));
        await tick(() => controller.actions.navigateHistory("panel-2", 1));
        assert.equal(treeMarkup(), frozen);
        assert.deepEqual(interactions.treeLoadPaths, []);
        await tick(() => container.querySelector<HTMLButtonElement>('.tree-node__label')!.click());
        assert.equal(getActiveTab(controller.state.panels["panel-2"]).snapshot.location.path, "D:\\", "tree still drives listing");
        assert.equal(controller.state.treeState.activePath, "D:\\");
        await tick(() => controller.actions.openNavigationTab());
        await tick(() => container.querySelector<HTMLButtonElement>('[aria-label="expand D"]')!.click());
        assert.deepEqual(interactions.treeLoadPaths, ["D:\\"]);
        await tick(() => container.querySelector<HTMLButtonElement>('[aria-label="collapse D"]')!.click());
        if (lateFailure) await tick(() => container.querySelector<HTMLButtonElement>('[aria-label="expand D"]')!.click());
        const pendingTree = controller.state.treeState;
        await tick(() => lateFailure ? reject(new Error("late")) : resolve([]));
        assert.deepEqual(controller.state.treeState, pendingTree, "late completion cannot alter manual state");
        await tick(() => controller.actions.focusPanel("panel-1"));
        const saves = interactions.savedSettingsModels.length;
        await tick(() => settingsChanged!({ settingsModel: { ...controller.state.settings.model, treeAutoFollowEnabled: true },
          bookmarks: controller.state.bookmarks, hotlist: controller.state.hotlist,
          remoteProfiles: controller.state.remoteProfiles, navigationItems: controller.state.navigation.items }));
        assert.equal(controller.state.settings.model.treeAutoFollowEnabled, true);
        assert.equal(controller.state.treeState.activePath, getActiveTab(controller.state.panels["panel-1"]).snapshot.location.path);
        assert.equal(interactions.savedSettingsModels.length, saves, "settings sync must not echo a save");
      } finally {
        await tick(() => root.unmount()); container.remove(); module.useWorkspaceController = original;
      }
    });
  }
  await assertTest("restored remote tree does not connect while local or navigation tab has focus", async () => {
    const bootstrap = createMockWorkspaceBootstrap("tauri");
    const path = "sftp://user@host/home";
    bootstrap.treeState = { activePath: path, expandedNodePaths: [path] };
    bootstrap.directoryTree = [{ id: path, path, label: "Remote", kind: "remote-root", expandable: true, loaded: false, children: [] }];
    const interactions = expansionInteractions();
    const gateway = createTestGateway(() => undefined, interactions, { loadBootstrap: () => bootstrap });
    let controller!: ReturnType<typeof original>;
    function Harness() { controller = original(gateway); return null; }
    const container = document.createElement("div"); const root = ReactDOM.createRoot(container);
    try {
      await tick(() => root.render(<Harness />));
      await tick(() => controller.actions.openNavigationTab());
      assert.deepEqual(interactions.treeLoadPaths, []);
      const panel = controller.state.panels[controller.state.activePanelId];
      await tick(() => controller.actions.toggleTreeNode(panel.id, panel.activeTabId, path, false));
      await tick(() => controller.actions.toggleTreeNode(panel.id, panel.activeTabId, path, true));
      assert.deepEqual(interactions.treeLoadPaths, [path], "explicit expansion is allowed on navigation tab");
    } finally { await tick(() => root.unmount()); }
  });
  await assertTest("settings window cannot overwrite the live workspace tree session", async () => {
    const bootstrap = createMockWorkspaceBootstrap("tauri");
    const gateway = createTestGateway(() => undefined, expansionInteractions(), { loadBootstrap: () => bootstrap });
    let sessionWrites = 0;
    gateway.saveSession = async () => { sessionWrites++; };
    let controller!: ReturnType<typeof original>;
    function Harness() { controller = original(gateway, { role: "settings" }); return null; }
    const container = document.createElement("div"); const root = ReactDOM.createRoot(container);
    try {
      await tick(() => root.render(<Harness />));
      await act(async () => {
        await controller.actions.applySettingsModel({ ...controller.state.settings.model, treeAutoFollowEnabled: true });
        await flushEffects();
      });
      assert.equal(sessionWrites, 0, "settings controller owns preferences, not the active workspace session");
    } finally { await tick(() => root.unmount()); }
  });
})();

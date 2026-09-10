import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { createWorkspaceState } from "./workspaceReducer";
import { expansionFixture, expansionInteractions, expansionSnapshot } from "./folderExpansionTestSupport";
import { getPathComparisonKey } from "./workspacePathRelations";
import { assertTest, createTestGateway, flushEffects, installDomEnvironment, waitFor } from "./workspaceControllerTestHarness";

export const completion = (async () => {
  const dom = installDomEnvironment();
  globalThis.Element = dom.window.Element;
  const f = expansionFixture("sftp");
  const state = createWorkspaceState(f.bootstrap);
  const tab = state.panels["panel-1"].tabs[0];
  tab.folderExpansion = { [getPathComparisonKey(f.parent.path)]: { path: f.parent.path, entries: [f.child, f.nested], status: "ready" } };
  tab.selectedEntryIds = [f.child.id];
  const toggled: unknown[][] = [];
  const actions = new Proxy({ toggleFolderExpansion: (...args: unknown[]) => toggled.push(args) }, {
    get: (target, key) => Reflect.get(target, key) ?? (() => undefined)
  });
  const module = require("./useWorkspaceController") as typeof import("./useWorkspaceController");
  const originalController = module.useWorkspaceController;
  module.useWorkspaceController = (() => ({ state, actions })) as unknown as typeof originalController;
  const { WorkspaceView } = require("./WorkspaceView") as typeof import("./WorkspaceView");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  const render = async () => act(async () => { root.render(<WorkspaceView />); await flushEffects(); });
  const paths = () => [...container.querySelectorAll<HTMLElement>(".file-row")].map((row) => row.dataset.entryPath);
  try {
    await assertTest("workspace wiring projects remote children into the listing and selection summary", async () => {
      await render();
      assert.deepEqual(paths(), [f.parent.path, f.nested.path, f.child.path, f.sibling.path]);
      assert.match(container.querySelector(".information-panel__summary")?.textContent ?? "", /4 项/);
      assert.match(container.querySelector(".information-panel__summary")?.textContent ?? "", /child.txt/);
      const arrow = container.querySelector<HTMLButtonElement>('[aria-label="收起 parent"]');
      assert.ok(arrow);
      await act(async () => { arrow.click(); await flushEffects(); });
      assert.deepEqual(toggled, [["panel-1", tab.id, f.parent.path]]);
    });
    await assertTest("quick filter retains ancestors; child context menus and counts use the same visible rows", async () => {
      state.search.filterText = "child.txt";
      state.contextMenu = { panelId: "panel-1", tabId: tab.id, mode: "custom", scope: "selection", x: 0, y: 0 };
      await render();
      assert.deepEqual(paths(), [f.parent.path, f.child.path]);
      assert.match(container.querySelector(".information-panel__summary")?.textContent ?? "", /2 项/);
      assert.ok([...document.querySelectorAll(".context-menu__item")].find((button) => button.textContent?.includes("复制文件名")));
      state.search.filterText = "sibling";
      await render();
      assert.deepEqual(paths(), [f.sibling.path]);
      assert.doesNotMatch(container.querySelector(".information-panel__summary")?.textContent ?? "", /child.txt/);
      assert.equal([...document.querySelectorAll(".context-menu__item")].some((button) => button.textContent?.includes("复制文件名")), false);
    });
    await assertTest("disabled, icon and search-result views do not expose folder expansion", async () => {
      state.contextMenu = undefined;
      state.search.filterText = "";
      for (const excluded of ["disabled", "icons", "search"] as const) {
        state.settings.model.folderExpansionEnabled = excluded !== "disabled";
        tab.kind = excluded === "search" ? "search-results" : "directory";
        tab.viewMode = excluded === "icons" ? "large-icons" : "details";
        await render();
        assert.equal(container.querySelector(".file-name-tree__toggle"), null);
        assert.equal([...container.querySelectorAll<HTMLElement>("[data-entry-path]")].some((row) => row.dataset.entryPath === f.child.path), false);
      }
    });
  } finally {
    await act(async () => { root.unmount(); await flushEffects(); });
    container.remove();
    module.useWorkspaceController = originalController;
  }

  await assertTest("real workspace shortcuts leave an expansion button for row navigation and Enter", async () => {
    const live = expansionFixture();
    const interactions = expansionInteractions();
    const gateway = createTestGateway(() => undefined, interactions, {
      loadBootstrap: () => live.bootstrap,
      resolveDirectory: async (path) => expansionSnapshot(path, path === live.path ? [live.parent, live.sibling] : [live.nested, live.child])
    });
    let controller!: ReturnType<typeof originalController>;
    module.useWorkspaceController = () => { controller = originalController(gateway); return controller; };
    const liveContainer = document.createElement("div");
    document.body.appendChild(liveContainer);
    const liveRoot = ReactDOM.createRoot(liveContainer);
    const key = async (value: string, ctrlKey = false) => act(async () => {
      (document.activeElement ?? window).dispatchEvent(new dom.window.KeyboardEvent("keydown", {
        key: value, ctrlKey, bubbles: true, cancelable: true
      }));
      await flushEffects();
    });
    try {
      await act(async () => { liveRoot.render(<WorkspaceView />); await flushEffects(); });
      await waitFor(() => controller?.state.status === "ready", "live workspace did not bootstrap");
      const parentRow = [...liveContainer.querySelectorAll<HTMLElement>(".file-row")].find((row) => row.dataset.entryPath === live.parent.path)!;
      await act(async () => { parentRow.click(); await flushEffects(); });
      const arrow = parentRow.querySelector<HTMLButtonElement>(".file-name-tree__toggle")!;
      await act(async () => { arrow.focus(); arrow.click(); await flushEffects(); });
      assert.equal(document.activeElement, arrow);
      await key("ArrowDown");
      assert.deepEqual(controller.state.panels["panel-1"].tabs[0].selectedEntryIds, [live.nested.id]);
      assert.notEqual(document.activeElement, arrow, "row navigation must release expansion-button focus before Enter");
      await key("ArrowDown");
      assert.deepEqual(controller.state.panels["panel-1"].tabs[0].selectedEntryIds, [live.child.id]);
      await key("Enter");
      assert.deepEqual(interactions.systemOpens, [live.child.path]);
      arrow.focus();
      await key("a", true);
      assert.deepEqual(new Set(controller.state.panels["panel-1"].tabs[0].selectedEntryIds),
        new Set([live.parent.id, live.nested.id, live.child.id, live.sibling.id]));
      const rootReads = interactions.resolvedPaths.filter((path) => path === live.path).length;
      await key("F5");
      assert.equal(interactions.resolvedPaths.filter((path) => path === live.path).length, rootReads + 1);
    } finally {
      await act(async () => { liveRoot.unmount(); await flushEffects(); });
      liveContainer.remove();
      module.useWorkspaceController = originalController;
    }
  });
})();

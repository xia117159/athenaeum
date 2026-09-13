import assert from "node:assert/strict";
import React, { act } from "react";
import { useWorkspaceController } from "./useWorkspaceController";
import { createMockWorkspaceBootstrap } from "./mockData";
import { createEntry, createTestGateway, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import { expansionInteractions } from "./folderExpansionTestSupport";
import type { BatchRenameSession } from "../../app/batchRename";

export const completion = (async () => {
  const dom = installDomEnvironment();
  const ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  const bootstrap = createMockWorkspaceBootstrap("tauri");
  bootstrap.layoutMode = "single"; bootstrap.activePanelId = "panel-1";
  const tab = bootstrap.panels["panel-1"].tabs[0];
  bootstrap.panels["panel-1"].activeTabId = tab.id;
  const a = createEntry(tab.snapshot.location.path, "Test.txt");
  const b = createEntry(tab.snapshot.location.path, "Other.txt");
  tab.snapshot.entries = [a, b]; tab.selectedEntryIds = [a.id]; tab.selectionCursorId = a.id;
  const gateway = createTestGateway(() => {}, expansionInteractions(), { loadBootstrap: () => bootstrap });
  const creates: string[][] = [];
  gateway.batchRename.create = paths => { creates.push(paths); return new Promise<BatchRenameSession>(() => {}); };
  let controller!: ReturnType<typeof useWorkspaceController>;
  const dialog = () => controller.state.batchRename;
  const inlineEdit = () => controller.state.panels["panel-1"].tabs[0].inlineEdit;
  function Harness() { controller = useWorkspaceController(gateway); return null; }
  const root = ReactDOM.createRoot(document.getElementById("root")!);
  const tick = async (fn: () => void) => act(async () => { fn(); await flushEffects(); });
  const key = (key: string, init: KeyboardEventInit = {}) => tick(() => window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })));
  try {
    await tick(() => root.render(React.createElement(Harness)));
    await key("F2");
    assert.equal(controller.state.panels["panel-1"].tabs[0].inlineEdit?.mode, "rename");
    assert.equal(dialog(), undefined);
    await tick(() => controller.actions.cancelInlineEdit("panel-1", tab.id));
    await tick(() => controller.actions.selectEntryRange("panel-1", tab.id, b.id, a.id, [a.id, b.id]));
    await key("F2");
    assert.equal(dialog()?.phase, "loading", "multi F2 opens the batch dialog");
    assert.equal(creates[0]?.length, 2);
    assert.deepEqual(new Set(creates[0]), new Set([a.path, b.path]));
    await key("Delete");
    assert.equal(controller.state.panels["panel-1"].tabs[0].inlineEdit, undefined);
    await tick(() => controller.actions.closeBatchRename(dialog()!.id));
    await tick(() => controller.actions.selectEntry("panel-1", tab.id, a.id, false));
    await key("m", { ctrlKey: true });
    assert.equal(dialog()?.target.entries.length, 1, "Ctrl+M works with one selected file");
    await tick(() => controller.actions.closeBatchRename(dialog()!.id));
    await tick(() => controller.actions.updateShortcutBinding("batch-rename", "Ctrl+Shift+M"));
    await key("m", { ctrlKey: true }); assert.equal(dialog(), undefined);
    await key("m", { ctrlKey: true, shiftKey: true }); assert.ok(dialog());
    await tick(() => controller.actions.closeBatchRename(dialog()!.id));
    let resolveNative!: (value: { opened: boolean; action?: { type: "rename" } }) => void;
    let allowRename: boolean | undefined;
    let renameAccelerator: string | undefined;
    gateway.showNativeContextMenu = async (_paths, _x, _y, shortcuts) => {
      allowRename = shortcuts.allowRename;
      renameAccelerator = shortcuts.rename;
      return new Promise(resolve => { resolveNative = resolve; });
    };
    const request = { panelId: "panel-1" as const, tabId: tab.id, paths: [b.path, a.path],
      clientX: 10, clientY: 10, screenX: 100, screenY: 100 };
    await tick(() => controller.actions.openNativeContextMenu(request));
    assert.equal(allowRename, true, "listing native menu must explicitly provide the application rename action");
    assert.equal(renameAccelerator, "Ctrl+Shift+M", "multi-selection menu shows the configured batch rename shortcut");
    await tick(() => controller.actions.selectEntry("panel-1", tab.id, a.id, false));
    await tick(() => resolveNative({ opened: true, action: { type: "rename" } }));
    assert.deepEqual(dialog()?.target.entries.map(entry => entry.path), request.paths, "native rename uses the captured collection and order");
    await tick(() => controller.actions.closeBatchRename(dialog()!.id));
    await tick(() => controller.actions.openNativeContextMenu({ ...request, paths: [a.path] }));
    assert.equal(allowRename, true);
    assert.equal(renameAccelerator, "F2", "single selection retains the ordinary rename shortcut");
    await tick(() => controller.actions.selectEntry("panel-1", tab.id, b.id, false));
    await tick(() => resolveNative({ opened: true, action: { type: "rename" } }));
    assert.equal(dialog(), undefined, "single native rename must not open the batch dialog");
    assert.equal(inlineEdit()?.originalPath, a.path,
      "single native rename edits the captured item even if the selection changed");
    await tick(() => controller.actions.cancelInlineEdit("panel-1", tab.id));
    await tick(() => controller.actions.openNativeContextMenu(request));
    await tick(() => resolveNative({ opened: false }));
    await tick(() => controller.actions.renameSelection("panel-1"));
    assert.deepEqual(dialog()?.target.entries.map(entry => entry.path), request.paths, "fallback rename uses the same captured collection");
    await tick(() => controller.actions.closeBatchRename(dialog()!.id));
    await tick(() => controller.actions.selectEntry("panel-1", tab.id, a.id, false));
    await tick(() => {
      controller.actions.selectEntry("panel-1", tab.id, b.id, false);
      controller.actions.openContextMenu({ panelId: "panel-1", tabId: tab.id, x: 10, y: 10, mode: "custom", scope: "selection" });
    });
    assert.deepEqual(controller.state.contextMenu?.renameTarget?.entries.map(entry => entry.path), [b.path],
      "right clicking an unselected row captures the new selection in the same event");
    console.log("ok - F2, configurable Ctrl+M and native/fallback menus retain captured rename targets");
  } finally { await tick(() => root.unmount()); }
})();

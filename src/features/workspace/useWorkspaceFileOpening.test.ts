import assert from "node:assert/strict";
import React, { act } from "react";
import { useWorkspaceController } from "./useWorkspaceController";
import { createMockWorkspaceBootstrap } from "./mockData";
import { createEntry, createTestGateway, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import { expansionInteractions } from "./folderExpansionTestSupport";
import type { FileOpenRequest } from "../../app/fileAssociations";
import { WorkspaceInformationPanel } from "./WorkspaceInformationPanel";

export const completion = (async () => {
  const dom = installDomEnvironment();
  const ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  const bootstrap = createMockWorkspaceBootstrap("tauri");
  bootstrap.layoutMode = "single"; bootstrap.activePanelId = "panel-1";
  const tab = bootstrap.panels["panel-1"].tabs[0];
  bootstrap.panels["panel-1"].activeTabId = tab.id;
  const a = createEntry(tab.snapshot.location.path, "a.txt");
  const b = createEntry(tab.snapshot.location.path, "b.txt");
  const folder = createEntry(tab.snapshot.location.path, "folder", "folder");
  tab.snapshot.entries = [a,b,folder]; tab.selectedEntryIds = [a.id]; tab.selectionCursorId = a.id;
  bootstrap.settingsModel.fileAssociations = [
    {id:"first",patterns:"txt",executablePath:"C:\\first.exe",argumentsTemplate:""},
    {id:"second",patterns:".TXT",executablePath:"C:\\second.exe",argumentsTemplate:"--new {file}"}
  ];
  bootstrap.navigationItems = [{id:"nav-file",path:b.path,displayName:"B",description:"",targetKind:"file",
    targetStatus:"ok",sortOrder:0,createdAt:"2026-09-12",updatedAt:"2026-09-12"}];
  const interactions = expansionInteractions();
  const gateway = createTestGateway(() => {}, interactions, {loadBootstrap:() => bootstrap});
  const opened: FileOpenRequest[] = [];
  gateway.openFile = async (request, progress) => {
    opened.push(request); progress({phase:"preparing"}); progress({phase:"opening"});
    return {status:"opened",localPath:request.target.path,associationId:request.associationId ?? "first"};
  };
  let controller!: ReturnType<typeof useWorkspaceController>;
  let role: "workspace" | "settings" = "workspace";
  function Harness() {
    controller = useWorkspaceController(gateway, {role});
    const {state, actions} = controller;
    return React.createElement(WorkspaceInformationPanel, {
      informationPanel: {...state.informationPanel, expanded:true, activeTab:"search"},
      search:state.search, operations:state.operations, activeEntries:[a,b,folder], selectedEntries:[a],
      onToggleExpanded:actions.setInformationPanelExpanded, onSelectInformationTab:actions.selectInformationPanelTab,
      onOpenHistory:actions.openOperationHistory, onRunSearch:() => {void actions.runSearch();},
      onStopSearch:() => {void actions.stopSearch();}, onSelectSearchTab:actions.selectSearchTab,
      onUpdateQuery:actions.updateSearchQuery, onUpdateFilter:actions.updateSearchFilter,
      onSelectHistory:actions.selectSearchHistory, onDeleteHistory:actions.deleteSearchHistory
    });
  }
  const root = ReactDOM.createRoot(document.getElementById("root")!);
  const tick = async (fn:() => void) => act(async () => {fn(); await flushEffects();});
  const key = async (name: string, init: KeyboardEventInit = {}, target: EventTarget = window) => {
    const event = new dom.window.KeyboardEvent("keydown",{key:name,bubbles:true,cancelable:true,...init});
    await tick(() => target.dispatchEvent(event)); return event;
  };
  try {
    await tick(() => root.render(React.createElement(Harness)));
    await tick(() => controller.actions.openEntry("panel-1",a));
    assert.equal(opened.length,1,"double click must use the unified opening gateway");
    await tick(() => controller.actions.openSearchResult("panel-1",b));
    await tick(() => controller.actions.openNavigationItem("panel-1","nav-file"));
    await tick(() => controller.actions.selectEntryRange("panel-1",tab.id,b.id,a.id,[a.id,b.id]));
    await key("Enter");
    assert.deepEqual(opened.map(request => request.target.path),[a.path,b.path,b.path,a.path],"all four entry points share the cursor-first file-opening route");
    assert.ok(opened.every(request => request.associationId == null),"ordinary opening lets persisted backend rules decide priority");
    assert.equal(interactions.systemOpens.length,0,"old default-open route must not remain in ordinary entry points");
    await key("o",{ctrlKey:true,altKey:true});
    assert.deepEqual(controller.state.openWithMenu?.ruleIds,["first","second"]);
    const blocked = await key("Delete");
    assert.equal(blocked.defaultPrevented,true); assert.equal(interactions.deleteCalls.length,0);
    await tick(() => controller.actions.selectEntry("panel-1",tab.id,folder.id,false));
    assert.equal(controller.state.openWithMenu,undefined,"selection changes close the menu");
    await key("o",{ctrlKey:true,altKey:true});
    assert.equal(controller.state.openWithMenu,undefined,"a folder cursor must not target a different selected file");
    await tick(() => controller.actions.selectEntry("panel-1",tab.id,a.id,false));
    const input = document.createElement("input"); document.body.appendChild(input); input.focus();
    await key("o",{ctrlKey:true,altKey:true},input);
    assert.equal(controller.state.openWithMenu,undefined,"editable controls keep their keyboard input");
    input.remove();
    const history = document.querySelector<HTMLElement>(".information-panel__history");
    assert.ok(history, "the real information panel renders its keyboard-accessible history");
    await tick(() => history.focus());
    await key("o", {ctrlKey:true,altKey:true}, history);
    assert.equal(controller.state.openWithMenu, undefined, "search history must not open the background listing's menu");
    assert.equal(document.activeElement, history);
    history.blur();
    await tick(() => controller.actions.updateShortcutBinding("open-with","Ctrl+Shift+O"));
    await key("o",{ctrlKey:true,altKey:true}); assert.equal(controller.state.openWithMenu,undefined);
    await key("o",{ctrlKey:true,shiftKey:true}); assert.ok(controller.state.openWithMenu);
    await tick(() => controller.actions.setLayoutMode("dual"));
    await tick(() => controller.actions.focusPanel("panel-2")); assert.equal(controller.state.openWithMenu,undefined);
    role = "settings";
    await tick(() => root.render(React.createElement(Harness)));
    await key("o",{ctrlKey:true,shiftKey:true}); assert.equal(controller.state.openWithMenu,undefined);
    console.log("ok - four unified opening routes, cursor selection, configurable shortcut and modal keyboard guards");
  } finally { await tick(() => root.unmount()); }
})();

import assert from "node:assert/strict";
import React, { act, useState } from "react";
import { OpenWithMenu } from "./OpenWithMenu";
import { createMockWorkspaceBootstrap } from "./mockData";
import { createWorkspaceState, workspaceReducer } from "./workspaceReducer";
import { createOpenWithMenu } from "./fileOpeningState";
import { createEntry, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { WorkspaceState } from "./types";
import { setSystemIconResolverForTests, type SystemIconRequest } from "./systemIconGateway";

export const completion = (async () => {
  const dom = installDomEnvironment();
  const iconRequests: SystemIconRequest[] = [];
  const programIcon = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="green"/></svg>');
  setSystemIconResolverForTests(async request => { iconRequests.push(request); return programIcon; });
  const ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  const state = createWorkspaceState(createMockWorkspaceBootstrap("tauri"));
  const tab = state.panels[state.activePanelId].tabs[0];
  const file = createEntry(tab.snapshot.location.path,"文档.txt");
  tab.snapshot.entries = [file]; tab.selectedEntryIds = [file.id];
  state.settings.model.fileAssociations = [
    {id:"new",patterns:"txt",executablePath:"C:\\editor.exe",argumentsTemplate:"--new {file}"},
    {id:"reuse",patterns:"txt",executablePath:"C:\\editor.exe",argumentsTemplate:"--reuse {file}"}
  ];
  const listing = document.createElement("div"); listing.className = "file-listing__scroll";
  listing.dataset.panelId = state.activePanelId; listing.tabIndex = -1;
  const row = document.createElement("div"); row.dataset.entryPath = file.path;
  listing.append(row); document.body.append(listing);
  Object.defineProperty(window,"innerWidth",{configurable:true,value:800});
  Object.defineProperty(window,"innerHeight",{configurable:true,value:600});
  const rect = (left:number,top:number,width:number,height:number) => ({left,top,width,height,right:left+width,bottom:top+height,x:left,y:top,toJSON:() => ({})});
  row.getBoundingClientRect = () => rect(620,560,150,24);
  listing.getBoundingClientRect = () => rect(500,100,290,490);
  const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
  let menuHeight = 160;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function() {
    return this.classList.contains("open-with-menu") ? rect(0,0,360,menuHeight) : originalRect.call(this);
  };
  state.openWithMenu = createOpenWithMenu(state,"menu");
  const opened: number[] = [];
  let latest = state;
  let change!: (updater: (previous:WorkspaceState) => WorkspaceState) => void;
  function Harness() {
    const [value,set] = useState(state); latest = value; change = set;
    return value.openWithMenu ? <OpenWithMenu menu={value.openWithMenu} rules={value.settings.model.fileAssociations ?? []}
      onSelect={(_id,index) => set(previous => workspaceReducer(previous,{type:"openWithSelectionChanged",payload:index}))}
      onConfirm={(_id,index) => {opened.push(index ?? value.openWithMenu!.selectedIndex); set(previous => ({...previous,openWithMenu:undefined}));}}
      onClose={() => set(previous => ({...previous,openWithMenu:undefined}))} /> : null;
  }
  const root = ReactDOM.createRoot(document.getElementById("root")!);
  const tick = async (fn: () => void) => act(async () => {fn(); await flushEffects();});
  const menu = () => document.querySelector<HTMLElement>('[role="menu"][aria-label="打开方式"]')!;
  const key = async (key:string) => tick(() => menu().dispatchEvent(new dom.window.KeyboardEvent("keydown",{key,bubbles:true,cancelable:true})));
  const reopen = async (empty = false) => tick(() => change(previous => {
    const next = {...previous,settings:{...previous.settings,model:{...previous.settings.model,
      fileAssociations: empty ? [] : state.settings.model.fileAssociations}}};
    return {...next,openWithMenu:createOpenWithMenu(next,crypto.randomUUID())};
  }));
  try {
    await tick(() => root.render(<Harness />));
    assert.ok(menu(),"menu should be rendered");
    assert.equal(menu().querySelector(".open-with-menu__heading") === null, true, "menu has no filename heading");
    assert.equal(menu().textContent?.includes("文档.txt"), false);
    assert.equal(document.activeElement,menu());
    assert.equal(menu().style.left,"432px"); assert.equal(menu().style.top,"432px");
    assert.equal(menu().querySelectorAll('[role="menuitem"]').length,3);
    assert.match(menu().textContent ?? "",/editor.exe/);
    assert.equal(menu().textContent?.includes("--new"), false);
    assert.equal(menu().textContent?.includes("--reuse"), false);
    assert.equal(menu().textContent?.includes("C:\\editor.exe"), false);
    const items = menu().querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    assert.match(items[0].title, /--new/); assert.match(items[1].title, /--reuse/);
    assert.equal(menu().querySelector(".open-with-menu__choices")?.contains(menu().querySelector(".open-with-menu__footer")),false);
    await key("ArrowDown"); assert.equal(latest.openWithMenu?.selectedIndex,1);
    await key("ArrowDown"); assert.equal(latest.openWithMenu?.selectedIndex,2);
    await key("ArrowDown"); assert.equal(latest.openWithMenu?.selectedIndex,0);
    await key("ArrowUp"); assert.equal(latest.openWithMenu?.selectedIndex,2);
    await key("Enter"); assert.deepEqual(opened,[2]); assert.equal(menu(),null);
    await reopen();
    menuHeight = 260;
    await tick(() => change(previous => ({...previous,openWithMenu:{...previous.openWithMenu!,programs:{"C:\\editor.exe":{path:"C:\\editor.exe",displayName:"中文 编辑器",exists:true}}}})));
    assert.match(menu().textContent ?? "",/中文 编辑器/); assert.equal(menu().style.top,"332px","late labels must trigger a new measurement");
    assert.equal(menu().querySelectorAll(`img[src="${programIcon}"]`).length, 2, "both choices display the executable's own resolved icon");
    assert.equal(iconRequests.length, 1, "same executable shares its icon regardless of arguments");
    assert.equal(iconRequests[0].path, "C:\\editor.exe");
    assert.equal(iconRequests[0].includeOverlays, true);
    await key("Escape"); assert.equal(menu(),null); assert.equal(document.activeElement,listing);
    await reopen(); await key("Tab"); assert.equal(menu(),null); assert.equal(document.activeElement,listing);
    await reopen();
    const outside = document.createElement("button"); document.body.append(outside); outside.focus();
    await tick(() => outside.dispatchEvent(new dom.window.Event("pointerdown",{bubbles:true})));
    assert.equal(menu(),null); assert.equal(document.activeElement,outside,"outside click must retain its chosen focus");
    outside.remove();
    await reopen(true); assert.match(menu().textContent ?? "",/没有匹配/);
    assert.equal(menu().querySelectorAll('[role="menuitem"]').length,1);
    await key("Enter"); assert.equal(opened.at(-1),0);
    console.log("ok - menu labels, keyboard, focus, async positioning and permanent settings footer");
  } finally {
    await tick(() => root.unmount()); listing.remove(); dom.window.HTMLElement.prototype.getBoundingClientRect = originalRect;
    setSystemIconResolverForTests();
  }
})();

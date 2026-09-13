import assert from "node:assert/strict";
import { createMockWorkspaceBootstrap } from "./mockData";
import { createWorkspaceState, getActiveTab } from "./workspaceReducer";
import { createEntry } from "./workspaceControllerTestHarness";
import { createOpenWithMenu, currentListingEntry, reconcileOpenWithMenu, reduceFileOpening, type FileOpeningAction } from "./fileOpeningState";

const state = createWorkspaceState(createMockWorkspaceBootstrap("tauri"));
const tab = getActiveTab(state.panels[state.activePanelId]);
const a = createEntry(tab.snapshot.location.path,"a.txt");
const b = createEntry(tab.snapshot.location.path,"b.txt");
const folder = createEntry(tab.snapshot.location.path,"folder","folder");
tab.snapshot.entries = [a,b,folder];
tab.selectedEntryIds = [a.id,b.id];
tab.selectionCursorId = a.id;
state.settings.model.fileAssociations = [
  {id:"first",patterns:"txt",executablePath:"C:\\editor.exe",argumentsTemplate:"--new-window {file}"},
  {id:"second",patterns:".TXT",executablePath:"C:\\editor.exe",argumentsTemplate:"--reuse-window {file}"},
  {id:"other",patterns:"md",executablePath:"C:\\other.exe",argumentsTemplate:""}
];
assert.equal(currentListingEntry(state)?.id,a.id,"upward range selection must target its cursor");
const menu = createOpenWithMenu(state,"menu-1");
assert.ok(menu);
assert.deepEqual(menu.ruleIds,["first","second"]);
assert.equal(menu.selectedIndex,0);
state.openWithMenu = menu;
assert.equal(reconcileOpenWithMenu(state),state);
tab.selectionCursorId = folder.id;
assert.equal(currentListingEntry(state)?.kind,"folder");
assert.equal(createOpenWithMenu(state,"menu-2"),undefined,"folder cursor must not fall back to selected file");
assert.equal(reconcileOpenWithMenu(state).openWithMenu,undefined);
tab.selectionCursorId = a.id;
const changedRules = {...state,settings:{...state.settings,model:{...state.settings.model,fileAssociations:[]}}};
assert.equal(reconcileOpenWithMenu(changedRules).openWithMenu,undefined);
const hidden = {...state,search:{...state.search,filterText:"no-such-file"}};
assert.equal(reconcileOpenWithMenu(hidden).openWithMenu,undefined);
const differentPanel = {...state,activePanelId:"panel-2" as const};
assert.equal(reconcileOpenWithMenu(differentPanel).openWithMenu,undefined);
const action = (type: FileOpeningAction) => type;
let next = reduceFileOpening(state,action({type:"openWithProgramsReceived",payload:{requestId:"old",programs:[]}}))!;
assert.equal(next.openWithMenu,menu,"late name lookup must not replace current menu");
next = reduceFileOpening(state,action({type:"openWithSelectionChanged",payload:2}))!;
assert.equal(next.openWithMenu?.selectedIndex,2,"footer is keyboard selectable");
next = reduceFileOpening(state,action({type:"fileOpenStarted",payload:{requestId:"open",path:"sftp://host/file.txt"}}))!;
assert.equal(next.fileOpens?.[0].registered,false);
next = reduceFileOpening(next,action({type:"fileOpenProgressed",payload:{requestId:"open",progress:{phase:"preparing"}}}))!;
assert.equal(next.fileOpens?.[0].registered,true);
next = reduceFileOpening(next,action({type:"fileOpenProgressed",payload:{requestId:"open",progress:{phase:"opening"}}}))!;
next = reduceFileOpening(next,action({type:"fileOpenProgressed",payload:{requestId:"open",progress:{phase:"downloading",completedBytes:1}}}))!;
assert.equal(next.fileOpens?.[0].progress.phase,"opening","phase cannot regress");
next = reduceFileOpening(next,action({type:"fileOpenFinished",payload:{requestId:"open"}}))!;
next = reduceFileOpening(next,action({type:"fileOpenProgressed",payload:{requestId:"open",progress:{phase:"downloading",completedBytes:500}}}))!;
assert.equal(next.fileOpens?.length,0,"late Channel cannot revive a finished task");
console.log("ok - current row, menu identity, metadata races and pending open lifecycle");

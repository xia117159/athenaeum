import type { AssociationProgramInfo, FileOpenProgress } from "../../app/fileAssociations";
import type { EntryViewModel, PanelId, WorkspaceState } from "./types";
import type { WorkspaceAction } from "./workspaceReducer";
import { getFolderListingRows } from "./folderExpansion";
import { matchingFileAssociations } from "./fileAssociations";

export interface OpenWithMenuState {
  requestId: string;
  panelId: PanelId;
  tabId: string;
  entryId: string;
  path: string;
  selectionKey: string;
  rulesKey: string;
  ruleIds: string[];
  selectedIndex: number;
  programs: Record<string, AssociationProgramInfo>;
  programsError?: string;
}
export interface PendingFileOpen {
  requestId: string;
  path: string;
  progress: FileOpenProgress;
  registered: boolean;
  cancelling: boolean;
}
export type FileOpeningAction =
  | {type:"openWithRequested";payload:{requestId:string}}
  | {type:"openWithClosed"}
  | {type:"openWithSelectionChanged";payload:number}
  | {type:"openWithProgramsReceived";payload:{requestId:string;programs:AssociationProgramInfo[];error?:string}}
  | {type:"fileOpenStarted";payload:{requestId:string;path:string}}
  | {type:"fileOpenProgressed";payload:{requestId:string;progress:FileOpenProgress}}
  | {type:"fileOpenCancelling";payload:{requestId:string;cancelling:boolean}}
  | {type:"fileOpenFinished";payload:{requestId:string}};

function currentTab(state: WorkspaceState, panelId: PanelId) {
  const panel = state.panels[panelId];
  return panel.tabs.find(tab => tab.id === panel.activeTabId) ?? panel.tabs[0];
}

export function currentListingEntry(state: WorkspaceState, panelId = state.activePanelId): EntryViewModel | undefined {
  const tab = currentTab(state, panelId);
  const entries = getFolderListingRows(tab, state.fileVisibility,
    panelId === state.activePanelId ? state.search.filterText : "",
    state.settings.model.folderExpansionEnabled === true, state.settings.model.sizeBarMode).map(row => row.entry);
  return entries.find(entry => entry.id === tab.selectionCursorId)
    ?? entries.find(entry => entry.id === tab.selectedEntryIds.at(-1))
    ?? entries[0];
}

function selectionKey(state: WorkspaceState, panelId: PanelId) {
  const tab = currentTab(state, panelId);
  return JSON.stringify([tab.snapshot.location.path, tab.selectionCursorId, tab.selectedEntryIds]);
}

function rulesKey(state: WorkspaceState) {
  return JSON.stringify(state.settings.model.fileAssociations ?? []);
}

export function createOpenWithMenu(state: WorkspaceState, requestId: string): OpenWithMenuState | undefined {
  const entry = currentListingEntry(state);
  if (!entry || entry.kind !== "file") return undefined;
  return {
    requestId, panelId: state.activePanelId, tabId: currentTab(state, state.activePanelId).id,
    entryId: entry.id, path: entry.path, selectionKey: selectionKey(state, state.activePanelId),
    rulesKey: rulesKey(state),
    ruleIds: matchingFileAssociations(state.settings.model.fileAssociations ?? [], entry.path).map(rule => rule.id),
    selectedIndex: 0, programs: {}
  };
}

export function reconcileOpenWithMenu(state: WorkspaceState): WorkspaceState {
  const menu = state.openWithMenu;
  if (!menu) return state;
  const tab = currentTab(state, state.activePanelId);
  const entry = currentListingEntry(state);
  const valid = menu.panelId === state.activePanelId && menu.tabId === tab.id
    && menu.selectionKey === selectionKey(state, state.activePanelId) && menu.rulesKey === rulesKey(state)
    && entry?.kind === "file" && entry.id === menu.entryId && entry.path === menu.path;
  return valid ? state : { ...state, openWithMenu: undefined };
}

const phaseOrder: Record<FileOpenProgress["phase"], number> = { preparing: 0, downloading: 1, opening: 2 };

export function reduceFileOpening(state: WorkspaceState, action: WorkspaceAction): WorkspaceState | undefined {
  const menu = state.openWithMenu;
  const opens = state.fileOpens ?? [];
  switch (action.type) {
    case "openWithRequested":
      return { ...state, contextMenu: undefined, openWithMenu: createOpenWithMenu(state, action.payload.requestId) };
    case "openWithClosed":
      return menu ? { ...state, openWithMenu: undefined } : state;
    case "openWithSelectionChanged":
      return menu ? { ...state, openWithMenu: { ...menu,
        selectedIndex: ((action.payload % (menu.ruleIds.length + 1)) + menu.ruleIds.length + 1) % (menu.ruleIds.length + 1)
      } } : state;
    case "openWithProgramsReceived":
      return menu?.requestId === action.payload.requestId ? { ...state, openWithMenu: { ...menu,
        programs: Object.fromEntries(action.payload.programs.map(program => [program.path, program])),
        programsError: action.payload.error
      } } : state;
    case "fileOpenStarted":
      return opens.some(open => open.requestId === action.payload.requestId) ? state : { ...state,
        fileOpens: [...opens, { ...action.payload, progress: { phase: "preparing" }, registered: false, cancelling: false }]
      };
    case "fileOpenProgressed":
      return { ...state, fileOpens: opens.map(open => {
        const progress = action.payload.progress;
        if (open.requestId !== action.payload.requestId || phaseOrder[progress.phase] < phaseOrder[open.progress.phase]) return open;
        return { ...open, registered: true, progress: progress.phase === "downloading"
          ? { ...progress, completedBytes: Math.max(open.progress.completedBytes ?? 0, progress.completedBytes ?? 0) }
          : progress };
      }) };
    case "fileOpenCancelling":
      return { ...state, fileOpens: opens.map(open => open.requestId === action.payload.requestId
        ? { ...open, cancelling: action.payload.cancelling } : open) };
    case "fileOpenFinished":
      return { ...state, fileOpens: opens.filter(open => open.requestId !== action.payload.requestId) };
    default:
      return undefined;
  }
}

import type { WorkspaceState } from "./types";
import type { WorkspaceAction } from "./workspaceReducer";

export interface MenuAnchor { x: number; y: number; left?: number }
export interface MenuParent { kind: "menubar" | "context"; hostId: string; triggerId: string }
export interface WorkspaceMenuBarState { id: string; sessionId: string; locationKey: string }
export type WorkspaceMenuAction =
  | { type: "workspaceMenuBarSet"; payload?: { id: string; sessionId: string } }
  | { type: "workspaceMenusClosed" };

function locationKey(state: WorkspaceState) {
  const panel = state.panels[state.activePanelId], tab = panel.tabs.find(item => item.id === panel.activeTabId);
  return JSON.stringify([panel.id, tab?.id, tab?.snapshot.location.path, tab?.navigationRevision]);
}
export function menuParentIsActive(state: WorkspaceState, parent?: MenuParent) {
  return !parent || (parent.kind === "menubar" ? state.menuBar?.sessionId === parent.hostId : Boolean(state.contextMenu));
}
export function sameMenuParent(left?: MenuParent, right?: MenuParent) {
  return left?.kind === right?.kind && left?.hostId === right?.hostId && left?.triggerId === right?.triggerId;
}
const closeMenus = (state: WorkspaceState): WorkspaceState => ({ ...state, menuBar: undefined, contextMenu: undefined, openWithMenu: undefined, templateMenu: undefined });

export function reduceWorkspaceMenus(state: WorkspaceState, action: WorkspaceAction): WorkspaceState | undefined {
  if (action.type === "workspaceMenusClosed") return closeMenus(state);
  if (action.type === "workspaceMenuBarSet") {
    if (action.payload?.id === state.menuBar?.id) return state;
    return { ...closeMenus(state), menuBar: action.payload ? { ...action.payload, locationKey: locationKey(state) } : undefined };
  }
}
export function reconcileWorkspaceMenus(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  // Domain reducers first capture the selected rename target in this same event.
  if (action.type === "contextMenuSet") return { ...closeMenus(state), contextMenu: state.contextMenu };
  const panel = state.panels[state.activePanelId], tab = panel.tabs.find(item => item.id === panel.activeTabId);
  if (state.menuBar && (state.menuBar.locationKey !== locationKey(state) || tab?.inlineEdit || state.batchRename)) return closeMenus(state);
  const openWithMenu = menuParentIsActive(state, state.openWithMenu?.parent) ? state.openWithMenu : undefined;
  const templateMenu = menuParentIsActive(state, state.templateMenu?.parent) ? state.templateMenu : undefined;
  return openWithMenu === state.openWithMenu && templateMenu === state.templateMenu ? state : { ...state, openWithMenu, templateMenu };
}

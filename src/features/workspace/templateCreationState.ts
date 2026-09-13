import type { CreationTemplateEntry, CreationTemplateListing } from "../../app/templates";
import type { OperationTaskSnapshot } from "../../app/types";
import type { RenameTarget } from "./batchRenameState";
import type { PanelId, WorkspaceState } from "./types";
import type { WorkspaceAction } from "./workspaceReducer";
import { getTabEntries } from "./folderExpansion";
import { getPathComparisonKey, pathsEqual } from "./workspacePathRelations";
import { templateKey, toggleTemplateSelection } from "./templateSelection";

export interface TemplateTarget { panelId: PanelId; tabId: string; rootPath: string; selectionRevision: number; navigationRevision?: number }
export interface TemplateAnchor { x: number; y: number; left?: number }
export interface TemplateLevel { relativePath: string; anchor: TemplateAnchor; parent?: CreationTemplateEntry }
export interface TemplateMenuState {
  id: string; target: TemplateTarget; settingsRoot: string; rootPath: string;
  /** A collapsed submenu retains this context-menu session's selection until the whole menu closes. */
  rootHidden?: boolean;
  levels: TemplateLevel[]; selected: CreationTemplateEntry[];
  directories: Record<string, { status: "loading" | "ready" | "error"; entries: CreationTemplateEntry[]; error?: string }>;
}
export interface TemplateCreationPending {
  requestId: string; target: TemplateTarget; allowRename: boolean;
  phase: "running" | "refreshing" | "ready" | "manual";
  paths: string[]; task?: OperationTaskSnapshot; renameTarget?: RenameTarget;
}
export type TemplateCreationAction =
  | { type: "templateTargetNavigationStarted"; payload: { panelId: PanelId; tabId: string; requestId: number } }
  | { type: "templateTargetNavigationFinished"; payload: { panelId: PanelId; tabId: string; requestId: number } }
  | { type: "templateMenuOpened"; payload: TemplateMenuState }
  | { type: "templateMenuClosed"; payload: { id: string } }
  | { type: "templateDirectoryRequested"; payload: { id: string; relativePath: string } }
  | { type: "templateDirectoryLoaded"; payload: { id: string; listing: CreationTemplateListing } }
  | { type: "templateDirectoryFailed"; payload: { id: string; relativePath: string; error: string } }
  | { type: "templateMenuExpanded"; payload: { id: string; depth: number; entry: CreationTemplateEntry; anchor: TemplateAnchor } }
  | { type: "templateMenuCollapsed"; payload: { id: string; depth: number } }
  | { type: "templateSelectionToggled"; payload: { id: string; entry: CreationTemplateEntry } }
  | { type: "templateCreationStarted"; payload: { requestId: string; target: TemplateTarget } }
  | { type: "templateTaskCompleted"; payload: { task: OperationTaskSnapshot } }
  | { type: "templateRefreshFinished"; payload: { requestId: string } }
  | { type: "templateCreationDismissed"; payload: { requestId: string } };

function invalidateTemplateRename(pending: TemplateCreationPending): TemplateCreationPending {
  return { ...pending, allowRename: false, renameTarget: undefined, phase: pending.phase === "ready" ? "manual" : pending.phase };
}

export function captureTemplateTarget(state: WorkspaceState, panelId: PanelId, tabId?: string): TemplateTarget | undefined {
  const panel = state.panels[panelId], tab = panel.tabs.find(tab => tab.id === (tabId ?? panel.activeTabId));
  if (tab?.kind !== "directory" || tab.snapshot.location.kind !== "local" || tab.inlineEdit || tab.pendingNavigationRequestId !== undefined) return;
  return { panelId, tabId: tab.id, rootPath: tab.snapshot.location.path, selectionRevision: tab.selectionRevision ?? 0,
    navigationRevision: tab.navigationRevision ?? 0 };
}
export function templateTargetMatches(state: WorkspaceState, target: TemplateTarget) {
  const panel = state.panels[target.panelId], tab = panel.tabs.find(tab => tab.id === target.tabId);
  return state.activePanelId === target.panelId && panel.activeTabId === target.tabId && tab?.kind === "directory"
    && tab.snapshot.location.kind === "local" && !tab.inlineEdit && tab.pendingNavigationRequestId === undefined
    && (tab.navigationRevision ?? 0) === (target.navigationRevision ?? 0)
    && pathsEqual(tab.snapshot.location.path, target.rootPath) && (tab.selectionRevision ?? 0) === target.selectionRevision;
}
export function reduceTemplates(state: WorkspaceState, input: WorkspaceAction): WorkspaceState | undefined {
  if (!input.type.startsWith("template")) return;
  const action = input as TemplateCreationAction;
  if (action.type === "templateTargetNavigationFinished") {
    // Request IDs are unique to the controller; both panel and tab IDs may change during a move.
    let panels = state.panels;
    for (const panel of Object.values(state.panels)) {
      if (!panel.tabs.some(tab => tab.pendingNavigationRequestId === action.payload.requestId)) continue;
      panels = { ...panels, [panel.id]: { ...panel, tabs: panel.tabs.map(tab => tab.pendingNavigationRequestId === action.payload.requestId
        ? { ...tab, pendingNavigationRequestId: undefined } : tab) } };
    }
    return panels === state.panels ? state : { ...state, panels };
  }
  if (action.type === "templateTargetNavigationStarted") {
    const { panelId, tabId, requestId } = action.payload, panel = state.panels[panelId];
    const tab = panel.tabs.find(tab => tab.id === tabId);
    if (!tab) return state;
    const next = { ...state, panels: { ...state.panels, [panelId]: { ...panel, tabs: panel.tabs.map(item => item === tab ? { ...tab,
      navigationRevision: (tab.navigationRevision ?? 0) + 1, pendingNavigationRequestId: requestId } : item) } } };
    const matches = (target: TemplateTarget) => target.panelId === panelId && target.tabId === tabId;
    return { ...next, templateMenu: state.templateMenu && matches(state.templateMenu.target) ? undefined : state.templateMenu,
      templateCreation: state.templateCreation && matches(state.templateCreation.target) ? invalidateTemplateRename(state.templateCreation) : state.templateCreation };
  }
  if (action.type === "templateMenuOpened") return state.templateCreation || state.batchRename || !templateTargetMatches(state, action.payload.target) ? state
    : { ...state, openWithMenu: undefined, templateMenu: action.payload };
  if (action.type === "templateCreationStarted") return state.templateCreation || state.batchRename || !templateTargetMatches(state, action.payload.target) ? state : { ...state, templateMenu: undefined, contextMenu: undefined,
    templateCreation: { ...action.payload, allowRename: true, phase: "running", paths: [] } };
  const pending = state.templateCreation;
  if (action.type === "templateTaskCompleted") {
    const task = action.payload.task;
    if (!pending || pending.requestId !== task.requestId || (pending.task && task.sequence <= pending.task.sequence)
      || pending.phase === "ready" || pending.phase === "manual") return state;
    const paths = [...new Set(task.entryResults.flatMap(result => result.kind === "created" && !result.error
      && result.destination?.kind === "local" ? [result.destination.path] : []))];
    return { ...state, templateCreation: { ...pending, task, paths, phase: "refreshing" } };
  }
  if (action.type === "templateRefreshFinished") {
    if (!pending || pending.requestId !== action.payload.requestId || pending.phase !== "refreshing") return state;
    const { target } = pending, panel = state.panels[target.panelId], tab = panel.tabs.find(tab => tab.id === target.tabId);
    const byPath = new Map((tab ? getTabEntries(tab) : []).map(entry => [getPathComparisonKey(entry.path), entry]));
    const entries = pending.paths.flatMap(path => { const entry = byPath.get(getPathComparisonKey(path)); return entry ? [entry] : []; });
    if (!pending.allowRename || !templateTargetMatches(state, target) || !tab || tab.inlineEdit || state.batchRename
      || !entries.length || entries.length !== pending.paths.length) return { ...state, templateCreation: { ...pending, phase: "manual" } };
    const renameTarget: RenameTarget = { ...target, source: "contextMenu", entries: entries.map(({ id, path, name, parentPath, kind }) => ({ id, path, name, parentPath, kind })) };
    return { ...state, keyboardNavToken: Symbol(), templateCreation: { ...pending, phase: "ready", renameTarget }, panels: { ...state.panels,
      [target.panelId]: { ...panel, tabs: panel.tabs.map(item => item === tab ? { ...tab,
        selectedEntryIds: entries.map(entry => entry.id), selectionAnchorId: entries[0].id, selectionCursorId: entries[0].id } : item) } } };
  }
  if (action.type === "templateCreationDismissed") return pending?.requestId === action.payload.requestId ? { ...state, templateCreation: undefined } : state;
  const menu = state.templateMenu;
  if (!menu || menu.id !== action.payload.id) return state;
  const update = (patch: Partial<TemplateMenuState>) => ({ ...state, templateMenu: { ...menu, ...patch } });
  switch (action.type) {
    case "templateMenuClosed": return { ...state, templateMenu: undefined };
    case "templateSelectionToggled": return update({ selected: toggleTemplateSelection(menu.selected, action.payload.entry) });
    case "templateMenuExpanded": return update({ levels: [...menu.levels.slice(0, action.payload.depth + 1),
      { relativePath: action.payload.entry.relativePath, parent: action.payload.entry, anchor: action.payload.anchor }] });
    case "templateMenuCollapsed": return update({ rootHidden: action.payload.depth === 0,
      levels: menu.levels.slice(0, Math.max(1, action.payload.depth)) });
    case "templateDirectoryRequested": return update({ directories: { ...menu.directories,
      [templateKey(action.payload.relativePath)]: { status: "loading", entries: [] } } });
    case "templateDirectoryFailed": return update({ directories: { ...menu.directories,
      [templateKey(action.payload.relativePath)]: { status: "error", entries: [], error: action.payload.error } } });
    case "templateDirectoryLoaded": {
      const listing = action.payload.listing;
      return update({ rootPath: listing.rootPath, directories: { ...menu.directories,
        [templateKey(listing.relativePath)]: { status: "ready", entries: listing.entries } } });
    }
  }
}
export function reconcileTemplates(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  const menu = state.templateMenu, pending = state.templateCreation;
  const closeMenu = menu && (!templateTargetMatches(state, menu.target) || menu.settingsRoot !== (state.settings.model.templateRoot ?? "")
    || action.type === "batchRenameOpened" || action.type === "inlineEditStarted" || action.type === "contextMenuSet");
  const invalidate = pending?.allowRename && (!templateTargetMatches(state, pending.target)
    || action.type === "inlineEditStarted" || action.type === "batchRenameOpened");
  if (!closeMenu && !invalidate) return state;
  return { ...state, templateMenu: closeMenu ? undefined : menu,
    templateCreation: invalidate && pending ? invalidateTemplateRename(pending) : pending };
}

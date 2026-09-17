import { normalizeLocationPath } from "./mockData";
import { isNavigationTab } from "./workspaceTabs";
import type { TabState, WorkspaceState, WorkspaceTreeState } from "./types";
import type { WorkspaceAction } from "./workspaceReducer";

export const emptyTreeState = (): WorkspaceTreeState => ({ activePath: "", expandedNodePaths: [] });

export function normalizeTreeState(value: unknown): WorkspaceTreeState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<WorkspaceTreeState>;
  if (typeof candidate.activePath !== "string" || !Array.isArray(candidate.expandedNodePaths) ||
    !candidate.expandedNodePaths.every(path => typeof path === "string")) return undefined;
  return { activePath: candidate.activePath ? normalizeLocationPath(candidate.activePath) : "",
    expandedNodePaths: [...new Set(candidate.expandedNodePaths.filter(Boolean).map(normalizeLocationPath))] };
}

export function treeStateFromTab(tab: TabState | undefined): WorkspaceTreeState {
  return !tab || isNavigationTab(tab) ? emptyTreeState() : {
    activePath: tab.snapshot.location.path,
    expandedNodePaths: [...tab.expandedNodePaths]
  };
}

function activeTab(state: WorkspaceState) {
  const panel = state.panels[state.activePanelId];
  return panel.tabs.find(tab => tab.id === panel.activeTabId) ?? panel.tabs[0];
}

function setExpanded(paths: string[], path: string, expanded: boolean) {
  const normalized = normalizeLocationPath(path);
  return expanded ? paths.includes(normalized) ? paths : [...paths, normalized]
    : paths.filter(item => item !== normalized);
}

export function reduceWorkspaceTree(state: WorkspaceState, action: WorkspaceAction): WorkspaceState | undefined {
  if (action.type === "treeNodeSelected") {
    return { ...state, treeState: { ...state.treeState, activePath: normalizeLocationPath(action.payload.path) } };
  }
  if (action.type !== "treeNodeExpansionSet") return undefined;
  const { panelId, tabId, path, expanded } = action.payload;
  // Tree input belongs to the visible workspace, including the virtual navigation tab.
  const treeState = { ...state.treeState, expandedNodePaths: setExpanded(state.treeState.expandedNodePaths, path, expanded) };
  if (!state.settings.model.treeAutoFollowEnabled) return { ...state, treeState };
  const panel = state.panels[panelId];
  return { ...state, treeState, panels: { ...state.panels, [panelId]: { ...panel,
    tabs: panel.tabs.map(tab => tab.id !== tabId || isNavigationTab(tab) ? tab : {
      ...tab, expandedNodePaths: setExpanded(tab.expandedNodePaths, path, expanded)
    })
  } } };
}

/** All focus/navigation entry points converge here; disabled mode never derives tree state from a tab. */
export function reconcileWorkspaceTree(previous: WorkspaceState, next: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  if (!next.settings.model.treeAutoFollowEnabled || action.type === "bootstrapLoaded") return next;
  const current = activeTab(next);
  const before = activeTab(previous);
  if (!current || isNavigationTab(current)) return next;
  const enabled = !previous.settings.model.treeAutoFollowEnabled;
  const focusChanged = previous.activePanelId !== next.activePanelId || before?.id !== current.id;
  const pathChanged = before?.snapshot.location.path !== current.snapshot.location.path;
  const committed = action.type === "tabSnapshotCommitted" && action.payload.panelId === next.activePanelId && action.payload.tabId === current.id;
  if (!enabled && !focusChanged && !pathChanged && !committed) return next;
  const expandedNodePaths = [...new Set([...current.expandedNodePaths, ...current.snapshot.breadcrumbs.map(item => item.path)])];
  const panel = next.panels[next.activePanelId];
  return { ...next, treeState: { activePath: current.snapshot.location.path, expandedNodePaths },
    panels: { ...next.panels, [panel.id]: { ...panel, tabs: panel.tabs.map(tab => tab.id === current.id ? { ...tab, expandedNodePaths } : tab) } } };
}

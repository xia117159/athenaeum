import { useEffect, useEffectEvent, useRef, type Dispatch } from "react";
import { normalizeLocationPath } from "./mockData";
import { findTreeNode, getErrorMessage } from "./workspaceControllerUtils";
import { isRemotePath, isSameOrDescendantPath } from "./workspacePathRelations";
import { isNavigationTab } from "./workspaceTabs";
import type { WorkspaceGateway } from "./workspaceGateway";
import type { WorkspaceAction } from "./workspaceReducer";
import type { PanelId, WorkspaceState } from "./types";

/** Restored expansion records are not permission to reconnect a remote root. */
function canHydratePath(state: WorkspaceState, path: string) {
  if (!isRemotePath(path)) return true;
  const root = state.directoryTree.find(node => node.kind === "remote-root" && isSameOrDescendantPath(node.path, path));
  if (!root) return false;
  if (root.connectionState === "connected") return true;
  return Object.values(state.panels).some(panel => panel.tabs.some(tab =>
    !isNavigationTab(tab) && tab.status === "ready" && isSameOrDescendantPath(root.path, tab.snapshot.location.path)));
}

export function useWorkspaceTreeController({ state, dispatch, workspaceGateway, notify, enabled }: {
  state: WorkspaceState;
  dispatch: Dispatch<WorkspaceAction>;
  workspaceGateway: WorkspaceGateway;
  notify: (message: string) => void;
  enabled: boolean;
}) {
  const pending = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = useEffectEvent(async (path: string) => {
    if (pending.current.has(path)) return;
    pending.current.add(path);
    dispatch({ type: "treeNodeConnectionStarted", payload: { path } });
    try {
      const children = await workspaceGateway.loadTreeChildren(path);
      if (mounted.current) dispatch({ type: "treeChildrenLoaded", payload: { path, children } });
    } catch (error) {
      if (mounted.current) {
        const message = getErrorMessage(error, `无法展开 ${path}`);
        // Neither success nor failure can override newer manual expansion/focus choices.
        dispatch({ type: "treeNodeConnectionFailed", payload: { path, message } });
        notify(message);
      }
    } finally {
      pending.current.delete(path);
    }
  });
  useEffect(() => {
    if (!enabled || state.status !== "ready") return;
    for (const path of state.treeState.expandedNodePaths) {
      const node = findTreeNode(state.directoryTree, path);
      if (node?.expandable && !node.loaded && node.connectionState !== "error" && canHydratePath(state, path)) void load(path);
    }
  }, [enabled, state.status, state.treeState.expandedNodePaths, state.directoryTree, state.panels, workspaceGateway]);

  return useEffectEvent((panelId: PanelId, tabId: string, rawPath: string, expanded: boolean) => {
    const path = normalizeLocationPath(rawPath);
    dispatch({ type: "treeNodeExpansionSet", payload: { panelId, tabId, path, expanded } });
    const node = findTreeNode(state.directoryTree, path);
    if (expanded && node && !node.loaded && node.expandable) void load(path);
  });
}

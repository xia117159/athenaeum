import type { OperationPathRef } from "../../app/types";
import { getParentLocationPath, normalizeLocationPath } from "./mockData";
import { createRemoteUri } from "./remoteUri";
import { getActiveTab, getVisiblePanelIds } from "./workspaceReducer";
import { isDirectoryTab, isNavigationTab, NAVIGATION_VIRTUAL_PATH } from "./workspaceTabs";
import type { OperationTaskSnapshot, RemoteConnectionProfile, WorkspaceState } from "./types";
import { getPathComparisonKey, isRemotePath, pathsEqual } from "./workspacePathRelations";
import { getExpandedFolderPaths, getFolderListingRows } from "./folderExpansion";
export { getPathComparisonKey, isRemotePath, pathsEqual } from "./workspacePathRelations";

export function getLocationPathSeparator(path: string) {
  return isRemotePath(path) ? "/" : "\\";
}

export function isLocalWatchPath(path: string) {
  const normalized = normalizeLocationPath(path);
  return !isRemotePath(normalized) && !normalized.startsWith(NAVIGATION_VIRTUAL_PATH);
}

export function getVisibleWatchRoots(state: WorkspaceState) {
  const directoryPaths = new Map<string, string>();
  const expandedPaths: string[] = [];
  let navigationVisible = false;

  for (const panelId of getVisiblePanelIds(state.layoutMode)) {
    const activeTab = getActiveTab(state.panels[panelId]);
    if (isDirectoryTab(activeTab) && activeTab.snapshot.location.kind === "local" && isLocalWatchPath(activeTab.snapshot.location.path)) {
      const path = normalizeLocationPath(activeTab.snapshot.location.path);
      directoryPaths.set(getPathComparisonKey(path), path);
      if (state.settings.model.folderExpansionEnabled) {
        expandedPaths.push(...getFolderListingRows(activeTab, state.fileVisibility, state.activePanelId === panelId ? state.search.filterText : "")
          .filter((row) => row.expansion).map((row) => row.entry.path));
      }
    }
    if (isNavigationTab(activeTab)) {
      navigationVisible = true;
    }
  }

  // Reserve every ordinary visible root before the manager/backend sort and cap.
  // Extra expanded branches remain usable through explicit refresh.
  for (const path of expandedPaths) {
    if (directoryPaths.size >= 256) break;
    directoryPaths.set(getPathComparisonKey(path), normalizeLocationPath(path));
  }

  const navigationParentPaths = new Set<string>();
  const gitSentinelPaths = new Set<string>();
  if (navigationVisible) {
    for (const item of state.navigation.items) {
      if (!isLocalWatchPath(item.path)) {
        continue;
      }
      gitSentinelPaths.add(normalizeLocationPath(item.path));
      const parentPath = getParentLocationPath(item.path);
      if (parentPath) {
        navigationParentPaths.add(normalizeLocationPath(parentPath));
      }
    }
  }

  for (const path of directoryPaths.values()) {
    gitSentinelPaths.add(path);
  }

  return {
    directoryPaths: Array.from(directoryPaths.values()).sort((left, right) => left.localeCompare(right)),
    navigationParentPaths: Array.from(navigationParentPaths).sort((left, right) => left.localeCompare(right)),
    gitSentinelPaths: Array.from(gitSentinelPaths).sort((left, right) => left.localeCompare(right))
  };
}

export function getVisibleDirectoryRefreshTargets(state: WorkspaceState, roots: string[]) {
  const normalizedRoots = roots.map((root) => normalizeLocationPath(root));
  return getVisiblePanelIds(state.layoutMode)
    .map((panelId) => {
      const tab = getActiveTab(state.panels[panelId]);
      if (!isDirectoryTab(tab)) {
        return null;
      }
      const paths = [tab.snapshot.location.path, ...getExpandedFolderPaths(tab)];
      if (!paths.some((path) => normalizedRoots.some((root) => pathsEqual(root, path)))) {
        return null;
      }
      return {
        panelId,
        tabId: tab.id,
        path: tab.snapshot.location.path,
        historyIndex: tab.historyIndex
      };
    })
    .filter((target): target is NonNullable<typeof target> => Boolean(target));
}

export function isTerminalOperationTask(task: OperationTaskSnapshot) {
  return (
    task.status === "succeeded" ||
    task.status === "failed" ||
    task.status === "partialSucceeded" ||
    task.status === "cancelled"
  );
}

export function pathRefToWorkspacePath(pathRef: OperationPathRef, profiles: RemoteConnectionProfile[]) {
  if (pathRef.kind === "local") {
    return normalizeLocationPath(pathRef.path);
  }

  const profile = profiles.find((item) => item.id === pathRef.profileId);
  if (!profile) {
    return null;
  }
  return createRemoteUri(profile, pathRef.remotePath);
}

export function getOperationRefreshPaths(task: OperationTaskSnapshot, profiles: RemoteConnectionProfile[]) {
  const roots = task.affectedRoots
    .map((pathRef) => pathRefToWorkspacePath(pathRef, profiles))
    .filter((path): path is string => Boolean(path));
  const resultParents = task.entryResults.flatMap((result) =>
    [result.source, result.destination]
      .map((pathRef) => (pathRef ? pathRefToWorkspacePath(pathRef, profiles) : null))
      .filter((path): path is string => Boolean(path))
      .map((path) => getParentPathForRefresh(path) ?? path)
  );
  return Array.from(new Set([...roots, ...resultParents].map((path) => normalizeLocationPath(path))));
}

export function getParentPathForRefresh(path: string): string | null {
  const normalized = normalizeLocationPath(path);
  if (!isRemotePath(normalized)) {
    return getParentLocationPath(normalized);
  }

  const match = /^(ftp|sftp):\/\/([^/]+)(\/.*)?$/.exec(normalized);
  if (!match) {
    return null;
  }

  const [, scheme, authority, remotePath = "/"] = match;
  const root = `${scheme}://${authority}`;
  const trimmedPath = remotePath.length > 1 ? remotePath.replace(/\/+$/, "") : remotePath;
  if (trimmedPath === "/") {
    return null;
  }

  const separatorIndex = trimmedPath.lastIndexOf("/");
  if (separatorIndex <= 0) {
    return `${root}/`;
  }

  return `${root}${trimmedPath.slice(0, separatorIndex)}`;
}

export function hasSameParentPath(source: string, destination: string) {
  const parent = getParentPathForRefresh(source);
  return Boolean(parent && pathsEqual(parent, destination));
}

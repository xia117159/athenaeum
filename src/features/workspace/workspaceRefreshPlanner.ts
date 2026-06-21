import type { OperationPathRef } from "../../app/types";
import { getParentLocationPath, normalizeLocationPath } from "./mockData";
import { createRemoteUri } from "./remoteUri";
import { getActiveTab, getVisiblePanelIds } from "./workspaceReducer";
import { isDirectoryTab, isNavigationTab, NAVIGATION_VIRTUAL_PATH } from "./workspaceTabs";
import type { OperationTaskSnapshot, RemoteConnectionProfile, WorkspaceState } from "./types";

export function isRemotePath(path: string) {
  return path.startsWith("ftp://") || path.startsWith("sftp://");
}

export function getLocationPathSeparator(path: string) {
  return isRemotePath(path) ? "/" : "\\";
}

export function getPathComparisonKey(path: string) {
  const normalized = normalizeLocationPath(path);
  return isRemotePath(normalized) ? normalized : normalized.toLowerCase();
}

export function pathsEqual(left: string, right: string) {
  return getPathComparisonKey(left) === getPathComparisonKey(right);
}

export function isLocalWatchPath(path: string) {
  const normalized = normalizeLocationPath(path);
  return !isRemotePath(normalized) && !normalized.startsWith(NAVIGATION_VIRTUAL_PATH);
}

export function getVisibleWatchRoots(state: WorkspaceState) {
  const directoryPaths = new Set<string>();
  let navigationVisible = false;

  for (const panelId of getVisiblePanelIds(state.layoutMode)) {
    const activeTab = getActiveTab(state.panels[panelId]);
    if (isDirectoryTab(activeTab) && activeTab.snapshot.location.kind === "local" && isLocalWatchPath(activeTab.snapshot.location.path)) {
      directoryPaths.add(normalizeLocationPath(activeTab.snapshot.location.path));
    }
    if (isNavigationTab(activeTab)) {
      navigationVisible = true;
    }
  }

  const navigationParentPaths = new Set<string>();
  if (navigationVisible) {
    for (const item of state.navigation.items) {
      if (!isLocalWatchPath(item.path)) {
        continue;
      }
      const parentPath = getParentLocationPath(item.path);
      if (parentPath) {
        navigationParentPaths.add(normalizeLocationPath(parentPath));
      }
    }
  }

  return {
    directoryPaths: Array.from(directoryPaths).sort((left, right) => left.localeCompare(right)),
    navigationParentPaths: Array.from(navigationParentPaths).sort((left, right) => left.localeCompare(right))
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
      const tabPath = normalizeLocationPath(tab.snapshot.location.path);
      if (!normalizedRoots.some((root) => pathsEqual(root, tabPath))) {
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

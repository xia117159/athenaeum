import { nextGeneratedTabId, normalizeLocationPath } from "./mockData";
import { cloneColumns } from "./workspaceMappers";
import { getActiveTab, getVisiblePanelIds } from "./workspaceReducer";
import {
  getLocationPathSeparator,
  getPathComparisonKey,
  isRemotePath,
  pathsEqual
} from "./workspaceRefreshPlanner";
import { isDirectoryTab, isNavigationTab } from "./workspaceTabs";
import type {
  ColumnDefinition,
  DirectoryNode,
  DirectorySnapshot,
  EntryViewModel,
  MultiSelectionPropertiesSummary,
  NotificationItem,
  PanelId,
  TabState,
  TabViewMode,
  WorkspaceState
} from "./types";

export const NOTIFICATION_AUTO_DISMISS_MS = 5000;

export type NavigationFolderInput = {
  displayName?: string;
  path: string;
};

export function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return fallback;
}

export function hasSameJsonShape(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createDragDropRequestKey(paths: string[], destination: string, operation: "copy" | "move") {
  return [
    operation,
    destination,
    ...Array.from(new Set(paths)).sort((left, right) => left.localeCompare(right))
  ].join("\u001f");
}

export function createDragDropRequestId(operation: "copy" | "move", sequence: number) {
  return `drag-drop-${operation}-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

export function createTabFromSnapshot(
  panelId: PanelId,
  snapshot: DirectorySnapshot,
  id = nextGeneratedTabId(panelId),
  viewMode: TabViewMode = "details",
  columns: ColumnDefinition[] = []
): TabState {
  return {
    id,
    title: snapshot.location.label,
    kind: "directory",
    snapshot,
    addressDraft: snapshot.location.path,
    history: [snapshot.location.path],
    historyIndex: 0,
    selectedEntryIds: [],
    expandedNodePaths: snapshot.breadcrumbs.map((breadcrumb) => breadcrumb.path),
    viewMode,
    sort: {
      columnId: "name",
      direction: "asc"
    },
    columns: cloneColumns(columns.length > 0 ? columns : undefined),
    status: "ready"
  };
}

function remoteKindFromPath(path: string) {
  return path.startsWith("ftp://") ? "ftp" : "sftp";
}

function createReconnectSnapshot(path: string, message?: string): DirectorySnapshot {
  return {
    location: {
      kind: remoteKindFromPath(path),
      label: path,
      path,
      subtitle: message
    },
    breadcrumbs: [
      {
        id: path,
        label: path,
        path
      }
    ],
    entries: []
  };
}

export function createReconnectTab(
  panelId: PanelId,
  path: string,
  id: string,
  viewMode: TabViewMode,
  columns: ColumnDefinition[],
  message?: string
): TabState {
  return {
    ...createTabFromSnapshot(panelId, createReconnectSnapshot(path, message), id, viewMode, columns),
    status: "reconnect-required",
    reconnect: {
      path,
      ...(message ? { message } : {})
    }
  };
}

export function createUniqueTabId(panelId: PanelId, tabs: TabState[]) {
  const existingIds = new Set(tabs.map((tab) => tab.id));
  let id = nextGeneratedTabId(panelId);
  while (existingIds.has(id)) {
    id = nextGeneratedTabId(panelId);
  }
  return id;
}

export function createUniqueSearchTabId(panelId: PanelId, tabs: TabState[]) {
  const existingIds = new Set(tabs.map((tab) => tab.id));
  let sequence = 1;
  let id = `${panelId}-search-results-${sequence}`;
  while (existingIds.has(id)) {
    sequence += 1;
    id = `${panelId}-search-results-${sequence}`;
  }
  return id;
}

export function findTreeNode(nodes: DirectoryNode[], path: string): DirectoryNode | undefined {
  for (const node of nodes) {
    if (node.path === path) {
      return node;
    }
    const nested = findTreeNode(node.children, path);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

export function createNotification(intent: WorkspaceState["notifications"][number]["intent"], message: string) {
  return {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `notification-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    intent,
    message
  } satisfies WorkspaceState["notifications"][number];
}

export function getSelectedEntries(state: WorkspaceState, panelId: PanelId) {
  const tab = getActiveTab(state.panels[panelId]);
  if (!isDirectoryTab(tab)) {
    return [];
  }
  return tab.snapshot.entries.filter((entry) => tab.selectedEntryIds.includes(entry.id));
}

export function createSelectionKey(entries: EntryViewModel[]) {
  return entries.map((entry) => entry.id).join("|");
}

export function createMultiSelectionSummary(entries: EntryViewModel[]): MultiSelectionPropertiesSummary {
  const parentPaths = new Set(entries.map((entry) => entry.parentPath));
  const kinds = new Set(entries.map((entry) => entry.kind));
  const commonExtension =
    entries.length > 0 && entries.every((entry) => entry.kind === "file" && Boolean(entry.extension))
      ? (() => {
          const extensions = new Set(entries.map((entry) => entry.extension));
          return extensions.size === 1 ? [...extensions][0] : undefined;
        })()
      : undefined;
  const directoryCount = entries.filter((entry) => entry.kind === "folder").length;
  const knownSizeBytes = entries.reduce(
    (sum, entry) => sum + (typeof entry.sizeBytes === "number" ? entry.sizeBytes : 0),
    0
  );
  const unknownSizeCount = entries.filter((entry) => typeof entry.sizeBytes !== "number").length;

  return {
    selectionKey: createSelectionKey(entries),
    count: entries.length,
    knownSizeBytes,
    unknownSizeCount,
    directoryCount,
    commonParentPath: parentPaths.size === 1 ? [...parentPaths][0] : undefined,
    commonKind: kinds.size === 1 ? [...kinds][0] : undefined,
    commonExtension,
    fieldStates:
      directoryCount > 0
        ? [
            {
              field: "directorySize",
              state: "notComputed",
              message: "多选目录大小未计算"
            }
          ]
        : []
  };
}

export function getActiveDirectoryTab(state: WorkspaceState, panelId: PanelId) {
  const tab = getActiveTab(state.panels[panelId]);
  return isDirectoryTab(tab) ? tab : undefined;
}

export function normalizeNavigationParentKey(path: string) {
  return normalizeLocationPath(path).replace(/\//g, "\\").toLowerCase();
}

export function findTab(state: WorkspaceState, panelId: PanelId, tabId: string) {
  return state.panels[panelId].tabs.find((tab) => tab.id === tabId);
}

export function findEntryByPath(state: WorkspaceState, path: string) {
  for (const panel of Object.values(state.panels)) {
    for (const tab of panel.tabs) {
      if (!isDirectoryTab(tab)) {
        continue;
      }
      const entry = tab.snapshot.entries.find((item) => pathsEqual(item.path, path));
      if (entry) {
        return entry;
      }
    }
  }
  return undefined;
}

export function getEntryNameFromPath(path: string) {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function getTabsForPaths(state: WorkspaceState, paths: string[]) {
  const normalizedPaths = paths.map((path) => normalizeLocationPath(path));
  return Object.values(state.panels).flatMap((panel) =>
    panel.tabs
      .filter(isDirectoryTab)
      .filter((tab) => {
        const tabPath = normalizeLocationPath(tab.snapshot.location.path);
        return normalizedPaths.some((path) => pathsEqual(tabPath, path) || isSameOrDescendantPath(path, tabPath));
      })
      .map((tab) => ({
        panelId: panel.id,
        tabId: tab.id,
        path: tab.snapshot.location.path,
        historyIndex: tab.historyIndex
      }))
  );
}

export function getFallbackDirectoryPath(state: WorkspaceState, preferredPanelId: PanelId) {
  const preferredPanel = state.panels[preferredPanelId];
  const preferredDirectoryTab = preferredPanel.tabs.find(isDirectoryTab);
  if (preferredDirectoryTab) {
    return preferredDirectoryTab.snapshot.location.path;
  }

  const visiblePanelIds = ["panel-1", "panel-2", "panel-3", "panel-4"].filter((panelId): panelId is PanelId => {
    switch (state.layoutMode) {
      case "single":
        return panelId === "panel-1";
      case "dual":
        return panelId === "panel-1" || panelId === "panel-2";
      case "triple":
        return panelId !== "panel-4";
      case "quad":
        return true;
      default:
        return panelId === "panel-1";
    }
  });

  for (const panelId of visiblePanelIds) {
    const tab = state.panels[panelId].tabs.find(isDirectoryTab);
    if (tab) {
      return tab.snapshot.location.path;
    }
  }

  for (const panel of Object.values(state.panels)) {
    const tab = panel.tabs.find(isDirectoryTab);
    if (tab) {
      return tab.snapshot.location.path;
    }
  }

  return "C:\\";
}

export function hasVisibleNavigationTab(state: WorkspaceState) {
  return getVisiblePanelIds(state.layoutMode).some((panelId) => isNavigationTab(getActiveTab(state.panels[panelId])));
}

function getNavigationFolderMatchPanelOrder(state: WorkspaceState, navigationPanelId: PanelId) {
  const visiblePanelIds = getVisiblePanelIds(state.layoutMode);
  return [
    ...visiblePanelIds.filter((panelId) => panelId !== navigationPanelId),
    ...(visiblePanelIds.includes(navigationPanelId) ? [navigationPanelId] : [])
  ];
}

export function findDirectoryTabForNavigationFolder(state: WorkspaceState, navigationPanelId: PanelId, path: string) {
  for (const panelId of getNavigationFolderMatchPanelOrder(state, navigationPanelId)) {
    for (const tab of state.panels[panelId].tabs) {
      if (isDirectoryTab(tab) && pathsEqual(tab.snapshot.location.path, path)) {
        return { panelId, tabId: tab.id };
      }
    }
  }

  return undefined;
}

export function isSameOrDescendantPath(source: string, destination: string) {
  const normalizedSource = normalizeLocationPath(source);
  const normalizedDestination = normalizeLocationPath(destination);
  const separator = isRemotePath(normalizedSource) || isRemotePath(normalizedDestination) ? "/" : "\\";
  const sourceKey = getPathComparisonKey(normalizedSource);
  const destinationKey = getPathComparisonKey(normalizedDestination);
  const prefix = sourceKey.endsWith(separator) ? sourceKey : `${sourceKey}${separator}`;
  return destinationKey === sourceKey || destinationKey.startsWith(prefix);
}

export function isLocalFileClipboard(paths: string[]) {
  return paths.length > 0 && paths.every((path) => !isRemotePath(path));
}

export function appendLocationPathSegment(basePath: string, segment: string) {
  const separator = getLocationPathSeparator(basePath);
  return basePath.endsWith(separator) ? `${basePath}${segment}` : `${basePath}${separator}${segment}`;
}

function buildDescendantPathChain(ancestorPath: string, descendantPath: string) {
  const normalizedAncestorPath = normalizeLocationPath(ancestorPath);
  const normalizedDescendantPath = normalizeLocationPath(descendantPath);
  if (!isSameOrDescendantPath(normalizedAncestorPath, normalizedDescendantPath)) {
    return [normalizedAncestorPath];
  }
  if (pathsEqual(normalizedAncestorPath, normalizedDescendantPath)) {
    return [normalizedAncestorPath];
  }

  const separator = getLocationPathSeparator(normalizedAncestorPath);
  const prefix = normalizedAncestorPath.endsWith(separator)
    ? normalizedAncestorPath
    : `${normalizedAncestorPath}${separator}`;
  const segments = normalizedDescendantPath.slice(prefix.length).split(separator).filter(Boolean);
  const chain = [normalizedAncestorPath];
  let cursor = normalizedAncestorPath;
  for (const segment of segments) {
    cursor = appendLocationPathSegment(cursor, segment);
    chain.push(cursor);
  }
  return chain;
}

function getDeepestForwardDescendantPath(tab: TabState, currentPath: string) {
  const normalizedCurrentPath = normalizeLocationPath(currentPath);
  return tab.history.slice(tab.historyIndex + 1).reduce<string>((deepestPath, historyPath) => {
    const normalizedHistoryPath = normalizeLocationPath(historyPath);
    if (
      pathsEqual(normalizedHistoryPath, normalizedCurrentPath) ||
      !isSameOrDescendantPath(normalizedCurrentPath, normalizedHistoryPath)
    ) {
      return deepestPath;
    }

    return getPathComparisonKey(normalizedHistoryPath).length > getPathComparisonKey(deepestPath).length
      ? normalizedHistoryPath
      : deepestPath;
  }, normalizedCurrentPath);
}

export function createForwardPreservingNavigationHistory(tab: TabState, targetPath: string) {
  const currentPath = tab.snapshot.location.path;
  const normalizedTargetPath = normalizeLocationPath(targetPath);
  const targetIsCurrent = pathsEqual(normalizedTargetPath, currentPath);
  const targetIsDescendant = isSameOrDescendantPath(currentPath, normalizedTargetPath) && !targetIsCurrent;
  const targetIsAncestor = isSameOrDescendantPath(normalizedTargetPath, currentPath);
  if (!targetIsCurrent && !targetIsDescendant && !targetIsAncestor) {
    return null;
  }

  const deepestPath = getDeepestForwardDescendantPath(tab, currentPath);
  const chainStartPath = targetIsDescendant ? currentPath : normalizedTargetPath;
  if (!isSameOrDescendantPath(chainStartPath, deepestPath)) {
    return null;
  }

  const chain = buildDescendantPathChain(chainStartPath, deepestPath);
  const targetChainIndex = chain.findIndex((path) => pathsEqual(path, normalizedTargetPath));
  if (targetChainIndex < 0) {
    return null;
  }

  const chainKeys = new Set(chain.map(getPathComparisonKey));
  const historyPrefix = tab.history
    .slice(0, tab.historyIndex)
    .map((historyPath) => normalizeLocationPath(historyPath))
    .filter((historyPath) => !chainKeys.has(getPathComparisonKey(historyPath)));
  return {
    history: [...historyPrefix, ...chain],
    historyIndex: historyPrefix.length + targetChainIndex
  };
}

export function waitForMilliseconds(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function planNotificationDismissals(
  notifications: readonly { id: string; intent: NotificationItem["intent"] }[],
  scheduledIds: ReadonlySet<string>
): { toSchedule: string[]; toClear: string[] } {
  const activeIds = new Set(notifications.map((notification) => notification.id));
  const toSchedule = notifications
    .filter((notification) => notification.intent !== "danger" && !scheduledIds.has(notification.id))
    .map((notification) => notification.id);
  const toClear = [...scheduledIds].filter((id) => !activeIds.has(id));
  return { toSchedule, toClear };
}

import { startTransition, useEffect, useEffectEvent, useMemo, useReducer, useRef } from "react";
import { createMockWorkspaceBootstrap, getParentLocationPath, nextGeneratedTabId, normalizeLocationPath } from "./mockData";
import { createRemoteUri, resolveRemotePath } from "./remoteUri";
import { createWorkspaceGateway, type WorkspaceGateway } from "./workspaceGateway";
import { createWorkspaceState, getActiveTab, workspaceReducer } from "./workspaceReducer";
import { eventToShortcutBinding, getShortcutBindingMap, shortcutMatches } from "./workspaceShortcuts";
import { isDirectoryTab, isNavigationTab, NAVIGATION_VIRTUAL_PATH } from "./workspaceTabs";
import { readSearchHistory, writeSearchHistory } from "./workspaceSearchHistoryStore";
import { createDefaultSearchId } from "./workspaceSearch";
import { cloneColumns } from "./workspaceMappers";
import { devLog } from "./devLog";
import type { OperationConflictResolution, OperationPathRef } from "../../app/types";
import type {
  ColumnId,
  ColumnDefinition,
  ContextMenuState,
  DirectoryNode,
  DirectorySnapshot,
  EntryViewModel,
  MultiSelectionPropertiesSummary,
  NativeContextMenuRequest,
  NavigationItem,
  NavigationItemUpsertRequest,
  OperationTaskSnapshot,
  PanelId,
  RemoteConnectionProfile,
  SearchProgressState,
  SettingsModel,
  SettingsSection,
  TabState,
  TabViewMode,
  WorkspaceState
} from "./types";

const defaultWorkspaceGateway = createWorkspaceGateway();

function isRemotePath(path: string) {
  return path.startsWith("ftp://") || path.startsWith("sftp://");
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return fallback;
}

function hasSameJsonShape(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isUntrustedSftpHostKeyError(message: string) {
  return message.includes("SFTP host key is not trusted yet");
}

function createHostKeyConfirmationMessage(info: Awaited<ReturnType<WorkspaceGateway["getRemoteHostKey"]>>) {
  return [
    `是否信任此 SFTP 主机密钥？`,
    ``,
    `主机：${info.host}:${info.port}`,
    `算法：${info.algorithm}`,
    `指纹：${info.fingerprintSha256}`,
    ``,
    `known_hosts 条目：`,
    info.knownHostsEntry,
    ``,
    `仅在你确认这是目标服务器时选择“确定”。`
  ].join("\n");
}

async function confirmAndTrustRemoteHostKey(
  workspaceGateway: WorkspaceGateway,
  profiles: RemoteConnectionProfile[],
  path: string,
  message: string
) {
  if (!isUntrustedSftpHostKeyError(message)) {
    return false;
  }

  const remote = resolveRemotePath(path, profiles);
  if (!remote || remote.profile.protocol !== "sftp") {
    return false;
  }

  const info = await workspaceGateway.getRemoteHostKey(remote.profile.id);
  const confirmed =
    typeof window === "undefined" ? false : window.confirm(createHostKeyConfirmationMessage(info));
  if (!confirmed) {
    return false;
  }

  await workspaceGateway.trustRemoteHostKey({
    profileId: info.profileId,
    host: info.host,
    port: info.port,
    algorithm: info.algorithm,
    keyBase64: info.keyBase64
  });
  return true;
}

function createTabFromSnapshot(
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

function createReconnectTab(
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

function createUniqueTabId(panelId: PanelId, tabs: TabState[]) {
  const existingIds = new Set(tabs.map((tab) => tab.id));
  let id = nextGeneratedTabId(panelId);
  while (existingIds.has(id)) {
    id = nextGeneratedTabId(panelId);
  }
  return id;
}

function createUniqueSearchTabId(panelId: PanelId, tabs: TabState[]) {
  const existingIds = new Set(tabs.map((tab) => tab.id));
  let sequence = 1;
  let id = `${panelId}-search-results-${sequence}`;
  while (existingIds.has(id)) {
    sequence += 1;
    id = `${panelId}-search-results-${sequence}`;
  }
  return id;
}

function findTreeNode(nodes: DirectoryNode[], path: string): DirectoryNode | undefined {
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

function createNotification(intent: WorkspaceState["notifications"][number]["intent"], message: string) {
  return {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `notification-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    intent,
    message
  } satisfies WorkspaceState["notifications"][number];
}

function getSelectedEntries(state: WorkspaceState, panelId: PanelId) {
  const tab = getActiveTab(state.panels[panelId]);
  if (!isDirectoryTab(tab)) {
    return [];
  }
  return tab.snapshot.entries.filter((entry) => tab.selectedEntryIds.includes(entry.id));
}

function createSelectionKey(entries: EntryViewModel[]) {
  return entries.map((entry) => entry.id).join("|");
}

function createMultiSelectionSummary(entries: EntryViewModel[]): MultiSelectionPropertiesSummary {
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

function getActiveDirectoryTab(state: WorkspaceState, panelId: PanelId) {
  const tab = getActiveTab(state.panels[panelId]);
  return isDirectoryTab(tab) ? tab : undefined;
}

type NavigationFolderInput = {
  displayName?: string;
  path: string;
};

function normalizeNavigationParentKey(path: string) {
  return normalizeLocationPath(path).replace(/\//g, "\\").toLowerCase();
}

function findTab(state: WorkspaceState, panelId: PanelId, tabId: string) {
  return state.panels[panelId].tabs.find((tab) => tab.id === tabId);
}

function getTabsForPaths(state: WorkspaceState, paths: string[]) {
  const normalizedPaths = new Set(paths.map((path) => normalizeLocationPath(path)));
  return Object.values(state.panels).flatMap((panel) =>
    panel.tabs
      .filter((tab) => !isNavigationTab(tab))
      .filter((tab) => normalizedPaths.has(normalizeLocationPath(tab.snapshot.location.path)))
      .map((tab) => ({
        panelId: panel.id,
        tabId: tab.id,
        path: tab.snapshot.location.path,
        historyIndex: tab.historyIndex
      }))
  );
}

function getFallbackDirectoryPath(state: WorkspaceState, preferredPanelId: PanelId) {
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

function getLocationPathSeparator(path: string) {
  return isRemotePath(path) ? "/" : "\\";
}

function getPathComparisonKey(path: string) {
  const normalized = normalizeLocationPath(path);
  return isRemotePath(normalized) ? normalized : normalized.toLowerCase();
}

function pathsEqual(left: string, right: string) {
  return getPathComparisonKey(left) === getPathComparisonKey(right);
}

function isSameOrDescendantPath(source: string, destination: string) {
  const normalizedSource = normalizeLocationPath(source);
  const normalizedDestination = normalizeLocationPath(destination);
  const separator = isRemotePath(normalizedSource) || isRemotePath(normalizedDestination) ? "/" : "\\";
  const sourceKey = getPathComparisonKey(normalizedSource);
  const destinationKey = getPathComparisonKey(normalizedDestination);
  const prefix = sourceKey.endsWith(separator) ? sourceKey : `${sourceKey}${separator}`;
  return destinationKey === sourceKey || destinationKey.startsWith(prefix);
}

function appendLocationPathSegment(basePath: string, segment: string) {
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

function createForwardPreservingNavigationHistory(tab: TabState, targetPath: string) {
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

function isTerminalOperationTask(task: OperationTaskSnapshot) {
  return (
    task.status === "succeeded" ||
    task.status === "failed" ||
    task.status === "partialSucceeded" ||
    task.status === "cancelled"
  );
}

function pathRefToWorkspacePath(pathRef: OperationPathRef, profiles: RemoteConnectionProfile[]) {
  if (pathRef.kind === "local") {
    return normalizeLocationPath(pathRef.path);
  }

  const profile = profiles.find((item) => item.id === pathRef.profileId);
  if (!profile) {
    return null;
  }
  return createRemoteUri(profile, pathRef.remotePath);
}

function getOperationRefreshPaths(task: OperationTaskSnapshot, profiles: RemoteConnectionProfile[]) {
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

export function useWorkspaceController(workspaceGateway: WorkspaceGateway = defaultWorkspaceGateway) {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, () => ({
    ...createWorkspaceState(createMockWorkspaceBootstrap("mock")),
    status: "loading" as const
  }));
  const hydratingTreePathsRef = useRef<Set<string>>(new Set());
  const navigationRequestsRef = useRef<Map<string, number>>(new Map());
  const nextNavigationRequestIdRef = useRef(0);
  const nextSearchRequestIdRef = useRef(0);
  const nextPropertiesRequestIdRef = useRef(0);
  const activeSearchRef = useRef<{ requestId: number; searchId: string } | null>(null);
  const searchHistoryHydratedRef = useRef(false);
  const refreshedOperationTasksRef = useRef<Set<string>>(new Set());
  const skipNextSettingsPersistenceRef = useRef({
    shortcuts: false,
    colorRules: false,
    detailsRowHeight: false,
    theme: false
  });

  const pushNotification = useEffectEvent((intent: WorkspaceState["notifications"][number]["intent"], message: string) => {
    dispatch({ type: "notificationAdded", payload: createNotification(intent, message) });
  });

  const skipNextSettingsPersistence = () => {
    skipNextSettingsPersistenceRef.current = {
      shortcuts: true,
      colorRules: true,
      detailsRowHeight: true,
      theme: true
    };
  };

  const clearSkippedSettingsPersistence = () => {
    skipNextSettingsPersistenceRef.current = {
      shortcuts: false,
      colorRules: false,
      detailsRowHeight: false,
      theme: false
    };
  };

  const skipChangedSettingsPersistence = (current: SettingsModel, next: SettingsModel) => {
    skipNextSettingsPersistenceRef.current = {
      shortcuts: !hasSameJsonShape(current.shortcuts, next.shortcuts),
      colorRules: !hasSameJsonShape(current.colorRules, next.colorRules),
      detailsRowHeight: current.detailsRowHeight !== next.detailsRowHeight,
      theme: !hasSameJsonShape(current.theme, next.theme)
    };
  };

  const persistedSettingsChanged = (current: SettingsModel, next: SettingsModel) =>
    !hasSameJsonShape(current.shortcuts, next.shortcuts) ||
    !hasSameJsonShape(current.colorRules, next.colorRules) ||
    current.detailsRowHeight !== next.detailsRowHeight ||
    !hasSameJsonShape(current.theme, next.theme);

  const propertiesPanel = state.panels[state.activePanelId];
  const propertiesWorkspaceTab = getActiveTab(propertiesPanel);
  const propertiesSelectedIds = isDirectoryTab(propertiesWorkspaceTab)
    ? propertiesWorkspaceTab.selectedEntryIds.join("|")
    : "";
  const propertiesEffectKey = [
    state.status,
    state.informationPanel.expanded ? "expanded" : "collapsed",
    state.informationPanel.activeTab,
    state.activePanelId,
    propertiesWorkspaceTab.id,
    propertiesWorkspaceTab.snapshot.location.path,
    propertiesSelectedIds
  ].join("::");

  useEffect(() => {
    let disposed = false;

    void workspaceGateway
      .loadBootstrap()
      .then((bootstrap) => {
        if (!disposed) {
          dispatch({ type: "bootstrapLoaded", payload: bootstrap });
        }
      })
      .catch((error) => {
        if (!disposed) {
          dispatch({ type: "bootstrapFailed" });
          pushNotification("danger", error instanceof Error ? error.message : "工作区加载失败");
        }
      });

    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (searchHistoryHydratedRef.current) {
      return;
    }
    searchHistoryHydratedRef.current = true;
    dispatch({ type: "searchHistoryLoaded", payload: { tab: "content", history: readSearchHistory("content") } });
    dispatch({ type: "searchHistoryLoaded", payload: { tab: "name", history: readSearchHistory("name") } });
  }, []);

  useEffect(() => {
    if (
      state.status !== "ready" ||
      !state.informationPanel.expanded ||
      state.informationPanel.activeTab !== "properties"
    ) {
      return;
    }

    const activePanel = state.panels[state.activePanelId];
    const activeTab = getActiveTab(activePanel);
    if (!isDirectoryTab(activeTab)) {
      dispatch({ type: "propertiesCleared" });
      return;
    }

    const selectedEntries = activeTab.snapshot.entries.filter((entry) => activeTab.selectedEntryIds.includes(entry.id));
    if (selectedEntries.length > 1) {
      dispatch({
        type: "propertiesSummaryReady",
        payload: {
          targetKey: `multi:${createSelectionKey(selectedEntries)}`,
          summary: createMultiSelectionSummary(selectedEntries)
        }
      });
      return;
    }

    const targetPath = selectedEntries[0]?.path ?? activeTab.snapshot.location.path;
    const targetKey = `single:${targetPath}`;
    const requestId = `properties-${++nextPropertiesRequestIdRef.current}`;
    let disposed = false;

    dispatch({
      type: "propertiesRequestStarted",
      payload: {
        requestId,
        targetKey
      }
    });

    void workspaceGateway
      .getItemProperties(requestId, targetPath, false)
      .then((item) => {
        if (!disposed) {
          dispatch({
            type: "propertiesRequestSucceeded",
            payload: {
              requestId,
              targetKey,
              item
            }
          });
        }
      })
      .catch((error) => {
        if (!disposed) {
          dispatch({
            type: "propertiesRequestFailed",
            payload: {
              requestId,
              targetKey,
              errorMessage: getErrorMessage(error, "无法读取属性。")
            }
          });
        }
      });

    return () => {
      disposed = true;
    };
  }, [propertiesEffectKey, workspaceGateway]);

  useEffect(() => {
    if (state.status !== "ready" || state.source !== "tauri") {
      return;
    }
    void workspaceGateway.saveSession(state);
  }, [state, workspaceGateway]);

  useEffect(() => {
    if (state.source !== "tauri") {
      return;
    }
    void workspaceGateway.saveLayout(state.layoutMode, state.layoutRatios);
  }, [
    state.layoutMode,
    state.layoutRatios.primary,
    state.layoutRatios.tripleSecondary,
    state.layoutRatios.quadLeftSecondary,
    state.layoutRatios.quadRightSecondary,
    state.layoutRatios.tree,
    state.layoutRatios.search,
    state.source
  ]);

  useEffect(() => {
    if (state.source !== "tauri") {
      return;
    }
    if (skipNextSettingsPersistenceRef.current.shortcuts) {
      skipNextSettingsPersistenceRef.current.shortcuts = false;
      return;
    }
    void workspaceGateway.saveShortcuts(state.settings.model.shortcuts);
  }, [state.settings.model.shortcuts, state.source]);

  useEffect(() => {
    if (state.source !== "tauri") {
      return;
    }
    if (skipNextSettingsPersistenceRef.current.colorRules) {
      skipNextSettingsPersistenceRef.current.colorRules = false;
      return;
    }
    void workspaceGateway.saveColorRules(state.settings.model.colorRules);
  }, [state.settings.model.colorRules, state.source]);

  useEffect(() => {
    if (state.source !== "tauri") {
      return;
    }
    if (skipNextSettingsPersistenceRef.current.detailsRowHeight) {
      skipNextSettingsPersistenceRef.current.detailsRowHeight = false;
      return;
    }
    void workspaceGateway.saveDetailsRowHeight(state.settings.model.detailsRowHeight);
  }, [state.settings.model.detailsRowHeight, state.source]);

  useEffect(() => {
    if (state.source !== "tauri") {
      return;
    }
    if (skipNextSettingsPersistenceRef.current.theme) {
      skipNextSettingsPersistenceRef.current.theme = false;
      return;
    }
    void workspaceGateway.saveTheme(state.settings.model.theme);
  }, [state.settings.model.theme, state.source]);

  useEffect(() => {
    if (!searchHistoryHydratedRef.current) {
      return;
    }
    writeSearchHistory("content", state.search.histories.content);
    writeSearchHistory("name", state.search.histories.name);
  }, [state.search.histories.content, state.search.histories.name]);

  useEffect(() => {
    if (state.status !== "ready") {
      hydratingTreePathsRef.current.clear();
      return;
    }

    const activeTab = getActiveTab(state.panels[state.activePanelId]);
    if (isNavigationTab(activeTab) || activeTab.status !== "ready") {
      return;
    }

    const pendingPaths = Array.from(new Set(activeTab.expandedNodePaths.map((path) => normalizeLocationPath(path)))).filter(
      (path) => {
        if (!path || hydratingTreePathsRef.current.has(path)) {
          return false;
        }

        const node = findTreeNode(state.directoryTree, path);
        return Boolean(node && node.expandable && !node.loaded);
      }
    );

    if (pendingPaths.length === 0) {
      return;
    }

    for (const path of pendingPaths) {
      hydratingTreePathsRef.current.add(path);

      void workspaceGateway
        .loadTreeChildren(path)
        .then((children) => {
          dispatch({ type: "treeChildrenLoaded", payload: { path, children } });
        })
        .catch((error) => {
          if (isRemotePath(path)) {
            dispatch({
              type: "treeNodeConnectionFailed",
              payload: { path, message: getErrorMessage(error, `无法展开 ${path}`) }
            });
          }
          pushNotification("danger", getErrorMessage(error, `无法展开 ${path}`));
        })
        .finally(() => {
          hydratingTreePathsRef.current.delete(path);
        });
    }
  }, [state.status, state.activePanelId, state.panels, state.directoryTree, workspaceGateway]);

  const applySettingsModel = useEffectEvent(async (model: SettingsModel, section?: SettingsSection) => {
    if (state.source === "tauri") {
      skipNextSettingsPersistence();
      try {
        await workspaceGateway.saveSettingsModel(model);
      } catch (error) {
        clearSkippedSettingsPersistence();
        throw error;
      }
    }

    dispatch({ type: "settingsModelApplied", payload: { model, section } });
  });

  const navigateHistoryByDelta = useEffectEvent((panelId: PanelId, delta: -1 | 1) => {
    const activeTab = getActiveTab(state.panels[panelId]);
    if (isNavigationTab(activeTab)) {
      return;
    }
    const targetHistoryIndex = activeTab.historyIndex + delta;
    const targetPath = activeTab.history[targetHistoryIndex];
    if (targetPath) {
      void commitNavigation(panelId, targetPath, false, {
        tabId: activeTab.id,
        historyIndex: targetHistoryIndex
      });
    }
  });

  const navigateUpKeepingForwardHistory = useEffectEvent((panelId: PanelId) => {
    const activeTab = getActiveTab(state.panels[panelId]);
    if (isNavigationTab(activeTab)) {
      return;
    }
    const activeSnapshot = activeTab.snapshot;
    const currentPath = activeSnapshot.location.path;
    const parentPath =
      activeSnapshot.breadcrumbs[activeSnapshot.breadcrumbs.length - 2]?.path ?? getParentPathForRefresh(currentPath);
    if (!parentPath) {
      return;
    }

    const historyBeforeCurrent = activeTab.history.slice(0, activeTab.historyIndex).filter((path) => path !== parentPath);
    const historyAfterCurrent = activeTab.history.slice(activeTab.historyIndex + 1).filter((path) => path !== currentPath);
    void commitNavigation(panelId, parentPath, false, {
      tabId: activeTab.id,
      history: [...historyBeforeCurrent, parentPath, currentPath, ...historyAfterCurrent],
      historyIndex: historyBeforeCurrent.length
    });
  });

  const navigateBreadcrumbPath = useEffectEvent((panelId: PanelId, path: string) => {
    const activeTab = getActiveTab(state.panels[panelId]);
    if (isNavigationTab(activeTab)) {
      return;
    }

    const preservedHistory = createForwardPreservingNavigationHistory(activeTab, path);
    if (preservedHistory) {
      void commitNavigation(panelId, path, false, {
        tabId: activeTab.id,
        history: preservedHistory.history,
        historyIndex: preservedHistory.historyIndex
      });
      return;
    }

    void commitNavigation(panelId, path);
  });

  const commitNavigation = useEffectEvent(
    async (
      panelId: PanelId,
      path: string,
      pushHistory = true,
      options: { tabId?: string; activatePanel?: boolean; historyIndex?: number; history?: string[] } = {}
    ) => {
      const panel = state.panels[panelId];
      const activeTab = getActiveTab(panel);
      const tabId = options.tabId ?? activeTab.id;
      const targetTab = panel.tabs.find((tab) => tab.id === tabId);
      if (isNavigationTab(targetTab)) {
        pushNotification("warning", "导航页不能作为目录跳转目标。");
        return;
      }
      if (targetTab?.locked && pushHistory && options.tabId === undefined) {
        void handleOpenNewTab(panelId, path);
        return;
      }
      const requestKey = `${panelId}:${tabId}`;
      const requestId = nextNavigationRequestIdRef.current + 1;
      nextNavigationRequestIdRef.current = requestId;
      navigationRequestsRef.current.set(requestKey, requestId);
      if (isRemotePath(path)) {
        dispatch({ type: "tabReconnectStarted", payload: { panelId, tabId } });
      }
      try {
        const snapshot = await workspaceGateway.resolveDirectory(path);
        const latestRequestId = navigationRequestsRef.current.get(requestKey);
        if (latestRequestId !== requestId || !state.panels[panelId].tabs.some((tab) => tab.id === tabId)) {
          return;
        }

        dispatch({
          type: "tabSnapshotCommitted",
          payload: {
            panelId,
            tabId,
            snapshot,
            pushHistory,
            activatePanel: options.activatePanel,
            historyIndex: options.historyIndex,
            history: options.history
          }
        });
      } catch (error) {
        const message = getErrorMessage(error, `无法打开 ${path}`);
        const latestRequestId = navigationRequestsRef.current.get(requestKey);
        const tabStillCurrent =
          latestRequestId === requestId && state.panels[panelId].tabs.some((tab) => tab.id === tabId);
        if (tabStillCurrent && isRemotePath(path)) {
          try {
            const shouldRetry = await confirmAndTrustRemoteHostKey(workspaceGateway, state.remoteProfiles, path, message);
            if (shouldRetry) {
              const snapshot = await workspaceGateway.resolveDirectory(path);
              const latestRetryRequestId = navigationRequestsRef.current.get(requestKey);
              if (latestRetryRequestId !== requestId || !state.panels[panelId].tabs.some((tab) => tab.id === tabId)) {
                return;
              }

              dispatch({
                type: "tabSnapshotCommitted",
                payload: {
                  panelId,
                  tabId,
                  snapshot,
                  pushHistory,
                  activatePanel: options.activatePanel,
                  historyIndex: options.historyIndex,
                  history: options.history
                }
              });
              return;
            }
          } catch (retryError) {
            const retryMessage = getErrorMessage(retryError, `无法信任 ${path} 的主机密钥`);
            dispatch({
              type: "tabReconnectRequired",
              payload: {
                panelId,
                tabId,
                path,
                message: retryMessage
              }
            });
            pushNotification("danger", retryMessage);
            return;
          }

          dispatch({
            type: "tabReconnectRequired",
            payload: {
              panelId,
              tabId,
              path,
              message
            }
          });
        }
        pushNotification("danger", message);
      } finally {
        if (navigationRequestsRef.current.get(requestKey) === requestId) {
          navigationRequestsRef.current.delete(requestKey);
        }
      }
    }
  );

  const refreshNavigationTargets = useEffectEvent(async () => {
    dispatch({ type: "navigationStatusSet", payload: "checking" });
    try {
      const infos = await workspaceGateway.resolveNavigationTargets(state.navigation.items.map((item) => item.path));
      dispatch({ type: "navigationTargetStatusUpdated", payload: infos });
    } catch (error) {
      dispatch({ type: "navigationStatusSet", payload: "idle" });
      pushNotification("danger", getErrorMessage(error, "无法刷新导航项目标状态。"));
    }
  });

  const refreshPanel = useEffectEvent(async (panelId: PanelId) => {
    const activeTab = getActiveTab(state.panels[panelId]);
    if (isNavigationTab(activeTab)) {
      await refreshNavigationTargets();
      return;
    }
    await commitNavigation(panelId, activeTab.snapshot.location.path, false, {
      tabId: activeTab.id,
      activatePanel: false,
      historyIndex: activeTab.historyIndex
    });
  });

  const refreshPanelsForPaths = useEffectEvent(async (paths: string[]) => {
    const seen = new Set<string>();
    const targets = getTabsForPaths(state, paths).filter((target) => {
      const key = `${target.panelId}:${target.tabId}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

    await Promise.all(
      targets.map((target) =>
        commitNavigation(target.panelId, target.path, false, {
          tabId: target.tabId,
          activatePanel: false,
          historyIndex: target.historyIndex
        })
      )
    );
  });

  const projectOperationTask = useEffectEvent(async (task: OperationTaskSnapshot) => {
    dispatch({ type: "operationTaskEventReceived", payload: task });
    if (!isTerminalOperationTask(task) || refreshedOperationTasksRef.current.has(task.taskId)) {
      return;
    }

    refreshedOperationTasksRef.current.add(task.taskId);
    const refreshPaths = getOperationRefreshPaths(task, state.remoteProfiles);
    if (refreshPaths.length > 0) {
      await refreshPanelsForPaths(refreshPaths);
    }

    if (task.status === "failed") {
      pushNotification("danger", task.message ?? "File operation failed");
    } else if (task.status === "partialSucceeded") {
      pushNotification("warning", task.message ?? "File operation completed with errors");
    }
  });

  const projectOperationResult = useEffectEvent(async (task: OperationTaskSnapshot | void) => {
    if (!task) {
      return;
    }
    await projectOperationTask(task);
  });

  useEffect(() => {
    if (state.status !== "ready" || state.source !== "tauri") {
      return;
    }

    let disposed = false;
    const unlistenFns: Array<() => void> = [];

    void (async () => {
      const [unlistenTasks, unlistenConflicts, unlistenHistory] = await Promise.all([
        workspaceGateway.listenOperationTasks((event) => {
          if (!disposed) {
            void projectOperationTask(event.snapshot);
          }
        }),
        workspaceGateway.listenOperationConflicts((request) => {
          if (!disposed) {
            dispatch({ type: "operationConflictRequested", payload: request });
          }
        }),
        workspaceGateway.listenOperationHistory((event) => {
          if (!disposed) {
            dispatch({ type: "operationHistoryEventReceived", payload: event });
          }
        })
      ]);

      if (disposed) {
        unlistenTasks();
        unlistenConflicts();
        unlistenHistory();
        return;
      }

      unlistenFns.push(unlistenTasks, unlistenConflicts, unlistenHistory);

      const [taskSnapshot, historySnapshot] = await Promise.all([
        workspaceGateway.listOperationTasks(),
        workspaceGateway.listOperationHistory()
      ]);

      if (disposed) {
        return;
      }

      dispatch({ type: "operationTasksSnapshotLoaded", payload: taskSnapshot });
      dispatch({ type: "operationHistorySnapshotLoaded", payload: historySnapshot });
    })().catch((error) => {
      if (!disposed) {
        pushNotification("danger", getErrorMessage(error, "Unable to initialize file operation events"));
      }
    });

    return () => {
      disposed = true;
      for (const unlisten of unlistenFns) {
        unlisten();
      }
    };
  }, [projectOperationTask, pushNotification, state.source, state.status, workspaceGateway]);

  useEffect(() => {
    if (state.status !== "ready" || state.source !== "tauri") {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void workspaceGateway
      .listenSettingsChanged((payload) => {
        if (disposed) {
          return;
        }

        const settingsModelChanged = persistedSettingsChanged(state.settings.model, payload.settingsModel);
        const navigationItemsChanged = !hasSameJsonShape(state.navigation.items, payload.navigationItems);
        const changed =
          navigationItemsChanged ||
          !hasSameJsonShape(state.bookmarks, payload.bookmarks) ||
          !hasSameJsonShape(state.hotlist, payload.hotlist) ||
          !hasSameJsonShape(state.remoteProfiles, payload.remoteProfiles) ||
          settingsModelChanged;

        if (!changed) {
          return;
        }

        if (settingsModelChanged) {
          skipChangedSettingsPersistence(state.settings.model, payload.settingsModel);
        }
        dispatch({ type: "settingsSnapshotSynced", payload });
      })
      .then((dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unlisten = dispose;
      })
      .catch((error) => {
        if (!disposed) {
          pushNotification("danger", getErrorMessage(error, "无法监听设置变更"));
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [
    pushNotification,
    state.bookmarks,
    state.hotlist,
    state.navigation.items,
    state.remoteProfiles,
    state.settings.model,
    state.source,
    state.status,
    workspaceGateway
  ]);

  const undoLatestOperation = useEffectEvent(async () => {
    try {
      const task = await workspaceGateway.undoLatestOperation();
      await projectOperationTask(task);
    } catch (error) {
      pushNotification("warning", getErrorMessage(error, "No undoable file operation is available"));
    }
  });

  const undoOperation = useEffectEvent(async (recordId: string) => {
    try {
      const task = await workspaceGateway.undoOperation(recordId);
      await projectOperationTask(task);
    } catch (error) {
      pushNotification("warning", getErrorMessage(error, "Unable to undo that operation"));
    }
  });

  const cancelOperation = useEffectEvent(async (taskId: string) => {
    try {
      const task = await workspaceGateway.cancelOperation(taskId);
      await projectOperationTask(task);
    } catch (error) {
      pushNotification("danger", getErrorMessage(error, "Unable to cancel the file operation"));
    }
  });

  const resolveOperationConflict = useEffectEvent(async () => {
    const dialog = state.operations.conflictDialog;
    if (!dialog) {
      return;
    }

    if (dialog.selectedResolution === "rename" && !dialog.renameValue.trim()) {
      pushNotification("warning", "Enter a new name to resolve the conflict.");
      return;
    }

    dispatch({ type: "operationConflictDialogChanged", payload: { resolving: true } });
    const resolution: OperationConflictResolution = {
      conflictId: dialog.request.conflictId,
      resolution: dialog.selectedResolution,
      newName: dialog.selectedResolution === "rename" ? dialog.renameValue.trim() : null,
      applyToAll: dialog.selectedResolution === "rename" ? false : dialog.applyToAll
    };

    try {
      const task = await workspaceGateway.resolveOperationConflict(resolution);
      dispatch({ type: "operationConflictDialogClosed", payload: { conflictId: dialog.request.conflictId } });
      await projectOperationTask(task);
    } catch (error) {
      dispatch({ type: "operationConflictDialogChanged", payload: { resolving: false } });
      pushNotification("danger", getErrorMessage(error, "Unable to resolve the file conflict"));
    }
  });

  const handleOpenNewTab = useEffectEvent(async (panelId: PanelId, path?: string) => {
    const sourceTab = getActiveTab(state.panels[panelId]);
    const basePath = path ?? (isNavigationTab(sourceTab) ? getFallbackDirectoryPath(state, panelId) : sourceTab.snapshot.location.path);
    const sourceColumns = isNavigationTab(sourceTab) ? state.settings.model.columns : sourceTab.columns;
    const viewMode = isNavigationTab(sourceTab) ? "details" : sourceTab.viewMode;
    const tabId = createUniqueTabId(panelId, state.panels[panelId].tabs);
    try {
      const snapshot = await workspaceGateway.resolveDirectory(basePath);
      dispatch({
        type: "tabOpened",
        payload: {
          panelId,
          tab: createTabFromSnapshot(panelId, snapshot, tabId, viewMode, sourceColumns)
        }
      });
    } catch (error) {
      const message = getErrorMessage(error, `无法打开 ${basePath}`);
      if (isRemotePath(basePath)) {
        try {
          const shouldRetry = await confirmAndTrustRemoteHostKey(workspaceGateway, state.remoteProfiles, basePath, message);
          if (shouldRetry) {
            const snapshot = await workspaceGateway.resolveDirectory(basePath);
            dispatch({
              type: "tabOpened",
              payload: {
                panelId,
                tab: createTabFromSnapshot(panelId, snapshot, tabId, viewMode, sourceColumns)
              }
            });
            return;
          }
        } catch (retryError) {
          const retryMessage = getErrorMessage(retryError, `无法信任 ${basePath} 的主机密钥`);
          dispatch({
            type: "tabOpened",
            payload: {
              panelId,
              tab: createReconnectTab(panelId, basePath, tabId, viewMode, sourceColumns, retryMessage)
            }
          });
          pushNotification("danger", retryMessage);
          return;
        }

        dispatch({
          type: "tabOpened",
          payload: {
            panelId,
            tab: createReconnectTab(panelId, basePath, tabId, viewMode, sourceColumns, message)
          }
        });
      }
      pushNotification("danger", message);
    }
  });

  const dropEntries = useEffectEvent(async (paths: string[], destination: string, operation: "copy" | "move") => {
    const normalizedPaths = Array.from(new Set(paths.map((path) => normalizeLocationPath(path)).filter(Boolean)));
    const normalizedDestination = normalizeLocationPath(destination);

    if (normalizedPaths.length === 0) {
      return;
    }

    if (normalizedPaths.some((path) => isSameOrDescendantPath(path, normalizedDestination))) {
      pushNotification("warning", "不能将项目拖到自身或其子目录中。");
      return;
    }

    const sourceParents = Array.from(
      new Set(
        normalizedPaths
          .map((path) => getParentPathForRefresh(path))
          .filter((path): path is string => Boolean(path))
      )
    );

    try {
      const activeTab = getActiveDirectoryTab(state, state.activePanelId);
      const operationOptions = {
        source: "dragDrop" as const,
        panelId: state.activePanelId,
        tabId: activeTab?.id ?? null
      };
      const task =
        operation === "copy"
          ? await workspaceGateway.copyEntries(normalizedPaths, normalizedDestination, operationOptions)
          : await workspaceGateway.moveEntries(normalizedPaths, normalizedDestination, operationOptions);
      await projectOperationResult(task);
      if (!task) {
        const refreshPaths = operation === "copy" ? [normalizedDestination] : [...sourceParents, normalizedDestination];
        await refreshPanelsForPaths(refreshPaths);
      }
      return;
    } catch (error) {
      pushNotification("danger", error instanceof Error ? error.message : `${operation === "copy" ? "复制" : "移动"}失败`);
    }
  });

  const openTreeNode = useEffectEvent((panelId: PanelId, path: string, kind: DirectoryNode["kind"]) => {
    const activeTab = getActiveTab(state.panels[panelId]);
    if (isNavigationTab(activeTab)) {
      void handleOpenNewTab(panelId, path);
      return;
    }
    if (kind === "remote-root") {
      void handleOpenNewTab(panelId, path);
      return;
    }

    void commitNavigation(panelId, path);
  });

  const loadTreeChildren = useEffectEvent(async (panelId: PanelId, tabId: string, path: string, expand: boolean) => {
    if (isNavigationTab(findTab(state, panelId, tabId))) {
      return;
    }
    dispatch({ type: "treeNodeExpansionSet", payload: { panelId, tabId, path, expanded: expand } });

    if (!expand) {
      return;
    }

    const node = findTreeNode(state.directoryTree, path);

    if (node?.loaded || node?.expandable === false) {
      return;
    }

    try {
      if (isRemotePath(path)) {
        dispatch({ type: "treeNodeConnectionStarted", payload: { path } });
      }
      const children = await workspaceGateway.loadTreeChildren(path);
      dispatch({ type: "treeChildrenLoaded", payload: { path, children } });
    } catch (error) {
      if (isRemotePath(path)) {
        dispatch({
          type: "treeNodeConnectionFailed",
          payload: { path, message: getErrorMessage(error, `无法展开 ${path}`) }
        });
      } else {
        dispatch({ type: "treeNodeExpansionSet", payload: { panelId, tabId, path, expanded: false } });
      }
      pushNotification("danger", getErrorMessage(error, `无法展开 ${path}`));
    }
  });

  const reconnectTab = useEffectEvent((panelId: PanelId, tabId: string) => {
    const tab = findTab(state, panelId, tabId);
    if (isNavigationTab(tab)) {
      return;
    }
    const path = tab?.reconnect?.path ?? tab?.snapshot.location.path;
    if (!path) {
      return;
    }

    void commitNavigation(panelId, path, false, {
      tabId,
      activatePanel: false,
      historyIndex: tab?.historyIndex
    });
  });

  const runSearch = useEffectEvent(async () => {
    const searchRequestId = nextSearchRequestIdRef.current + 1;
    nextSearchRequestIdRef.current = searchRequestId;
    const searchId = createDefaultSearchId();
    activeSearchRef.current = { requestId: searchRequestId, searchId };
    let latestProgress: SearchProgressState | undefined;
    const sourcePanelId = state.activePanelId;
    const sourcePanel = state.panels[sourcePanelId];
    const sourceTab = getActiveTab(sourcePanel);
    if (isNavigationTab(sourceTab)) {
      pushNotification("warning", "导航页不支持目录搜索。");
      return;
    }
    const query =
      state.search.activeTab === "name"
        ? { ...state.search.query, content: "" }
        : { ...state.search.query, name: "" };
    const resultTabId = createUniqueSearchTabId(sourcePanelId, sourcePanel.tabs);
    dispatch({ type: "searchStarted", payload: { searchId } });
    const scopePaths = [sourceTab.snapshot.location.path];

    try {
      const results = await workspaceGateway.search(query, scopePaths, {
        searchId,
        onProgress: (progress) => {
          if (nextSearchRequestIdRef.current !== searchRequestId) {
            return;
          }

          latestProgress = progress;
          dispatch({ type: "searchProgressUpdated", payload: progress });
        }
      });
      if (nextSearchRequestIdRef.current !== searchRequestId) {
        return;
      }
      activeSearchRef.current = null;
      startTransition(() => {
        dispatch({
          type: "searchResultsTabCommitted",
          payload: {
            panelId: sourcePanelId,
            sourceTabId: sourceTab.id,
            tabId: resultTabId,
            query,
            results,
            progress: latestProgress
          }
        });
      });
    } catch (error) {
      if (nextSearchRequestIdRef.current !== searchRequestId) {
        return;
      }
      activeSearchRef.current = null;
      dispatch({ type: "searchFailed" });
      pushNotification("danger", error instanceof Error ? error.message : "搜索失败");
    } finally {
      if (activeSearchRef.current?.requestId === searchRequestId) {
        activeSearchRef.current = null;
      }
    }
  });

  const stopSearch = useEffectEvent(async () => {
    const activeSearch = activeSearchRef.current;
    if (!activeSearch) {
      return;
    }

    nextSearchRequestIdRef.current += 1;
    activeSearchRef.current = null;
    dispatch({ type: "searchCancelled" });

    try {
      await workspaceGateway.cancelSearch(activeSearch.searchId);
    } catch (error) {
      pushNotification("danger", error instanceof Error ? error.message : "停止搜索失败");
    }
  });

  const copySelection = useEffectEvent((panelId: PanelId, mode: "copy" | "cut") => {
    if (!getActiveDirectoryTab(state, panelId)) {
      pushNotification("warning", "当前标签页不支持选择项文件操作。");
      return;
    }
    const selection = getSelectedEntries(state, panelId);
    if (selection.length === 0) {
      pushNotification("warning", "请先选择至少一个项目。");
      return;
    }

    const selectedPaths = selection.map((entry) => entry.path);
    dispatch({ type: "clipboardSet", payload: { mode, paths: selectedPaths } });
    pushNotification("success", `${mode === "copy" ? "已复制" : "已剪切"} ${selectedPaths.length} 项到剪贴板。`);
  });

  const pasteIntoPanel = useEffectEvent(async (panelId: PanelId) => {
    const clipboard = state.clipboard;
    if (!clipboard || clipboard.paths.length === 0) {
      pushNotification("warning", "剪贴板为空。");
      return;
    }

    const activeTab = getActiveDirectoryTab(state, panelId);
    if (!activeTab) {
      pushNotification("warning", "当前标签页不能作为粘贴目标。");
      return;
    }
    const destination = activeTab.snapshot.location.path;
    const sourceParents = Array.from(
      new Set(
        clipboard.paths
          .map((path) => getParentPathForRefresh(path))
          .filter((path): path is string => Boolean(path))
      )
    );

    try {
      const operationOptions = {
        source: "paste" as const,
        panelId,
        tabId: activeTab.id
      };
      const task =
        clipboard.mode === "copy"
          ? await workspaceGateway.copyEntries(clipboard.paths, destination, operationOptions)
          : await workspaceGateway.moveEntries(clipboard.paths, destination, operationOptions);
      if (clipboard.mode === "cut" && task?.status !== "waitingConflict") {
        dispatch({ type: "clipboardSet", payload: undefined });
      }
      await projectOperationResult(task);
      if (!task) {
        const refreshPaths = clipboard.mode === "copy" ? [destination] : [...sourceParents, destination];
        await refreshPanelsForPaths(refreshPaths);
      }
      return;
    } catch (error) {
      pushNotification("danger", error instanceof Error ? error.message : "粘贴失败");
    }
  });

  const saveFavorite = useEffectEvent(async (kind: "bookmark" | "hotlist") => {
    const activeTab = getActiveDirectoryTab(state, state.activePanelId);
    if (!activeTab) {
      pushNotification("warning", "当前标签页不能保存为书签或目录热表。");
      return;
    }
    const defaultLabel = activeTab.snapshot.location.label || activeTab.title;
    const label =
      typeof window === "undefined"
        ? defaultLabel
        : window.prompt(kind === "bookmark" ? "输入书签名称" : "输入目录热表名称", defaultLabel);

    if (!label || !label.trim()) {
      return;
    }

    try {
      const favorites =
        kind === "bookmark"
          ? await workspaceGateway.saveBookmark(activeTab.snapshot.location.path, label.trim())
          : await workspaceGateway.saveHotlist(activeTab.snapshot.location.path, label.trim());
      dispatch({ type: "favoritesUpdated", payload: favorites });
      pushNotification("success", kind === "bookmark" ? "书签已保存。" : "目录热表项已保存。");
    } catch (error) {
      pushNotification("danger", error instanceof Error ? error.message : "无法保存收藏项");
    }
  });

  const deleteFavorite = useEffectEvent(async (kind: "bookmark" | "hotlist", id: string) => {
    try {
      const favorites =
        kind === "bookmark"
          ? await workspaceGateway.deleteBookmark(id)
          : await workspaceGateway.deleteHotlist(id);
      dispatch({ type: "favoritesUpdated", payload: favorites });
      pushNotification("success", kind === "bookmark" ? "书签已移除。" : "目录热表项已移除。");
    } catch (error) {
      pushNotification("danger", error instanceof Error ? error.message : "无法移除收藏项");
    }
  });

  const saveNavigationItem = useEffectEvent(async (item: NavigationItem | NavigationItemUpsertRequest) => {
    if (!item.path.trim()) {
      pushNotification("warning", "导航项路径不能为空。");
      return;
    }
    dispatch({ type: "navigationStatusSet", payload: "saving" });
    try {
      const payload = await workspaceGateway.saveNavigationItem(item);
      dispatch({ type: "navigationItemsUpdated", payload: payload.navigationItems });
      pushNotification("success", "导航项已保存。");
    } catch (error) {
      dispatch({ type: "navigationStatusSet", payload: "idle" });
      pushNotification("danger", getErrorMessage(error, "无法保存导航项。"));
    }
  });

  const deleteNavigationItems = useEffectEvent(async (ids: string[]) => {
    const uniqueIds = Array.from(new Set(ids));
    if (uniqueIds.length === 0) {
      return;
    }
    const confirmed =
      typeof window === "undefined"
        ? true
        : window.confirm("从导航页移除选中的导航项？这只删除导航项配置，不会删除磁盘上的文件或文件夹。");
    if (!confirmed) {
      return;
    }
    dispatch({ type: "navigationStatusSet", payload: "saving" });
    try {
      let latestItems = state.navigation.items;
      for (const id of uniqueIds) {
        const payload = await workspaceGateway.deleteNavigationItem(id);
        latestItems = payload.navigationItems;
      }
      dispatch({ type: "navigationItemsUpdated", payload: latestItems });
      dispatch({ type: "navigationSelectionSet", payload: [] });
      pushNotification("success", "导航项已从导航页移除。");
    } catch (error) {
      dispatch({ type: "navigationStatusSet", payload: "idle" });
      pushNotification("danger", getErrorMessage(error, "无法移除导航项。"));
    }
  });

  const deleteSelectedNavigationItems = useEffectEvent(async () => {
    await deleteNavigationItems(state.navigation.selectedItemIds);
  });

  const reorderNavigationItem = useEffectEvent(async (itemId: string, direction: -1 | 1) => {
    const items = state.navigation.items;
    const index = items.findIndex((item) => item.id === itemId);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= items.length) {
      return;
    }
    const nextItems = [...items];
    const [item] = nextItems.splice(index, 1);
    nextItems.splice(targetIndex, 0, item);
    dispatch({ type: "navigationItemsUpdated", payload: nextItems.map((entry, entryIndex) => ({ ...entry, sortOrder: entryIndex + 1 })) });
    try {
      const payload = await workspaceGateway.reorderNavigationItems(nextItems.map((entry) => entry.id));
      dispatch({ type: "navigationItemsUpdated", payload: payload.navigationItems });
    } catch (error) {
      pushNotification("danger", getErrorMessage(error, "无法保存导航项顺序。"));
    }
  });

  const markNavigationItemOpened = useEffectEvent(async (itemId: string) => {
    try {
      const payload = await workspaceGateway.markNavigationItemOpened(itemId);
      dispatch({ type: "navigationItemsUpdated", payload: payload.navigationItems });
    } catch (error) {
      pushNotification("warning", getErrorMessage(error, "无法更新导航项最近打开时间。"));
    }
  });

  const openNavigationItem = useEffectEvent(async (panelId: PanelId, itemId: string, inBackground = false) => {
    const item = state.navigation.items.find((entry) => entry.id === itemId);
    if (!item) {
      return;
    }
    if (item.targetStatus !== "ok") {
      pushNotification("warning", item.statusMessage || "导航目标缺失或不可访问。");
      await refreshNavigationTargets();
      return;
    }
    if (item.targetKind === "folder") {
      if (inBackground) {
        const previousActiveTabId = state.panels[panelId].activeTabId;
        await handleOpenNewTab(panelId, item.path);
        await markNavigationItemOpened(item.id);
        dispatch({ type: "tabActivated", payload: { panelId, tabId: previousActiveTabId } });
        return;
      }
      await handleOpenNewTab(panelId, item.path);
      await markNavigationItemOpened(item.id);
      return;
    }
    if (item.targetKind === "file") {
      try {
        await workspaceGateway.openPathWithSystemDefault(item.path);
        await markNavigationItemOpened(item.id);
        pushNotification("success", "已使用系统默认方式打开。");
      } catch (error) {
        pushNotification("danger", getErrorMessage(error, "无法使用系统默认方式打开。"));
      }
      return;
    }
    pushNotification("warning", "该导航目标暂不支持打开。");
  });

  const openNavigationItemParent = useEffectEvent(async (panelId: PanelId, itemId: string) => {
    const item = state.navigation.items.find((entry) => entry.id === itemId);
    if (!item) {
      return;
    }
    const infos = await workspaceGateway.resolveNavigationTargets([item.path]);
    const parentPath = infos[0]?.parentPath;
    if (!parentPath) {
      pushNotification("warning", "无法确定导航目标所在文件夹。");
      return;
    }
    await handleOpenNewTab(panelId, parentPath);
  });

  const openNavigationNativeContextMenu = useEffectEvent(async (itemIds: string[], clientX: number, clientY: number, screenX: number, screenY: number) => {
    const paths = itemIds
      .map((id) => state.navigation.items.find((item) => item.id === id)?.path)
      .filter((path): path is string => Boolean(path));
    if (paths.length === 0) {
      return false;
    }
    try {
      const infos = await workspaceGateway.resolveNavigationTargets(paths);
      dispatch({ type: "navigationTargetStatusUpdated", payload: infos });
      const parentKeys = new Set<string>();
      const unavailable = infos.some((info) => {
        if (!info.isLocal || !info.exists || info.targetStatus !== "ok" || !info.parentPath) {
          return true;
        }
        parentKeys.add(normalizeNavigationParentKey(info.parentPath));
        return false;
      });
      if (unavailable || parentKeys.size !== 1) {
        pushNotification("warning", "Windows 文件操作菜单不可用于这些导航目标。");
        void clientX;
        void clientY;
        return false;
      }
      const opened = await workspaceGateway.showNativeContextMenu(paths, screenX, screenY);
      if (!opened) {
        pushNotification("warning", "Windows 文件操作菜单不可用于这些导航目标。");
        void clientX;
        void clientY;
        return false;
      }
      const refreshedInfos = await workspaceGateway.resolveNavigationTargets(paths);
      dispatch({ type: "navigationTargetStatusUpdated", payload: refreshedInfos });
      void clientX;
      void clientY;
      return true;
    } catch (error) {
      pushNotification("warning", getErrorMessage(error, "Windows 文件操作菜单不可用于这些导航目标。"));
      void clientX;
      void clientY;
      return false;
    }
  });

  const addCurrentFolderToNavigation = useEffectEvent(async (folder?: NavigationFolderInput) => {
    const activeTab = folder ? undefined : getActiveDirectoryTab(state, state.activePanelId);
    const folderPath = folder?.path ?? activeTab?.snapshot.location.path;
    if (!folderPath) {
      pushNotification("warning", "当前标签页没有可添加的文件夹路径。");
      return;
    }
    await saveNavigationItem({
      displayName: folder?.displayName ?? activeTab?.snapshot.location.label,
      description: "",
      path: folderPath
    });
  });

  const addSelectedEntriesToNavigation = useEffectEvent(async (panelId: PanelId, entries?: EntryViewModel[]) => {
    const selection = entries ?? getSelectedEntries(state, panelId);
    if (selection.length === 0) {
      pushNotification("warning", "请先选择要添加到导航页的文件或文件夹。");
      return;
    }
    for (const entry of selection) {
      await saveNavigationItem({
        displayName: entry.name,
        description: "",
        path: entry.path
      });
    }
  });

  const deleteSelection = useEffectEvent(async (panelId: PanelId) => {
    if (isNavigationTab(getActiveTab(state.panels[panelId]))) {
      void deleteSelectedNavigationItems();
      return;
    }
    const activeTab = getActiveDirectoryTab(state, panelId);
    if (!activeTab) {
      pushNotification("warning", "当前标签页不支持删除文件。");
      return;
    }
    const selection = getSelectedEntries(state, panelId);
    if (selection.length === 0) {
      pushNotification("warning", "请先选择至少一个项目。");
      return;
    }

    const confirmed = typeof window === "undefined" ? true : window.confirm(`确认删除所选的 ${selection.length} 项吗？`);
    if (!confirmed) {
      return;
    }

    const sourceParents = Array.from(
      new Set(
        selection
          .map((entry) => getParentPathForRefresh(entry.path))
          .filter((path): path is string => Boolean(path))
      )
    );

    try {
      const task = await workspaceGateway.deleteEntries(
        selection.map((entry) => entry.path),
        {
          source: "toolbar",
          panelId,
          tabId: activeTab.id
        }
      );
      await projectOperationResult(task);
      if (!task) {
        await refreshPanelsForPaths(sourceParents.length > 0 ? sourceParents : [activeTab.snapshot.location.path]);
      }
      return;
    } catch (error) {
      pushNotification("danger", error instanceof Error ? error.message : "删除失败");
    }
  });

  const renameSelection = useEffectEvent((panelId: PanelId) => {
    if (isNavigationTab(getActiveTab(state.panels[panelId]))) {
      const selectedId = state.navigation.selectedItemIds[0];
      const selectedItem = state.navigation.items.find((item) => item.id === selectedId);
      if (selectedItem) {
        void saveNavigationItem({
          ...selectedItem,
          displayName:
            typeof window === "undefined"
              ? selectedItem.displayName
              : window.prompt("编辑导航项名称", selectedItem.displayName) ?? selectedItem.displayName
        });
      }
      return;
    }
    const activeTab = getActiveDirectoryTab(state, panelId);
    if (!activeTab) {
      pushNotification("warning", "当前标签页不支持重命名文件。");
      return;
    }
    const selection = getSelectedEntries(state, panelId);
    if (selection.length !== 1) {
      pushNotification("warning", "请选择一个项目进行重命名。");
      return;
    }

    const [entry] = selection;
    dispatch({
      type: "inlineEditStarted",
      payload: {
        panelId,
        tabId: activeTab.id,
        edit: {
          mode: "rename",
          value: entry.name,
          kind: entry.kind,
          parentPath: entry.parentPath,
          entryId: entry.id,
          originalName: entry.name,
          originalPath: entry.path
        }
      }
    });
  });

  const createFolder = useEffectEvent((panelId: PanelId) => {
    const activeTab = getActiveDirectoryTab(state, panelId);
    if (!activeTab) {
      pushNotification("warning", "当前标签页不能新建文件夹。");
      return;
    }
    dispatch({
      type: "inlineEditStarted",
      payload: {
        panelId,
        tabId: activeTab.id,
        edit: {
          mode: "create-folder",
          value: "新建文件夹",
          kind: "folder",
          parentPath: activeTab.snapshot.location.path
        }
      }
    });
  });

  const createFile = useEffectEvent((panelId: PanelId) => {
    const activeTab = getActiveDirectoryTab(state, panelId);
    if (!activeTab) {
      pushNotification("warning", "当前标签页不能新建文件。");
      return;
    }
    dispatch({
      type: "inlineEditStarted",
      payload: {
        panelId,
        tabId: activeTab.id,
        edit: {
          mode: "create-file",
          value: "新建文件.txt",
          kind: "file",
          parentPath: activeTab.snapshot.location.path
        }
      }
    });
  });

  const updateInlineEdit = useEffectEvent((panelId: PanelId, tabId: string, value: string) => {
    dispatch({ type: "inlineEditChanged", payload: { panelId, tabId, value } });
  });

  const cancelInlineEdit = useEffectEvent((panelId: PanelId, tabId: string) => {
    dispatch({ type: "inlineEditCanceled", payload: { panelId, tabId } });
  });

  const commitInlineEdit = useEffectEvent(async (panelId: PanelId, tabId: string, value?: string) => {
    const tab = findTab(state, panelId, tabId);
    const edit = tab?.inlineEdit;
    if (!edit) {
      return;
    }

    const nextName = (value ?? edit.value).trim();
    if (!nextName || (edit.mode === "rename" && nextName === edit.originalName)) {
      dispatch({ type: "inlineEditCanceled", payload: { panelId, tabId } });
      return;
    }

    try {
      if (edit.mode === "create-folder") {
        const task = await workspaceGateway.createDirectory(edit.parentPath, nextName, {
          source: "inlineEdit",
          panelId,
          tabId
        });
        dispatch({ type: "inlineEditCanceled", payload: { panelId, tabId } });
        await projectOperationResult(task);
        if (!task) {
          await refreshPanelsForPaths([edit.parentPath]);
        }
        return;
      }

      if (edit.mode === "create-file") {
        const task = await workspaceGateway.createFile(edit.parentPath, nextName, {
          source: "inlineEdit",
          panelId,
          tabId
        });
        dispatch({ type: "inlineEditCanceled", payload: { panelId, tabId } });
        await projectOperationResult(task);
        if (!task) {
          await refreshPanelsForPaths([edit.parentPath]);
        }
        return;
      }

      if (edit.originalPath) {
        const task = await workspaceGateway.renameEntry(edit.originalPath, nextName, {
          source: "inlineEdit",
          panelId,
          tabId
        });
        dispatch({ type: "inlineEditCanceled", payload: { panelId, tabId } });
        await projectOperationResult(task);
        if (!task) {
          await refreshPanelsForPaths([edit.parentPath]);
        }
        return;
      }
    } catch (error) {
      pushNotification(
        "danger",
        error instanceof Error
          ? error.message
          : edit.mode === "create-folder"
            ? "无法创建文件夹"
            : edit.mode === "create-file"
              ? "无法创建文件"
              : "重命名失败"
      );
    }
  });

  const saveRemoteProfile = useEffectEvent(async (profile: RemoteConnectionProfile, password?: string) => {
    try {
      const payload = await workspaceGateway.saveRemoteProfile(profile, password);
      dispatch({ type: "remoteProfilesUpdated", payload: payload.remoteProfiles });
      pushNotification("success", `远程连接“${profile.name}”已保存。`);
    } catch (error) {
      pushNotification("danger", error instanceof Error ? error.message : "无法保存远程连接");
      throw error;
    }
  });

  const testRemoteProfile = useEffectEvent(async (profile: RemoteConnectionProfile, password?: string) => {
    try {
      const result = await workspaceGateway.testRemoteProfile(profile, password);
      pushNotification(result.success ? "success" : "warning", result.message);
      for (const detail of result.details) {
        pushNotification(result.success ? "info" : "warning", detail);
      }
    } catch (error) {
      pushNotification("danger", error instanceof Error ? error.message : "远程连接测试失败");
    }
  });

  const deleteRemoteProfile = useEffectEvent(async (id: string) => {
    try {
      const payload = await workspaceGateway.deleteRemoteProfile(id);
      dispatch({ type: "remoteProfilesUpdated", payload: payload.remoteProfiles });
      pushNotification("success", "远程连接已删除。");
    } catch (error) {
      pushNotification("danger", error instanceof Error ? error.message : "无法删除远程连接");
      throw error;
    }
  });

  const closeTabGuarded = useEffectEvent(async (panelId: PanelId, tabId: string) => {
    const panel = state.panels[panelId];
    const tab = panel.tabs.find((item) => item.id === tabId);
    if (!tab || tab.locked) {
      return;
    }
    if (!isNavigationTab(tab) || panel.tabs.length > 1) {
      dispatch({ type: "tabClosed", payload: { panelId, tabId } });
      return;
    }

    try {
      await handleOpenNewTab(panelId, getFallbackDirectoryPath(state, panelId));
      dispatch({ type: "tabClosed", payload: { panelId, tabId } });
    } catch (error) {
      pushNotification("danger", getErrorMessage(error, "无法关闭唯一导航页，因为后备目录无法打开。"));
    }
  });

  const moveTabGuarded = useEffectEvent(async (sourcePanelId: PanelId, targetPanelId: PanelId, tabId: string, targetIndex: number) => {
    const sourcePanel = state.panels[sourcePanelId];
    const targetPanel = state.panels[targetPanelId];
    const tab = sourcePanel.tabs.find((item) => item.id === tabId);
    if (!tab) {
      return;
    }

    if (isNavigationTab(tab) && sourcePanelId !== targetPanelId && targetPanel.tabs.some(isNavigationTab)) {
      return;
    }

    if (isNavigationTab(tab) && sourcePanelId !== targetPanelId && sourcePanel.tabs.length === 1) {
      try {
        await handleOpenNewTab(sourcePanelId, getFallbackDirectoryPath(state, sourcePanelId));
      } catch (error) {
        pushNotification("danger", getErrorMessage(error, "无法移动唯一导航页，因为后备目录无法打开。"));
        return;
      }
    }

    dispatch({ type: "tabMoved", payload: { sourcePanelId, targetPanelId, tabId, targetIndex } });
  });

  const openNativeContextMenu = useEffectEvent(async (request: NativeContextMenuRequest) => {
    dispatch({ type: "contextMenuSet", payload: undefined });

    if (request.paths.length === 0 || request.paths.some((path) => isRemotePath(path))) {
      dispatch({
        type: "contextMenuSet",
        payload: {
          x: request.clientX,
          y: request.clientY,
          panelId: request.panelId,
          tabId: request.tabId,
          mode: "system-fallback",
          scope: "selection"
        }
      });
      return;
    }

    const opened = await workspaceGateway.showNativeContextMenu(request.paths, request.screenX, request.screenY);
    if (!opened) {
      dispatch({
        type: "contextMenuSet",
        payload: {
          x: request.clientX,
          y: request.clientY,
          panelId: request.panelId,
          tabId: request.tabId,
          mode: "system-fallback",
          scope: "selection"
        }
      });
    }
  });

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) {
        return false;
      }
      return (
        target.isContentEditable ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT"
      );
    };

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      const editable = isEditableTarget(event.target);
      const eventBinding = eventToShortcutBinding(event);
      const shortcuts = getShortcutBindingMap(state.settings.model.shortcuts);

      if (shortcutMatches(shortcuts, "undo", eventBinding) && !editable && !state.operations.conflictDialog) {
        event.preventDefault();
        void undoLatestOperation();
        return;
      }

      if (shortcutMatches(shortcuts, "focus-next-panel", eventBinding) && !editable) {
        event.preventDefault();
        dispatch({ type: "focusNextPanel" });
        return;
      }

      if (shortcutMatches(shortcuts, "open-search", eventBinding) && !editable) {
        event.preventDefault();
        dispatch({ type: "searchToggled", payload: true });
        return;
      }

      if (shortcutMatches(shortcuts, "new-tab", eventBinding) && !editable) {
        event.preventDefault();
        void handleOpenNewTab(state.activePanelId);
        return;
      }

      if (shortcutMatches(shortcuts, "close-tab", eventBinding) && !editable) {
        event.preventDefault();
        const activePanel = state.panels[state.activePanelId];
        void closeTabGuarded(state.activePanelId, getActiveTab(activePanel).id);
        return;
      }

      if (shortcutMatches(shortcuts, "copy", eventBinding) && !editable) {
        event.preventDefault();
        copySelection(state.activePanelId, "copy");
        return;
      }

      if (shortcutMatches(shortcuts, "cut", eventBinding) && !editable) {
        event.preventDefault();
        copySelection(state.activePanelId, "cut");
        return;
      }

      if (shortcutMatches(shortcuts, "paste", eventBinding) && !editable) {
        event.preventDefault();
        void pasteIntoPanel(state.activePanelId);
        return;
      }

      if (shortcutMatches(shortcuts, "create-folder", eventBinding) && !editable) {
        event.preventDefault();
        void createFolder(state.activePanelId);
        return;
      }

      if (shortcutMatches(shortcuts, "delete", eventBinding) && !editable) {
        event.preventDefault();
        void deleteSelection(state.activePanelId);
        return;
      }

      if (shortcutMatches(shortcuts, "rename", eventBinding) && !editable) {
        event.preventDefault();
        void renameSelection(state.activePanelId);
        return;
      }

      if (shortcutMatches(shortcuts, "refresh", eventBinding) && !editable) {
        event.preventDefault();
        void refreshPanel(state.activePanelId);
        return;
      }

      if (event.altKey && event.key === "ArrowLeft") {
        event.preventDefault();
        const activeTab = getActiveTab(state.panels[state.activePanelId]);
        if (isNavigationTab(activeTab)) {
          return;
        }
        const targetHistoryIndex = activeTab.historyIndex - 1;
        const targetPath = activeTab.history[targetHistoryIndex];
        if (targetPath) {
          void commitNavigation(state.activePanelId, targetPath, false, {
            tabId: activeTab.id,
            historyIndex: targetHistoryIndex
          });
        }
        return;
      }

      if (shortcutMatches(shortcuts, "navigate-forward", eventBinding) && !editable) {
        event.preventDefault();
        navigateHistoryByDelta(state.activePanelId, 1);
        return;
      }

      if (shortcutMatches(shortcuts, "navigate-up", eventBinding) && !editable) {
        event.preventDefault();
        navigateUpKeepingForwardHistory(state.activePanelId);
      }
    };

    window.addEventListener("keydown", handleWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  }, [
    commitNavigation,
    closeTabGuarded,
    copySelection,
    createFolder,
    deleteSelection,
    handleOpenNewTab,
    navigateHistoryByDelta,
    navigateUpKeepingForwardHistory,
    pasteIntoPanel,
    refreshPanel,
    renameSelection,
    state,
    undoLatestOperation
  ]);

  const actions = useMemo(
    () => ({
      setLayoutMode: (layoutMode: WorkspaceState["layoutMode"]) =>
        dispatch({ type: "layoutModeSet", payload: layoutMode }),
      setSplitRatio: (key: keyof WorkspaceState["layoutRatios"], value: number) =>
        dispatch({ type: "splitRatioSet", payload: { key, value } }),
      focusPanel: (panelId: PanelId) => dispatch({ type: "panelFocused", payload: { panelId } }),
      focusNextPanel: () => dispatch({ type: "focusNextPanel" }),
      activateTab: (panelId: PanelId, tabId: string) =>
        dispatch({ type: "tabActivated", payload: { panelId, tabId } }),
      closeTab: (panelId: PanelId, tabId: string) => void closeTabGuarded(panelId, tabId),
      closeOtherTabs: (panelId: PanelId, tabId: string, includeLocked = false) =>
        dispatch({ type: "otherTabsClosed", payload: { panelId, tabId, includeLocked } }),
      toggleTabLock: (panelId: PanelId, tabId: string) =>
        dispatch({ type: "tabLockedToggled", payload: { panelId, tabId } }),
      renameTab: (panelId: PanelId, tabId: string, title: string) =>
        dispatch({ type: "tabTitleRenamed", payload: { panelId, tabId, title } }),
      moveTab: (sourcePanelId: PanelId, targetPanelId: PanelId, tabId: string, targetIndex: number) =>
        void moveTabGuarded(sourcePanelId, targetPanelId, tabId, targetIndex),
      copyTabPath: (panelId: PanelId, tabId: string) => {
        const tab = state.panels[panelId].tabs.find((item) => item.id === tabId);
        if (isNavigationTab(tab)) {
          pushNotification("warning", "导航页没有可复制的文件系统路径。");
          return;
        }
        const path = tab?.snapshot.location.path;
        if (!path) {
          return;
        }
        void navigator.clipboard?.writeText(path).catch(() => undefined);
        dispatch({ type: "clipboardSet", payload: { mode: "copy", paths: [path] } });
        pushNotification("success", "路径已复制。");
      },
      openNewTab: (panelId: PanelId, path?: string) => void handleOpenNewTab(panelId, path),
      updateAddressDraft: (panelId: PanelId, tabId: string, value: string) => {
        if (isNavigationTab(findTab(state, panelId, tabId))) {
          return;
        }
        dispatch({ type: "addressDraftChanged", payload: { panelId, tabId, value } });
      },
      submitAddress: (panelId: PanelId, path: string) => {
        if (isNavigationTab(getActiveTab(state.panels[panelId]))) {
          return;
        }
        void commitNavigation(panelId, path);
      },
      navigateToPath: (panelId: PanelId, path: string, pushHistory = true) =>
        void commitNavigation(panelId, path, pushHistory),
      navigateBreadcrumbPath: (panelId: PanelId, path: string) => navigateBreadcrumbPath(panelId, path),
      navigateHistory: (panelId: PanelId, delta: -1 | 1) => navigateHistoryByDelta(panelId, delta),
      navigateUp: (panelId: PanelId) => navigateUpKeepingForwardHistory(panelId),
      toggleTreeNode: (panelId: PanelId, tabId: string, path: string, expand: boolean) => void loadTreeChildren(panelId, tabId, path, expand),
      openTreeNode: (panelId: PanelId, path: string, kind: DirectoryNode["kind"]) => openTreeNode(panelId, path, kind),
      selectEntry: (panelId: PanelId, tabId: string, entryId: string, multi: boolean) =>
        dispatch({ type: "entrySelectionChanged", payload: { panelId, tabId, entryId, multi } }),
      selectMultipleEntries: (panelId: PanelId, tabId: string, entryIds: string[]) => {
        devLog("[useWorkspaceController] selectMultipleEntries called with:", entryIds);
        dispatch({ type: "entrySelectionSet", payload: { panelId, tabId, entryIds } });
      },
      selectAllEntries: (panelId: PanelId, tabId: string) => {
        devLog("[useWorkspaceController] selectAllEntries called for panelId:", panelId, "tabId:", tabId);
        dispatch({ type: "allEntriesSelected", payload: { panelId, tabId } });
      },
      selectEntryRange: (panelId: PanelId, tabId: string, fromEntryId: string, toEntryId: string) => {
        devLog("[useWorkspaceController] selectEntryRange called from:", fromEntryId, "to:", toEntryId);
        dispatch({ type: "entryRangeSelected", payload: { panelId, tabId, fromEntryId, toEntryId } });
      },
      clearSelection: (panelId: PanelId, tabId: string) => {
        devLog("[useWorkspaceController] clearSelection called for panelId:", panelId, "tabId:", tabId);
        dispatch({ type: "entrySelectionCleared", payload: { panelId, tabId } });
      },
      sortEntries: (panelId: PanelId, tabId: string, columnId: ColumnId) =>
        dispatch({ type: "tabSortChanged", payload: { panelId, tabId, columnId } }),
      setTabViewMode: (panelId: PanelId, tabId: string, viewMode: TabViewMode) =>
        dispatch({ type: "tabViewModeSet", payload: { panelId, tabId, viewMode } }),
      openEntry: (panelId: PanelId, entry: EntryViewModel) => {
        if (isNavigationTab(getActiveTab(state.panels[panelId]))) {
          return;
        }
        if (entry.kind === "folder") {
          void commitNavigation(panelId, entry.path);
          return;
        }
        void (async () => {
          try {
            await workspaceGateway.openPathWithSystemDefault(entry.path);
          } catch (error) {
            pushNotification("danger", getErrorMessage(error, "无法使用系统默认方式打开。"));
          }
        })();
      },
      dropEntries: (paths: string[], destination: string, operation: "copy" | "move") =>
        dropEntries(paths, destination, operation),
      openBookmark: (path: string, inNewTab = false) => {
        if (inNewTab) {
          void handleOpenNewTab(state.activePanelId, path);
          return;
        }
        if (isNavigationTab(getActiveTab(state.panels[state.activePanelId]))) {
          void handleOpenNewTab(state.activePanelId, path);
          return;
        }
        void commitNavigation(state.activePanelId, path);
      },
      openNavigationTab: () => dispatch({ type: "navigationTabOpened", payload: { panelId: state.activePanelId } }),
      closeNavigationTab: () => {
        const navigation = Object.values(state.panels)
          .flatMap((panel) => panel.tabs.map((tab) => ({ panelId: panel.id, tab })))
          .find((item) => item.tab.kind === "navigation");
        if (navigation) {
          void closeTabGuarded(navigation.panelId, navigation.tab.id);
        }
      },
      saveNavigationItem: (item: NavigationItem | NavigationItemUpsertRequest) => void saveNavigationItem(item),
      deleteNavigationItems: (ids: string[]) => void deleteNavigationItems(ids),
      reorderNavigationItem: (itemId: string, direction: -1 | 1) => void reorderNavigationItem(itemId, direction),
      selectNavigationItem: (itemId: string, multi = false) =>
        dispatch({ type: "navigationItemSelectionChanged", payload: { itemId, multi } }),
      setNavigationSelection: (itemIds: string[]) => dispatch({ type: "navigationSelectionSet", payload: itemIds }),
      setNavigationFilter: (value: string) => dispatch({ type: "navigationFilterChanged", payload: value }),
      refreshNavigationTargets: () => void refreshNavigationTargets(),
      openNavigationItem: (panelId: PanelId, itemId: string, inBackground = false) =>
        void openNavigationItem(panelId, itemId, inBackground),
      openNavigationItemParent: (panelId: PanelId, itemId: string) => void openNavigationItemParent(panelId, itemId),
      openNavigationNativeContextMenu: (itemIds: string[], clientX: number, clientY: number, screenX: number, screenY: number) =>
        openNavigationNativeContextMenu(itemIds, clientX, clientY, screenX, screenY),
      addCurrentFolderToNavigation: (folder?: NavigationFolderInput) => void addCurrentFolderToNavigation(folder),
      addSelectedEntriesToNavigation: (panelId: PanelId, entries?: EntryViewModel[]) =>
        void addSelectedEntriesToNavigation(panelId, entries),
      setInformationPanelExpanded: (expanded: boolean) =>
        dispatch({ type: "informationPanelExpandedSet", payload: expanded }),
      selectInformationPanelTab: (tab: WorkspaceState["informationPanel"]["activeTab"]) =>
        dispatch({ type: "informationPanelTabChanged", payload: tab }),
      openOperationHistory: () => dispatch({ type: "informationPanelHistoryRequested" }),
      toggleSearch: (open?: boolean) => dispatch({ type: "searchToggled", payload: open }),
      selectSearchTab: (tab: WorkspaceState["search"]["activeTab"]) =>
        dispatch({ type: "searchTabChanged", payload: tab }),
      updateSearchQuery: (payload: Partial<WorkspaceState["search"]["query"]>) =>
        dispatch({ type: "searchQueryChanged", payload }),
      updateSearchFilter: (value: string) => dispatch({ type: "searchFilterChanged", payload: value }),
      selectSearchHistory: (index: number) => dispatch({ type: "searchHistorySelected", payload: { index } }),
      deleteSearchHistory: (index: number) => dispatch({ type: "searchHistoryDeleted", payload: { index } }),
      runSearch: () => void runSearch(),
      stopSearch: () => void stopSearch(),
      setSettingsSection: (section: SettingsSection) => dispatch({ type: "settingsSectionSet", payload: section }),
      applySettingsModel: (model: SettingsModel, section?: SettingsSection) => applySettingsModel(model, section),
      updateShortcutBinding: (id: string, binding: string) =>
        dispatch({ type: "shortcutBindingUpdated", payload: { id, binding } }),
      updateColorRule: (id: string, color: string) =>
        dispatch({ type: "colorRuleUpdated", payload: { id, color } }),
      updateTagRule: (id: string, quickFilter: string) =>
        dispatch({ type: "tagRuleUpdated", payload: { id, quickFilter } }),
      updatePanelFocusAccent: (color: string) =>
        dispatch({ type: "themePanelFocusAccentSet", payload: { color } }),
      updateTabMinWidth: (value: number) =>
        dispatch({ type: "themeTabMinWidthSet", payload: { value } }),
      toggleColumnVisibility: (id: string) => dispatch({ type: "columnVisibilityToggled", payload: { id } }),
      setColumnWidth: (panelId: PanelId, tabId: string, id: ColumnId, width: string) =>
        dispatch({ type: "columnWidthSet", payload: { panelId, tabId, id, width } }),
      setDetailsRowHeight: (value: number) => dispatch({ type: "detailsRowHeightSet", payload: { value } }),
      setOperationTasksOpen: (open: boolean) => dispatch({ type: "operationTasksOpenSet", payload: open }),
      cancelOperation: (taskId: string) => void cancelOperation(taskId),
      undoLatestOperation: () => void undoLatestOperation(),
      undoOperation: (recordId: string) => void undoOperation(recordId),
      resolveOperationConflict: () => void resolveOperationConflict(),
      updateOperationConflictDialog: (
        payload: Partial<
          Pick<
            NonNullable<WorkspaceState["operations"]["conflictDialog"]>,
            "selectedResolution" | "renameValue" | "applyToAll" | "resolving"
          >
        >
      ) => dispatch({ type: "operationConflictDialogChanged", payload }),
      closeOperationConflictDialog: () => dispatch({ type: "operationConflictDialogClosed" }),
      copySelection: (panelId: PanelId) => copySelection(panelId, "copy"),
      cutSelection: (panelId: PanelId) => copySelection(panelId, "cut"),
      pasteIntoPanel: (panelId: PanelId) => void pasteIntoPanel(panelId),
      deleteSelection: (panelId: PanelId) => void deleteSelection(panelId),
      renameSelection: (panelId: PanelId) => void renameSelection(panelId),
      createFolder: (panelId: PanelId) => void createFolder(panelId),
      createFile: (panelId: PanelId) => void createFile(panelId),
      updateInlineEdit: (panelId: PanelId, tabId: string, value: string) => updateInlineEdit(panelId, tabId, value),
      commitInlineEdit: (panelId: PanelId, tabId: string, value?: string) => void commitInlineEdit(panelId, tabId, value),
      cancelInlineEdit: (panelId: PanelId, tabId: string) => cancelInlineEdit(panelId, tabId),
      refreshPanel: (panelId: PanelId) => void refreshPanel(panelId),
      reconnectTab: (panelId: PanelId, tabId: string) => reconnectTab(panelId, tabId),
      saveCurrentAsBookmark: () => void saveFavorite("bookmark"),
      saveCurrentAsHotlist: () => void saveFavorite("hotlist"),
      deleteBookmark: (id: string) => void deleteFavorite("bookmark", id),
      deleteHotlist: (id: string) => void deleteFavorite("hotlist", id),
      saveRemoteProfile: (profile: RemoteConnectionProfile, password?: string) => saveRemoteProfile(profile, password),
      deleteRemoteProfile: (id: string) => deleteRemoteProfile(id),
      testRemoteProfile: (profile: RemoteConnectionProfile, password?: string) => void testRemoteProfile(profile, password),
      openContextMenu: (payload: ContextMenuState) => dispatch({ type: "contextMenuSet", payload }),
      openNativeContextMenu: (payload: NativeContextMenuRequest) => void openNativeContextMenu(payload),
      closeContextMenu: () => dispatch({ type: "contextMenuSet", payload: undefined }),
      dismissNotification: (id: string) => dispatch({ type: "notificationDismissed", payload: { id } })
    }),
    [
      addCurrentFolderToNavigation,
      addSelectedEntriesToNavigation,
      applySettingsModel,
      cancelOperation,
      closeTabGuarded,
      commitInlineEdit,
      commitNavigation,
      copySelection,
      createFile,
      createFolder,
      deleteNavigationItems,
      deleteRemoteProfile,
      deleteSelection,
      dispatch,
      dropEntries,
      handleOpenNewTab,
      moveTabGuarded,
      navigateBreadcrumbPath,
      navigateHistoryByDelta,
      navigateUpKeepingForwardHistory,
      openNavigationItem,
      openNavigationItemParent,
      openNavigationNativeContextMenu,
      openNativeContextMenu,
      openTreeNode,
      pasteIntoPanel,
      pushNotification,
      refreshNavigationTargets,
      refreshPanel,
      reconnectTab,
      renameSelection,
      reorderNavigationItem,
      runSearch,
      saveNavigationItem,
      saveRemoteProfile,
      state,
      stopSearch,
      testRemoteProfile,
      undoLatestOperation,
      undoOperation,
      workspaceGateway
    ]
  );

  return {
    state,
    actions
  };
}

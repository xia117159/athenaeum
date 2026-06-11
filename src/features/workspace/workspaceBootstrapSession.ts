import type { RemoteProfile as BackendRemoteProfile } from "../../app/types";
import { createRemoteRootUri } from "./remoteUri";
import { resolveWorkspaceDirectory } from "./workspaceDirectoryGateway";
import type { PersistedTab, PersistedWorkspaceSession } from "./workspaceSessionStore";
import { normalizeLayoutRatios } from "./workspaceSessionStore";
import {
  createPanelState,
  createTabFromSnapshot,
  labelFromPath,
  normalizeSettingsModel,
  PANEL_IDS
} from "./workspaceMappers";
import type { DirectorySnapshot, PanelId, TabState, WorkspaceBootstrap } from "./types";
import { createNavigationTab, isNavigationTab, NAVIGATION_VIRTUAL_PATH } from "./workspaceTabs";

export type WorkspaceDirectoryResolver = (
  path: string,
  profiles: BackendRemoteProfile[]
) => Promise<DirectorySnapshot>;

const defaultResolveDirectory: WorkspaceDirectoryResolver = (path, profiles) => resolveWorkspaceDirectory(path, profiles);

function isRemotePath(path: string) {
  return path.startsWith("ftp://") || path.startsWith("sftp://");
}

function remoteKindFromPath(path: string) {
  return path.startsWith("ftp://") ? "ftp" : "sftp";
}

function createRemoteReconnectSnapshot(path: string, profiles: BackendRemoteProfile[]): DirectorySnapshot {
  const matchedProfile = profiles.find((profile) => path === createRemoteRootUri(profile) || path.startsWith(`${createRemoteRootUri(profile).replace(/\/$/, "")}/`));
  return {
    location: {
      kind: remoteKindFromPath(path),
      label: matchedProfile?.name ?? labelFromPath(path),
      path,
      subtitle: matchedProfile ? `${matchedProfile.protocol.toUpperCase()} · ${matchedProfile.host}:${matchedProfile.port}` : "远程位置"
    },
    breadcrumbs: [
      {
        id: matchedProfile ? createRemoteRootUri(matchedProfile) : path,
        label: matchedProfile?.name ?? labelFromPath(path),
        path: matchedProfile ? createRemoteRootUri(matchedProfile) : path
      }
    ],
    entries: []
  };
}

function createReconnectTab(
  tab: PersistedTab,
  profiles: BackendRemoteProfile[],
  message?: string
): TabState {
  const snapshot = createRemoteReconnectSnapshot(tab.path, profiles);
  const profileId = profiles.find((profile) => tab.path === createRemoteRootUri(profile) || tab.path.startsWith(`${createRemoteRootUri(profile).replace(/\/$/, "")}/`))?.id;
  return createTabFromSnapshot(snapshot, tab.id, {
    title: tab.titleOverride ?? tab.title,
    titleOverride: tab.titleOverride,
    locked: tab.locked,
    history: tab.history.length > 0 ? tab.history : [tab.path],
    historyIndex: tab.historyIndex,
    expandedNodePaths: tab.expandedNodePaths.length > 0 ? tab.expandedNodePaths : snapshot.breadcrumbs.map((breadcrumb) => breadcrumb.path),
    viewMode: tab.viewMode,
    sort: tab.sort,
    columns: tab.columns,
    status: "reconnect-required",
    reconnect: {
      path: tab.path,
      profileId,
      message
    }
  });
}

export async function hydratePanels(
  base: WorkspaceBootstrap,
  seedPaths: string[],
  profiles: BackendRemoteProfile[],
  resolveDirectory: WorkspaceDirectoryResolver = defaultResolveDirectory
) {
  const panels = { ...base.panels };
  const uniquePaths = seedPaths.filter((path, index) => path && seedPaths.indexOf(path) === index);
  const snapshots = await Promise.allSettled(
    uniquePaths.map(async (path, index) => ({
      panelId: PANEL_IDS[index],
      snapshot: await resolveDirectory(path, profiles)
    }))
  );

  for (const result of snapshots) {
    if (result.status === "rejected") {
      continue;
    }

    const item = result.value;
    if (!item.panelId) {
      continue;
    }
    panels[item.panelId] = createPanelState(
      item.panelId,
      panels[item.panelId].label,
      item.snapshot,
      `${item.panelId}-tab-1`,
      base.settingsModel.columns
    );
  }

  return {
    ...base,
    panels
  };
}

export async function reviveTab(
  tab: PersistedTab,
  fallback: DirectorySnapshot,
  profiles: BackendRemoteProfile[],
  resolveDirectory: WorkspaceDirectoryResolver = defaultResolveDirectory
) {
  if (tab.kind === "navigation" || tab.path === NAVIGATION_VIRTUAL_PATH || tab.virtualPath === NAVIGATION_VIRTUAL_PATH) {
    return {
      ...createNavigationTab(tab.id),
      locked: tab.locked
    };
  }

  if (isRemotePath(tab.path)) {
    return createReconnectTab(tab, profiles);
  }

  try {
    const snapshot = await resolveDirectory(tab.path, profiles);
    const history = tab.history.length > 0 ? tab.history.map((item) => item) : [snapshot.location.path];
    return createTabFromSnapshot(snapshot, tab.id, {
      title: tab.titleOverride ?? tab.title,
      titleOverride: tab.titleOverride,
      locked: tab.locked,
      history,
      historyIndex: tab.historyIndex,
      expandedNodePaths: tab.expandedNodePaths,
      viewMode: tab.viewMode,
      sort: tab.sort,
      columns: tab.columns
    });
  } catch (error) {
    if (isRemotePath(tab.path)) {
      return createReconnectTab(tab, profiles, error instanceof Error ? error.message : undefined);
    }

    return createTabFromSnapshot(fallback, tab.id, {
      title: tab.titleOverride ?? tab.title,
      titleOverride: tab.titleOverride,
      locked: tab.locked,
      history: [fallback.location.path],
      historyIndex: 0,
      expandedNodePaths: tab.expandedNodePaths,
      viewMode: tab.viewMode,
      sort: tab.sort,
      columns: tab.columns
    });
  }
}

function removeDuplicateTabs<T extends { id: string }>(tabs: T[]) {
  const seen = new Set<string>();
  return tabs.filter((tab) => {
    if (seen.has(tab.id)) {
      return false;
    }
    seen.add(tab.id);
    return true;
  });
}

function dedupeNavigationTabsAcrossPanels(
  panels: WorkspaceBootstrap["panels"],
  activePanelId: PanelId
): WorkspaceBootstrap["panels"] {
  const navigationTabs = PANEL_IDS.flatMap((panelId) =>
    panels[panelId].tabs.filter(isNavigationTab).map((tab) => ({ panelId, tab }))
  );
  if (navigationTabs.length <= 1) {
    return panels;
  }

  const keeper =
    navigationTabs.find((item) => item.panelId === activePanelId && panels[item.panelId].activeTabId === item.tab.id) ??
    navigationTabs.find((item) => item.panelId === activePanelId) ??
    navigationTabs[0];

  const nextPanels = { ...panels };
  for (const panelId of PANEL_IDS) {
    const panel = panels[panelId];
    const tabs = panel.tabs.filter((tab) => tab.kind !== "navigation" || (panelId === keeper.panelId && tab.id === keeper.tab.id));
    nextPanels[panelId] = {
      ...panel,
      tabs,
      activeTabId: tabs.some((tab) => tab.id === panel.activeTabId) ? panel.activeTabId : tabs[0]?.id ?? panel.activeTabId
    };
  }
  return nextPanels;
}

function getVisiblePanelIds(layoutMode: WorkspaceBootstrap["layoutMode"]): PanelId[] {
  switch (layoutMode) {
    case "single":
      return ["panel-1"];
    case "dual":
      return ["panel-1", "panel-2"];
    case "triple":
      return ["panel-1", "panel-2", "panel-3"];
    case "quad":
    default:
      return PANEL_IDS;
  }
}

export async function mergeBootstrapWithSession(
  base: WorkspaceBootstrap,
  session: PersistedWorkspaceSession | null,
  profiles: BackendRemoteProfile[],
  resolveDirectory: WorkspaceDirectoryResolver = defaultResolveDirectory
) {
  if (!session) {
    return base;
  }

  const panels = { ...base.panels };
  for (const panelId of PANEL_IDS) {
    const persistedPanel = session.panels[panelId];
    if (!persistedPanel || persistedPanel.tabs.length === 0) {
      continue;
    }

    const fallbackSnapshot = base.panels[panelId].tabs[0].snapshot;
    const restoredTabs = await Promise.all(
      persistedPanel.tabs.map((tab) => reviveTab(tab, fallbackSnapshot, profiles, resolveDirectory))
    );
    const tabs = removeDuplicateTabs(restoredTabs);
    if (tabs.length === 0) {
      continue;
    }
    const activeTabId = tabs.some((tab) => tab.id === persistedPanel.activeTabId) ? persistedPanel.activeTabId : tabs[0].id;
    panels[panelId] = {
      ...panels[panelId],
      tabs,
      activeTabId
    };
  }
  const visiblePanelIds = getVisiblePanelIds(session.layoutMode);
  const activePanelId = visiblePanelIds.includes(session.activePanelId) ? session.activePanelId : visiblePanelIds[0];

  const dedupedPanels = dedupeNavigationTabsAcrossPanels(panels, activePanelId);

  return {
    ...base,
    layoutMode: session.layoutMode,
    layoutRatios: normalizeLayoutRatios(session.layoutRatios),
    activePanelId,
    panels: dedupedPanels,
    settingsModel: normalizeSettingsModel(session.settingsModel)
  };
}

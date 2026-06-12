import type {
  ColumnId,
  ColumnDefinition,
  DirectoryNode,
  DirectorySnapshot,
  InlineEditState,
  NavigationItem,
  NavigationTargetInfo,
  OperationConflictRequest,
  OperationHistoryRecord,
  OperationTaskSnapshot,
  PanelId,
  PanelLayoutMode,
  PanelState,
  RemoteConnectionProfile,
  SearchQuery,
  SearchProgressState,
  SearchResult,
  SearchTabId,
  SearchTabState,
  SettingsSection,
  SettingsModel,
  TabState,
  TabViewMode,
  WorkspaceBootstrap,
  WorkspaceState
} from "./types";
import { normalizeLocationPath } from "./mockData";
import { cloneColumns, normalizeSettingsModel, normalizeTabMinWidth, normalizeThemeAccentColor } from "./workspaceMappers";
import { devLog } from "./devLog";
import {
  createNavigationTab,
  isDirectoryLikeTab,
  isNavigationTab,
  NAVIGATION_TAB_ID
} from "./workspaceTabs";

export { createNavigationTab, isDirectoryLikeTab, isNavigationTab, NAVIGATION_VIRTUAL_PATH } from "./workspaceTabs";

export type WorkspaceAction =
  | { type: "bootstrapLoaded"; payload: WorkspaceBootstrap }
  | { type: "bootstrapFailed" }
  | { type: "layoutModeSet"; payload: PanelLayoutMode }
  | { type: "splitRatioSet"; payload: { key: keyof WorkspaceState["layoutRatios"]; value: number } }
  | { type: "panelFocused"; payload: { panelId: PanelId } }
  | { type: "focusNextPanel" }
  | { type: "tabOpened"; payload: { panelId: PanelId; tab: TabState } }
  | { type: "navigationTabOpened"; payload?: { panelId?: PanelId } }
  | { type: "tabActivated"; payload: { panelId: PanelId; tabId: string } }
  | { type: "tabClosed"; payload: { panelId: PanelId; tabId: string } }
  | { type: "tabMoved"; payload: { sourcePanelId: PanelId; targetPanelId: PanelId; tabId: string; targetIndex: number } }
  | { type: "tabLockedToggled"; payload: { panelId: PanelId; tabId: string } }
  | { type: "tabTitleRenamed"; payload: { panelId: PanelId; tabId: string; title: string } }
  | { type: "otherTabsClosed"; payload: { panelId: PanelId; tabId: string; includeLocked: boolean } }
  | {
      type: "tabSnapshotCommitted";
      payload: {
        panelId: PanelId;
        tabId: string;
        snapshot: DirectorySnapshot;
        pushHistory: boolean;
        activatePanel?: boolean;
        historyIndex?: number;
        history?: string[];
      };
    }
  | { type: "addressDraftChanged"; payload: { panelId: PanelId; tabId: string; value: string } }
  | { type: "treeChildrenLoaded"; payload: { path: string; children: DirectoryNode[] } }
  | { type: "treeNodeConnectionStarted"; payload: { path: string } }
  | { type: "treeNodeConnectionSucceeded"; payload: { path: string } }
  | { type: "treeNodeConnectionFailed"; payload: { path: string; message?: string } }
  | { type: "treeNodeExpansionSet"; payload: { panelId: PanelId; tabId: string; path: string; expanded: boolean } }
  | { type: "tabReconnectRequired"; payload: { panelId: PanelId; tabId: string; path: string; profileId?: string; message?: string } }
  | { type: "tabReconnectStarted"; payload: { panelId: PanelId; tabId: string } }
  | { type: "entrySelectionChanged"; payload: { panelId: PanelId; tabId: string; entryId: string; multi: boolean } }
  | { type: "entrySelectionSet"; payload: { panelId: PanelId; tabId: string; entryIds: string[] } }
  | { type: "entryRangeSelected"; payload: { panelId: PanelId; tabId: string; fromEntryId: string; toEntryId: string } }
  | { type: "allEntriesSelected"; payload: { panelId: PanelId; tabId: string } }
  | { type: "entrySelectionCleared"; payload: { panelId: PanelId; tabId: string } }
  | { type: "tabSortChanged"; payload: { panelId: PanelId; tabId: string; columnId: ColumnId } }
  | { type: "tabViewModeSet"; payload: { panelId: PanelId; tabId: string; viewMode: TabViewMode } }
  | { type: "inlineEditStarted"; payload: { panelId: PanelId; tabId: string; edit: InlineEditState } }
  | { type: "inlineEditChanged"; payload: { panelId: PanelId; tabId: string; value: string } }
  | { type: "inlineEditCanceled"; payload: { panelId: PanelId; tabId: string } }
  | { type: "searchToggled"; payload?: boolean }
  | { type: "searchTabChanged"; payload: SearchTabId }
  | { type: "searchStarted"; payload?: { searchId?: string } }
  | { type: "searchQueryChanged"; payload: Partial<SearchQuery> }
  | { type: "searchFilterChanged"; payload: string }
  | { type: "searchHistoryLoaded"; payload: { tab: SearchTabId; history: string[] } }
  | { type: "searchHistorySelected"; payload: { index: number } }
  | { type: "searchHistoryDeleted"; payload: { index: number } }
  | { type: "searchProgressUpdated"; payload: SearchProgressState }
  | { type: "searchCompleted"; payload: SearchResult[] | { results: SearchResult[]; progress?: SearchProgressState } }
  | {
      type: "searchResultsTabCommitted";
      payload: {
        panelId: PanelId;
        sourceTabId: string;
        tabId: string;
        query: SearchQuery;
        results: SearchResult[];
        progress?: SearchProgressState;
      };
    }
  | { type: "searchFailed" }
  | { type: "searchCancelled" }
  | { type: "favoritesUpdated"; payload: Pick<WorkspaceState, "bookmarks" | "hotlist"> }
  | { type: "navigationItemsUpdated"; payload: NavigationItem[] }
  | { type: "navigationTargetStatusUpdated"; payload: NavigationTargetInfo[] }
  | { type: "navigationSelectionSet"; payload: string[] }
  | { type: "navigationItemSelectionChanged"; payload: { itemId: string; multi: boolean } }
  | { type: "navigationFilterChanged"; payload: string }
  | { type: "navigationStatusSet"; payload: WorkspaceState["navigation"]["status"] }
  | { type: "remoteProfilesUpdated"; payload: RemoteConnectionProfile[] }
  | { type: "settingsSectionSet"; payload: SettingsSection }
  | { type: "shortcutBindingUpdated"; payload: { id: string; binding: string } }
  | { type: "colorRuleUpdated"; payload: { id: string; color: string } }
  | { type: "tagRuleUpdated"; payload: { id: string; quickFilter: string } }
  | { type: "columnVisibilityToggled"; payload: { id: string } }
  | { type: "columnWidthSet"; payload: { panelId: PanelId; tabId: string; id: ColumnId; width: string } }
  | { type: "detailsRowHeightSet"; payload: { value: number } }
  | { type: "themePanelFocusAccentSet"; payload: { color: string } }
  | { type: "themeTabMinWidthSet"; payload: { value: number } }
  | { type: "settingsModelApplied"; payload: { model: SettingsModel; section?: SettingsSection } }
  | {
      type: "settingsSnapshotSynced";
      payload: Pick<WorkspaceState, "bookmarks" | "hotlist" | "remoteProfiles"> & {
        navigationItems: NavigationItem[];
        settingsModel: SettingsModel;
      };
    }
  | { type: "clipboardSet"; payload?: WorkspaceState["clipboard"] }
  | { type: "operationTasksOpenSet"; payload: boolean }
  | { type: "operationTasksSnapshotLoaded"; payload: { tasks: OperationTaskSnapshot[]; taskSequence: number } }
  | { type: "operationTaskEventReceived"; payload: OperationTaskSnapshot }
  | { type: "operationHistorySnapshotLoaded"; payload: { records: OperationHistoryRecord[]; historySequence: number } }
  | { type: "operationHistoryEventReceived"; payload: { record: OperationHistoryRecord; historySequence: number } }
  | { type: "operationConflictRequested"; payload: OperationConflictRequest }
  | {
      type: "operationConflictDialogChanged";
      payload: Partial<
        Pick<NonNullable<WorkspaceState["operations"]["conflictDialog"]>, "selectedResolution" | "renameValue" | "applyToAll" | "resolving">
      >;
    }
  | { type: "operationConflictDialogClosed"; payload?: { conflictId?: string } }
  | { type: "notificationAdded"; payload: WorkspaceState["notifications"][number] }
  | { type: "notificationDismissed"; payload: { id: string } }
  | { type: "contextMenuSet"; payload?: WorkspaceState["contextMenu"] };

const PANEL_ORDER: PanelId[] = ["panel-1", "panel-2", "panel-3", "panel-4"];
const MIN_DETAILS_ROW_HEIGHT = 24;
const MAX_DETAILS_ROW_HEIGHT = 72;
const MIN_COLUMN_WIDTH = 48;
const MAX_COLUMN_WIDTH = 960;

const DEFAULT_SEARCH_PROGRESS: SearchProgressState = {
  scannedEntries: 0,
  matchedEntries: 0,
  cancelled: false,
  statusText: "就绪"
};

const MAX_SEARCH_HISTORY_ITEMS = 20;

function normalizeRemotePath(path: string) {
  const normalized = path
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .join("/");
  return normalized ? `/${normalized}` : "/";
}

function createRemoteRootPath(profile: RemoteConnectionProfile) {
  return `${profile.protocol}://${profile.username}@${profile.host}${normalizeRemotePath(profile.rootPath)}`;
}

export function getVisiblePanelIds(layoutMode: PanelLayoutMode): PanelId[] {
  switch (layoutMode) {
    case "single":
      return ["panel-1"];
    case "dual":
      return ["panel-1", "panel-2"];
    case "triple":
      return ["panel-1", "panel-2", "panel-3"];
    case "quad":
      return PANEL_ORDER;
    default:
      return ["panel-1"];
  }
}

export function getActiveTab(panel: PanelState): TabState {
  const activeTab = panel.tabs.find((tab) => tab.id === panel.activeTabId) ?? panel.tabs[0];
  if (!activeTab) {
    throw new Error(`Panel ${panel.id} has no tabs`);
  }
  return activeTab;
}

function cloneRecoveredTab(tab: TabState, panelId: PanelId): TabState {
  const id = `${panelId}-recovered-tab`;
  return {
    ...tab,
    id,
    selectedEntryIds: [...tab.selectedEntryIds],
    expandedNodePaths: [...tab.expandedNodePaths],
    history: [...tab.history],
    sort: { ...tab.sort },
    columns: cloneColumns(tab.columns),
    snapshot: {
      location: { ...tab.snapshot.location },
      breadcrumbs: tab.snapshot.breadcrumbs.map((breadcrumb) => ({ ...breadcrumb })),
      entries: tab.snapshot.entries.map((entry) => ({
        ...entry,
        attributes: [...entry.attributes],
        tags: [...entry.tags]
      }))
    }
  };
}

function createFallbackDirectoryTabForPanel(state: WorkspaceState, panelId: PanelId): TabState | undefined {
  const fallbackTab = PANEL_ORDER.flatMap((id) => state.panels[id].tabs).find((tab) => tab.kind === "directory");
  return fallbackTab ? cloneRecoveredTab(fallbackTab, panelId) : undefined;
}

export function createWorkspaceState(bootstrap: WorkspaceBootstrap): WorkspaceState {
  const visiblePanelIds = getVisiblePanelIds(bootstrap.layoutMode);
  const fallbackTab = PANEL_ORDER.flatMap((panelId) => bootstrap.panels[panelId].tabs)[0];
  const normalizedPanelsBeforeNavigationDedupe = Object.fromEntries(
    PANEL_ORDER.map((panelId) => {
      const panel = bootstrap.panels[panelId];
      return [
        panelId,
        normalizePanelTabs(
          panel.tabs.length > 0 || !fallbackTab
            ? panel
            : {
                ...panel,
                tabs: [cloneRecoveredTab(fallbackTab, panelId)],
                activeTabId: `${panelId}-recovered-tab`
              }
        )
      ];
    })
  ) as WorkspaceState["panels"];
  const normalizedPanels = dedupeNavigationTabs(
    normalizedPanelsBeforeNavigationDedupe,
    bootstrap.activePanelId,
    bootstrap.panels[bootstrap.activePanelId]?.activeTabId
  );

  return {
    status: "ready",
    source: bootstrap.source,
    layoutMode: bootstrap.layoutMode,
    layoutRatios: bootstrap.layoutRatios,
    panels: normalizedPanels,
    activePanelId: visiblePanelIds.includes(bootstrap.activePanelId) ? bootstrap.activePanelId : visiblePanelIds[0],
    directoryTree: bootstrap.directoryTree,
    bookmarks: bootstrap.bookmarks,
    hotlist: bootstrap.hotlist,
    navigation: {
      items: sortNavigationItems(bootstrap.navigationItems),
      selectedItemIds: [],
      filterText: "",
      status: "idle"
    },
    remoteProfiles: bootstrap.remoteProfiles,
    search: {
      open: false,
      loading: false,
      filterText: "",
      query: {
        name: "",
        content: "",
        nameMode: "normal",
        contentMode: "normal",
        extensionFilterText: "",
        extensionFilterMode: "include",
        includeFolders: false,
        recursive: true,
        caseSensitive: false,
        scope: "active-panel"
      },
      results: [],
      activeTab: "content",
      histories: {
        name: [],
        content: []
      },
      history: [],
      progress: DEFAULT_SEARCH_PROGRESS
    },
    settings: {
      section: "shortcuts",
      model: normalizeSettingsModel(bootstrap.settingsModel)
    },
    notifications: [],
    operations: {
      tasksOpen: false,
      tasks: [],
      taskSequence: 0,
      history: [],
      historySequence: 0
    }
  };
}

function clampRatio(key: keyof WorkspaceState["layoutRatios"], value: number) {
  const limitMap = {
    primary: { min: 0, max: 1 },
    tripleSecondary: { min: 0, max: 1 },
    quadLeftSecondary: { min: 0, max: 1 },
    quadRightSecondary: { min: 0, max: 1 },
    tree: { min: 0.12, max: 0.45 },
    search: { min: 0.18, max: 0.5 }
  };
  const limits = limitMap[key];
  return Math.min(limits.max, Math.max(limits.min, value));
}

function updatePanel(state: WorkspaceState, panelId: PanelId, updater: (panel: PanelState) => PanelState) {
  const nextPanel = updater(state.panels[panelId]);
  if (nextPanel === state.panels[panelId]) {
    return state;
  }

  return {
    ...state,
    panels: {
      ...state.panels,
      [panelId]: nextPanel
    }
  };
}

function updateTab(panel: PanelState, tabId: string, updater: (tab: TabState) => TabState) {
  let updated = false;
  const tabs = panel.tabs.map((tab) => {
    if (updated || tab.id !== tabId) {
      return tab;
    }

    updated = true;
    return updater(tab);
  });

  if (!updated) {
    return panel;
  }

  return {
    ...panel,
    tabs
  };
}

function sortOperationTasks(tasks: OperationTaskSnapshot[]) {
  return [...tasks].sort((left, right) => {
    const leftFinished = left.finishedAt ?? "";
    const rightFinished = right.finishedAt ?? "";
    const leftTime = leftFinished || left.startedAt || left.createdAt;
    const rightTime = rightFinished || right.startedAt || right.createdAt;
    return rightTime.localeCompare(leftTime) || right.sequence - left.sequence;
  });
}

function upsertOperationTask(tasks: OperationTaskSnapshot[], incoming: OperationTaskSnapshot) {
  const current = tasks.find((task) => task.taskId === incoming.taskId);
  if (current && current.sequence >= incoming.sequence) {
    return tasks;
  }

  return sortOperationTasks([...tasks.filter((task) => task.taskId !== incoming.taskId), incoming]);
}

function sortOperationHistory(records: OperationHistoryRecord[]) {
  return [...records].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function upsertOperationHistoryRecord(records: OperationHistoryRecord[], incoming: OperationHistoryRecord) {
  return sortOperationHistory([...records.filter((record) => record.recordId !== incoming.recordId), incoming]);
}

function hasSameOperationTasksSnapshot(current: OperationTaskSnapshot[], incoming: OperationTaskSnapshot[]) {
  return (
    current.length === incoming.length &&
    current.every((task, index) => {
      const nextTask = incoming[index];
      return nextTask && task.taskId === nextTask.taskId && task.sequence === nextTask.sequence;
    })
  );
}

function hasSameOperationHistorySnapshot(current: OperationHistoryRecord[], incoming: OperationHistoryRecord[]) {
  return (
    current.length === incoming.length &&
    current.every((record, index) => {
      const nextRecord = incoming[index];
      return nextRecord && record.recordId === nextRecord.recordId && record.updatedAt === nextRecord.updatedAt;
    })
  );
}

function hasSameJsonShape(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizePanelTabs(panel: PanelState): PanelState {
  const seen = new Set<string>();
  const tabs = panel.tabs.filter((tab) => {
    if (seen.has(tab.id)) {
      return false;
    }
    seen.add(tab.id);
    return true;
  });
  const activeTabId = tabs.some((tab) => tab.id === panel.activeTabId) ? panel.activeTabId : tabs[0]?.id ?? panel.activeTabId;

  if (tabs.length === panel.tabs.length && activeTabId === panel.activeTabId) {
    return panel;
  }

  return {
    ...panel,
    tabs,
    activeTabId
  };
}

function sortNavigationItems(items: NavigationItem[]) {
  return [...items].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.displayName.localeCompare(right.displayName, "zh-CN")
  );
}

function findNavigationTabInPanels(panels: WorkspaceState["panels"]) {
  for (const panelId of PANEL_ORDER) {
    const tab = panels[panelId].tabs.find(isNavigationTab);
    if (tab) {
      return { panelId, tab };
    }
  }
  return undefined;
}

function dedupeNavigationTabs(
  panels: WorkspaceState["panels"],
  preferredPanelId?: PanelId,
  preferredTabId?: string
): WorkspaceState["panels"] {
  const navigationTabs = PANEL_ORDER.flatMap((panelId) =>
    panels[panelId].tabs.filter(isNavigationTab).map((tab) => ({ panelId, tab }))
  );
  if (navigationTabs.length <= 1) {
    return panels;
  }

  const keeper =
    navigationTabs.find((item) => item.panelId === preferredPanelId && item.tab.id === preferredTabId) ??
    navigationTabs.find((item) => item.panelId === preferredPanelId) ??
    navigationTabs[0];
  let changed = false;
  const nextPanels = { ...panels };

  for (const panelId of PANEL_ORDER) {
    const panel = panels[panelId];
    const nextTabs = panel.tabs.filter((tab) => tab.kind !== "navigation" || (panelId === keeper.panelId && tab.id === keeper.tab.id));
    if (nextTabs.length !== panel.tabs.length) {
      changed = true;
      nextPanels[panelId] = {
        ...panel,
        tabs: nextTabs,
        activeTabId: nextTabs.some((tab) => tab.id === panel.activeTabId) ? panel.activeTabId : nextTabs[0]?.id ?? panel.activeTabId
      };
    }
  }

  return changed ? nextPanels : panels;
}

function getNavigationOpenPanelId(state: WorkspaceState, requestedPanelId?: PanelId): PanelId {
  const visiblePanelIds = getVisiblePanelIds(state.layoutMode);
  if (requestedPanelId && visiblePanelIds.includes(requestedPanelId)) {
    return requestedPanelId;
  }
  if (visiblePanelIds.includes(state.activePanelId)) {
    return state.activePanelId;
  }
  return visiblePanelIds[0];
}

function panelHasTab(panel: PanelState, tabId: string) {
  return panel.tabs.some((tab) => tab.id === tabId);
}

function getUniqueTabIdForPanel(tabId: string, panel: PanelState) {
  if (!panelHasTab(panel, tabId)) {
    return tabId;
  }

  let index = 1;
  let nextId = `${tabId}-moved-${index}`;
  while (panelHasTab(panel, nextId)) {
    index += 1;
    nextId = `${tabId}-moved-${index}`;
  }
  return nextId;
}

function insertTabAt(tabs: TabState[], tab: TabState, index: number) {
  const targetIndex = Math.min(Math.max(0, Math.round(index)), tabs.length);
  return [...tabs.slice(0, targetIndex), tab, ...tabs.slice(targetIndex)];
}

function createSearchResultsSnapshot(sourceTab: TabState, tabId: string, results: SearchResult[]): DirectorySnapshot {
  const sourcePath = sourceTab.snapshot.location.path;
  return {
    location: {
      ...sourceTab.snapshot.location,
      label: "搜索结果",
      path: sourcePath,
      subtitle: sourceTab.snapshot.location.label
    },
    breadcrumbs: [
      ...sourceTab.snapshot.breadcrumbs,
      {
        id: tabId,
        label: "搜索结果",
        path: sourcePath
      }
    ],
    entries: results.map((result) => ({
      id: result.id,
      name: result.name,
      kind: result.kind,
      path: result.path,
      parentPath: result.parentPath,
      sizeLabel: "--",
      modifiedLabel: "--",
      extension: result.kind === "file" && result.name.includes(".") ? `.${result.name.split(".").pop()}` : "",
      attributes: result.kind === "folder" ? ["D"] : ["A"],
      accentColor: result.kind === "folder" ? "#2f6b57" : "#29659f",
      tags: [],
      description: result.match
    }))
  };
}

function createSearchResultsTitle(query: SearchQuery) {
  const pattern = query.content.trim() || query.name.trim();
  return pattern ? `搜索：${pattern}` : "搜索结果";
}

function createSearchResultsTab(
  id: string,
  sourceTab: TabState,
  search: SearchTabState,
  title: string
): TabState {
  const snapshot = createSearchResultsSnapshot(sourceTab, id, search.results);
  return {
    id,
    title,
    kind: "search-results",
    snapshot,
    addressDraft: sourceTab.snapshot.location.path,
    history: [sourceTab.snapshot.location.path],
    historyIndex: 0,
    selectedEntryIds: [],
    expandedNodePaths: [...sourceTab.expandedNodePaths],
    viewMode: sourceTab.viewMode,
    sort: { ...sourceTab.sort },
    columns: cloneColumns(sourceTab.columns),
    status: "ready",
    search
  };
}

function updateSearchResultsTab(tab: TabState, sourceTab: TabState, search: SearchTabState, title: string): TabState {
  const snapshot = createSearchResultsSnapshot(sourceTab, tab.id, search.results);
  return {
    ...tab,
    title,
    kind: "search-results",
    snapshot,
    addressDraft: sourceTab.snapshot.location.path,
    history: tab.history.length > 0 ? tab.history : [sourceTab.snapshot.location.path],
    historyIndex: Math.min(tab.historyIndex, Math.max(0, tab.history.length - 1)),
    selectedEntryIds: [],
    expandedNodePaths: [...sourceTab.expandedNodePaths],
    columns: cloneColumns(sourceTab.columns),
    inlineEdit: undefined,
    search
  };
}

function unbindSearchTabsForSource(panel: PanelState, sourceTabId: string): PanelState {
  let changed = false;
  const tabs = panel.tabs.map((tab) => {
    if (tab.kind !== "search-results" || tab.search?.sourceTabId !== sourceTabId) {
      return tab;
    }

    changed = true;
    return {
      ...tab,
      search: tab.search
        ? {
            ...tab.search,
            sourceTabId: undefined,
            sourcePath: undefined
          }
        : undefined
    };
  });

  return changed ? { ...panel, tabs } : panel;
}

function commitSearchResultsTab(
  panel: PanelState,
  payload: Extract<WorkspaceAction, { type: "searchResultsTabCommitted" }>["payload"]
): PanelState {
  const sourceIndex = panel.tabs.findIndex((tab) => tab.id === payload.sourceTabId);
  if (sourceIndex === -1) {
    return panel;
  }

  const sourceTab = panel.tabs[sourceIndex];
  const search: SearchTabState = {
    sourceTabId: sourceTab.id,
    sourcePath: sourceTab.snapshot.location.path,
    query: { ...payload.query },
    results: payload.results.map((result) => ({ ...result, location: { ...result.location } })),
    progress: payload.progress ? { ...payload.progress } : undefined
  };
  const title = createSearchResultsTitle(payload.query);
  const reusableIndex = panel.tabs.findIndex((tab) => tab.kind === "search-results" && !tab.search?.sourceTabId);

  if (reusableIndex >= 0) {
    const tabs = panel.tabs.map((tab, index) =>
      index === reusableIndex ? updateSearchResultsTab(tab, sourceTab, search, title) : tab
    );
    return {
      ...panel,
      tabs,
      activeTabId: tabs[reusableIndex].id
    };
  }

  if (panelHasTab(panel, payload.tabId)) {
    return panel;
  }

  const resultTab = createSearchResultsTab(payload.tabId, sourceTab, search, title);
  const tabs = [...panel.tabs.slice(0, sourceIndex + 1), resultTab, ...panel.tabs.slice(sourceIndex + 1)];
  return {
    ...panel,
    tabs,
    activeTabId: resultTab.id
  };
}

function getNextVisiblePanelId(layoutMode: PanelLayoutMode, activePanelId: PanelId) {
  const visiblePanels = getVisiblePanelIds(layoutMode);
  const currentIndex = visiblePanels.indexOf(activePanelId);
  if (currentIndex === -1) {
    return visiblePanels[0];
  }
  return visiblePanels[(currentIndex + 1) % visiblePanels.length];
}

function ensureVisibleActivePanel(layoutMode: PanelLayoutMode, activePanelId: PanelId) {
  const visiblePanels = getVisiblePanelIds(layoutMode);
  return visiblePanels.includes(activePanelId) ? activePanelId : visiblePanels[0];
}

function toggleExpandedPath(expandedNodePaths: string[], path: string) {
  return expandedNodePaths.includes(path)
    ? expandedNodePaths.filter((nodePath) => nodePath !== path)
    : [...expandedNodePaths, path];
}

function normalizeDetailsRowHeight(value: number) {
  if (!Number.isFinite(value)) {
    return 24;
  }

  return Math.min(MAX_DETAILS_ROW_HEIGHT, Math.max(MIN_DETAILS_ROW_HEIGHT, Math.round(value)));
}

function normalizeSearchHistory(items: string[]) {
  const seen = new Set<string>();
  const history: string[] = [];

  for (const item of items) {
    const value = item.trim();
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) {
      continue;
    }
    seen.add(key);
    history.push(value);
    if (history.length >= MAX_SEARCH_HISTORY_ITEMS) {
      break;
    }
  }

  return history;
}

function addSearchHistoryItem(history: string[], value: string) {
  return normalizeSearchHistory([value, ...history]);
}

function getSearchHistoryValue(search: WorkspaceState["search"]) {
  return search.activeTab === "name" ? search.query.name : search.query.content;
}

function createSearchHistoryState(
  search: WorkspaceState["search"],
  histories: WorkspaceState["search"]["histories"],
  selectedHistoryIndex?: number
) {
  return {
    histories,
    history: histories[search.activeTab],
    selectedHistoryIndex
  };
}

function normalizeColumnWidth(width: string) {
  const trimmed = width.trim();
  const pixelMatch = /^(\d+(?:\.\d+)?)px$/i.exec(trimmed);
  if (!pixelMatch) {
    return trimmed || `${MIN_COLUMN_WIDTH}px`;
  }

  const nextWidth = Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(Number(pixelMatch[1]))));
  return `${nextWidth}px`;
}

function setColumnWidth(columns: ColumnDefinition[], columnId: ColumnId, width: string) {
  let changed = false;
  const normalizedWidth = normalizeColumnWidth(width);
  const nextColumns = columns.map((column) => {
    if (column.id !== columnId) {
      return column;
    }
    changed = true;
    return {
      ...column,
      width: normalizedWidth
    };
  });
  return changed ? nextColumns : columns;
}

function setExpandedPath(expandedNodePaths: string[], path: string, expanded: boolean) {
  const normalizedPath = normalizeLocationPath(path);
  if (expanded) {
    return expandedNodePaths.includes(normalizedPath) ? expandedNodePaths : [...expandedNodePaths, normalizedPath];
  }
  return expandedNodePaths.filter((nodePath) => nodePath !== normalizedPath);
}

function normalizeDirectoryNode(node: DirectoryNode): DirectoryNode {
  const normalizedPath = normalizeLocationPath(node.path);

  return {
    ...node,
    id: node.id === node.path ? normalizedPath : node.id,
    path: normalizedPath,
    children: node.children.map(normalizeDirectoryNode)
  };
}

function updateTreeNode(nodes: DirectoryNode[], targetPath: string, updater: (node: DirectoryNode) => DirectoryNode): DirectoryNode[] {
  const normalizedTargetPath = normalizeLocationPath(targetPath);
  let changed = false;
  const nextNodes = nodes.map((node) => {
    const normalizedNode = normalizeDirectoryNode(node);
    if (normalizeLocationPath(normalizedNode.path) === normalizedTargetPath) {
      changed = true;
      return updater(normalizedNode);
    }

    if (normalizedNode.children.length === 0) {
      return node;
    }

    const nextChildren = updateTreeNode(normalizedNode.children, targetPath, updater);
    if (nextChildren !== normalizedNode.children) {
      changed = true;
      return {
        ...normalizedNode,
        children: nextChildren
      };
    }

    return node;
  });

  return changed ? nextNodes : nodes;
}

function replaceTreeChildren(nodes: DirectoryNode[], targetPath: string, children: DirectoryNode[]): DirectoryNode[] {
  const normalizedTargetPath = normalizeLocationPath(targetPath);
  const normalizedChildren = children.map(normalizeDirectoryNode);

  return nodes.map((node) => {
    if (normalizeLocationPath(node.path) === normalizedTargetPath) {
      if (node.loaded && node.children.length > 0 && normalizedChildren.length === 0) {
        return node;
      }

      return {
        ...normalizeDirectoryNode(node),
        loaded: true,
        children: normalizedChildren
      };
    }

    if (node.children.length === 0) {
      return node;
    }

    return {
      ...node,
      children: replaceTreeChildren(node.children, targetPath, children)
    };
  });
}

function replaceRemoteRoots(
  directoryTree: DirectoryNode[],
  remoteProfiles: RemoteConnectionProfile[],
  previousProfiles: RemoteConnectionProfile[]
) {
  const remoteRootsById = new Map(
    directoryTree
      .filter((node) => node.kind === "remote-root")
      .map((node) => [node.id, node] as const)
  );
  const previousById = new Map(previousProfiles.map((profile) => [profile.id, profile]));
  const localRoots = directoryTree.filter((node) => node.kind !== "remote-root");

  const remoteRoots = remoteProfiles.map((profile) => {
    const previousProfile = previousById.get(profile.id);
    const existingNode = remoteRootsById.get(profile.id);
    const pathChanged = previousProfile ? createRemoteRootPath(previousProfile) !== createRemoteRootPath(profile) : false;

    return {
      id: profile.id,
      label: profile.name,
      path: createRemoteRootPath(profile),
      kind: "remote-root" as const,
      badge: `${profile.protocol.toUpperCase()} ${profile.host}`,
      connectionState: pathChanged ? "unknown" as const : existingNode?.connectionState ?? "unknown" as const,
      errorMessage: pathChanged ? undefined : existingNode?.errorMessage,
      expandable: true,
      loaded: pathChanged ? false : existingNode?.loaded ?? false,
      children: pathChanged ? [] : existingNode?.children ?? []
    };
  });

  return [...localRoots, ...remoteRoots];
}

function selectEntries(selectedEntryIds: string[], entryId: string, multi: boolean) {
  if (!multi) {
    return [entryId];
  }
  return selectedEntryIds.includes(entryId)
    ? selectedEntryIds.filter((selectedId) => selectedId !== entryId)
    : [...selectedEntryIds, entryId];
}

function selectEntryRange(entries: { id: string }[], fromEntryId: string, toEntryId: string): string[] {
  const fromIndex = entries.findIndex((entry) => entry.id === fromEntryId);
  const toIndex = entries.findIndex((entry) => entry.id === toEntryId);

  if (fromIndex === -1 || toIndex === -1) {
    return [];
  }

  const startIndex = Math.min(fromIndex, toIndex);
  const endIndex = Math.max(fromIndex, toIndex);

  return entries.slice(startIndex, endIndex + 1).map((entry) => entry.id);
}

function clearActiveTabSelectionForPanel(panel: PanelState): PanelState {
  return updateTab(panel, panel.activeTabId, (tab) =>
    tab.selectedEntryIds.length === 0
      ? tab
      : {
          ...tab,
          selectedEntryIds: []
        }
  );
}

function focusPanel(state: WorkspaceState, panelId: PanelId): WorkspaceState {
  if (state.activePanelId === panelId) {
    return state;
  }

  return updatePanel(
    {
      ...state,
      activePanelId: panelId
    },
    state.activePanelId,
    clearActiveTabSelectionForPanel
  );
}

function updateSettingsModel<T extends keyof WorkspaceState["settings"]["model"]>(
  state: WorkspaceState,
  key: T,
  updater: (value: WorkspaceState["settings"]["model"][T]) => WorkspaceState["settings"]["model"][T]
) {
  return {
    ...state,
    settings: {
      ...state.settings,
      model: {
        ...state.settings.model,
        [key]: updater(state.settings.model[key])
      }
    }
  };
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "bootstrapLoaded":
      return createWorkspaceState(action.payload);

    case "bootstrapFailed":
      return {
        ...state,
        status: "ready"
      };

    case "layoutModeSet":
      return {
        ...state,
        layoutMode: action.payload,
        activePanelId: ensureVisibleActivePanel(action.payload, state.activePanelId)
      };

    case "splitRatioSet":
      return {
        ...state,
        layoutRatios: {
          ...state.layoutRatios,
          [action.payload.key]: clampRatio(action.payload.key, action.payload.value)
        }
      };

    case "panelFocused":
      if (!getVisiblePanelIds(state.layoutMode).includes(action.payload.panelId)) {
        return state;
      }
      return focusPanel(state, action.payload.panelId);

    case "focusNextPanel":
      return focusPanel(state, getNextVisiblePanelId(state.layoutMode, state.activePanelId));

    case "tabOpened":
      if (isNavigationTab(action.payload.tab) && findNavigationTabInPanels(state.panels)) {
        return workspaceReducer(state, {
          type: "navigationTabOpened",
          payload: { panelId: action.payload.panelId }
        });
      }
      if (panelHasTab(state.panels[action.payload.panelId], action.payload.tab.id)) {
        return state;
      }
      return updatePanel(
        focusPanel(state, action.payload.panelId),
        action.payload.panelId,
        (panel) => ({
          ...panel,
          tabs: [...panel.tabs, action.payload.tab],
          activeTabId: action.payload.tab.id
        })
      );

    case "navigationTabOpened":
      {
        const targetPanelId = getNavigationOpenPanelId(state, action.payload?.panelId);
        const existing = findNavigationTabInPanels(state.panels);
        if (!existing) {
          return {
            ...updatePanel(focusPanel(state, targetPanelId), targetPanelId, (panel) => ({
              ...panel,
              tabs: [...panel.tabs, createNavigationTab(NAVIGATION_TAB_ID)],
              activeTabId: NAVIGATION_TAB_ID
            })),
            navigation: {
              ...state.navigation,
              selectedItemIds: [],
              filterText: ""
            }
          };
        }

        const visiblePanelIds = getVisiblePanelIds(state.layoutMode);
        if (!visiblePanelIds.includes(existing.panelId)) {
          const sourcePanel = state.panels[existing.panelId];
          const targetPanel = state.panels[targetPanelId];
          const nextSourceTabsBeforeFallback = sourcePanel.tabs.filter((tab) => tab.id !== existing.tab.id);
          const sourceFallbackTab =
            nextSourceTabsBeforeFallback.length === 0 ? createFallbackDirectoryTabForPanel(state, existing.panelId) : undefined;
          const nextSourceTabs = sourceFallbackTab ? [sourceFallbackTab] : nextSourceTabsBeforeFallback;
          const nextState = {
            ...state,
            activePanelId: targetPanelId,
            navigation: {
              ...state.navigation,
              selectedItemIds: [],
              filterText: ""
            },
            panels: {
              ...state.panels,
              [existing.panelId]: {
                ...sourcePanel,
                tabs: nextSourceTabs,
                activeTabId: nextSourceTabs.some((tab) => tab.id === sourcePanel.activeTabId)
                  ? sourcePanel.activeTabId
                  : nextSourceTabs[0]?.id ?? sourcePanel.activeTabId
              },
              [targetPanelId]: {
                ...targetPanel,
                tabs: targetPanel.tabs.some(isNavigationTab) ? targetPanel.tabs : [...targetPanel.tabs, existing.tab],
                activeTabId: existing.tab.id
              }
            }
          };
          return {
            ...nextState,
            panels: dedupeNavigationTabs(nextState.panels, targetPanelId, existing.tab.id)
          };
        }

        return {
          ...updatePanel(focusPanel(state, existing.panelId), existing.panelId, (panel) => ({
            ...panel,
            activeTabId: existing.tab.id
          })),
          navigation: {
            ...state.navigation,
            selectedItemIds: [],
            filterText: ""
          }
        };
      }

    case "tabActivated":
      if (!panelHasTab(state.panels[action.payload.panelId], action.payload.tabId)) {
        return state;
      }
      return updatePanel(
        focusPanel(state, action.payload.panelId),
        action.payload.panelId,
        (panel) => ({
          ...panel,
          activeTabId: action.payload.tabId
        })
      );

    case "tabClosed":
      return updatePanel(state, action.payload.panelId, (panel) => {
        if (panel.tabs.length === 1) {
          return panel;
        }

        const closingIndex = panel.tabs.findIndex((tab) => tab.id === action.payload.tabId);
        if (closingIndex === -1) {
          return panel;
        }
        if (panel.tabs[closingIndex].locked) {
          return panel;
        }

        const nextTabs = panel.tabs.filter((_, index) => index !== closingIndex);
        if (nextTabs.length === 0) {
          return panel;
        }
        const nextActiveTabId =
          panel.activeTabId === action.payload.tabId && !nextTabs.some((tab) => tab.id === panel.activeTabId)
            ? nextTabs[Math.max(0, closingIndex - 1)]?.id ?? nextTabs[0].id
            : panel.activeTabId;

        return {
          ...panel,
          tabs: nextTabs,
          activeTabId: nextActiveTabId
        };
      });

    case "tabMoved":
      {
        const sourcePanel = state.panels[action.payload.sourcePanelId];
        const sourceIndex = sourcePanel.tabs.findIndex((tab) => tab.id === action.payload.tabId);
        if (sourceIndex === -1 || sourcePanel.tabs.length <= 1) {
          return state;
        }

        const sourceTab = sourcePanel.tabs[sourceIndex];
        if (isNavigationTab(sourceTab) && state.panels[action.payload.targetPanelId].tabs.some(isNavigationTab)) {
          return state;
        }
        if (action.payload.sourcePanelId === action.payload.targetPanelId) {
          const remainingTabs = sourcePanel.tabs.filter((_, index) => index !== sourceIndex);
          const adjustedTargetIndex =
            action.payload.targetIndex > sourceIndex ? action.payload.targetIndex - 1 : action.payload.targetIndex;
          const nextTabs = insertTabAt(remainingTabs, sourceTab, adjustedTargetIndex);
          return updatePanel(state, action.payload.sourcePanelId, (panel) => ({
            ...panel,
            tabs: nextTabs,
            activeTabId: sourceTab.id
          }));
        }

        const targetPanel = state.panels[action.payload.targetPanelId];
        const movedTabId = getUniqueTabIdForPanel(sourceTab.id, targetPanel);
        const movedTab = movedTabId === sourceTab.id ? sourceTab : { ...sourceTab, id: movedTabId };
        const nextSourceTabs = sourcePanel.tabs.filter((_, index) => index !== sourceIndex);
        const nextSourceActiveTabId =
          sourcePanel.activeTabId === sourceTab.id
            ? nextSourceTabs[Math.max(0, sourceIndex - 1)]?.id ?? nextSourceTabs[0].id
            : sourcePanel.activeTabId;

        return {
          ...state,
          activePanelId: action.payload.targetPanelId,
          panels: {
            ...state.panels,
            [action.payload.sourcePanelId]: {
              ...sourcePanel,
              tabs: nextSourceTabs,
              activeTabId: nextSourceActiveTabId
            },
            [action.payload.targetPanelId]: {
              ...targetPanel,
              tabs: insertTabAt(targetPanel.tabs, movedTab, action.payload.targetIndex),
              activeTabId: movedTab.id
            }
          }
        };
      }

    case "tabLockedToggled":
      return updatePanel(state, action.payload.panelId, (panel) =>
        updateTab(panel, action.payload.tabId, (tab) => ({
          ...tab,
          locked: !tab.locked
        }))
      );

    case "tabTitleRenamed":
      {
        const nextTitle = action.payload.title.trim();
        if (!nextTitle) {
          return state;
        }
        const target = state.panels[action.payload.panelId].tabs.find((tab) => tab.id === action.payload.tabId);
        if (isNavigationTab(target)) {
          return state;
        }
        return updatePanel(state, action.payload.panelId, (panel) =>
          updateTab(panel, action.payload.tabId, (tab) => ({
            ...tab,
            title: nextTitle,
            titleOverride: nextTitle
          }))
        );
      }

    case "otherTabsClosed":
      return updatePanel(state, action.payload.panelId, (panel) => {
        const targetTab = panel.tabs.find((tab) => tab.id === action.payload.tabId);
        if (!targetTab) {
          return panel;
        }

        const nextTabs = panel.tabs.filter((tab) => {
          if (tab.id === action.payload.tabId) {
            return true;
          }
          return !action.payload.includeLocked && tab.locked;
        });

        return nextTabs.length === panel.tabs.length
          ? panel
          : {
              ...panel,
              tabs: nextTabs,
              activeTabId: action.payload.tabId
            };
      });

    case "tabSnapshotCommitted":
      if (!panelHasTab(state.panels[action.payload.panelId], action.payload.tabId)) {
        return state;
      }
      if (isNavigationTab(state.panels[action.payload.panelId].tabs.find((tab) => tab.id === action.payload.tabId))) {
        return state;
      }
      return updatePanel(
        action.payload.activatePanel === false
          ? state
          : {
              ...state,
              activePanelId: action.payload.panelId
            },
        action.payload.panelId,
        (panel) => {
          const targetTab = panel.tabs.find((tab) => tab.id === action.payload.tabId);
          const previousPath = targetTab?.snapshot.location.path;
          const nextPath = action.payload.snapshot.location.path;
          const pathChanged = Boolean(previousPath && previousPath !== nextPath);
          const updatedPanel = updateTab(panel, action.payload.tabId, (tab) => {
            const currentPath = tab.history[tab.historyIndex] ?? tab.snapshot.location.path;
            const shouldPushHistory = action.payload.pushHistory && currentPath !== nextPath;
            const explicitHistory = action.payload.history?.length
              ? action.payload.history.map((historyPath) => normalizeLocationPath(historyPath))
              : undefined;
            const nextHistory = explicitHistory ?? (shouldPushHistory
              ? [...tab.history.slice(0, tab.historyIndex + 1), nextPath]
              : tab.history);
            const nextHistoryIndex =
              explicitHistory !== undefined
                ? Math.min(
                    Math.max(
                      action.payload.historyIndex ??
                        Math.max(0, nextHistory.findIndex((historyPath) => historyPath === nextPath)),
                      0
                    ),
                    Math.max(0, nextHistory.length - 1)
                  )
                : shouldPushHistory
                  ? nextHistory.length - 1
                  : action.payload.historyIndex ??
                    (tab.history[tab.historyIndex] === nextPath
                      ? tab.historyIndex
                      : Math.max(0, nextHistory.findIndex((historyPath) => historyPath === nextPath)));

            const breadcrumbPaths = action.payload.snapshot.breadcrumbs.map((breadcrumb) => breadcrumb.path);
            const nextExpandedNodePaths = breadcrumbPaths.reduce<string[]>(
              (paths, breadcrumbPath) =>
                paths.includes(breadcrumbPath) ? paths : [...paths, breadcrumbPath],
              tab.expandedNodePaths
            );

            return {
              ...tab,
              title: tab.titleOverride ?? action.payload.snapshot.location.label,
              kind: "directory",
              snapshot: action.payload.snapshot,
              addressDraft: action.payload.snapshot.location.path,
              history: nextHistory,
              historyIndex: nextHistoryIndex,
              selectedEntryIds: [],
              expandedNodePaths: nextExpandedNodePaths,
              status: "ready",
              inlineEdit: undefined,
              search: undefined,
              reconnect: undefined
            };
          });

          return pathChanged ? unbindSearchTabsForSource(updatedPanel, action.payload.tabId) : updatedPanel;
        }
      );

    case "addressDraftChanged":
      return updatePanel(
        focusPanel(state, action.payload.panelId),
        action.payload.panelId,
        (panel) =>
          updateTab(panel, action.payload.tabId, (tab) =>
            isNavigationTab(tab)
              ? tab
              : {
                  ...tab,
                  addressDraft: action.payload.value
                }
          )
      );

    case "treeChildrenLoaded":
      return {
        ...state,
        directoryTree: updateTreeNode(
          replaceTreeChildren(state.directoryTree, action.payload.path, action.payload.children),
          action.payload.path,
          (node) => ({
            ...node,
            connectionState: node.kind === "remote-root" || node.path.startsWith("ftp://") || node.path.startsWith("sftp://")
              ? "connected"
              : node.connectionState,
            errorMessage: undefined
          })
        )
      };

    case "treeNodeConnectionStarted":
      return {
        ...state,
        directoryTree: updateTreeNode(state.directoryTree, action.payload.path, (node) => ({
          ...node,
          connectionState: "connecting",
          errorMessage: undefined
        }))
      };

    case "treeNodeConnectionSucceeded":
      return {
        ...state,
        directoryTree: updateTreeNode(state.directoryTree, action.payload.path, (node) => ({
          ...node,
          connectionState: "connected",
          errorMessage: undefined
        }))
      };

    case "treeNodeConnectionFailed":
      return {
        ...state,
        directoryTree: updateTreeNode(state.directoryTree, action.payload.path, (node) => ({
          ...node,
          connectionState: "error",
          errorMessage: action.payload.message
        }))
      };

    case "treeNodeExpansionSet":
      return updatePanel(state, action.payload.panelId, (panel) =>
        updateTab(panel, action.payload.tabId, (tab) => ({
          ...tab,
          expandedNodePaths: isNavigationTab(tab)
            ? tab.expandedNodePaths
            : setExpandedPath(tab.expandedNodePaths, action.payload.path, action.payload.expanded)
        }))
      );

    case "tabReconnectRequired":
      return updatePanel(state, action.payload.panelId, (panel) =>
        updateTab(panel, action.payload.tabId, (tab) =>
          isNavigationTab(tab)
            ? tab
            : {
              ...tab,
              title: tab.title || action.payload.path,
              kind: "directory",
              snapshot: {
                ...tab.snapshot,
                location: {
                  ...tab.snapshot.location,
                  kind: action.payload.path.startsWith("ftp://") ? "ftp" : action.payload.path.startsWith("sftp://") ? "sftp" : tab.snapshot.location.kind,
                  path: action.payload.path,
                  subtitle: action.payload.message ?? tab.snapshot.location.subtitle
                },
                entries: []
              },
              addressDraft: action.payload.path,
              status: "reconnect-required",
              inlineEdit: undefined,
              search: undefined,
              reconnect: {
                path: action.payload.path,
                ...(action.payload.profileId ? { profileId: action.payload.profileId } : {}),
                ...(action.payload.message ? { message: action.payload.message } : {})
              }
            }
        )
      );

    case "tabReconnectStarted":
      return updatePanel(state, action.payload.panelId, (panel) =>
        updateTab(panel, action.payload.tabId, (tab) =>
          isNavigationTab(tab)
            ? tab
            : {
              ...tab,
              status: "loading"
            }
        )
      );

    case "entrySelectionChanged":
      return updatePanel(
        focusPanel(state, action.payload.panelId),
        action.payload.panelId,
        (panel) =>
          updateTab(panel, action.payload.tabId, (tab) =>
            isNavigationTab(tab)
              ? tab
              : {
                  ...tab,
                  selectedEntryIds: selectEntries(tab.selectedEntryIds, action.payload.entryId, action.payload.multi)
                }
          )
      );

    case "entrySelectionSet":
      devLog("[workspaceReducer] entrySelectionSet:", action.payload);
      return updatePanel(
        focusPanel(state, action.payload.panelId),
        action.payload.panelId,
        (panel) =>
          updateTab(panel, action.payload.tabId, (tab) =>
            isNavigationTab(tab)
              ? tab
              : {
                  ...tab,
                  selectedEntryIds: action.payload.entryIds
                }
          )
      );

    case "entryRangeSelected":
      devLog("[workspaceReducer] entryRangeSelected:", action.payload);
      return updatePanel(
        focusPanel(state, action.payload.panelId),
        action.payload.panelId,
        (panel) =>
          updateTab(panel, action.payload.tabId, (tab) =>
            isNavigationTab(tab)
              ? tab
              : {
                  ...tab,
                  selectedEntryIds: selectEntryRange(
                    tab.snapshot.entries,
                    action.payload.fromEntryId,
                    action.payload.toEntryId
                  )
                }
          )
      );

    case "allEntriesSelected":
      devLog("[workspaceReducer] allEntriesSelected:", action.payload);
      return updatePanel(
        focusPanel(state, action.payload.panelId),
        action.payload.panelId,
        (panel) =>
          updateTab(panel, action.payload.tabId, (tab) =>
            isNavigationTab(tab)
              ? tab
              : {
                  ...tab,
                  selectedEntryIds: tab.snapshot.entries.map((entry) => entry.id)
                }
          )
      );

    case "entrySelectionCleared":
      devLog("[workspaceReducer] entrySelectionCleared:", action.payload);
      return updatePanel(
        focusPanel(state, action.payload.panelId),
        action.payload.panelId,
        (panel) =>
          updateTab(panel, action.payload.tabId, (tab) =>
            isNavigationTab(tab)
              ? tab
              : {
                  ...tab,
                  selectedEntryIds: []
                }
          )
      );

    case "tabSortChanged":
      return updatePanel(state, action.payload.panelId, (panel) =>
        updateTab(panel, action.payload.tabId, (tab) =>
          isNavigationTab(tab)
            ? tab
            : {
              ...tab,
              sort:
                tab.sort.columnId === action.payload.columnId
                  ? {
                    ...tab.sort,
                    direction: tab.sort.direction === "asc" ? "desc" : "asc"
                  }
                  : {
                    columnId: action.payload.columnId,
                    direction: "asc"
                  }
            }
        )
      );

    case "tabViewModeSet":
      return updatePanel(state, action.payload.panelId, (panel) =>
        updateTab(panel, action.payload.tabId, (tab) =>
          isNavigationTab(tab)
            ? tab
            : {
              ...tab,
              viewMode: action.payload.viewMode
            }
        )
      );

    case "inlineEditStarted":
      return updatePanel(state, action.payload.panelId, (panel) =>
        updateTab(panel, action.payload.tabId, (tab) =>
          isNavigationTab(tab)
            ? tab
            : {
              ...tab,
              inlineEdit: action.payload.edit
            }
        )
      );

    case "inlineEditChanged":
      return updatePanel(state, action.payload.panelId, (panel) =>
        updateTab(panel, action.payload.tabId, (tab) =>
          !isNavigationTab(tab) && tab.inlineEdit
            ? {
                ...tab,
                inlineEdit: {
                  ...tab.inlineEdit,
                  value: action.payload.value
                }
              }
            : tab
        )
      );

    case "inlineEditCanceled":
      return updatePanel(state, action.payload.panelId, (panel) =>
        updateTab(panel, action.payload.tabId, (tab) =>
          isNavigationTab(tab)
            ? tab
            : {
              ...tab,
              inlineEdit: undefined
            }
        )
      );

    case "searchToggled":
      return {
        ...state,
        search: {
          ...state.search,
          open: action.payload ?? !state.search.open
        }
      };

    case "searchTabChanged":
      if (state.search.activeTab === action.payload) {
        return state;
      }
      return {
        ...state,
        search: {
          ...state.search,
          activeTab: action.payload,
          history: state.search.histories[action.payload],
          selectedHistoryIndex: undefined
        }
      };

    case "searchStarted":
      {
        const nextHistories = {
          ...state.search.histories,
          [state.search.activeTab]: addSearchHistoryItem(
            state.search.histories[state.search.activeTab],
            getSearchHistoryValue(state.search)
          )
        };
        return {
          ...state,
          search: {
            ...state.search,
            open: true,
            loading: true,
            results: [],
            ...createSearchHistoryState(state.search, nextHistories, undefined),
            progress: {
              ...DEFAULT_SEARCH_PROGRESS,
              searchId: action.payload?.searchId,
              statusText: "正在搜索..."
            }
          }
        };
      }

    case "searchQueryChanged":
      return {
        ...state,
        search: {
          ...state.search,
          query: {
            ...state.search.query,
            ...action.payload
          }
        }
      };

    case "searchFilterChanged":
      return {
        ...state,
        search: {
          ...state.search,
          filterText: action.payload
        }
      };

    case "searchHistoryLoaded":
      {
        const nextHistories = {
          ...state.search.histories,
          [action.payload.tab]: normalizeSearchHistory(action.payload.history)
        };
        return {
          ...state,
          search: {
            ...state.search,
            histories: nextHistories,
            history: nextHistories[state.search.activeTab],
            selectedHistoryIndex: undefined
          }
        };
      }

    case "searchHistorySelected":
      {
        const value = state.search.histories[state.search.activeTab][action.payload.index];
        if (!value) {
          return state;
        }

        return {
          ...state,
          search: {
            ...state.search,
            selectedHistoryIndex: action.payload.index,
            query: {
              ...state.search.query,
              [state.search.activeTab === "name" ? "name" : "content"]: value
            }
          }
        };
      }

    case "searchHistoryDeleted":
      {
        const currentHistory = state.search.histories[state.search.activeTab];
        if (action.payload.index < 0 || action.payload.index >= currentHistory.length) {
          return state;
        }

        const nextHistories = {
          ...state.search.histories,
          [state.search.activeTab]: currentHistory.filter((_, index) => index !== action.payload.index)
        };
        return {
          ...state,
          search: {
            ...state.search,
            histories: nextHistories,
            history: nextHistories[state.search.activeTab],
            selectedHistoryIndex:
              state.search.selectedHistoryIndex === action.payload.index ? undefined : state.search.selectedHistoryIndex
          }
        };
      }

    case "searchProgressUpdated":
      return {
        ...state,
        search: {
          ...state.search,
          progress: action.payload
        }
      };

    case "searchCompleted":
      {
        const payload = Array.isArray(action.payload)
          ? {
              results: action.payload,
              progress: state.search.progress
                ? {
                    ...state.search.progress,
                    statusText: `搜索完成：${action.payload.length} 个结果`
                  }
                : undefined
            }
          : action.payload;

        return {
          ...state,
          search: {
            ...state.search,
            loading: false,
            results: payload.results,
            progress: payload.progress ?? state.search.progress
          }
        };
      }

    case "searchResultsTabCommitted":
      return updatePanel(
        {
          ...state,
          activePanelId: action.payload.panelId,
          search: {
            ...state.search,
            loading: false,
            results: action.payload.results,
            progress: action.payload.progress ?? state.search.progress
          }
        },
        action.payload.panelId,
        (panel) => commitSearchResultsTab(panel, action.payload)
      );

    case "searchFailed":
      return {
        ...state,
        search: {
          ...state.search,
          loading: false,
          progress: {
            ...(state.search.progress ?? DEFAULT_SEARCH_PROGRESS),
            statusText: "搜索失败"
          }
        }
      };

    case "searchCancelled":
      return {
        ...state,
        search: {
          ...state.search,
          loading: false,
          progress: {
            ...(state.search.progress ?? DEFAULT_SEARCH_PROGRESS),
            cancelled: true,
            statusText: "搜索已停止"
          }
        }
      };

    case "favoritesUpdated":
      return {
        ...state,
        bookmarks: action.payload.bookmarks,
        hotlist: action.payload.hotlist
      };

    case "navigationItemsUpdated":
      {
        const items = sortNavigationItems(action.payload);
        const itemIds = new Set(items.map((item) => item.id));
        return {
          ...state,
          navigation: {
            ...state.navigation,
            items,
            selectedItemIds: state.navigation.selectedItemIds.filter((id) => itemIds.has(id)),
            status: "idle"
          }
        };
      }

    case "navigationTargetStatusUpdated":
      {
        const infoByPath = new Map(action.payload.map((info) => [normalizeLocationPath(info.normalizedPath ?? info.path), info]));
        return {
          ...state,
          navigation: {
            ...state.navigation,
            items: state.navigation.items.map((item) => {
              const info = infoByPath.get(normalizeLocationPath(item.path)) ?? infoByPath.get(normalizeLocationPath(item.path.replace(/\//g, "\\")));
              return info
                ? {
                    ...item,
                    path: info.normalizedPath ?? item.path,
                    displayName: item.displayName || info.displayName,
                    targetKind: info.targetKind,
                    targetStatus: info.targetStatus,
                    statusMessage: info.message ?? undefined
                  }
                : item;
            }),
            status: "idle"
          }
        };
      }

    case "navigationSelectionSet":
      return {
        ...state,
        navigation: {
          ...state.navigation,
          selectedItemIds: action.payload.filter((id, index, ids) => ids.indexOf(id) === index)
        }
      };

    case "navigationItemSelectionChanged":
      return {
        ...state,
        navigation: {
          ...state.navigation,
          selectedItemIds: selectEntries(state.navigation.selectedItemIds, action.payload.itemId, action.payload.multi)
        }
      };

    case "navigationFilterChanged":
      return {
        ...state,
        navigation: {
          ...state.navigation,
          filterText: action.payload
        }
      };

    case "navigationStatusSet":
      return {
        ...state,
        navigation: {
          ...state.navigation,
          status: action.payload
        }
      };

    case "remoteProfilesUpdated":
      return {
        ...state,
        remoteProfiles: action.payload,
        directoryTree: replaceRemoteRoots(state.directoryTree, action.payload, state.remoteProfiles)
      };

    case "settingsSectionSet":
      return {
        ...state,
        settings: {
          ...state.settings,
          section: action.payload
        }
      };

    case "shortcutBindingUpdated":
      return updateSettingsModel(state, "shortcuts", (shortcuts) =>
        shortcuts.map((shortcut) =>
          shortcut.id === action.payload.id ? { ...shortcut, binding: action.payload.binding } : shortcut
        )
      );

    case "colorRuleUpdated":
      return updateSettingsModel(state, "colorRules", (colorRules) =>
        colorRules.map((rule) => (rule.id === action.payload.id ? { ...rule, color: action.payload.color } : rule))
      );

    case "tagRuleUpdated":
      return updateSettingsModel(state, "tagRules", (tagRules) =>
        tagRules.map((rule) =>
          rule.id === action.payload.id ? { ...rule, quickFilter: action.payload.quickFilter } : rule
        )
      );

    case "columnVisibilityToggled":
      return updateSettingsModel(state, "columns", (columns) =>
        columns.map((column) =>
          column.id === action.payload.id ? { ...column, visible: !column.visible } : column
        )
      );

    case "columnWidthSet":
      return updatePanel(state, action.payload.panelId, (panel) =>
        updateTab(panel, action.payload.tabId, (tab) => {
          const nextColumns = setColumnWidth(tab.columns, action.payload.id, action.payload.width);
          return nextColumns === tab.columns
            ? tab
            : {
                ...tab,
                columns: nextColumns
              };
        })
      );

    case "detailsRowHeightSet":
      return updateSettingsModel(state, "detailsRowHeight", () => normalizeDetailsRowHeight(action.payload.value));

    case "themePanelFocusAccentSet":
      {
        const nextColor = normalizeThemeAccentColor(action.payload.color);
        if (nextColor !== action.payload.color.trim().toLowerCase()) {
          return state;
        }
        return updateSettingsModel(state, "theme", (theme) => ({
          ...theme,
          panelFocusAccent: nextColor
        }));
      }

    case "themeTabMinWidthSet":
      return updateSettingsModel(state, "theme", (theme) => ({
        ...theme,
        tabMinWidth: normalizeTabMinWidth(action.payload.value)
      }));

    case "settingsModelApplied":
      {
        const model = normalizeSettingsModel(action.payload.model);
        if (
          hasSameJsonShape(state.settings.model, model) &&
          (action.payload.section === undefined || action.payload.section === state.settings.section)
        ) {
          return state;
        }
        return {
          ...state,
          settings: {
            section: action.payload.section ?? state.settings.section,
            model
          }
        };
      }

    case "settingsSnapshotSynced":
      {
        const model = normalizeSettingsModel({
          ...action.payload.settingsModel,
          tagRules: state.settings.model.tagRules,
          columns: state.settings.model.columns
        });
        const navigationItems = sortNavigationItems(action.payload.navigationItems);
        const itemIds = new Set(navigationItems.map((item) => item.id));
        if (
          hasSameJsonShape(state.settings.model, model) &&
          hasSameJsonShape(state.bookmarks, action.payload.bookmarks) &&
          hasSameJsonShape(state.hotlist, action.payload.hotlist) &&
          hasSameJsonShape(state.remoteProfiles, action.payload.remoteProfiles) &&
          hasSameJsonShape(state.navigation.items, navigationItems)
        ) {
          return state;
        }
        return {
          ...state,
          bookmarks: action.payload.bookmarks,
          hotlist: action.payload.hotlist,
          remoteProfiles: action.payload.remoteProfiles,
          directoryTree: replaceRemoteRoots(state.directoryTree, action.payload.remoteProfiles, state.remoteProfiles),
          navigation: {
            ...state.navigation,
            items: navigationItems,
            selectedItemIds: state.navigation.selectedItemIds.filter((id) => itemIds.has(id)),
            status: "idle"
          },
          settings: {
            ...state.settings,
            model
          }
        };
      }

    case "clipboardSet":
      return {
        ...state,
        clipboard: action.payload
      };

    case "operationTasksOpenSet":
      return {
        ...state,
        operations: {
          ...state.operations,
          tasksOpen: action.payload
        }
      };

    case "operationTasksSnapshotLoaded":
      if (action.payload.taskSequence < state.operations.taskSequence) {
        return state;
      }
      if (
        action.payload.taskSequence === state.operations.taskSequence &&
        hasSameOperationTasksSnapshot(state.operations.tasks, action.payload.tasks)
      ) {
        return state;
      }
      return {
        ...state,
        operations: {
          ...state.operations,
          tasks: sortOperationTasks(action.payload.tasks),
          taskSequence: action.payload.taskSequence
        }
      };

    case "operationTaskEventReceived":
      if (action.payload.sequence <= state.operations.taskSequence) {
        const current = state.operations.tasks.find((task) => task.taskId === action.payload.taskId);
        if (current && current.sequence >= action.payload.sequence) {
          return state;
        }
      }
      return {
        ...state,
        operations: {
          ...state.operations,
          tasks: upsertOperationTask(state.operations.tasks, action.payload),
          taskSequence: Math.max(state.operations.taskSequence, action.payload.sequence)
        }
      };

    case "operationHistorySnapshotLoaded":
      if (action.payload.historySequence < state.operations.historySequence) {
        return state;
      }
      if (
        action.payload.historySequence === state.operations.historySequence &&
        hasSameOperationHistorySnapshot(state.operations.history, action.payload.records)
      ) {
        return state;
      }
      return {
        ...state,
        operations: {
          ...state.operations,
          history: sortOperationHistory(action.payload.records),
          historySequence: action.payload.historySequence
        }
      };

    case "operationHistoryEventReceived":
      if (action.payload.historySequence <= state.operations.historySequence) {
        return state;
      }
      return {
        ...state,
        operations: {
          ...state.operations,
          history: upsertOperationHistoryRecord(state.operations.history, action.payload.record),
          historySequence: action.payload.historySequence
        }
      };

    case "operationConflictRequested":
      return {
        ...state,
        operations: {
          ...state.operations,
          tasksOpen: true,
          conflictDialog: {
            request: action.payload,
            renameValue: action.payload.suggestedName ?? "",
            selectedResolution: action.payload.allowedResolutions.includes("keepBoth")
              ? "keepBoth"
              : action.payload.allowedResolutions[0] ?? "skip",
            applyToAll: false,
            resolving: false
          }
        }
      };

    case "operationConflictDialogChanged":
      if (!state.operations.conflictDialog) {
        return state;
      }
      return {
        ...state,
        operations: {
          ...state.operations,
          conflictDialog: {
            ...state.operations.conflictDialog,
            ...action.payload
          }
        }
      };

    case "operationConflictDialogClosed":
      if (
        action.payload?.conflictId &&
        state.operations.conflictDialog?.request.conflictId !== action.payload.conflictId
      ) {
        return state;
      }
      return {
        ...state,
        operations: {
          ...state.operations,
          conflictDialog: undefined
        }
      };

    case "notificationAdded":
      return {
        ...state,
        notifications: [...state.notifications, action.payload]
      };

    case "notificationDismissed":
      return {
        ...state,
        notifications: state.notifications.filter((notification) => notification.id !== action.payload.id)
      };

    case "contextMenuSet":
      return {
        ...state,
        contextMenu: action.payload
      };

    default:
      return state;
  }
}

import type {
  ContextMenuState,
  DirectoryListing,
  NotificationItem,
  PanelLayoutMode,
  PanelState,
  SearchResult,
  SettingsSnapshot,
  TabState,
  WorkspaceBootstrap,
  WorkspaceState
} from "../../app/types";

type Action =
  | { type: "bootstrap"; payload: WorkspaceBootstrap }
  | { type: "set-error"; payload?: string }
  | { type: "set-layout"; payload: PanelLayoutMode }
  | { type: "set-panel-proportion"; payload: { index: number; value: number } }
  | { type: "set-active-panel"; payload: string }
  | { type: "set-panel-listing"; payload: { panelId: string; tabId: string; listing: DirectoryListing } }
  | { type: "restore-tab-history"; payload: { panelId: string; tabId: string; listing: DirectoryListing; historyIndex: number } }
  | { type: "open-tab"; payload: { panelId: string; listing: DirectoryListing } }
  | { type: "activate-tab"; payload: { panelId: string; tabId: string } }
  | { type: "close-tab"; payload: { panelId: string; tabId: string } }
  | { type: "select-paths"; payload: { panelId: string; tabId: string; selectedPaths: string[] } }
  | { type: "toggle-settings"; payload?: boolean }
  | { type: "set-context-menu"; payload?: ContextMenuState }
  | { type: "push-notification"; payload: NotificationItem }
  | { type: "dismiss-notification"; payload: string }
  | { type: "apply-settings"; payload: SettingsSnapshot }
  | { type: "set-tree-children"; payload: { path: string; children: WorkspaceState["tree"][string] } }
  | { type: "toggle-tree-node"; payload: string }
  | { type: "set-search-running"; payload: boolean }
  | { type: "set-search-results"; payload: SearchResult[] }
  | { type: "set-search-query"; payload: Partial<WorkspaceState["search"]> }
  | { type: "set-clipboard"; payload?: WorkspaceState["clipboard"] };

function createTab(listing: DirectoryListing): TabState {
  return {
    id: crypto.randomUUID(),
    title: listing.location.path.split("\\").pop() || listing.location.path,
    path: listing.location.path,
    listing,
    history: [listing.location.path],
    historyIndex: 0,
    selectedPaths: []
  };
}

function createPanels(listing: DirectoryListing): PanelState[] {
  const firstTab = createTab(listing);
  return Array.from({ length: 4 }, (_, index) => {
    const tab = index === 0 ? firstTab : createTab(listing);
    return {
      id: `panel-${index + 1}`,
      tabs: [tab],
      activeTabId: tab.id
    };
  });
}

export function getVisiblePanelIds(layoutMode: PanelLayoutMode) {
  switch (layoutMode) {
    case "single":
      return ["panel-1"];
    case "dual":
      return ["panel-1", "panel-2"];
    case "triple":
      return ["panel-1", "panel-2", "panel-3"];
    case "quad":
      return ["panel-1", "panel-2", "panel-3", "panel-4"];
  }
}

export function createInitialState(): WorkspaceState {
  const emptyListing: DirectoryListing = {
    location: { kind: "local", path: "C:\\" },
    entries: [],
    parent: null,
    canGoUp: false
  };

  return {
    ready: false,
    drives: [],
    layout: {
      layoutMode: "dual",
      panelProportions: [52, 58],
      sidebarWidth: 280,
      showTree: true,
      showSearch: true
    },
    panels: createPanels(emptyListing),
    activePanelId: "panel-1",
    bookmarks: [],
    hotlist: [],
    tagDefinitions: [],
    colorRules: [],
    shortcuts: [],
    remoteProfiles: [],
    tree: {},
    expandedTreeNodes: [],
    search: {
      namePattern: "",
      contentPattern: "",
      extensions: "",
      nameMode: "normal",
      contentMode: "normal",
      extensionFilterMode: "include",
      includeFolders: false,
      recursive: true,
      includeHidden: false,
      running: false,
      results: []
    },
    notifications: [],
    settingsOpen: false
  };
}

function updatePanel(state: WorkspaceState, panelId: string, updater: (panel: PanelState) => PanelState) {
  return {
    ...state,
    panels: state.panels.map((panel) => (panel.id === panelId ? updater(panel) : panel))
  };
}

function withActiveTab(panel: PanelState, tabId: string, updater: (tab: TabState) => TabState): PanelState {
  return {
    ...panel,
    tabs: panel.tabs.map((tab) => (tab.id === tabId ? updater(tab) : tab))
  };
}

function patchSettings(state: WorkspaceState, snapshot: SettingsSnapshot): WorkspaceState {
  return {
    ...state,
    bookmarks: snapshot.bookmarks,
    hotlist: snapshot.hotlist,
    tagDefinitions: snapshot.tagDefinitions,
    colorRules: snapshot.colorRules,
    shortcuts: snapshot.shortcuts,
    remoteProfiles: snapshot.remoteProfiles,
    layout: snapshot.layout
  };
}

export function workspaceReducer(state: WorkspaceState, action: Action): WorkspaceState {
  switch (action.type) {
    case "bootstrap":
      return {
        ...patchSettings(state, action.payload.settings),
        ready: true,
        drives: action.payload.drives,
        activePanelId: "panel-1",
        panels: createPanels(action.payload.initialListing),
        error: undefined
      };
    case "set-error":
      return { ...state, error: action.payload };
    case "set-layout":
      return {
        ...state,
        layout: {
          ...state.layout,
          layoutMode: action.payload
        }
      };
    case "set-panel-proportion":
      return {
        ...state,
        layout: {
          ...state.layout,
          panelProportions: state.layout.panelProportions.map((value, index) =>
            index === action.payload.index ? action.payload.value : value
          )
        }
      };
    case "set-active-panel":
      return { ...state, activePanelId: action.payload };
    case "set-panel-listing":
      return updatePanel(state, action.payload.panelId, (panel) =>
        withActiveTab(panel, action.payload.tabId, (tab) => ({
          ...tab,
          title: action.payload.listing.location.path.split("\\").pop() || action.payload.listing.location.path,
          path: action.payload.listing.location.path,
          listing: action.payload.listing,
          history:
            tab.history[tab.historyIndex] === action.payload.listing.location.path
              ? tab.history
              : [...tab.history.slice(0, tab.historyIndex + 1), action.payload.listing.location.path],
          historyIndex:
            tab.history[tab.historyIndex] === action.payload.listing.location.path
              ? tab.historyIndex
              : tab.historyIndex + 1,
          selectedPaths: []
        }))
      );
    case "restore-tab-history":
      return updatePanel(state, action.payload.panelId, (panel) =>
        withActiveTab(panel, action.payload.tabId, (tab) => ({
          ...tab,
          title: action.payload.listing.location.path.split("\\").pop() || action.payload.listing.location.path,
          path: action.payload.listing.location.path,
          listing: action.payload.listing,
          historyIndex: action.payload.historyIndex,
          selectedPaths: []
        }))
      );
    case "open-tab":
      return updatePanel(state, action.payload.panelId, (panel) => {
        const tab = createTab(action.payload.listing);
        return {
          ...panel,
          tabs: [...panel.tabs, tab],
          activeTabId: tab.id
        };
      });
    case "activate-tab":
      return updatePanel(state, action.payload.panelId, (panel) => ({
        ...panel,
        activeTabId: action.payload.tabId
      }));
    case "close-tab":
      return updatePanel(state, action.payload.panelId, (panel) => {
        const remainingTabs = panel.tabs.filter((tab) => tab.id !== action.payload.tabId);
        const nextTabs = remainingTabs.length > 0 ? remainingTabs : panel.tabs;
        return {
          ...panel,
          tabs: nextTabs,
          activeTabId:
            panel.activeTabId === action.payload.tabId
              ? nextTabs[Math.max(0, nextTabs.length - 1)].id
              : panel.activeTabId
        };
      });
    case "select-paths":
      return updatePanel(state, action.payload.panelId, (panel) =>
        withActiveTab(panel, action.payload.tabId, (tab) => ({
          ...tab,
          selectedPaths: action.payload.selectedPaths
        }))
      );
    case "toggle-settings":
      return { ...state, settingsOpen: action.payload ?? !state.settingsOpen };
    case "set-context-menu":
      return { ...state, contextMenu: action.payload };
    case "push-notification":
      return { ...state, notifications: [...state.notifications, action.payload] };
    case "dismiss-notification":
      return {
        ...state,
        notifications: state.notifications.filter((item) => item.id !== action.payload)
      };
    case "apply-settings":
      return patchSettings(state, action.payload);
    case "set-tree-children":
      return {
        ...state,
        tree: {
          ...state.tree,
          [action.payload.path]: action.payload.children
        }
      };
    case "toggle-tree-node":
      return {
        ...state,
        expandedTreeNodes: state.expandedTreeNodes.includes(action.payload)
          ? state.expandedTreeNodes.filter((item) => item !== action.payload)
          : [...state.expandedTreeNodes, action.payload]
      };
    case "set-search-running":
      return {
        ...state,
        search: {
          ...state.search,
          running: action.payload
        }
      };
    case "set-search-results":
      return {
        ...state,
        search: {
          ...state.search,
          results: action.payload
        }
      };
    case "set-search-query":
      return {
        ...state,
        search: {
          ...state.search,
          ...action.payload
        }
      };
    case "set-clipboard":
      return {
        ...state,
        clipboard: action.payload
      };
  }
}

export function getActiveTab(panel: PanelState) {
  return panel.tabs.find((tab) => tab.id === panel.activeTabId) ?? panel.tabs[0];
}

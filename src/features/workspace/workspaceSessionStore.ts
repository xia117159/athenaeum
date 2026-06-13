import { normalizeLocationPath } from "./mockData";
import { DEFAULT_LAYOUT_RATIOS, PANEL_IDS } from "./workspaceMappers";
import type {
  ColumnDefinition,
  InformationPanelTab,
  LayoutRatios,
  PanelId,
  PanelLayoutMode,
  SettingsModel,
  TabState,
  WorkspaceState
} from "./types";
import { isNavigationTab, NAVIGATION_VIRTUAL_PATH } from "./workspaceTabs";

export const WORKSPACE_SESSION_STORAGE_KEY = "SimpleFileManager.workspace.session.v1";

export type PersistedTab = {
  id: string;
  kind?: TabState["kind"];
  title: string;
  titleOverride?: string;
  locked?: boolean;
  path: string;
  virtualPath?: typeof NAVIGATION_VIRTUAL_PATH;
  history: string[];
  historyIndex: number;
  expandedNodePaths: string[];
  viewMode?: TabState["viewMode"];
  sort?: TabState["sort"];
  columns?: ColumnDefinition[];
};

export type PersistedPanel = {
  activeTabId: string;
  tabs: PersistedTab[];
};

export type PersistedLayoutRatios = Partial<LayoutRatios> & {
  secondary?: number;
};

export type PersistedInformationPanel = {
  expanded: boolean;
  activeTab: InformationPanelTab;
};

export type PersistedWorkspaceSession = {
  layoutMode: PanelLayoutMode;
  layoutRatios: PersistedLayoutRatios;
  informationPanel?: PersistedInformationPanel;
  activePanelId: PanelId;
  panels: Record<PanelId, PersistedPanel>;
  settingsModel: SettingsModel;
};

type WorkspaceStorage = Pick<Storage, "getItem" | "setItem">;

function getDefaultStorage(): WorkspaceStorage | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function readPersistedSession(storage: WorkspaceStorage | null | undefined = getDefaultStorage()): PersistedWorkspaceSession | null {
  if (!storage) {
    return null;
  }

  try {
    const raw = storage.getItem(WORKSPACE_SESSION_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as PersistedWorkspaceSession;
    return {
      ...parsed,
      informationPanel: normalizePersistedInformationPanel(parsed.informationPanel)
    };
  } catch {
    return null;
  }
}

export function writePersistedSession(
  session: PersistedWorkspaceSession,
  storage: WorkspaceStorage | null | undefined = getDefaultStorage()
) {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(WORKSPACE_SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Local storage can fail because of browser privacy settings or quota; keep the workspace usable.
  }
}

export function normalizeLayoutRatios(layoutRatios?: PersistedLayoutRatios | null): LayoutRatios {
  const legacySecondary = layoutRatios?.secondary;

  return {
    primary: layoutRatios?.primary ?? DEFAULT_LAYOUT_RATIOS.primary,
    tripleSecondary: layoutRatios?.tripleSecondary ?? legacySecondary ?? DEFAULT_LAYOUT_RATIOS.tripleSecondary,
    quadLeftSecondary: layoutRatios?.quadLeftSecondary ?? legacySecondary ?? DEFAULT_LAYOUT_RATIOS.quadLeftSecondary,
    quadRightSecondary: layoutRatios?.quadRightSecondary ?? legacySecondary ?? DEFAULT_LAYOUT_RATIOS.quadRightSecondary,
    tree: layoutRatios?.tree ?? DEFAULT_LAYOUT_RATIOS.tree,
    search: layoutRatios?.search ?? DEFAULT_LAYOUT_RATIOS.search
  };
}

export function normalizePersistedInformationPanel(
  informationPanel?: Partial<PersistedInformationPanel> | null
): PersistedInformationPanel {
  const activeTab =
    informationPanel?.activeTab === "properties" ||
    informationPanel?.activeTab === "search" ||
    informationPanel?.activeTab === "history"
      ? informationPanel.activeTab
      : "properties";

  return {
    expanded: informationPanel?.expanded === true,
    activeTab
  };
}

function toPersistedTab(tab: TabState): PersistedTab {
  if (isNavigationTab(tab)) {
    return {
      id: tab.id,
      kind: "navigation",
      title: tab.title,
      locked: tab.locked,
      path: tab.virtualPath ?? NAVIGATION_VIRTUAL_PATH,
      virtualPath: tab.virtualPath ?? NAVIGATION_VIRTUAL_PATH,
      history: [],
      historyIndex: 0,
      expandedNodePaths: [],
      viewMode: tab.viewMode,
      sort: tab.sort,
      columns: tab.columns.map((column) => ({ ...column }))
    };
  }

  return {
    id: tab.id,
    kind: tab.kind,
    title: tab.title,
    titleOverride: tab.titleOverride,
    locked: tab.locked,
    path: normalizeLocationPath(tab.snapshot.location.path),
    history: tab.history.map((item) => normalizeLocationPath(item)),
    historyIndex: tab.historyIndex,
    expandedNodePaths: Array.from(new Set(tab.expandedNodePaths.map((item) => normalizeLocationPath(item)))),
    viewMode: tab.viewMode,
    sort: tab.sort,
    columns: tab.columns.map((column) => ({ ...column }))
  };
}

function toPersistedPanel(state: WorkspaceState, panelId: PanelId): PersistedPanel {
  const seen = new Set<string>();
  const tabs = state.panels[panelId].tabs.filter((tab) => {
    if (tab.kind === "search-results") {
      return false;
    }
    if (seen.has(tab.id)) {
      return false;
    }
    seen.add(tab.id);
    return true;
  });
  const activeTabId = tabs.some((tab) => tab.id === state.panels[panelId].activeTabId)
    ? state.panels[panelId].activeTabId
    : tabs[0]?.id ?? state.panels[panelId].activeTabId;

  return {
    activeTabId,
    tabs: tabs.map(toPersistedTab)
  };
}

export function toPersistedSession(state: WorkspaceState): PersistedWorkspaceSession {
  return {
    layoutMode: state.layoutMode,
    layoutRatios: state.layoutRatios,
    informationPanel: {
      expanded: state.informationPanel.expanded,
      activeTab: state.informationPanel.activeTab
    },
    activePanelId: state.activePanelId,
    panels: Object.fromEntries(
      PANEL_IDS.map((panelId) => [panelId, toPersistedPanel(state, panelId)])
    ) as Record<PanelId, PersistedPanel>,
    settingsModel: state.settings.model
  };
}

export function writeWorkspaceSession(state: WorkspaceState, storage: WorkspaceStorage | null | undefined = getDefaultStorage()) {
  writePersistedSession(toPersistedSession(state), storage);
}

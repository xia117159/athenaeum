import assert from "node:assert/strict";
import { createMockWorkspaceBootstrap } from "./mockData";
import { createNavigationTab } from "./workspaceReducer";
import {
  normalizeLayoutRatios,
  readPersistedSession,
  toPersistedSession,
  WORKSPACE_SESSION_STORAGE_KEY,
  writePersistedSession,
  writeWorkspaceSession
} from "./workspaceSessionStore";
import type { WorkspaceState } from "./types";

function assertTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function createStorage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    snapshot() {
      return Object.fromEntries(values.entries());
    }
  };
}

function createWorkspaceState(): WorkspaceState {
  const bootstrap = createMockWorkspaceBootstrap("mock");
  const panelOne = bootstrap.panels["panel-1"];
  const firstTab = panelOne.tabs[0];

  return {
    status: "ready",
    source: bootstrap.source,
    layoutMode: "quad",
    layoutRatios: {
      primary: 0.61,
      tripleSecondary: 0.47,
      quadLeftSecondary: 0.43,
      quadRightSecondary: 0.58,
      tree: 0.31,
      search: 0.36
    },
    panels: {
      ...bootstrap.panels,
      "panel-1": {
        ...panelOne,
        tabs: [
          {
            ...firstTab,
            snapshot: {
              ...firstTab.snapshot,
              location: {
                ...firstTab.snapshot.location,
                path: "\\\\?\\E:\\Workspace"
              }
            },
            history: ["\\\\?\\E:\\Workspace", "E:\\Workspace\\Docs"],
            expandedNodePaths: ["\\\\?\\E:\\Workspace", "E:\\Workspace", "E:\\Workspace"]
          }
        ]
      }
    },
    activePanelId: "panel-1",
    directoryTree: bootstrap.directoryTree,
    bookmarks: bootstrap.bookmarks,
    hotlist: bootstrap.hotlist,
    navigation: {
      items: bootstrap.navigationItems,
      selectedItemIds: [],
      filterText: "",
      status: "idle"
    },
    remoteProfiles: bootstrap.remoteProfiles,
    search: {
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
      progress: {
        scannedEntries: 0,
        matchedEntries: 0,
        cancelled: false,
        statusText: "就绪"
      }
    },
    informationPanel: {
      expanded: true,
      activeTab: "history",
      properties: {
        status: "idle"
      }
    },
    settings: {
      section: "shortcuts",
      model: bootstrap.settingsModel
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

assertTest("normalizeLayoutRatios migrates legacy secondary split values", () => {
  assert.deepEqual(normalizeLayoutRatios({ primary: 0.7, secondary: 0.4, tree: 0.22 }), {
    primary: 0.7,
    tripleSecondary: 0.4,
    quadLeftSecondary: 0.4,
    quadRightSecondary: 0.4,
    tree: 0.22,
    search: 0.28
  });
});

assertTest("toPersistedSession stores tab paths, history, expansion, lock state, user title, view mode, and sort", () => {
  const base = createWorkspaceState();
  const sourceTab = base.panels["panel-1"].tabs[0];
  const session = toPersistedSession({
    ...base,
    panels: {
      ...base.panels,
      "panel-1": {
        ...base.panels["panel-1"],
        tabs: [
          {
            ...sourceTab,
            title: "Work Root",
            titleOverride: "Work Root",
            locked: true,
            columns: sourceTab.columns.map((column) =>
              column.id === "name"
                ? {
                    ...column,
                    width: "320px"
                  }
                : column
            )
          },
          ...base.panels["panel-1"].tabs.slice(1)
        ]
      }
    }
  });
  const tab = session.panels["panel-1"].tabs[0];

  assert.equal(session.layoutMode, "quad");
  assert.equal(session.activePanelId, "panel-1");
  assert.equal(tab.path, "E:\\Workspace");
  assert.equal(tab.title, "Work Root");
  assert.equal(tab.titleOverride, "Work Root");
  assert.equal(tab.locked, true);
  assert.deepEqual(tab.history, ["E:\\Workspace", "E:\\Workspace\\Docs"]);
  assert.deepEqual(tab.expandedNodePaths, ["E:\\Workspace"]);
  assert.equal(tab.viewMode, "details");
  assert.deepEqual(tab.sort, {
    columnId: "name",
    direction: "asc"
  });
  assert.equal(tab.columns?.find((column) => column.id === "name")?.width, "320px");
});

assertTest("toPersistedSession skips transient search results tabs", () => {
  const state = createWorkspaceState();
  const sourceTab = state.panels["panel-1"].tabs[0];
  const session = toPersistedSession({
    ...state,
    panels: {
      ...state.panels,
      "panel-1": {
        ...state.panels["panel-1"],
        tabs: [
          sourceTab,
          {
            ...sourceTab,
            id: "panel-1-search-results",
            title: "搜索结果",
            kind: "search-results",
            search: {
              sourceTabId: sourceTab.id,
              sourcePath: sourceTab.snapshot.location.path,
              query: state.search.query,
              results: [],
              progress: state.search.progress
            }
          }
        ],
        activeTabId: "panel-1-search-results"
      }
    }
  });

  assert.equal(session.panels["panel-1"].tabs.length, 1);
  assert.equal(session.panels["panel-1"].tabs[0].id, sourceTab.id);
  assert.equal(session.panels["panel-1"].activeTabId, sourceTab.id);
});

assertTest("toPersistedSession stores the bottom information panel state", () => {
  const session = toPersistedSession(createWorkspaceState());

  assert.deepEqual(session.informationPanel, {
    expanded: true,
    activeTab: "history"
  });
});

assertTest("toPersistedSession keeps a navigation tab as a virtual session tab", () => {
  const state = createWorkspaceState();
  const navigationTab = createNavigationTab("navigation-tab");
  const session = toPersistedSession({
    ...state,
    panels: {
      ...state.panels,
      "panel-1": {
        ...state.panels["panel-1"],
        tabs: [state.panels["panel-1"].tabs[0], navigationTab],
        activeTabId: navigationTab.id
      }
    }
  });

  const restored = session.panels["panel-1"].tabs.find((tab) => tab.kind === "navigation");

  assert.ok(restored);
  assert.equal(restored!.path, "navigation://shortcuts");
  assert.equal(restored!.virtualPath, "navigation://shortcuts");
  assert.equal(session.panels["panel-1"].activeTabId, navigationTab.id);
});

assertTest("readPersistedSession returns null for unavailable or malformed storage", () => {
  assert.equal(readPersistedSession(undefined), null);
  assert.equal(readPersistedSession(createStorage({ [WORKSPACE_SESSION_STORAGE_KEY]: "{broken" })), null);
});

assertTest("readPersistedSession normalizes old sessions without informationPanel", () => {
  const legacySession = toPersistedSession(createWorkspaceState());
  delete legacySession.informationPanel;
  const storage = createStorage({
    [WORKSPACE_SESSION_STORAGE_KEY]: JSON.stringify(legacySession)
  });

  const restored = readPersistedSession(storage);

  assert.deepEqual(restored?.informationPanel, {
    expanded: false,
    activeTab: "properties"
  });
});

assertTest("writePersistedSession ignores storage failures", () => {
  const session = toPersistedSession(createWorkspaceState());
  const throwingStorage = {
    getItem() {
      return null;
    },
    setItem() {
      throw new Error("quota exceeded");
    }
  };

  assert.doesNotThrow(() => writePersistedSession(session, throwingStorage));
});

assertTest("writeWorkspaceSession serializes the workspace session under the stable storage key", () => {
  const storage = createStorage();

  writeWorkspaceSession(createWorkspaceState(), storage);

  const raw = storage.snapshot()[WORKSPACE_SESSION_STORAGE_KEY];
  assert.ok(raw);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.layoutMode, "quad");
  assert.equal(parsed.panels["panel-1"].tabs[0].path, "E:\\Workspace");
});

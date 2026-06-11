import assert from "node:assert/strict";
import { createMockWorkspaceBootstrap } from "./mockData";
import {
  hydratePanels,
  mergeBootstrapWithSession,
  reviveTab
} from "./workspaceBootstrapSession";
import type { PersistedTab, PersistedWorkspaceSession } from "./workspaceSessionStore";
import type { DirectorySnapshot } from "./types";

function assertTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

async function assertAsyncTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function createSnapshot(path: string): DirectorySnapshot {
  const label = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  return {
    location: {
      kind: "local",
      label,
      path
    },
    breadcrumbs: [{ id: path, label, path }],
    entries: []
  };
}

function createPersistedTab(path: string, id = "restored-tab"): PersistedTab {
  return {
    id,
    title: "Restored",
    titleOverride: "Pinned Root",
    locked: true,
    path,
    history: [path, `${path}\\child`],
    historyIndex: 1,
    expandedNodePaths: [path],
    viewMode: "list",
  sort: {
      columnId: "modified",
      direction: "desc"
    }
  };
}

function createPersistedNavigationTab(id = "navigation-tab"): PersistedTab {
  return {
    id,
    kind: "navigation",
    title: "导航",
    path: "navigation://shortcuts",
    virtualPath: "navigation://shortcuts",
    history: [],
    historyIndex: 0,
    expandedNodePaths: []
  };
}

const remoteProfiles = [
  {
    id: "remote-1",
    name: "Edge",
    protocol: "sftp",
    host: "edge-01.internal",
    port: 22,
    username: "deploy",
    rootPath: "/releases"
  }
] as const;

export const workspaceBootstrapSessionTests = (async () => {
  await assertAsyncTest("mergeBootstrapWithSession returns base bootstrap when no session exists", async () => {
    const base = createMockWorkspaceBootstrap("tauri");

    assert.equal(await mergeBootstrapWithSession(base, null, []), base);
  });

  await assertAsyncTest("hydratePanels resolves unique seed paths into panel order", async () => {
    const base = createMockWorkspaceBootstrap("tauri");
    const resolvedPaths: string[] = [];

    const hydrated = await hydratePanels(base, ["E:\\One", "E:\\One", "E:\\Two"], [], async (path) => {
      resolvedPaths.push(path);
      return createSnapshot(path);
    });

    assert.deepEqual(resolvedPaths, ["E:\\One", "E:\\Two"]);
    assert.equal(hydrated.panels["panel-1"].tabs[0].snapshot.location.path, "E:\\One");
    assert.equal(hydrated.panels["panel-2"].tabs[0].snapshot.location.path, "E:\\Two");
    assert.equal(hydrated.panels["panel-1"].label, base.panels["panel-1"].label);
  });

  await assertAsyncTest("hydratePanels skips unreadable seed paths instead of failing workspace bootstrap", async () => {
    const base = createMockWorkspaceBootstrap("tauri");
    const resolvedPaths: string[] = [];

    const hydrated = await hydratePanels(base, ["E:\\Readable", "G:\\Offline", "F:\\AlsoReadable"], [], async (path) => {
      resolvedPaths.push(path);
      if (path === "G:\\Offline") {
        throw new Error("drive is not ready");
      }
      return createSnapshot(path);
    });

    assert.deepEqual(resolvedPaths, ["E:\\Readable", "G:\\Offline", "F:\\AlsoReadable"]);
    assert.equal(hydrated.panels["panel-1"].tabs[0].snapshot.location.path, "E:\\Readable");
    assert.equal(hydrated.panels["panel-2"].tabs[0].snapshot.location.path, base.panels["panel-2"].tabs[0].snapshot.location.path);
    assert.equal(hydrated.panels["panel-3"].tabs[0].snapshot.location.path, "F:\\AlsoReadable");
  });

  await assertAsyncTest("reviveTab restores a persisted tab from the resolver", async () => {
    const tab = await reviveTab(createPersistedTab("E:\\Restored"), createSnapshot("E:\\Fallback"), [], async (path) =>
      createSnapshot(path)
    );

    assert.equal(tab.id, "restored-tab");
    assert.equal(tab.title, "Pinned Root");
    assert.equal(tab.titleOverride, "Pinned Root");
    assert.equal(tab.locked, true);
    assert.equal(tab.snapshot.location.path, "E:\\Restored");
    assert.equal(tab.historyIndex, 1);
    assert.equal(tab.viewMode, "list");
    assert.deepEqual(tab.sort, {
      columnId: "modified",
      direction: "desc"
    });
  });

  await assertAsyncTest("reviveTab falls back to the existing panel snapshot when resolution fails", async () => {
    const fallback = createSnapshot("E:\\Fallback");
    const tab = await reviveTab(createPersistedTab("E:\\Missing"), fallback, [], async () => {
      throw new Error("missing");
    });

    assert.equal(tab.snapshot.location.path, "E:\\Fallback");
    assert.equal(tab.locked, true);
    assert.deepEqual(tab.history, ["E:\\Fallback"]);
    assert.equal(tab.historyIndex, 0);
  });

  await assertAsyncTest("reviveTab restores remote tabs lazily without connecting during session bootstrap", async () => {
    const remotePath = "sftp://deploy@edge-01.internal/releases/current";
    const resolvedPaths: string[] = [];
    const tab = await reviveTab(createPersistedTab(remotePath), createSnapshot("E:\\Fallback"), [...remoteProfiles], async () => {
      resolvedPaths.push(remotePath);
      return createSnapshot(remotePath);
    });

    assert.deepEqual(resolvedPaths, []);
    assert.equal(tab.id, "restored-tab");
    assert.equal(tab.locked, true);
    assert.equal(tab.status, "reconnect-required");
    assert.equal(tab.snapshot.location.kind, "sftp");
    assert.equal(tab.snapshot.location.path, remotePath);
    assert.equal(tab.addressDraft, remotePath);
    assert.equal(tab.reconnect?.path, remotePath);
    assert.equal(tab.reconnect?.message, undefined);
    assert.deepEqual(tab.history, [remotePath, `${remotePath}/child`]);
    assert.equal(tab.historyIndex, 1);
  });

  await assertAsyncTest("reviveTab restores navigation tabs without resolving the virtual path", async () => {
    const resolvedPaths: string[] = [];
    const tab = await reviveTab(createPersistedNavigationTab(), createSnapshot("E:\\Fallback"), [], async (path) => {
      resolvedPaths.push(path);
      return createSnapshot(path);
    });

    assert.deepEqual(resolvedPaths, []);
    assert.equal(tab.kind, "navigation");
    assert.equal(tab.snapshot.location.kind, "virtual");
    assert.equal(tab.snapshot.location.path, "navigation://shortcuts");
  });

  await assertAsyncTest("mergeBootstrapWithSession does not resolve remote tabs while restoring the workspace", async () => {
    const base = createMockWorkspaceBootstrap("tauri");
    const remotePath = "sftp://deploy@edge-01.internal/releases/current";
    const resolvedPaths: string[] = [];
    const session = {
      layoutMode: "dual",
      layoutRatios: {},
      activePanelId: "panel-1",
      panels: {
        "panel-1": {
          activeTabId: "remote-restored",
          tabs: [
            createPersistedTab(remotePath, "remote-restored"),
            createPersistedTab("E:\\Local", "local-restored")
          ]
        },
        "panel-2": {
          activeTabId: "missing",
          tabs: []
        },
        "panel-3": {
          activeTabId: "missing",
          tabs: []
        },
        "panel-4": {
          activeTabId: "missing",
          tabs: []
        }
      },
      settingsModel: base.settingsModel
    } as PersistedWorkspaceSession;

    const merged = await mergeBootstrapWithSession(base, session, [...remoteProfiles], async (path) => {
      resolvedPaths.push(path);
      return createSnapshot(path);
    });

    assert.deepEqual(resolvedPaths, ["E:\\Local"]);
    assert.equal(merged.panels["panel-1"].tabs[0].status, "reconnect-required");
    assert.equal(merged.panels["panel-1"].tabs[0].snapshot.location.path, remotePath);
    assert.equal(merged.panels["panel-1"].tabs[1].snapshot.location.path, "E:\\Local");
  });

  await assertAsyncTest("mergeBootstrapWithSession restores panel tabs, active panel, layout, and settings", async () => {
    const base = createMockWorkspaceBootstrap("tauri");
    const session = {
      layoutMode: "quad",
      layoutRatios: {
        primary: 0.61,
        secondary: 0.44,
        tree: 0.33
      },
      activePanelId: "panel-2",
      panels: {
        "panel-1": {
          activeTabId: "restored-tab",
          tabs: [createPersistedTab("E:\\Restored")]
        },
        "panel-2": {
          activeTabId: "missing",
          tabs: []
        },
        "panel-3": {
          activeTabId: "missing",
          tabs: []
        },
        "panel-4": {
          activeTabId: "missing",
          tabs: []
        }
      },
      settingsModel: {
        ...base.settingsModel,
        columns: [],
        detailsRowHeight: 999
      }
    } as PersistedWorkspaceSession;

    const merged = await mergeBootstrapWithSession(base, session, [], async (path) => createSnapshot(path));

    assert.equal(merged.activePanelId, "panel-2");
    assert.equal(merged.panels["panel-1"].activeTabId, "restored-tab");
    assert.equal(merged.panels["panel-1"].tabs[0].snapshot.location.path, "E:\\Restored");
    assert.equal(merged.layoutRatios.tripleSecondary, 0.44);
    assert.equal(merged.settingsModel.detailsRowHeight, 72);
    assert.ok(merged.settingsModel.columns.length > 0);
  });

  await assertAsyncTest("mergeBootstrapWithSession removes duplicate restored tab ids and keeps active ids valid", async () => {
    const base = createMockWorkspaceBootstrap("tauri");
    const session = {
      layoutMode: "single",
      layoutRatios: {},
      activePanelId: "panel-4",
      panels: {
        "panel-1": {
          activeTabId: "duplicate-tab",
          tabs: [
            createPersistedTab("E:\\First", "duplicate-tab"),
            createPersistedTab("E:\\Second", "duplicate-tab"),
            createPersistedTab("E:\\Third", "unique-tab")
          ]
        },
        "panel-2": {
          activeTabId: "missing",
          tabs: []
        },
        "panel-3": {
          activeTabId: "missing",
          tabs: []
        },
        "panel-4": {
          activeTabId: "missing",
          tabs: []
        }
      },
      settingsModel: base.settingsModel
    } as PersistedWorkspaceSession;

    const merged = await mergeBootstrapWithSession(base, session, [], async (path) => createSnapshot(path));

    assert.equal(merged.activePanelId, "panel-1");
    assert.deepEqual(merged.panels["panel-1"].tabs.map((tab) => tab.id), ["duplicate-tab", "unique-tab"]);
    assert.equal(merged.panels["panel-1"].activeTabId, "duplicate-tab");
  });

  await assertAsyncTest("mergeBootstrapWithSession keeps only one restored navigation tab globally", async () => {
    const base = createMockWorkspaceBootstrap("tauri");
    const session = {
      layoutMode: "dual",
      layoutRatios: {},
      activePanelId: "panel-2",
      panels: {
        "panel-1": {
          activeTabId: "navigation-tab-a",
          tabs: [createPersistedNavigationTab("navigation-tab-a")]
        },
        "panel-2": {
          activeTabId: "navigation-tab-b",
          tabs: [createPersistedNavigationTab("navigation-tab-b"), createPersistedTab("E:\\Local", "local-tab")]
        },
        "panel-3": {
          activeTabId: "missing",
          tabs: []
        },
        "panel-4": {
          activeTabId: "missing",
          tabs: []
        }
      },
      settingsModel: base.settingsModel
    } as PersistedWorkspaceSession;

    const merged = await mergeBootstrapWithSession(base, session, [], async (path) => createSnapshot(path));
    const navigationTabs = Object.values(merged.panels).flatMap((panel) => panel.tabs.filter((tab) => tab.kind === "navigation"));

    assert.equal(navigationTabs.length, 1);
    assert.equal(navigationTabs[0].id, "navigation-tab-b");
    assert.equal(merged.panels["panel-2"].activeTabId, "navigation-tab-b");
  });
})();

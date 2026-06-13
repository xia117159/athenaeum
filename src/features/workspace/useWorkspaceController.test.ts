import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { createMockWorkspaceBootstrap, createTabState, resolveMockDirectory } from "./mockData";
import { getParentPathForRefresh, useWorkspaceController } from "./useWorkspaceController";
import { createNavigationTab, getActiveTab } from "./workspaceReducer";
import type {
  DirectoryNode,
  EntryViewModel,
  OperationTaskSnapshot,
  RemoteConnectionProfile,
  SettingsModel,
  WorkspaceBootstrap
} from "./types";
import type { WorkspaceGateway } from "./workspaceGateway";

const { JSDOM } = require("jsdom") as {
  JSDOM: new (
    html?: string,
    options?: {
      url?: string;
    }
  ) => {
    window: Window & typeof globalThis;
  };
};

function assertTest(name: string, fn: () => Promise<void>) {
  return fn()
    .then(() => {
      console.log(`ok - ${name}`);
    })
    .catch((error) => {
      console.error(`not ok - ${name}`);
      throw error;
    });
}

function createTestGateway(
  onLoadBootstrap: () => void,
  interactions: {
    resolvedPaths: string[];
    copyCalls: Array<{ paths: string[]; destination: string }>;
    moveCalls: Array<{ paths: string[]; destination: string }>;
    deleteCalls: Array<{ paths: string[] }>;
    renameCalls: Array<{ source: string; newName: string }>;
    createDirectoryCalls: Array<{ parent: string; name: string }>;
    createFileCalls: Array<{ parent: string; name: string }>;
    treeLoadPaths: string[];
    savedDetailsRowHeights: number[];
    savedSettingsModels?: SettingsModel[];
    nativeContextMenus: Array<{ paths: string[]; x: number; y: number }>;
    navigationSaves?: Array<{ displayName?: string; description: string; path: string; id?: string }>;
    navigationDeletes?: string[];
    navigationReorders?: string[][];
    navigationMarks?: string[];
    navigationResolves?: string[][];
    systemOpens?: string[];
    hostKeyLookups?: string[];
    trustedHostKeys?: Array<{ profileId: string; keyBase64: string }>;
    cancelSearchIds?: string[];
    propertyCalls?: Array<{ requestId: string; path: string; includeDirectorySize?: boolean }>;
  },
  overrides: {
    loadBootstrap?: () => WorkspaceBootstrap | Promise<WorkspaceBootstrap>;
    loadTreeChildren?: (path: string) => DirectoryNode[] | Promise<DirectoryNode[]>;
    getItemProperties?: WorkspaceGateway["getItemProperties"];
    renameEntry?: WorkspaceGateway["renameEntry"];
    listOperationTasks?: WorkspaceGateway["listOperationTasks"];
    listenOperationTasks?: WorkspaceGateway["listenOperationTasks"];
  } = {}
): WorkspaceGateway {
  const emptyFavorites = { bookmarks: [], hotlist: [] };
  const emptyRemoteProfiles = { remoteProfiles: [] as RemoteConnectionProfile[] };
  const createOperationTask = (taskId = "operation-test"): OperationTaskSnapshot => ({
    taskId,
    requestId: `request-${taskId}`,
    kind: "copy",
    label: "Test operation",
    status: "succeeded",
    createdAt: "2026-06-10T08:00:00Z",
    startedAt: "2026-06-10T08:00:00Z",
    finishedAt: "2026-06-10T08:00:01Z",
    totalEntries: 1,
    completedEntries: 1,
    failedEntries: 0,
    totalBytes: null,
    completedBytes: null,
    currentPath: null,
    message: null,
    cancelable: false,
    undoable: true,
    affectedRoots: [],
    entryResults: [],
    sequence: 1,
    updatedAt: "2026-06-10T08:00:01Z"
  });

  return {
    async loadBootstrap() {
      onLoadBootstrap();
      return overrides.loadBootstrap ? overrides.loadBootstrap() : createMockWorkspaceBootstrap("tauri");
    },
    async resolveDirectory(path) {
      interactions.resolvedPaths.push(path);
      return resolveMockDirectory(path);
    },
    async loadTreeChildren(path) {
      interactions.treeLoadPaths.push(path);
      return overrides.loadTreeChildren ? overrides.loadTreeChildren(path) : [];
    },
    async search() {
      return [];
    },
    async cancelSearch(searchId: string) {
      interactions.cancelSearchIds?.push(searchId);
    },
    async getItemProperties(requestId: string, path: string, includeDirectorySize = false) {
      interactions.propertyCalls?.push({ requestId, path, includeDirectorySize });
      if (overrides.getItemProperties) {
        return overrides.getItemProperties(requestId, path, includeDirectorySize);
      }
      return {
        requestId,
        target: {
          kind: "local" as const,
          path
        },
        displayPath: path,
        actualPath: path,
        parentPath: "D:\\Projects\\Atlas",
        name: path.split("\\").pop() ?? path,
        extension: ".txt",
        kind: "file" as const,
        sizeBytes: 1024,
        allocatedBytes: null,
        createdAt: null,
        modifiedAt: "2026-06-10T08:00:00Z",
        accessedAt: null,
        isHidden: false,
        isReadOnly: false,
        isSymlink: false,
        directorySizeState: {
          state: "notApplicable" as const
        },
        fieldStates: []
      };
    },
    async saveSession() {},
    async saveLayout() {},
    async saveShortcuts() {},
    async saveColorRules() {},
    async saveDetailsRowHeight(value: number) {
      interactions.savedDetailsRowHeights.push(value);
    },
    async saveTheme() {},
    async saveSettingsModel(model: SettingsModel) {
      interactions.savedSettingsModels?.push(model);
    },
    async listOperationTasks() {
      if (overrides.listOperationTasks) {
        return overrides.listOperationTasks();
      }
      return { tasks: [], taskSequence: 0 };
    },
    async listOperationHistory() {
      return { records: [], historySequence: 0 };
    },
    async listenOperationTasks(handler) {
      if (overrides.listenOperationTasks) {
        return overrides.listenOperationTasks(handler);
      }
      return () => undefined;
    },
    async listenOperationConflicts() {
      return () => undefined;
    },
    async listenOperationHistory() {
      return () => undefined;
    },
    async listenSettingsChanged() {
      return () => undefined;
    },
    async saveBookmark() {
      return emptyFavorites;
    },
    async deleteBookmark() {
      return emptyFavorites;
    },
    async saveHotlist() {
      return emptyFavorites;
    },
    async deleteHotlist() {
      return emptyFavorites;
    },
    async saveRemoteProfile() {
      return emptyRemoteProfiles;
    },
    async deleteRemoteProfile() {
      return emptyRemoteProfiles;
    },
    async testRemoteProfile() {
      return { success: true, adapter: "unsupported" as const, message: "ok", details: [] };
    },
    async getRemoteHostKey(profileId: string) {
      interactions.hostKeyLookups?.push(profileId);
      return {
        profileId,
        host: "edge-01",
        port: 22,
        algorithm: "ssh-ed25519",
        fingerprintSha256: "SHA256:test",
        keyBase64: "AAAA",
        knownHostsEntry: "edge-01 ssh-ed25519 AAAA",
        trustState: "unknown" as const
      };
    },
    async trustRemoteHostKey(request) {
      interactions.trustedHostKeys?.push({ profileId: request.profileId, keyBase64: request.keyBase64 });
      return {
        profileId: request.profileId,
        host: request.host,
        port: request.port,
        algorithm: request.algorithm,
        fingerprintSha256: "SHA256:test",
        keyBase64: request.keyBase64,
        knownHostsEntry: `${request.host} ${request.algorithm} ${request.keyBase64}`,
        trustState: "trusted" as const
      };
    },
    async copyEntries(paths, destination) {
      interactions.copyCalls.push({ paths: [...paths], destination });
    },
    async moveEntries(paths, destination) {
      interactions.moveCalls.push({ paths: [...paths], destination });
    },
    async deleteEntries(paths) {
      interactions.deleteCalls.push({ paths: [...paths] });
    },
    async renameEntry(source, newName) {
      if (overrides.renameEntry) {
        return overrides.renameEntry(source, newName);
      }
      interactions.renameCalls.push({ source, newName });
    },
    async createDirectory(parent, name) {
      interactions.createDirectoryCalls.push({ parent, name });
    },
    async createFile(parent, name) {
      interactions.createFileCalls.push({ parent, name });
    },
    async cancelOperation(taskId) {
      return { ...createOperationTask(taskId), status: "cancelled" };
    },
    async resolveOperationConflict() {
      return createOperationTask("resolved-conflict");
    },
    async undoLatestOperation() {
      return { ...createOperationTask("undo-latest"), kind: "undo" };
    },
    async undoOperation(recordId) {
      return { ...createOperationTask(`undo-${recordId}`), kind: "undo" };
    },
    async showNativeContextMenu(paths: string[], x: number, y: number) {
      interactions.nativeContextMenus.push({ paths: [...paths], x, y });
      return true;
    },
    async saveNavigationItem(request) {
      interactions.navigationSaves?.push({ ...request });
      const item = {
        id: request.id ?? `nav-${(interactions.navigationSaves?.length ?? 1).toString()}`,
        displayName: request.displayName?.trim() || request.path.split(/[\\/]/).filter(Boolean).pop() || request.path,
        description: request.description.trim(),
        path: request.path.trim(),
        targetKind: "missing" as const,
        targetStatus: "missing" as const,
        sortOrder: interactions.navigationSaves?.length ?? 1,
        createdAt: "2026-06-08T09:00:00Z",
        updatedAt: "2026-06-08T09:00:00Z"
      };
      return { navigationItems: [item] };
    },
    async deleteNavigationItem(id) {
      interactions.navigationDeletes?.push(id);
      return { navigationItems: [] };
    },
    async reorderNavigationItems(ids) {
      interactions.navigationReorders?.push([...ids]);
      return { navigationItems: [] };
    },
    async markNavigationItemOpened(id) {
      interactions.navigationMarks?.push(id);
      return {
        navigationItems: [
          {
            id,
            displayName: id,
            description: "",
            path: id,
            targetKind: "missing" as const,
            targetStatus: "missing" as const,
            sortOrder: 1,
            createdAt: "2026-06-08T09:00:00Z",
            updatedAt: "2026-06-08T10:00:00Z",
            lastOpenedAt: "2026-06-08T10:00:00Z"
          }
        ]
      };
    },
    async resolveNavigationTargets(paths) {
      interactions.navigationResolves?.push([...paths]);
      return paths.map((path) => ({
        path,
        normalizedPath: path,
        canonicalPath: null,
        displayName: path.split(/[\\/]/).filter(Boolean).pop() || path,
        targetKind: "missing" as const,
        targetStatus: "missing" as const,
        message: "missing",
        exists: false,
        isLocal: true,
        parentPath: null
      }));
    },
    async openPathWithSystemDefault(path) {
      interactions.systemOpens?.push(path);
    }
  };
}

function installDomEnvironment() {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost"
  });

  globalThis.window = dom.window as typeof globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: dom.window.localStorage
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  return dom;
}

async function flushEffects() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) {
      return;
    }
    await act(async () => {
      await flushEffects();
    });
  }

  assert.fail(message);
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

function createEntry(parentPath: string, name: string, kind: EntryViewModel["kind"] = "file"): EntryViewModel {
  const separator = parentPath.startsWith("ftp://") || parentPath.startsWith("sftp://") ? "/" : "\\";
  const path = parentPath.endsWith(separator) ? `${parentPath}${name}` : `${parentPath}${separator}${name}`;
  const sizeBytes = kind === "folder" ? null : 1024;
  return {
    id: `${parentPath}:${name}`,
    name,
    kind,
    path,
    parentPath,
    sizeLabel: kind === "folder" ? "--" : "1 KB",
    sizeBytes,
    modifiedLabel: "2026-04-21 10:00",
    extension: kind === "folder" ? "" : name.includes(".") ? `.${name.split(".").pop()}` : "",
    attributes: kind === "folder" ? ["D"] : ["A"],
    accentColor: "#0f6cbd",
    tags: [],
    description: name
  };
}

export const completion = (async () => {
  const dom = installDomEnvironment();
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("test root container is missing");
  }

  let bootstrapCalls = 0;
  let latestController: ReturnType<typeof useWorkspaceController> | undefined;
  const interactions = {
    resolvedPaths: [] as string[],
    copyCalls: [] as Array<{ paths: string[]; destination: string }>,
    moveCalls: [] as Array<{ paths: string[]; destination: string }>,
    deleteCalls: [] as Array<{ paths: string[] }>,
    renameCalls: [] as Array<{ source: string; newName: string }>,
    createDirectoryCalls: [] as Array<{ parent: string; name: string }>,
    createFileCalls: [] as Array<{ parent: string; name: string }>,
    treeLoadPaths: [] as string[],
    savedDetailsRowHeights: [] as number[],
    nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>,
    systemOpens: [] as string[],
    propertyCalls: [] as Array<{ requestId: string; path: string; includeDirectorySize?: boolean }>
  };

  const gateway = createTestGateway(() => {
    bootstrapCalls += 1;
  }, interactions);

  function Harness() {
    latestController = useWorkspaceController(gateway);
    return React.createElement("div", null, latestController.state.layoutMode);
  }

  const root = ReactDOM.createRoot(container);

  try {
    await assertTest("useWorkspaceController computes parent refresh paths for real remote URIs", async () => {
      assert.equal(
        getParentPathForRefresh("sftp://cheng@127.0.0.1:6666/home/cheng/report.txt"),
        "sftp://cheng@127.0.0.1:6666/home/cheng"
      );
      assert.equal(
        getParentPathForRefresh("sftp://cheng@127.0.0.1:6666/home/cheng/nested/"),
        "sftp://cheng@127.0.0.1:6666/home/cheng"
      );
      assert.equal(getParentPathForRefresh("sftp://cheng@127.0.0.1:6666/"), null);
      assert.equal(getParentPathForRefresh("C:\\Users\\Admin\\Downloads\\Installer.msi"), "C:\\Users\\Admin\\Downloads");
    });

    await assertTest("useWorkspaceController bootstraps once even after state updates rerender the hook", async () => {
      await act(async () => {
        root.render(React.createElement(Harness));
        await flushEffects();
      });

      assert.equal(bootstrapCalls, 1);
      assert.equal(latestController?.state.layoutMode, "quad");

      await act(async () => {
        latestController?.actions.setLayoutMode("dual");
        await flushEffects();
      });

      assert.equal(bootstrapCalls, 1);
      assert.equal(latestController?.state.layoutMode, "dual");
    });

    await assertTest("useWorkspaceController opens file entries through the system default app", async () => {
      interactions.systemOpens.length = 0;
      const activeTab = getActiveTab(latestController!.state.panels["panel-1"]);
      assert.equal(activeTab.kind, "directory");
      const file = createEntry(activeTab.snapshot.location.path, "notes.txt", "file");

      await act(async () => {
        latestController?.actions.openEntry("panel-1", file);
        await flushEffects();
      });

      await waitFor(() => interactions.systemOpens.includes(file.path), "file entry was not opened through the system default app");
      assert.deepEqual(interactions.systemOpens, [file.path]);
    });

    await assertTest("useWorkspaceController loads properties for the current folder and selected item", async () => {
      interactions.propertyCalls.length = 0;
      const activeTab = getActiveTab(latestController!.state.panels["panel-1"]);
      const selectedEntry = activeTab.snapshot.entries.find((entry) => entry.kind === "file") ?? activeTab.snapshot.entries[0];
      assert.ok(selectedEntry);

      await act(async () => {
        latestController?.actions.setInformationPanelExpanded(true);
        latestController?.actions.selectInformationPanelTab("properties");
        await flushEffects();
      });

      await waitFor(() => interactions.propertyCalls.length >= 1, "current folder properties were not requested");
      assert.deepEqual(interactions.propertyCalls.at(-1), {
        requestId: "properties-1",
        path: activeTab.snapshot.location.path,
        includeDirectorySize: false
      });

      await act(async () => {
        latestController?.actions.selectEntry("panel-1", activeTab.id, selectedEntry.id, false);
        await flushEffects();
      });

      await waitFor(
        () => interactions.propertyCalls.some((call) => call.path === selectedEntry.path),
        "selected item properties were not requested"
      );
      assert.equal(latestController?.state.informationPanel.properties.status, "ready");
      assert.equal(latestController?.state.informationPanel.properties.item?.actualPath, selectedEntry.path);
    });

    await assertTest("useWorkspaceController creates multi-selection properties summary without per-entry IPC", async () => {
      const activeTab = getActiveTab(latestController!.state.panels["panel-1"]);
      const selectableEntries = activeTab.snapshot.entries.slice(0, 2);
      assert.equal(selectableEntries.length, 2);
      interactions.propertyCalls.length = 0;

      await act(async () => {
        latestController?.actions.selectMultipleEntries(
          "panel-1",
          activeTab.id,
          selectableEntries.map((entry) => entry.id)
        );
        await flushEffects();
      });

      await waitFor(
        () => latestController?.state.informationPanel.properties.summary?.count === 2,
        "multi-selection properties summary was not created"
      );
      assert.deepEqual(interactions.propertyCalls, []);
      assert.equal(latestController?.state.informationPanel.properties.summary?.knownSizeBytes, selectableEntries.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0));
    });

    await assertTest("useWorkspaceController sets common extension only when every selected entry is a file with that extension", async () => {
      const extensionInteractions = {
        resolvedPaths: [] as string[],
        copyCalls: [] as Array<{ paths: string[]; destination: string }>,
        moveCalls: [] as Array<{ paths: string[]; destination: string }>,
        deleteCalls: [] as Array<{ paths: string[] }>,
        renameCalls: [] as Array<{ source: string; newName: string }>,
        createDirectoryCalls: [] as Array<{ parent: string; name: string }>,
        createFileCalls: [] as Array<{ parent: string; name: string }>,
        treeLoadPaths: [] as string[],
        savedDetailsRowHeights: [] as number[],
        nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>,
        propertyCalls: [] as Array<{ requestId: string; path: string; includeDirectorySize?: boolean }>
      };
      const extensionBootstrap = createMockWorkspaceBootstrap("tauri");
      const extensionPanel = extensionBootstrap.panels["panel-1"];
      const extensionTab = getActiveTab(extensionPanel);
      const parentPath = extensionTab.snapshot.location.path;
      const txtFile = createEntry(parentPath, "report.txt");
      const secondTxtFile = createEntry(parentPath, "notes.txt");
      const noExtensionFile = createEntry(parentPath, "README");
      const folder = createEntry(parentPath, "src", "folder");
      extensionPanel.tabs = extensionPanel.tabs.map((tab) =>
        tab.id === extensionTab.id
          ? {
              ...tab,
              snapshot: {
                ...tab.snapshot,
                entries: [txtFile, secondTxtFile, noExtensionFile, folder]
              }
            }
          : tab
      );

      let extensionController: ReturnType<typeof useWorkspaceController> | undefined;
      const extensionGateway = createTestGateway(() => undefined, extensionInteractions, {
        loadBootstrap: () => extensionBootstrap
      });

      function ExtensionHarness() {
        extensionController = useWorkspaceController(extensionGateway);
        return React.createElement("div", null, extensionController.state.status);
      }

      const extensionContainer = document.createElement("div");
      document.body.appendChild(extensionContainer);
      const extensionRoot = ReactDOM.createRoot(extensionContainer);

      async function selectForSummary(ids: string[]) {
        await act(async () => {
          extensionController?.actions.setInformationPanelExpanded(true);
          extensionController?.actions.selectInformationPanelTab("properties");
          extensionController?.actions.selectMultipleEntries("panel-1", extensionTab.id, ids);
          await flushEffects();
        });
        await waitFor(
          () => extensionController?.state.informationPanel.properties.summary?.selectionKey === ids.join("|"),
          "multi-selection extension summary was not updated"
        );
        return extensionController!.state.informationPanel.properties.summary;
      }

      try {
        await act(async () => {
          extensionRoot.render(React.createElement(ExtensionHarness));
          await flushEffects();
        });
        await waitFor(() => extensionController?.state.status === "ready", "extension controller did not bootstrap");

        assert.equal((await selectForSummary([txtFile.id, folder.id]))?.commonExtension, undefined);
        assert.equal((await selectForSummary([txtFile.id, noExtensionFile.id]))?.commonExtension, undefined);
        assert.equal((await selectForSummary([txtFile.id, secondTxtFile.id]))?.commonExtension, ".txt");
        assert.deepEqual(extensionInteractions.propertyCalls, []);
      } finally {
        await act(async () => {
          extensionRoot.unmount();
          await flushEffects();
        });
        extensionContainer.remove();
      }
    });

    await assertTest("useWorkspaceController ignores a deferred properties result after selection changes", async () => {
      const raceInteractions = {
        resolvedPaths: [] as string[],
        copyCalls: [] as Array<{ paths: string[]; destination: string }>,
        moveCalls: [] as Array<{ paths: string[]; destination: string }>,
        deleteCalls: [] as Array<{ paths: string[] }>,
        renameCalls: [] as Array<{ source: string; newName: string }>,
        createDirectoryCalls: [] as Array<{ parent: string; name: string }>,
        createFileCalls: [] as Array<{ parent: string; name: string }>,
        treeLoadPaths: [] as string[],
        savedDetailsRowHeights: [] as number[],
        nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>,
        propertyCalls: [] as Array<{ requestId: string; path: string; includeDirectorySize?: boolean }>
      };
      type DeferredPropertyRequest = {
        requestId: string;
        path: string;
        resolve: (path: string) => void;
      };
      const pendingRequests: DeferredPropertyRequest[] = [];
      const createPropertyItem = (requestId: string, path: string) => ({
        requestId,
        target: {
          kind: "local" as const,
          path
        },
        displayPath: path,
        actualPath: path,
        parentPath: "D:\\Projects\\Atlas",
        name: path.split("\\").pop() ?? path,
        extension: ".txt",
        kind: "file" as const,
        sizeBytes: 1024,
        allocatedBytes: null,
        createdAt: null,
        modifiedAt: "2026-06-10T08:00:00Z",
        accessedAt: null,
        isHidden: false,
        isReadOnly: false,
        isSymlink: false,
        directorySizeState: {
          state: "notApplicable" as const
        },
        fieldStates: []
      });

      let raceController: ReturnType<typeof useWorkspaceController> | undefined;
      const raceGateway = createTestGateway(() => undefined, raceInteractions, {
        loadBootstrap: () => createMockWorkspaceBootstrap("tauri"),
        getItemProperties: (requestId, path) =>
          new Promise((resolve) => {
            pendingRequests.push({
              requestId,
              path,
              resolve: (resolvedPath: string) => resolve(createPropertyItem(requestId, resolvedPath))
            });
          })
      });

      function RaceHarness() {
        raceController = useWorkspaceController(raceGateway);
        return React.createElement("div", null, raceController.state.status);
      }

      const raceContainer = document.createElement("div");
      document.body.appendChild(raceContainer);
      const raceRoot = ReactDOM.createRoot(raceContainer);

      try {
        await act(async () => {
          raceRoot.render(React.createElement(RaceHarness));
          await flushEffects();
        });
        await waitFor(() => raceController?.state.status === "ready", "race controller did not bootstrap");

        const activeTab = getActiveTab(raceController!.state.panels["panel-1"]);
        const selectedEntry = activeTab.snapshot.entries.find((entry) => entry.kind === "file") ?? activeTab.snapshot.entries[0];
        assert.ok(selectedEntry);

        await act(async () => {
          raceController?.actions.setInformationPanelExpanded(true);
          raceController?.actions.selectInformationPanelTab("properties");
          await flushEffects();
        });
        await waitFor(() => pendingRequests.length >= 1, "initial properties request did not start");
        const folderRequest = pendingRequests[0];

        await act(async () => {
          raceController?.actions.selectEntry("panel-1", activeTab.id, selectedEntry.id, false);
          folderRequest.resolve(folderRequest.path);
          await flushEffects();
        });

        assert.notEqual(raceController?.state.informationPanel.properties.item?.actualPath, folderRequest.path);

        await waitFor(() => pendingRequests.some((request) => request.path === selectedEntry.path), "selected properties request did not start");
        const selectedRequest = pendingRequests.find((request) => request.path === selectedEntry.path);
        assert.ok(selectedRequest);
        await act(async () => {
          selectedRequest.resolve(selectedEntry.path);
          await flushEffects();
        });
        await waitFor(
          () => raceController?.state.informationPanel.properties.item?.actualPath === selectedEntry.path,
          "selected properties result was not stored"
        );
      } finally {
        await act(async () => {
          raceRoot.unmount();
          await flushEffects();
        });
        raceContainer.remove();
      }
    });

    await assertTest("useWorkspaceController opens new tabs with unique ids and isolated editable state", async () => {
      interactions.resolvedPaths.length = 0;
      const sourceTab = latestController?.state.panels["panel-1"].tabs[0];
      assert.ok(sourceTab);

      await act(async () => {
        latestController?.actions.activateTab("panel-1", sourceTab.id);
        await flushEffects();
      });

      await act(async () => {
        latestController?.actions.openNewTab("panel-1");
        await flushEffects();
      });

      await waitFor(() => (latestController?.state.panels["panel-1"].tabs.length ?? 0) > 2, "new tab was not opened");

      const tabs = latestController!.state.panels["panel-1"].tabs;
      const newTab = tabs[tabs.length - 1];
      assert.equal(new Set(tabs.map((tab) => tab.id)).size, tabs.length);
      assert.notEqual(newTab.id, sourceTab.id);
      assert.deepEqual(interactions.resolvedPaths.at(-1), sourceTab.snapshot.location.path);

      await act(async () => {
        latestController?.actions.updateAddressDraft("panel-1", newTab.id, "C:\\Users\\Admin\\Downloads");
        latestController?.actions.selectEntry("panel-1", newTab.id, "download-1", false);
        await flushEffects();
      });

      const updatedSource = latestController!.state.panels["panel-1"].tabs.find((tab) => tab.id === sourceTab.id);
      const updatedNewTab = latestController!.state.panels["panel-1"].tabs.find((tab) => tab.id === newTab.id);

      assert.equal(updatedSource?.addressDraft, sourceTab.addressDraft);
      assert.deepEqual(updatedSource?.selectedEntryIds, sourceTab.selectedEntryIds);
      assert.equal(updatedNewTab?.addressDraft, "C:\\Users\\Admin\\Downloads");
      assert.deepEqual(updatedNewTab?.selectedEntryIds, ["download-1"]);
    });

    await assertTest("useWorkspaceController opens navigation tabs without resolving a virtual directory and guards directory commands", async () => {
      const navigationInteractions = {
        resolvedPaths: [] as string[],
        copyCalls: [] as Array<{ paths: string[]; destination: string }>,
        moveCalls: [] as Array<{ paths: string[]; destination: string }>,
        deleteCalls: [] as Array<{ paths: string[] }>,
        renameCalls: [] as Array<{ source: string; newName: string }>,
        createDirectoryCalls: [] as Array<{ parent: string; name: string }>,
        createFileCalls: [] as Array<{ parent: string; name: string }>,
        treeLoadPaths: [] as string[],
        savedDetailsRowHeights: [] as number[],
        nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>,
        navigationResolves: [] as string[][]
      };
      let navigationController: ReturnType<typeof useWorkspaceController> | undefined;
      const navigationGateway = createTestGateway(() => undefined, navigationInteractions, {
        loadBootstrap: () => createMockWorkspaceBootstrap("tauri")
      });

      function NavigationHarness() {
        navigationController = useWorkspaceController(navigationGateway);
        return React.createElement("div", null, navigationController.state.status);
      }

      const navigationContainer = document.createElement("div");
      document.body.appendChild(navigationContainer);
      const navigationRoot = ReactDOM.createRoot(navigationContainer);

      try {
        await act(async () => {
          navigationRoot.render(React.createElement(NavigationHarness));
          await flushEffects();
        });
        await waitFor(() => navigationController?.state.status === "ready", "navigation controller did not bootstrap");

        await act(async () => {
          navigationController?.actions.openNavigationTab();
          await flushEffects();
        });

        const panel = navigationController!.state.panels[navigationController!.state.activePanelId];
        const activeTab = panel.tabs.find((tab) => tab.id === panel.activeTabId);
        assert.equal(activeTab?.kind, "navigation");
        assert.equal(activeTab?.snapshot.location.kind, "virtual");
        assert.equal(navigationInteractions.resolvedPaths.includes("navigation://shortcuts"), false);

        await act(async () => {
          navigationController?.actions.createFolder(navigationController.state.activePanelId);
          navigationController?.actions.createFile(navigationController.state.activePanelId);
          navigationController?.actions.refreshPanel(navigationController.state.activePanelId);
          await flushEffects();
        });

        assert.deepEqual(navigationInteractions.createDirectoryCalls, []);
        assert.deepEqual(navigationInteractions.createFileCalls, []);
        assert.deepEqual(navigationInteractions.navigationResolves, [[]]);
      } finally {
        await act(async () => {
          navigationRoot.unmount();
          await flushEffects();
        });
        navigationContainer.remove();
      }
    });

    await assertTest("useWorkspaceController saves explicit navigation page context while navigation tab is active", async () => {
      const explicitInteractions = {
        resolvedPaths: [] as string[],
        copyCalls: [] as Array<{ paths: string[]; destination: string }>,
        moveCalls: [] as Array<{ paths: string[]; destination: string }>,
        deleteCalls: [] as Array<{ paths: string[] }>,
        renameCalls: [] as Array<{ source: string; newName: string }>,
        createDirectoryCalls: [] as Array<{ parent: string; name: string }>,
        createFileCalls: [] as Array<{ parent: string; name: string }>,
        treeLoadPaths: [] as string[],
        savedDetailsRowHeights: [] as number[],
        nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>,
        navigationSaves: [] as Array<{ displayName?: string; description: string; path: string; id?: string }>
      };
      const explicitBootstrap = createMockWorkspaceBootstrap("tauri");
      const directoryTab = explicitBootstrap.panels["panel-1"].tabs[0];
      const selectedEntry = createEntry("C:\\Users\\Admin\\Documents", "from-navigation.txt");
      const navigationTab = createNavigationTab("navigation-tab");
      explicitBootstrap.panels["panel-1"] = {
        ...explicitBootstrap.panels["panel-1"],
        tabs: [directoryTab, navigationTab],
        activeTabId: navigationTab.id
      };
      explicitBootstrap.activePanelId = "panel-1";

      let explicitController: ReturnType<typeof useWorkspaceController> | undefined;
      const explicitGateway = createTestGateway(() => undefined, explicitInteractions, {
        loadBootstrap: () => explicitBootstrap
      });

      function ExplicitHarness() {
        explicitController = useWorkspaceController(explicitGateway);
        return React.createElement("div", null, explicitController.state.status);
      }

      const explicitContainer = document.createElement("div");
      document.body.appendChild(explicitContainer);
      const explicitRoot = ReactDOM.createRoot(explicitContainer);

      try {
        await act(async () => {
          explicitRoot.render(React.createElement(ExplicitHarness));
          await flushEffects();
        });
        await waitFor(() => explicitController?.state.status === "ready", "explicit controller did not bootstrap");

        await act(async () => {
          explicitController?.actions.addCurrentFolderToNavigation({
            displayName: "Documents",
            path: "C:\\Users\\Admin\\Documents"
          });
          explicitController?.actions.addSelectedEntriesToNavigation("panel-1", [selectedEntry]);
          await flushEffects();
        });

        await waitFor(
          () => explicitInteractions.navigationSaves.length === 2,
          "explicit navigation context was not saved"
        );
        assert.deepEqual(explicitInteractions.navigationSaves, [
          {
            displayName: "Documents",
            description: "",
            path: "C:\\Users\\Admin\\Documents"
          },
          {
            displayName: "from-navigation.txt",
            description: "",
            path: "C:\\Users\\Admin\\Documents\\from-navigation.txt"
          }
        ]);
      } finally {
        await act(async () => {
          explicitRoot.unmount();
          await flushEffects();
        });
        explicitContainer.remove();
      }
    });

    await assertTest("useWorkspaceController moves a single navigation tab after creating a fallback directory tab", async () => {
      const moveInteractions = {
        resolvedPaths: [] as string[],
        copyCalls: [] as Array<{ paths: string[]; destination: string }>,
        moveCalls: [] as Array<{ paths: string[]; destination: string }>,
        deleteCalls: [] as Array<{ paths: string[] }>,
        renameCalls: [] as Array<{ source: string; newName: string }>,
        createDirectoryCalls: [] as Array<{ parent: string; name: string }>,
        createFileCalls: [] as Array<{ parent: string; name: string }>,
        treeLoadPaths: [] as string[],
        savedDetailsRowHeights: [] as number[],
        nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>
      };
      const moveBootstrap = createMockWorkspaceBootstrap("tauri");
      const navigationTab = createNavigationTab("navigation-tab");
      moveBootstrap.panels["panel-1"] = {
        ...moveBootstrap.panels["panel-1"],
        tabs: [navigationTab],
        activeTabId: navigationTab.id
      };
      moveBootstrap.activePanelId = "panel-1";

      let moveController: ReturnType<typeof useWorkspaceController> | undefined;
      const moveGateway = createTestGateway(() => undefined, moveInteractions, {
        loadBootstrap: () => moveBootstrap
      });

      function MoveHarness() {
        moveController = useWorkspaceController(moveGateway);
        return React.createElement("div", null, moveController.state.status);
      }

      const moveContainer = document.createElement("div");
      document.body.appendChild(moveContainer);
      const moveRoot = ReactDOM.createRoot(moveContainer);

      try {
        await act(async () => {
          moveRoot.render(React.createElement(MoveHarness));
          await flushEffects();
        });
        await waitFor(() => moveController?.state.status === "ready", "move controller did not bootstrap");

        await act(async () => {
          moveController?.actions.moveTab("panel-1", "panel-2", "navigation-tab", 0);
          await flushEffects();
        });

        await waitFor(
          () => moveController?.state.panels["panel-2"].tabs.some((tab) => tab.kind === "navigation") === true,
          "navigation tab was not moved to the target panel"
        );

        assert.equal(moveController!.state.panels["panel-1"].tabs.length, 1);
        assert.equal(moveController!.state.panels["panel-1"].tabs[0].kind, "directory");
        assert.equal(moveController!.state.panels["panel-2"].tabs.filter((tab) => tab.kind === "navigation").length, 1);
        assert.equal(moveInteractions.resolvedPaths.length, 1);
        assert.equal(moveInteractions.resolvedPaths.includes("navigation://shortcuts"), false);
      } finally {
        await act(async () => {
          moveRoot.unmount();
          await flushEffects();
        });
        moveContainer.remove();
      }
    });

    await assertTest("useWorkspaceController blocks directory mutations from search result tabs", async () => {
      const searchInteractions = {
        resolvedPaths: [] as string[],
        copyCalls: [] as Array<{ paths: string[]; destination: string }>,
        moveCalls: [] as Array<{ paths: string[]; destination: string }>,
        deleteCalls: [] as Array<{ paths: string[] }>,
        renameCalls: [] as Array<{ source: string; newName: string }>,
        createDirectoryCalls: [] as Array<{ parent: string; name: string }>,
        createFileCalls: [] as Array<{ parent: string; name: string }>,
        treeLoadPaths: [] as string[],
        savedDetailsRowHeights: [] as number[],
        nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>
      };
      const searchBootstrap = createMockWorkspaceBootstrap("tauri");
      const sourceTab = searchBootstrap.panels["panel-1"].tabs[0];
      const selectedEntry = sourceTab.snapshot.entries[0] ?? createEntry(sourceTab.snapshot.location.path, "README.md");
      const searchTab = {
        ...createTabState(sourceTab.snapshot.location.path, "search-results-tab"),
        title: "搜索结果",
        kind: "search-results" as const,
        selectedEntryIds: [selectedEntry.id],
        snapshot: {
          ...sourceTab.snapshot,
          entries: [selectedEntry]
        },
        search: {
          sourceTabId: sourceTab.id,
          sourcePath: sourceTab.snapshot.location.path,
          query: {
            name: "readme",
            content: "",
            nameMode: "normal" as const,
            contentMode: "normal" as const,
            extensionFilterText: "",
            extensionFilterMode: "include" as const,
            includeFolders: true,
            recursive: true,
            caseSensitive: false,
            scope: "active-panel" as const
          },
          results: []
        }
      };
      searchBootstrap.panels["panel-1"] = {
        ...searchBootstrap.panels["panel-1"],
        tabs: [sourceTab, searchTab],
        activeTabId: searchTab.id
      };
      searchBootstrap.activePanelId = "panel-1";

      let searchController: ReturnType<typeof useWorkspaceController> | undefined;
      const searchGateway = createTestGateway(() => undefined, searchInteractions, {
        loadBootstrap: () => searchBootstrap
      });

      function SearchHarness() {
        searchController = useWorkspaceController(searchGateway);
        return React.createElement("div", null, searchController.state.status);
      }

      const searchContainer = document.createElement("div");
      document.body.appendChild(searchContainer);
      const searchRoot = ReactDOM.createRoot(searchContainer);
      const originalConfirm = window.confirm;
      window.confirm = () => true;

      try {
        await act(async () => {
          searchRoot.render(React.createElement(SearchHarness));
          await flushEffects();
        });
        await waitFor(() => searchController?.state.status === "ready", "search controller did not bootstrap");

        await act(async () => {
          searchController?.actions.createFolder("panel-1");
          searchController?.actions.createFile("panel-1");
          searchController?.actions.renameSelection("panel-1");
          searchController?.actions.deleteSelection("panel-1");
          await flushEffects();
        });

        const activeTab = searchController!.state.panels["panel-1"].tabs.find((tab) => tab.id === "search-results-tab");
        assert.equal(activeTab?.inlineEdit, undefined);
        assert.deepEqual(searchInteractions.deleteCalls, []);
        assert.deepEqual(searchInteractions.createDirectoryCalls, []);
        assert.deepEqual(searchInteractions.createFileCalls, []);
        assert.deepEqual(searchInteractions.renameCalls, []);
      } finally {
        window.confirm = originalConfirm;
        await act(async () => {
          searchRoot.unmount();
          await flushEffects();
        });
        searchContainer.remove();
      }
    });

    await assertTest("useWorkspaceController marks navigation items opened after successful folder opens", async () => {
      const openedInteractions = {
        resolvedPaths: [] as string[],
        copyCalls: [] as Array<{ paths: string[]; destination: string }>,
        moveCalls: [] as Array<{ paths: string[]; destination: string }>,
        deleteCalls: [] as Array<{ paths: string[] }>,
        renameCalls: [] as Array<{ source: string; newName: string }>,
        createDirectoryCalls: [] as Array<{ parent: string; name: string }>,
        createFileCalls: [] as Array<{ parent: string; name: string }>,
        treeLoadPaths: [] as string[],
        savedDetailsRowHeights: [] as number[],
        nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>,
        navigationMarks: [] as string[]
      };
      const openedBootstrap = createMockWorkspaceBootstrap("tauri");
      openedBootstrap.navigationItems = [
        {
          id: "nav-folder",
          displayName: "Archive",
          description: "",
          path: "D:\\Archive",
          targetKind: "folder",
          targetStatus: "ok",
          sortOrder: 1,
          createdAt: "2026-06-08T09:00:00Z",
          updatedAt: "2026-06-08T09:00:00Z"
        }
      ];

      let openedController: ReturnType<typeof useWorkspaceController> | undefined;
      const openedGateway = createTestGateway(() => undefined, openedInteractions, {
        loadBootstrap: () => openedBootstrap
      });

      function OpenedHarness() {
        openedController = useWorkspaceController(openedGateway);
        return React.createElement("div", null, openedController.state.status);
      }

      const openedContainer = document.createElement("div");
      document.body.appendChild(openedContainer);
      const openedRoot = ReactDOM.createRoot(openedContainer);

      try {
        await act(async () => {
          openedRoot.render(React.createElement(OpenedHarness));
          await flushEffects();
        });
        await waitFor(() => openedController?.state.status === "ready", "opened controller did not bootstrap");

        await act(async () => {
          openedController?.actions.openNavigationItem("panel-1", "nav-folder");
          await flushEffects();
        });

        await waitFor(() => openedInteractions.navigationMarks.includes("nav-folder"), "navigation open was not marked");
        assert.equal(openedInteractions.resolvedPaths.includes("D:\\Archive"), true);
      } finally {
        await act(async () => {
          openedRoot.unmount();
          await flushEffects();
        });
        openedContainer.remove();
      }
    });

    await assertTest("useWorkspaceController opens remote tree roots in a new tab in the selected panel", async () => {
      const treeInteractions = {
        resolvedPaths: [] as string[],
        copyCalls: [] as Array<{ paths: string[]; destination: string }>,
        moveCalls: [] as Array<{ paths: string[]; destination: string }>,
        deleteCalls: [] as Array<{ paths: string[] }>,
        renameCalls: [] as Array<{ source: string; newName: string }>,
        createDirectoryCalls: [] as Array<{ parent: string; name: string }>,
    createFileCalls: [] as Array<{ parent: string; name: string }>,
        treeLoadPaths: [] as string[],
        savedDetailsRowHeights: [] as number[],
        nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>
      };
      let treeController: ReturnType<typeof useWorkspaceController> | undefined;
      const treeGateway = createTestGateway(
        () => undefined,
        treeInteractions,
        {
          loadBootstrap: () => createMockWorkspaceBootstrap("tauri")
        }
      );

      function TreeHarness() {
        treeController = useWorkspaceController(treeGateway);
        return React.createElement("div", null, treeController.state.status);
      }

      const treeContainer = document.createElement("div");
      document.body.appendChild(treeContainer);
      const treeRoot = ReactDOM.createRoot(treeContainer);

      try {
        await act(async () => {
          treeRoot.render(React.createElement(TreeHarness));
          await flushEffects();
        });
        await waitFor(() => treeController?.state.status === "ready", "tree controller did not bootstrap");

        await act(async () => {
          treeController?.actions.focusPanel("panel-2");
          await flushEffects();
        });

        const beforeTabs = treeController!.state.panels["panel-2"].tabs;
        const previousActiveTab = beforeTabs.find((tab) => tab.id === treeController!.state.panels["panel-2"].activeTabId);
        assert.ok(previousActiveTab);

        await act(async () => {
          treeController?.actions.openTreeNode("panel-2", "sftp://deploy@edge-01/releases", "remote-root");
          await flushEffects();
        });

        await waitFor(
          () =>
            (treeController?.state.panels["panel-2"].tabs.length ?? 0) === beforeTabs.length + 1 &&
            Boolean(
              treeController?.state.panels["panel-2"].tabs.some(
                (tab) => tab.snapshot.location.path === "sftp://deploy@edge-01/releases"
              )
            ),
          "remote tree root did not open in a new tab"
        );

        const panel = treeController!.state.panels["panel-2"];
        const openedTab = panel.tabs.find((tab) => tab.snapshot.location.path === "sftp://deploy@edge-01/releases");
        assert.ok(openedTab);
        assert.equal(panel.activeTabId, openedTab.id);
        assert.equal(
          panel.tabs.find((tab) => tab.id === previousActiveTab.id)?.snapshot.location.path,
          previousActiveTab.snapshot.location.path
        );
        assert.deepEqual(treeInteractions.resolvedPaths.at(-1), "sftp://deploy@edge-01/releases");
      } finally {
        await act(async () => {
          treeRoot.unmount();
          await flushEffects();
        });
        treeContainer.remove();
      }
    });

    await assertTest("useWorkspaceController keeps failed remote tree root opens as reconnect tabs", async () => {
      const failedTreeInteractions = {
        resolvedPaths: [] as string[],
        copyCalls: [] as Array<{ paths: string[]; destination: string }>,
        moveCalls: [] as Array<{ paths: string[]; destination: string }>,
        deleteCalls: [] as Array<{ paths: string[] }>,
        renameCalls: [] as Array<{ source: string; newName: string }>,
        createDirectoryCalls: [] as Array<{ parent: string; name: string }>,
    createFileCalls: [] as Array<{ parent: string; name: string }>,
        treeLoadPaths: [] as string[],
        savedDetailsRowHeights: [] as number[],
        nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>
      };
      let failedTreeController: ReturnType<typeof useWorkspaceController> | undefined;
      const failedTreeGateway = createTestGateway(
        () => undefined,
        failedTreeInteractions,
        {
          loadBootstrap: () => createMockWorkspaceBootstrap("tauri")
        }
      );
      failedTreeGateway.resolveDirectory = async (path: string) => {
        failedTreeInteractions.resolvedPaths.push(path);
        throw "SFTP host key is not trusted yet; add 192.168.1.12:6666 to known_hosts";
      };

      function FailedTreeHarness() {
        failedTreeController = useWorkspaceController(failedTreeGateway);
        return React.createElement("div", null, failedTreeController.state.status);
      }

      const failedTreeContainer = document.createElement("div");
      document.body.appendChild(failedTreeContainer);
      const failedTreeRoot = ReactDOM.createRoot(failedTreeContainer);

      try {
        await act(async () => {
          failedTreeRoot.render(React.createElement(FailedTreeHarness));
          await flushEffects();
        });
        await waitFor(() => failedTreeController?.state.status === "ready", "failed tree controller did not bootstrap");

        const beforeTabs = failedTreeController!.state.panels["panel-1"].tabs.length;

        await act(async () => {
          failedTreeController?.actions.openTreeNode("panel-1", "sftp://cheng@192.168.1.12:6666/", "remote-root");
          await flushEffects();
        });

        await waitFor(
          () => (failedTreeController?.state.panels["panel-1"].tabs.length ?? 0) === beforeTabs + 1,
          "failed remote tree root did not create a reconnect tab"
        );

        const panel = failedTreeController!.state.panels["panel-1"];
        const activeTab = panel.tabs.find((tab) => tab.id === panel.activeTabId);
        assert.equal(activeTab?.status, "reconnect-required");
        assert.equal(activeTab?.snapshot.location.path, "sftp://cheng@192.168.1.12:6666/");
        assert.equal(activeTab?.reconnect?.message?.includes("SFTP host key is not trusted yet"), true);
        assert.deepEqual(failedTreeInteractions.resolvedPaths, ["sftp://cheng@192.168.1.12:6666/"]);
      } finally {
        await act(async () => {
          failedTreeRoot.unmount();
          await flushEffects();
        });
        failedTreeContainer.remove();
      }
    });

    await assertTest("useWorkspaceController confirms and trusts unknown SFTP host keys before retrying remote opens", async () => {
      const hostKeyInteractions = {
        resolvedPaths: [] as string[],
        copyCalls: [] as Array<{ paths: string[]; destination: string }>,
        moveCalls: [] as Array<{ paths: string[]; destination: string }>,
        deleteCalls: [] as Array<{ paths: string[] }>,
        renameCalls: [] as Array<{ source: string; newName: string }>,
        createDirectoryCalls: [] as Array<{ parent: string; name: string }>,
    createFileCalls: [] as Array<{ parent: string; name: string }>,
        treeLoadPaths: [] as string[],
        savedDetailsRowHeights: [] as number[],
        nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>,
        hostKeyLookups: [] as string[],
        trustedHostKeys: [] as Array<{ profileId: string; keyBase64: string }>
      };
      const hostKeyBootstrap = createMockWorkspaceBootstrap("tauri");
      const remotePath = "sftp://cheng@192.168.1.12:6666/";
      hostKeyBootstrap.remoteProfiles = [
        {
          id: "remote-wsl",
          name: "WSL",
          protocol: "sftp",
          host: "192.168.1.12",
          port: 6666,
          username: "cheng",
          rootPath: "/",
          authKind: "password",
          passiveMode: true,
          ignoreHostKey: false,
          connectTimeoutSecs: 10,
          commandTimeoutSecs: 20
        }
      ];
      hostKeyBootstrap.directoryTree = [
        ...hostKeyBootstrap.directoryTree,
        {
          id: "remote-wsl",
          label: "WSL",
          path: remotePath,
          kind: "remote-root",
          expandable: true,
          loaded: false,
          children: []
        }
      ];

      let hostKeyController: ReturnType<typeof useWorkspaceController> | undefined;
      let confirmedMessage = "";
      const hostKeyGateway = createTestGateway(
        () => undefined,
        hostKeyInteractions,
        {
          loadBootstrap: () => hostKeyBootstrap
        }
      );
      hostKeyGateway.resolveDirectory = async (path: string) => {
        hostKeyInteractions.resolvedPaths.push(path);
        if (hostKeyInteractions.trustedHostKeys.length === 0) {
          throw "SFTP host key is not trusted yet; add 192.168.1.12:6666 to known_hosts";
        }
        return resolveMockDirectory(path);
      };
      hostKeyGateway.getRemoteHostKey = async (profileId: string) => {
        hostKeyInteractions.hostKeyLookups.push(profileId);
        return {
          profileId,
          host: "192.168.1.12",
          port: 6666,
          algorithm: "ssh-ed25519",
          fingerprintSha256: "SHA256:test-fingerprint",
          keyBase64: "AAAA",
          knownHostsEntry: "[192.168.1.12]:6666 ssh-ed25519 AAAA",
          trustState: "unknown"
        };
      };

      function HostKeyHarness() {
        hostKeyController = useWorkspaceController(hostKeyGateway);
        return React.createElement("div", null, hostKeyController.state.status);
      }

      const hostKeyContainer = document.createElement("div");
      document.body.appendChild(hostKeyContainer);
      const hostKeyRoot = ReactDOM.createRoot(hostKeyContainer);
      const originalConfirm = window.confirm;
      window.confirm = (message?: string) => {
        confirmedMessage = message ?? "";
        return true;
      };

      try {
        await act(async () => {
          hostKeyRoot.render(React.createElement(HostKeyHarness));
          await flushEffects();
        });
        await waitFor(() => hostKeyController?.state.status === "ready", "host key controller did not bootstrap");

        await act(async () => {
          hostKeyController?.actions.openTreeNode("panel-1", remotePath, "remote-root");
          await flushEffects();
        });

        await waitFor(
          () => hostKeyInteractions.resolvedPaths.filter((path) => path === remotePath).length === 2,
          "remote open was not retried after trusting the host key"
        );

        const panel = hostKeyController!.state.panels["panel-1"];
        const activeTab = panel.tabs.find((tab) => tab.id === panel.activeTabId);
        assert.equal(activeTab?.status, "ready");
        assert.equal(activeTab?.snapshot.location.path, remotePath);
        assert.deepEqual(hostKeyInteractions.hostKeyLookups, ["remote-wsl"]);
        assert.deepEqual(hostKeyInteractions.trustedHostKeys, [{ profileId: "remote-wsl", keyBase64: "AAAA" }]);
        assert.equal(confirmedMessage.includes("SHA256:test-fingerprint"), true);
        assert.equal(confirmedMessage.includes("[192.168.1.12]:6666 ssh-ed25519 AAAA"), true);
      } finally {
        window.confirm = originalConfirm;
        await act(async () => {
          hostKeyRoot.unmount();
          await flushEffects();
        });
        hostKeyContainer.remove();
      }
    });

    await assertTest("useWorkspaceController ignores stale navigation responses for the same tab", async () => {
      const racingInteractions = {
        resolvedPaths: [] as string[],
        copyCalls: [] as Array<{ paths: string[]; destination: string }>,
        moveCalls: [] as Array<{ paths: string[]; destination: string }>,
        deleteCalls: [] as Array<{ paths: string[] }>,
        renameCalls: [] as Array<{ source: string; newName: string }>,
        createDirectoryCalls: [] as Array<{ parent: string; name: string }>,
    createFileCalls: [] as Array<{ parent: string; name: string }>,
        treeLoadPaths: [] as string[],
        savedDetailsRowHeights: [] as number[],
        nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>
      };
      const pending = new Map<string, (snapshot: ReturnType<typeof resolveMockDirectory>) => void>();
      let racingController: ReturnType<typeof useWorkspaceController> | undefined;
      const racingGateway = createTestGateway(
        () => undefined,
        racingInteractions,
        {
          loadBootstrap: () => createMockWorkspaceBootstrap("tauri")
        }
      );
      racingGateway.resolveDirectory = (path: string) => {
        racingInteractions.resolvedPaths.push(path);
        return new Promise((resolve) => {
          pending.set(path, resolve);
        });
      };

      function RacingHarness() {
        racingController = useWorkspaceController(racingGateway);
        return React.createElement("div", null, racingController.state.status);
      }

      const racingContainer = document.createElement("div");
      document.body.appendChild(racingContainer);
      const racingRoot = ReactDOM.createRoot(racingContainer);

      try {
        await act(async () => {
          racingRoot.render(React.createElement(RacingHarness));
          await flushEffects();
        });
        await waitFor(() => racingController?.state.status === "ready", "racing controller did not bootstrap");

        const activeTab = racingController!.state.panels["panel-1"].tabs[0];

        act(() => {
          racingController?.actions.navigateToPath("panel-1", "C:\\Users\\Admin\\Downloads");
          racingController?.actions.navigateToPath("panel-1", "D:\\Archive");
        });

        assert.deepEqual(racingInteractions.resolvedPaths, ["C:\\Users\\Admin\\Downloads", "D:\\Archive"]);

        await act(async () => {
          pending.get("D:\\Archive")?.(resolveMockDirectory("D:\\Archive"));
          await flushEffects();
        });
        assert.equal(racingController?.state.panels["panel-1"].tabs.find((tab) => tab.id === activeTab.id)?.snapshot.location.path, "D:\\Archive");

        await act(async () => {
          pending.get("C:\\Users\\Admin\\Downloads")?.(resolveMockDirectory("C:\\Users\\Admin\\Downloads"));
          await flushEffects();
        });
        assert.equal(racingController?.state.panels["panel-1"].tabs.find((tab) => tab.id === activeTab.id)?.snapshot.location.path, "D:\\Archive");
      } finally {
        await act(async () => {
          racingRoot.unmount();
          await flushEffects();
        });
        racingContainer.remove();
      }
    });

    await assertTest("useWorkspaceController honors configurable navigate-up and navigate-forward shortcuts", async () => {
      const shortcutContainer = document.createElement("div");
      document.body.appendChild(shortcutContainer);
      const shortcutRoot = ReactDOM.createRoot(shortcutContainer);
      const shortcutInteractions = {
        resolvedPaths: [] as string[],
        copyCalls: [] as Array<{ paths: string[]; destination: string }>,
        moveCalls: [] as Array<{ paths: string[]; destination: string }>,
        deleteCalls: [] as Array<{ paths: string[] }>,
        renameCalls: [] as Array<{ source: string; newName: string }>,
        createDirectoryCalls: [] as Array<{ parent: string; name: string }>,
        createFileCalls: [] as Array<{ parent: string; name: string }>,
        treeLoadPaths: [] as string[],
        savedDetailsRowHeights: [] as number[],
        nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>
      };
      let shortcutController: ReturnType<typeof useWorkspaceController> | undefined;
      const shortcutGateway = createTestGateway(() => undefined, shortcutInteractions, {
        loadBootstrap: () => {
          const bootstrap = createMockWorkspaceBootstrap("tauri");
          return {
            ...bootstrap,
            settingsModel: {
              ...bootstrap.settingsModel,
              shortcuts: [
                ...bootstrap.settingsModel.shortcuts,
                {
                  id: "navigate-up",
                  action: "上一级",
                  scope: "panel",
                  binding: "Up",
                  description: "打开当前文件夹的上一级。"
                },
                {
                  id: "navigate-forward",
                  action: "回到下一级",
                  scope: "panel",
                  binding: "Alt+Right",
                  description: "回到历史中的下一级文件夹。"
                }
              ]
            }
          };
        }
      });

      function ShortcutHarness() {
        shortcutController = useWorkspaceController(shortcutGateway);
        return React.createElement("div", null, shortcutController.state.status);
      }

      try {
        await act(async () => {
          shortcutRoot.render(React.createElement(ShortcutHarness));
          await flushEffects();
        });
        await waitFor(() => shortcutController?.state.status === "ready", "shortcut controller did not bootstrap");

        const activeTab = getActiveTab(shortcutController!.state.panels["panel-1"]);
        assert.equal(activeTab.snapshot.location.path, "D:\\Projects\\Atlas");

        await act(async () => {
          window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
          await flushEffects();
        });
        await waitFor(
          () => getActiveTab(shortcutController!.state.panels["panel-1"]).snapshot.location.path === "D:\\Projects",
          "single-key Up shortcut did not navigate to the parent folder"
        );
        assert.equal(shortcutInteractions.resolvedPaths.includes("D:\\Projects"), true);

        await act(async () => {
          window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true }));
          await flushEffects();
        });
        await waitFor(
          () => getActiveTab(shortcutController!.state.panels["panel-1"]).snapshot.location.path === "D:\\Projects\\Atlas",
          "Alt+Right shortcut did not restore the child folder"
        );
      } finally {
        await act(async () => {
          shortcutRoot.unmount();
          await flushEffects();
        });
        shortcutContainer.remove();
      }
    });

    await assertTest("useWorkspaceController preserves the full descendant chain for breadcrumb navigation", async () => {
      const breadcrumbContainer = document.createElement("div");
      document.body.appendChild(breadcrumbContainer);
      const breadcrumbRoot = ReactDOM.createRoot(breadcrumbContainer);
      const breadcrumbInteractions = {
        resolvedPaths: [] as string[],
        copyCalls: [] as Array<{ paths: string[]; destination: string }>,
        moveCalls: [] as Array<{ paths: string[]; destination: string }>,
        deleteCalls: [] as Array<{ paths: string[] }>,
        renameCalls: [] as Array<{ source: string; newName: string }>,
        createDirectoryCalls: [] as Array<{ parent: string; name: string }>,
        createFileCalls: [] as Array<{ parent: string; name: string }>,
        treeLoadPaths: [] as string[],
        savedDetailsRowHeights: [] as number[],
        nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>
      };
      let breadcrumbController: ReturnType<typeof useWorkspaceController> | undefined;
      const breadcrumbGateway = createTestGateway(() => undefined, breadcrumbInteractions, {
        loadBootstrap: () => createMockWorkspaceBootstrap("tauri")
      });

      function BreadcrumbHarness() {
        breadcrumbController = useWorkspaceController(breadcrumbGateway);
        return React.createElement("div", null, breadcrumbController.state.status);
      }

      try {
        await act(async () => {
          breadcrumbRoot.render(React.createElement(BreadcrumbHarness));
          await flushEffects();
        });
        await waitFor(() => breadcrumbController?.state.status === "ready", "breadcrumb controller did not bootstrap");

        await act(async () => {
          breadcrumbController?.actions.navigateToPath("panel-1", "D:\\Projects\\Atlas\\src\\components");
          await flushEffects();
        });
        await waitFor(
          () => getActiveTab(breadcrumbController!.state.panels["panel-1"]).snapshot.location.path === "D:\\Projects\\Atlas\\src\\components",
          "deep folder navigation did not complete"
        );

        await act(async () => {
          breadcrumbController?.actions.navigateBreadcrumbPath("panel-1", "D:\\Projects");
          await flushEffects();
        });
        await waitFor(
          () => getActiveTab(breadcrumbController!.state.panels["panel-1"]).snapshot.location.path === "D:\\Projects",
          "breadcrumb parent navigation did not complete"
        );

        let activeTab = getActiveTab(breadcrumbController!.state.panels["panel-1"]);
        const preservedChain = [
          "D:\\Projects",
          "D:\\Projects\\Atlas",
          "D:\\Projects\\Atlas\\src",
          "D:\\Projects\\Atlas\\src\\components"
        ];
        assert.deepEqual(activeTab.history, preservedChain);
        assert.equal(activeTab.historyIndex, 0);

        await act(async () => {
          breadcrumbController?.actions.navigateBreadcrumbPath("panel-1", "D:\\Projects\\Atlas\\src");
          await flushEffects();
        });
        await waitFor(
          () => getActiveTab(breadcrumbController!.state.panels["panel-1"]).snapshot.location.path === "D:\\Projects\\Atlas\\src",
          "breadcrumb child navigation did not complete"
        );

        activeTab = getActiveTab(breadcrumbController!.state.panels["panel-1"]);
        assert.deepEqual(activeTab.history, preservedChain);
        assert.equal(activeTab.historyIndex, 2);
      } finally {
        await act(async () => {
          breadcrumbRoot.unmount();
          await flushEffects();
        });
        breadcrumbContainer.remove();
      }
    });

    await assertTest("useWorkspaceController routes dropped entries through copy/move gateways and refreshes affected panels", async () => {
      interactions.resolvedPaths.length = 0;
      interactions.copyCalls.length = 0;
      interactions.moveCalls.length = 0;

      await act(async () => {
        await latestController?.actions.dropEntries(
          ["D:\\Projects\\Atlas\\README.md"],
          "C:\\Users\\Admin\\Downloads",
          "copy"
        );
        await flushEffects();
      });

      assert.deepEqual(interactions.copyCalls, [
        {
          paths: ["D:\\Projects\\Atlas\\README.md"],
          destination: "C:\\Users\\Admin\\Downloads"
        }
      ]);
      assert.equal(interactions.resolvedPaths.includes("C:\\Users\\Admin\\Downloads"), true);

      interactions.resolvedPaths.length = 0;

      await act(async () => {
        await latestController?.actions.dropEntries(
          ["C:\\Users\\Admin\\Downloads\\Installer.msi"],
          "D:\\Archive",
          "move"
        );
        await flushEffects();
      });

      assert.deepEqual(interactions.moveCalls, [
        {
          paths: ["C:\\Users\\Admin\\Downloads\\Installer.msi"],
          destination: "D:\\Archive"
        }
      ]);
      assert.equal(interactions.resolvedPaths.includes("C:\\Users\\Admin\\Downloads"), true);
    });

    await assertTest("useWorkspaceController routes remote clipboard and mutation actions through the gateway", async () => {
      interactions.resolvedPaths.length = 0;
      interactions.copyCalls.length = 0;
      interactions.moveCalls.length = 0;
      interactions.deleteCalls.length = 0;
      interactions.renameCalls.length = 0;
      interactions.createDirectoryCalls.length = 0;

      const remoteFileId = "sftp://deploy@edge-01/releases:manifest.yml";
      const remoteFilePath = "sftp://deploy@edge-01/releases/manifest.yml";

      await act(async () => {
        latestController?.actions.selectEntry("panel-3", "panel-3-tab-1", remoteFileId, false);
        await flushEffects();
      });

      await act(async () => {
        latestController?.actions.copySelection("panel-3");
        await flushEffects();
      });
      assert.deepEqual(latestController?.state.clipboard?.paths, [remoteFilePath]);

      await act(async () => {
        await latestController?.actions.pasteIntoPanel("panel-2");
        await flushEffects();
      });
      await waitFor(() => interactions.copyCalls.length > 0, "remote copy was not routed through the gateway");
      assert.deepEqual(interactions.copyCalls.at(-1), {
        paths: [remoteFilePath],
        destination: "C:\\Users\\Admin\\Downloads"
      });
      await waitFor(
        () => interactions.resolvedPaths.includes("C:\\Users\\Admin\\Downloads"),
        "remote-to-local copy did not refresh the destination panel"
      );

      interactions.resolvedPaths.length = 0;
      await act(async () => {
        latestController?.actions.cutSelection("panel-3");
        await flushEffects();
      });
      await act(async () => {
        await latestController?.actions.pasteIntoPanel("panel-4");
        await flushEffects();
      });
      await waitFor(() => interactions.moveCalls.length > 0, "remote move was not routed through the gateway");
      assert.deepEqual(interactions.moveCalls.at(-1), {
        paths: [remoteFilePath],
        destination: "C:\\Tools"
      });
      await waitFor(
        () =>
          interactions.resolvedPaths.includes("sftp://deploy@edge-01/releases") &&
          interactions.resolvedPaths.includes("C:\\Tools"),
        "remote-to-local move did not refresh source and destination panels"
      );
      await waitFor(() => latestController?.state.clipboard === undefined, "cut clipboard was not cleared after move");

      const originalConfirm = window.confirm;
      window.confirm = () => true;

      try {
        await act(async () => {
          latestController?.actions.selectEntry("panel-3", "panel-3-tab-1", remoteFileId, false);
          await flushEffects();
        });
        await act(async () => {
          await latestController?.actions.deleteSelection("panel-3");
          await flushEffects();
        });
        await waitFor(() => interactions.deleteCalls.length > 0, "remote delete was not routed through the gateway");
        assert.deepEqual(interactions.deleteCalls.at(-1), {
          paths: [remoteFilePath]
        });
      } finally {
        window.confirm = originalConfirm;
      }
    });

    await assertTest("useWorkspaceController refreshes every open tab that points at a mutated directory", async () => {
      const sharedPath = "C:\\Users\\Admin\\Downloads";
      const firstSnapshot = resolveMockDirectory(sharedPath);
      const secondSnapshot = {
        ...resolveMockDirectory(sharedPath),
        entries: [...resolveMockDirectory(sharedPath).entries, createEntry(sharedPath, "created-from-panel-a")]
      };
      const refreshedSnapshots = new Map<string, ReturnType<typeof resolveMockDirectory>>([
        [`${sharedPath}#1`, firstSnapshot],
        [`${sharedPath}#2`, secondSnapshot]
      ]);
      const multiInteractions = {
        resolvedPaths: [] as string[],
        copyCalls: [] as Array<{ paths: string[]; destination: string }>,
        moveCalls: [] as Array<{ paths: string[]; destination: string }>,
        deleteCalls: [] as Array<{ paths: string[] }>,
        renameCalls: [] as Array<{ source: string; newName: string }>,
        createDirectoryCalls: [] as Array<{ parent: string; name: string }>,
    createFileCalls: [] as Array<{ parent: string; name: string }>,
        treeLoadPaths: [] as string[],
        savedDetailsRowHeights: [] as number[],
        nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>
      };
      let multiController: ReturnType<typeof useWorkspaceController> | undefined;
      const multiBootstrap = createMockWorkspaceBootstrap("tauri");
      multiBootstrap.layoutMode = "dual";
      multiBootstrap.panels["panel-1"] = {
        ...multiBootstrap.panels["panel-1"],
        tabs: [
          createTabState(sharedPath, "panel-1-shared", {
            selectedEntryIds: ["C:\\Users\\Admin\\Downloads:desktop-build.msi"]
          })
        ],
        activeTabId: "panel-1-shared"
      };
      multiBootstrap.panels["panel-2"] = {
        ...multiBootstrap.panels["panel-2"],
        tabs: [createTabState(sharedPath, "panel-2-shared")],
        activeTabId: "panel-2-shared"
      };

      const multiGateway = createTestGateway(() => undefined, multiInteractions, {
        loadBootstrap: () => multiBootstrap
      });
      multiGateway.resolveDirectory = async (path: string) => {
        multiInteractions.resolvedPaths.push(path);
        const callCount = multiInteractions.resolvedPaths.filter((item) => item === path).length;
        return refreshedSnapshots.get(`${path}#${callCount}`) ?? resolveMockDirectory(path);
      };

      function MultiHarness() {
        multiController = useWorkspaceController(multiGateway);
        return React.createElement("div", null, multiController.state.status);
      }

      const multiContainer = document.createElement("div");
      document.body.appendChild(multiContainer);
      const multiRoot = ReactDOM.createRoot(multiContainer);
      const originalConfirm = window.confirm;
      window.confirm = () => true;

      try {
        await act(async () => {
          multiRoot.render(React.createElement(MultiHarness));
          await flushEffects();
        });
        await waitFor(() => multiController?.state.status === "ready", "multi controller did not bootstrap");

        await act(async () => {
          multiController?.actions.deleteSelection("panel-1");
          await flushEffects();
        });

        await waitFor(
          () => multiInteractions.resolvedPaths.filter((path) => path === sharedPath).length === 2,
          "mutation did not refresh both open tabs"
        );

        assert.deepEqual(multiInteractions.deleteCalls, [
          {
            paths: ["C:\\Users\\Admin\\Downloads\\desktop-build.msi"]
          }
        ]);
        assert.equal(multiController?.state.panels["panel-1"].tabs[0].snapshot.entries.length, firstSnapshot.entries.length);
        assert.equal(multiController?.state.panels["panel-2"].tabs[0].snapshot.entries.length, secondSnapshot.entries.length);
        assert.equal(multiController?.state.activePanelId, "panel-1");
      } finally {
        window.confirm = originalConfirm;
        await act(async () => {
          multiRoot.unmount();
          await flushEffects();
        });
        multiContainer.remove();
      }
    });

    await assertTest("useWorkspaceController starts inline edits for create folder and rename before mutating through the gateway", async () => {
      const inlineInteractions = {
        resolvedPaths: [] as string[],
        copyCalls: [] as Array<{ paths: string[]; destination: string }>,
        moveCalls: [] as Array<{ paths: string[]; destination: string }>,
        deleteCalls: [] as Array<{ paths: string[] }>,
        renameCalls: [] as Array<{ source: string; newName: string }>,
        createDirectoryCalls: [] as Array<{ parent: string; name: string }>,
    createFileCalls: [] as Array<{ parent: string; name: string }>,
        treeLoadPaths: [] as string[],
        savedDetailsRowHeights: [] as number[],
        nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>
      };
      let inlineController: ReturnType<typeof useWorkspaceController> | undefined;
      const inlineBootstrap = createMockWorkspaceBootstrap("tauri");
      inlineBootstrap.layoutMode = "single";
      inlineBootstrap.panels["panel-1"] = {
        ...inlineBootstrap.panels["panel-1"],
        tabs: [
          createTabState("sftp://deploy@edge-01/releases", "inline-tab", {
            selectedEntryIds: ["sftp://deploy@edge-01/releases:manifest.yml"]
          })
        ],
        activeTabId: "inline-tab"
      };
      const inlineGateway = createTestGateway(() => undefined, inlineInteractions, {
        loadBootstrap: () => inlineBootstrap
      });

      function InlineHarness() {
        inlineController = useWorkspaceController(inlineGateway);
        return React.createElement("div", null, inlineController.state.status);
      }

      const inlineContainer = document.createElement("div");
      document.body.appendChild(inlineContainer);
      const inlineRoot = ReactDOM.createRoot(inlineContainer);
      const originalPrompt = window.prompt;
      let promptCalls = 0;
      window.prompt = () => {
        promptCalls += 1;
        return "should-not-be-used";
      };

      try {
        await act(async () => {
          inlineRoot.render(React.createElement(InlineHarness));
          await flushEffects();
        });
        await waitFor(() => inlineController?.state.status === "ready", "inline controller did not bootstrap");

        await act(async () => {
          inlineController?.actions.renameSelection("panel-1");
          await flushEffects();
        });

        const renameEdit = inlineController?.state.panels["panel-1"].tabs[0].inlineEdit;
        assert.equal(renameEdit?.mode, "rename");
        assert.equal(renameEdit?.value, "manifest.yml");
        assert.equal(promptCalls, 0);
        assert.deepEqual(inlineInteractions.renameCalls, []);

        await act(async () => {
          inlineController?.actions.updateInlineEdit("panel-1", "inline-tab", "manifest-renamed.yml");
          inlineController?.actions.commitInlineEdit("panel-1", "inline-tab", "manifest-renamed.yml");
          await flushEffects();
        });

        await waitFor(() => inlineInteractions.renameCalls.length === 1, "inline rename was not committed through the gateway");
        assert.deepEqual(inlineInteractions.renameCalls, [
          {
            source: "sftp://deploy@edge-01/releases/manifest.yml",
            newName: "manifest-renamed.yml"
          }
        ]);
        await waitFor(
          () => inlineInteractions.resolvedPaths.includes("sftp://deploy@edge-01/releases"),
          "inline rename did not refresh the source directory"
        );

        await act(async () => {
          inlineController?.actions.createFolder("panel-1");
          await flushEffects();
        });

        const createEdit = inlineController?.state.panels["panel-1"].tabs[0].inlineEdit;
        assert.equal(createEdit?.mode, "create-folder");
        assert.equal(createEdit?.value, "新建文件夹");
        assert.equal(promptCalls, 0);

        await act(async () => {
          inlineController?.actions.updateInlineEdit("panel-1", "inline-tab", "new-remote-folder");
          inlineController?.actions.commitInlineEdit("panel-1", "inline-tab", "new-remote-folder");
          await flushEffects();
        });

        await waitFor(
          () => inlineInteractions.createDirectoryCalls.length === 1,
          "inline folder creation was not committed through the gateway"
        );
        assert.deepEqual(inlineInteractions.createDirectoryCalls, [
          {
            parent: "sftp://deploy@edge-01/releases",
            name: "new-remote-folder"
          }
        ]);

        await act(async () => {
          inlineController?.actions.createFile("panel-1");
          await flushEffects();
        });

        const createFileEdit = inlineController?.state.panels["panel-1"].tabs[0].inlineEdit;
        assert.equal(createFileEdit?.mode, "create-file");
        assert.equal(createFileEdit?.value, "新建文件.txt");

        await act(async () => {
          inlineController?.actions.updateInlineEdit("panel-1", "inline-tab", "notes.txt");
          inlineController?.actions.commitInlineEdit("panel-1", "inline-tab", "notes.txt");
          await flushEffects();
        });

        await waitFor(
          () => inlineInteractions.createFileCalls.length === 1,
          "inline file creation was not committed through the gateway"
        );
        assert.deepEqual(inlineInteractions.createFileCalls, [
          {
            parent: "sftp://deploy@edge-01/releases",
            name: "notes.txt"
          }
        ]);
      } finally {
        window.prompt = originalPrompt;
        await act(async () => {
          inlineRoot.unmount();
          await flushEffects();
        });
        inlineContainer.remove();
      }
    });

    await assertTest("useWorkspaceController commits inactive tab inline edits from a workspace-level outside click", async () => {
      const inactiveInteractions = {
        resolvedPaths: [] as string[],
        copyCalls: [] as Array<{ paths: string[]; destination: string }>,
        moveCalls: [] as Array<{ paths: string[]; destination: string }>,
        deleteCalls: [] as Array<{ paths: string[] }>,
        renameCalls: [] as Array<{ source: string; newName: string }>,
        createDirectoryCalls: [] as Array<{ parent: string; name: string }>,
        createFileCalls: [] as Array<{ parent: string; name: string }>,
        treeLoadPaths: [] as string[],
        savedDetailsRowHeights: [] as number[],
        nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>
      };
      let inactiveController: ReturnType<typeof useWorkspaceController> | undefined;
      const inactiveBootstrap = createMockWorkspaceBootstrap("tauri");
      const editingTab = createTabState("D:\\Projects\\Atlas", "inactive-editing-tab", {
        selectedEntryIds: ["D:\\Projects\\Atlas:sprint-plan.md"]
      });
      const activeTab = createTabState("D:\\Projects\\Atlas\\src", "inactive-active-tab");
      inactiveBootstrap.layoutMode = "single";
      inactiveBootstrap.panels["panel-1"] = {
        ...inactiveBootstrap.panels["panel-1"],
        tabs: [editingTab, activeTab],
        activeTabId: editingTab.id
      };
      const inactiveGateway = createTestGateway(() => undefined, inactiveInteractions, {
        loadBootstrap: () => inactiveBootstrap
      });

      function InactiveHarness() {
        inactiveController = useWorkspaceController(inactiveGateway);
        return React.createElement("div", null, inactiveController.state.status);
      }

      const inactiveContainer = document.createElement("div");
      document.body.appendChild(inactiveContainer);
      const inactiveRoot = ReactDOM.createRoot(inactiveContainer);

      try {
        await act(async () => {
          inactiveRoot.render(React.createElement(InactiveHarness));
          await flushEffects();
        });
        await waitFor(() => inactiveController?.state.status === "ready", "inactive controller did not bootstrap");

        await act(async () => {
          inactiveController?.actions.renameSelection("panel-1");
          await flushEffects();
        });
        await waitFor(
          () => inactiveController?.state.panels["panel-1"].tabs[0].inlineEdit?.mode === "rename",
          "rename edit was not started on the first tab"
        );

        await act(async () => {
          inactiveController?.actions.updateInlineEdit("panel-1", editingTab.id, "sprint-plan-final.md");
          inactiveController?.actions.activateTab("panel-1", activeTab.id);
          await flushEffects();
        });

        await act(async () => {
          inactiveController?.actions.commitActiveInlineEdits();
          await flushEffects();
        });

        await waitFor(() => inactiveInteractions.renameCalls.length === 1, "inactive inline rename was not committed");
        assert.deepEqual(inactiveInteractions.renameCalls, [
          {
            source: "D:\\Projects\\Atlas\\sprint-plan.md",
            newName: "sprint-plan-final.md"
          }
        ]);
        await waitFor(
          () => inactiveInteractions.resolvedPaths.includes("D:\\Projects\\Atlas"),
          "inactive inline rename did not refresh the source directory"
        );
      } finally {
        await act(async () => {
          inactiveRoot.unmount();
          await flushEffects();
        });
        inactiveContainer.remove();
      }
    });

    await assertTest("useWorkspaceController refreshes the source directory after a completed inline rename", async () => {
      const refreshInteractions = {
        resolvedPaths: [] as string[],
        copyCalls: [] as Array<{ paths: string[]; destination: string }>,
        moveCalls: [] as Array<{ paths: string[]; destination: string }>,
        deleteCalls: [] as Array<{ paths: string[] }>,
        renameCalls: [] as Array<{ source: string; newName: string }>,
        createDirectoryCalls: [] as Array<{ parent: string; name: string }>,
        createFileCalls: [] as Array<{ parent: string; name: string }>,
        treeLoadPaths: [] as string[],
        savedDetailsRowHeights: [] as number[],
        nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>
      };
      let refreshController: ReturnType<typeof useWorkspaceController> | undefined;
      const refreshPath = "sftp://deploy@edge-01/releases";
      const refreshBootstrap = createMockWorkspaceBootstrap("tauri");
      refreshBootstrap.layoutMode = "single";
      refreshBootstrap.panels["panel-1"] = {
        ...refreshBootstrap.panels["panel-1"],
        tabs: [
          createTabState(refreshPath, "rename-refresh-tab", {
            selectedEntryIds: [`${refreshPath}:manifest.yml`]
          })
        ],
        activeTabId: "rename-refresh-tab"
      };
      const refreshGateway = createTestGateway(() => undefined, refreshInteractions, {
        loadBootstrap: () => refreshBootstrap,
        renameEntry: async (source, newName) => {
          refreshInteractions.renameCalls.push({ source, newName });
          const now = "2026-06-10T08:00:00Z";
          return {
            taskId: "rename-refresh-task",
            requestId: "request-rename-refresh-task",
            kind: "rename",
            label: "Rename manifest.yml",
            status: "succeeded",
            createdAt: now,
            startedAt: now,
            finishedAt: now,
            totalEntries: 1,
            completedEntries: 1,
            failedEntries: 0,
            totalBytes: null,
            completedBytes: null,
            currentPath: null,
            message: null,
            cancelable: false,
            undoable: true,
            affectedRoots: [],
            entryResults: [],
            sequence: 1,
            updatedAt: now
          } satisfies OperationTaskSnapshot;
        }
      });

      function RefreshHarness() {
        refreshController = useWorkspaceController(refreshGateway);
        return React.createElement("div", null, refreshController.state.status);
      }

      const refreshContainer = document.createElement("div");
      document.body.appendChild(refreshContainer);
      const refreshRoot = ReactDOM.createRoot(refreshContainer);

      try {
        await act(async () => {
          refreshRoot.render(React.createElement(RefreshHarness));
          await flushEffects();
        });
        await waitFor(() => refreshController?.state.status === "ready", "refresh controller did not bootstrap");

        await act(async () => {
          refreshController?.actions.renameSelection("panel-1");
          await flushEffects();
        });

        await act(async () => {
          refreshController?.actions.updateInlineEdit("panel-1", "rename-refresh-tab", "manifest-final.yml");
          refreshController?.actions.commitInlineEdit("panel-1", "rename-refresh-tab", "manifest-final.yml");
          await flushEffects();
        });

        await waitFor(
          () => refreshInteractions.resolvedPaths.includes(refreshPath),
          "completed inline rename did not refresh the source directory"
        );
        assert.deepEqual(refreshInteractions.renameCalls, [
          {
            source: `${refreshPath}/manifest.yml`,
            newName: "manifest-final.yml"
          }
        ]);
      } finally {
        await act(async () => {
          refreshRoot.unmount();
          await flushEffects();
        });
        refreshContainer.remove();
      }
    });

    await assertTest("useWorkspaceController refreshes inline rename parent after the background task finishes", async () => {
      const taskInteractions = {
        resolvedPaths: [] as string[],
        copyCalls: [] as Array<{ paths: string[]; destination: string }>,
        moveCalls: [] as Array<{ paths: string[]; destination: string }>,
        deleteCalls: [] as Array<{ paths: string[] }>,
        renameCalls: [] as Array<{ source: string; newName: string }>,
        createDirectoryCalls: [] as Array<{ parent: string; name: string }>,
        createFileCalls: [] as Array<{ parent: string; name: string }>,
        treeLoadPaths: [] as string[],
        savedDetailsRowHeights: [] as number[],
        nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>
      };
      let taskController: ReturnType<typeof useWorkspaceController> | undefined;
      let taskListener: Parameters<WorkspaceGateway["listenOperationTasks"]>[0] | undefined;
      let currentTask: OperationTaskSnapshot;
      const taskPath = "sftp://deploy@edge-01/releases";
      const taskNow = "2026-06-10T08:00:00Z";
      const baseTask: OperationTaskSnapshot = {
        taskId: "rename-background-task",
        requestId: "request-rename-background-task",
        kind: "rename",
        label: "Rename manifest.yml",
        status: "running",
        createdAt: taskNow,
        startedAt: taskNow,
        finishedAt: null,
        totalEntries: 1,
        completedEntries: 0,
        failedEntries: 0,
        totalBytes: null,
        completedBytes: null,
        currentPath: null,
        message: null,
        cancelable: true,
        undoable: false,
        affectedRoots: [],
        entryResults: [],
        sequence: 1,
        updatedAt: taskNow
      };
      currentTask = baseTask;
      const taskBootstrap = createMockWorkspaceBootstrap("tauri");
      taskBootstrap.layoutMode = "single";
      taskBootstrap.panels["panel-1"] = {
        ...taskBootstrap.panels["panel-1"],
        tabs: [
          createTabState(taskPath, "rename-background-tab", {
            selectedEntryIds: [`${taskPath}:manifest.yml`]
          })
        ],
        activeTabId: "rename-background-tab"
      };
      const taskGateway = createTestGateway(() => undefined, taskInteractions, {
        loadBootstrap: () => taskBootstrap,
        renameEntry: async (source, newName) => {
          taskInteractions.renameCalls.push({ source, newName });
          return currentTask;
        },
        listOperationTasks: async () => ({ tasks: [currentTask], taskSequence: currentTask.sequence }),
        listenOperationTasks: async (handler) => {
          taskListener = handler;
          return () => undefined;
        }
      });

      function TaskHarness() {
        taskController = useWorkspaceController(taskGateway);
        return React.createElement("div", null, taskController.state.status);
      }

      const taskContainer = document.createElement("div");
      document.body.appendChild(taskContainer);
      const taskRoot = ReactDOM.createRoot(taskContainer);

      try {
        await act(async () => {
          taskRoot.render(React.createElement(TaskHarness));
          await flushEffects();
        });
        await waitFor(() => taskController?.state.status === "ready", "task controller did not bootstrap");
        await waitFor(() => Boolean(taskListener), "operation task listener was not registered");

        await act(async () => {
          taskController?.actions.renameSelection("panel-1");
          await flushEffects();
        });

        await act(async () => {
          taskController?.actions.updateInlineEdit("panel-1", "rename-background-tab", "manifest-final.yml");
          taskController?.actions.commitInlineEdit("panel-1", "rename-background-tab", "manifest-final.yml");
          await flushEffects();
        });

        assert.equal(taskInteractions.resolvedPaths.includes(taskPath), false);

        currentTask = {
          ...baseTask,
          status: "succeeded",
          finishedAt: "2026-06-10T08:00:01Z",
          completedEntries: 1,
          cancelable: false,
          undoable: true,
          sequence: 2,
          updatedAt: "2026-06-10T08:00:01Z"
        };

        await act(async () => {
          taskListener?.({
            taskId: currentTask.taskId,
            sequence: currentTask.sequence,
            updatedAt: currentTask.updatedAt,
            snapshot: currentTask
          });
          await flushEffects();
        });

        await waitFor(
          () => taskInteractions.resolvedPaths.includes(taskPath),
          "background inline rename completion did not refresh the source directory"
        );
      } finally {
        await act(async () => {
          taskRoot.unmount();
          await flushEffects();
        });
        taskContainer.remove();
      }
    });

    await assertTest("useWorkspaceController cancels the active backend search immediately and ignores its later result", async () => {
      const searchInteractions = {
        resolvedPaths: [] as string[],
        copyCalls: [] as Array<{ paths: string[]; destination: string }>,
        moveCalls: [] as Array<{ paths: string[]; destination: string }>,
        deleteCalls: [] as Array<{ paths: string[] }>,
        renameCalls: [] as Array<{ source: string; newName: string }>,
        createDirectoryCalls: [] as Array<{ parent: string; name: string }>,
    createFileCalls: [] as Array<{ parent: string; name: string }>,
        treeLoadPaths: [] as string[],
        savedDetailsRowHeights: [] as number[],
        nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>,
        cancelSearchIds: [] as string[]
      };
      let searchController: ReturnType<typeof useWorkspaceController> | undefined;
      let resolveSearch: ((value: Awaited<ReturnType<WorkspaceGateway["search"]>>) => void) | undefined;
      const searchGateway = createTestGateway(() => undefined, searchInteractions, {
        loadBootstrap: () => createMockWorkspaceBootstrap("tauri")
      });
      searchGateway.search = async (_query, _scopePaths, options) => {
        options?.onProgress?.({
          searchId: options.searchId,
          scannedEntries: 10,
          matchedEntries: 1,
          cancelled: false,
          statusText: "已扫描 10 项，匹配 1 项"
        });
        return new Promise((resolve) => {
          resolveSearch = resolve;
        });
      };

      function SearchHarness() {
        searchController = useWorkspaceController(searchGateway);
        return React.createElement("div", null, searchController.state.search.progress?.statusText ?? "");
      }

      const searchContainer = document.createElement("div");
      document.body.appendChild(searchContainer);
      const searchRoot = ReactDOM.createRoot(searchContainer);

      try {
        await act(async () => {
          searchRoot.render(React.createElement(SearchHarness));
          await flushEffects();
        });
        await waitFor(() => searchController?.state.status === "ready", "search controller did not bootstrap");

        await act(async () => {
          searchController?.actions.updateSearchQuery({ content: "needle" });
          await flushEffects();
        });
        await act(async () => {
          searchController?.actions.runSearch();
          await flushEffects();
        });
        await waitFor(() => searchController?.state.search.loading === true, "search did not enter loading state");

        const activeSearchId = searchController?.state.search.progress?.searchId;
        assert.ok(activeSearchId);

        await act(async () => {
          searchController?.actions.stopSearch();
          await flushEffects();
        });

        await waitFor(() => searchController?.state.search.loading === false, "search did not stop immediately");
        assert.deepEqual(searchInteractions.cancelSearchIds, [activeSearchId]);
        assert.equal(searchController?.state.search.progress?.statusText, "搜索已停止");
        assert.equal(searchController?.state.search.progress?.cancelled, true);

        await act(async () => {
          resolveSearch?.([
            {
              id: "late-result",
              name: "late.txt",
              kind: "file",
              path: "D:\\Projects\\Atlas\\late.txt",
              parentPath: "D:\\Projects\\Atlas",
              openPath: "D:\\Projects\\Atlas",
              location: { kind: "local", label: "Atlas", path: "D:\\Projects\\Atlas" },
              match: "needle"
            }
          ]);
          await flushEffects();
        });

        assert.equal(searchController?.state.search.results.length, 0);
        assert.equal(searchController?.state.panels["panel-1"].tabs.some((tab) => tab.kind === "search-results"), false);
      } finally {
        await act(async () => {
          searchRoot.unmount();
          await flushEffects();
        });
        searchContainer.remove();
      }
    });

    await assertTest("useWorkspaceController runs name searches with name-specific filters and history", async () => {
      const nameSearchInteractions = {
        resolvedPaths: [] as string[],
        copyCalls: [] as Array<{ paths: string[]; destination: string }>,
        moveCalls: [] as Array<{ paths: string[]; destination: string }>,
        deleteCalls: [] as Array<{ paths: string[] }>,
        renameCalls: [] as Array<{ source: string; newName: string }>,
        createDirectoryCalls: [] as Array<{ parent: string; name: string }>,
    createFileCalls: [] as Array<{ parent: string; name: string }>,
        treeLoadPaths: [] as string[],
        savedDetailsRowHeights: [] as number[],
        nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>,
        cancelSearchIds: [] as string[]
      };
      let nameSearchController: ReturnType<typeof useWorkspaceController> | undefined;
      const searchCalls: Array<Parameters<WorkspaceGateway["search"]>> = [];
      const nameSearchGateway = createTestGateway(() => undefined, nameSearchInteractions, {
        loadBootstrap: () => createMockWorkspaceBootstrap("tauri")
      });
      nameSearchGateway.search = async (...args) => {
        searchCalls.push(args);
        args[2]?.onProgress?.({
          searchId: args[2]?.searchId,
          scannedEntries: 1,
          matchedEntries: 1,
          cancelled: false,
          statusText: "搜索完成：已扫描 1 项，匹配 1 项"
        });
        return [
          {
            id: "name-result",
            name: "release-notes.txt",
            kind: "file",
            path: "D:\\Projects\\Atlas\\release-notes.txt",
            parentPath: "D:\\Projects\\Atlas",
            openPath: "D:\\Projects\\Atlas",
            location: { kind: "local", label: "Atlas", path: "D:\\Projects\\Atlas" },
            match: "name"
          }
        ];
      };

      function NameSearchHarness() {
        nameSearchController = useWorkspaceController(nameSearchGateway);
        return React.createElement("div", null, nameSearchController.state.search.activeTab);
      }

      const nameSearchContainer = document.createElement("div");
      document.body.appendChild(nameSearchContainer);
      const nameSearchRoot = ReactDOM.createRoot(nameSearchContainer);

      try {
        await act(async () => {
          nameSearchRoot.render(React.createElement(NameSearchHarness));
          await flushEffects();
        });
        await waitFor(() => nameSearchController?.state.status === "ready", "name search controller did not bootstrap");

        await act(async () => {
          nameSearchController?.actions.selectSearchTab("name");
          nameSearchController?.actions.updateSearchQuery({
            name: "release",
            nameMode: "wildcard",
            extensionFilterText: "txt;md",
            extensionFilterMode: "include",
            includeFolders: true,
            recursive: false
          });
          await flushEffects();
        });

        await act(async () => {
          nameSearchController?.actions.runSearch();
          await flushEffects();
        });

        await waitFor(() => searchCalls.length === 1, "name search was not routed through the gateway");
        assert.deepEqual(searchCalls[0][0], {
          ...nameSearchController!.state.search.query,
          name: "release",
          content: "",
          nameMode: "wildcard",
          extensionFilterText: "txt;md",
          extensionFilterMode: "include",
          includeFolders: true,
          recursive: false
        });
        assert.deepEqual(nameSearchController?.state.search.histories.name, ["release"]);
        assert.deepEqual(nameSearchController?.state.search.histories.content, []);
        await waitFor(
          () => nameSearchController?.state.panels["panel-1"].tabs.some((tab) => tab.kind === "search-results") === true,
          "name search results tab was not committed"
        );
      } finally {
        await act(async () => {
          nameSearchRoot.unmount();
          await flushEffects();
        });
        nameSearchContainer.remove();
      }
    });

    await assertTest("useWorkspaceController falls back to the app menu when native context menu does not open", async () => {
      const fallbackInteractions = {
        resolvedPaths: [] as string[],
        copyCalls: [] as Array<{ paths: string[]; destination: string }>,
        moveCalls: [] as Array<{ paths: string[]; destination: string }>,
        deleteCalls: [] as Array<{ paths: string[] }>,
        renameCalls: [] as Array<{ source: string; newName: string }>,
        createDirectoryCalls: [] as Array<{ parent: string; name: string }>,
    createFileCalls: [] as Array<{ parent: string; name: string }>,
        treeLoadPaths: [] as string[],
        savedDetailsRowHeights: [] as number[],
        nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>
      };
      let fallbackController: ReturnType<typeof useWorkspaceController> | undefined;
      const fallbackGateway = createTestGateway(() => undefined, fallbackInteractions, {
        loadBootstrap: () => createMockWorkspaceBootstrap("tauri")
      });
      fallbackGateway.showNativeContextMenu = async (paths: string[], x: number, y: number) => {
        fallbackInteractions.nativeContextMenus.push({ paths: [...paths], x, y });
        return false;
      };

      function FallbackHarness() {
        fallbackController = useWorkspaceController(fallbackGateway);
        return React.createElement("div", null, fallbackController.state.status);
      }

      const fallbackContainer = document.createElement("div");
      document.body.appendChild(fallbackContainer);
      const fallbackRoot = ReactDOM.createRoot(fallbackContainer);

      try {
        await act(async () => {
          fallbackRoot.render(React.createElement(FallbackHarness));
          await flushEffects();
        });
        await waitFor(() => fallbackController?.state.status === "ready", "fallback controller did not bootstrap");

        await act(async () => {
          fallbackController?.actions.openNativeContextMenu({
            panelId: "panel-1",
            tabId: "panel-1-tab-1",
            paths: ["C:\\Users\\Admin\\Desktop\\notes.md"],
            clientX: 760,
            clientY: 540,
            screenX: 1120,
            screenY: 740
          });
          await flushEffects();
        });

        await waitFor(() => fallbackController?.state.contextMenu?.mode === "system-fallback", "fallback app menu did not open");
        assert.deepEqual(fallbackInteractions.nativeContextMenus, [
          {
            paths: ["C:\\Users\\Admin\\Desktop\\notes.md"],
            x: 1120,
            y: 740
          }
        ]);
        assert.deepEqual(fallbackController?.state.contextMenu, {
          x: 760,
          y: 540,
          panelId: "panel-1",
          tabId: "panel-1-tab-1",
          mode: "system-fallback",
          scope: "selection"
        });
      } finally {
        await act(async () => {
          fallbackRoot.unmount();
          await flushEffects();
        });
        fallbackContainer.remove();
      }
    });

    await assertTest("useWorkspaceController hydrates expanded tree nodes after bootstrap restores an unloaded tree", async () => {
      const hydratedInteractions = {
        resolvedPaths: [] as string[],
        copyCalls: [] as Array<{ paths: string[]; destination: string }>,
        moveCalls: [] as Array<{ paths: string[]; destination: string }>,
        deleteCalls: [] as Array<{ paths: string[] }>,
        renameCalls: [] as Array<{ source: string; newName: string }>,
        createDirectoryCalls: [] as Array<{ parent: string; name: string }>,
    createFileCalls: [] as Array<{ parent: string; name: string }>,
        treeLoadPaths: [] as string[],
        savedDetailsRowHeights: [] as number[],
        nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>
      };
      let hydratedController: ReturnType<typeof useWorkspaceController> | undefined;

      const bootstrap = createMockWorkspaceBootstrap("mock");
      const panel = bootstrap.panels["panel-1"];
      const activeTab = panel.tabs[0];
      const loadResponses = new Map<string, DirectoryNode[]>([
        [
          "D:\\",
          [
            {
              id: "D:\\Projects",
              label: "Projects",
              path: "D:\\Projects",
              kind: "folder",
              expandable: true,
              loaded: false,
              children: []
            }
          ]
        ],
        [
          "D:\\Projects",
          [
            {
              id: "D:\\Projects\\Atlas",
              label: "Atlas",
              path: "D:\\Projects\\Atlas",
              kind: "folder",
              expandable: true,
              loaded: false,
              children: []
            }
          ]
        ],
        [
          "D:\\Projects\\Atlas",
          [
            {
              id: "D:\\Projects\\Atlas\\src",
              label: "src",
              path: "D:\\Projects\\Atlas\\src",
              kind: "folder",
              expandable: false,
              loaded: true,
              children: []
            }
          ]
        ]
      ]);

      const hydrationGateway = createTestGateway(
        () => undefined,
        hydratedInteractions,
        {
          loadBootstrap: () => ({
            ...bootstrap,
            panels: {
              ...bootstrap.panels,
              "panel-1": {
                ...panel,
                activeTabId: activeTab.id,
                tabs: panel.tabs.map((tab) =>
                  tab.id === activeTab.id
                    ? {
                        ...tab,
                        expandedNodePaths: ["D:\\", "D:\\Projects", "D:\\Projects\\Atlas"]
                      }
                    : tab
                )
              }
            },
            directoryTree: [
              {
                id: "D:\\",
                label: "Projects (D:)",
                path: "D:\\",
                kind: "drive",
                expandable: true,
                loaded: false,
                children: []
              }
            ]
          }),
          loadTreeChildren: async (path) => loadResponses.get(path) ?? []
        }
      );

      function HydrationHarness() {
        hydratedController = useWorkspaceController(hydrationGateway);
        return React.createElement("div", null, hydratedController.state.status);
      }

      const hydrationContainer = document.createElement("div");
      document.body.appendChild(hydrationContainer);
      const hydrationRoot = ReactDOM.createRoot(hydrationContainer);

      try {
        await act(async () => {
          hydrationRoot.render(React.createElement(HydrationHarness));
          await flushEffects();
        });

        await waitFor(
          () => hydratedInteractions.treeLoadPaths.length === 3,
          "expanded tree paths were not rehydrated after bootstrap"
        );

        assert.deepEqual(hydratedInteractions.treeLoadPaths, ["D:\\", "D:\\Projects", "D:\\Projects\\Atlas"]);

        const driveNode = findTreeNode(hydratedController?.state.directoryTree ?? [], "D:\\");
        const projectsNode = findTreeNode(hydratedController?.state.directoryTree ?? [], "D:\\Projects");
        const atlasNode = findTreeNode(hydratedController?.state.directoryTree ?? [], "D:\\Projects\\Atlas");

        assert.equal(driveNode?.loaded, true);
        assert.equal(projectsNode?.loaded, true);
        assert.equal(atlasNode?.loaded, true);
        assert.equal(projectsNode?.children.some((node) => node.path === "D:\\Projects\\Atlas"), true);
        assert.equal(atlasNode?.children.some((node) => node.path === "D:\\Projects\\Atlas\\src"), true);
      } finally {
        await act(async () => {
          hydrationRoot.unmount();
          await flushEffects();
        });
        hydrationContainer.remove();
      }
    });

    await assertTest("useWorkspaceController does not hydrate remote tree nodes for reconnect-required tabs", async () => {
      const reconnectInteractions = {
        resolvedPaths: [] as string[],
        copyCalls: [] as Array<{ paths: string[]; destination: string }>,
        moveCalls: [] as Array<{ paths: string[]; destination: string }>,
        deleteCalls: [] as Array<{ paths: string[] }>,
        renameCalls: [] as Array<{ source: string; newName: string }>,
        createDirectoryCalls: [] as Array<{ parent: string; name: string }>,
        createFileCalls: [] as Array<{ parent: string; name: string }>,
        treeLoadPaths: [] as string[],
        savedDetailsRowHeights: [] as number[],
        nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>
      };
      let reconnectController: ReturnType<typeof useWorkspaceController> | undefined;
      const bootstrap = createMockWorkspaceBootstrap("tauri");
      const remoteRootPath = "sftp://deploy@edge-01.internal/releases";
      const remoteCurrentPath = `${remoteRootPath}/current`;
      const baseTab = bootstrap.panels["panel-1"].tabs[0];
      const remoteTab: typeof baseTab = {
        ...baseTab,
        id: "remote-reconnect-tab",
        title: "Edge",
        snapshot: {
          location: {
            kind: "sftp",
            label: "Edge",
            path: remoteCurrentPath
          },
          breadcrumbs: [{ id: remoteRootPath, label: "Edge", path: remoteRootPath }],
          entries: []
        },
        addressDraft: remoteCurrentPath,
        history: [remoteCurrentPath],
        historyIndex: 0,
        selectedEntryIds: [],
        expandedNodePaths: [remoteRootPath],
        status: "reconnect-required",
        reconnect: {
          path: remoteCurrentPath,
          profileId: "remote-1"
        }
      };

      const reconnectGateway = createTestGateway(
        () => undefined,
        reconnectInteractions,
        {
          loadBootstrap: () => ({
            ...bootstrap,
            activePanelId: "panel-1",
            remoteProfiles: [
              {
                id: "remote-1",
                name: "Edge",
                protocol: "sftp",
                host: "edge-01.internal",
                port: 22,
                username: "deploy",
                rootPath: "/releases",
                authKind: "password",
                passiveMode: true,
                ignoreHostKey: false,
                connectTimeoutSecs: 10,
                commandTimeoutSecs: 20
              }
            ],
            directoryTree: [
              {
                id: remoteRootPath,
                label: "Edge",
                path: remoteRootPath,
                kind: "remote-root",
                expandable: true,
                loaded: false,
                children: []
              }
            ],
            panels: {
              ...bootstrap.panels,
              "panel-1": {
                ...bootstrap.panels["panel-1"],
                activeTabId: remoteTab.id,
                tabs: [remoteTab]
              }
            }
          }),
          loadTreeChildren: async () => [
            {
              id: `${remoteRootPath}/child`,
              label: "child",
              path: `${remoteRootPath}/child`,
              kind: "folder",
              expandable: false,
              loaded: true,
              children: []
            }
          ]
        }
      );

      function ReconnectHarness() {
        reconnectController = useWorkspaceController(reconnectGateway);
        return React.createElement("div", null, reconnectController.state.status);
      }

      const reconnectContainer = document.createElement("div");
      document.body.appendChild(reconnectContainer);
      const reconnectRoot = ReactDOM.createRoot(reconnectContainer);

      try {
        await act(async () => {
          reconnectRoot.render(React.createElement(ReconnectHarness));
          await flushEffects();
        });
        await waitFor(() => reconnectController?.state.status === "ready", "reconnect controller did not bootstrap");
        await act(async () => {
          await flushEffects();
          await flushEffects();
        });

        assert.deepEqual(reconnectInteractions.treeLoadPaths, []);
      } finally {
        await act(async () => {
          reconnectRoot.unmount();
          await flushEffects();
        });
        reconnectContainer.remove();
      }
    });

    await assertTest("useWorkspaceController persists details row height changes through the workspace gateway", async () => {
      interactions.savedDetailsRowHeights.length = 0;

      await act(async () => {
        latestController?.actions.setDetailsRowHeight(50);
        await flushEffects();
      });

      assert.deepEqual(interactions.savedDetailsRowHeights, [50]);
      assert.equal(latestController?.state.settings.model.detailsRowHeight, 50);
    });
  } finally {
    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    dom.window.close();
  }
})();


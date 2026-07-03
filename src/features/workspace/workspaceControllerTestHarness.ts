import assert from "node:assert/strict";
import { act } from "react";
import { createMockWorkspaceBootstrap, resolveMockDirectory } from "./mockData";
import { installLegacyInputEventPatch } from "./testDom";
import type {
  DirectoryNode,
  EntryViewModel,
  OperationTaskSnapshot,
  RemoteConnectionProfile,
  SettingsModel,
  WorkspaceBootstrap,
  WorkspaceFsChangedEvent,
  WorkspaceWatchRootsRequest
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

export function assertTest(name: string, fn: () => Promise<void>) {
  return fn()
    .then(() => {
      console.log(`ok - ${name}`);
    })
    .catch((error) => {
      console.error(`not ok - ${name}`);
      throw error;
    });
}

export function createTestGateway(
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
    nativeBackgroundContextMenus?: Array<{ directoryPath: string; x: number; y: number }>;
    watchRootUpdates?: WorkspaceWatchRootsRequest[];
    fileSystemChangeListeners?: Array<(event: WorkspaceFsChangedEvent) => void | Promise<void>>;
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
    systemClipboardWrites?: Array<{ paths: string[]; mode: "copy" | "cut" }>;
    systemClipboardReads?: number;
    systemDragStarts?: string[][];
  },
  overrides: {
    loadBootstrap?: () => WorkspaceBootstrap | Promise<WorkspaceBootstrap>;
    resolveDirectory?: WorkspaceGateway["resolveDirectory"];
    loadTreeChildren?: (path: string) => DirectoryNode[] | Promise<DirectoryNode[]>;
    getItemProperties?: WorkspaceGateway["getItemProperties"];
    deleteEntries?: WorkspaceGateway["deleteEntries"];
    renameEntry?: WorkspaceGateway["renameEntry"];
    resolveNavigationTargets?: WorkspaceGateway["resolveNavigationTargets"];
    listOperationTasks?: WorkspaceGateway["listOperationTasks"];
    listenOperationTasks?: WorkspaceGateway["listenOperationTasks"];
    readSystemFileClipboard?: WorkspaceGateway["readSystemFileClipboard"];
    copyEntries?: WorkspaceGateway["copyEntries"];
    moveEntries?: WorkspaceGateway["moveEntries"];
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
      if (overrides.resolveDirectory) {
        return overrides.resolveDirectory(path);
      }
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
async getGitStatus() {
return { statuses: {}, isGitRepo: false };
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
    async getEntryComment() {
      return null;
    },
    async saveEntryComment(_path: string, comment: string) {
      return comment;
    },
    async removeEntryComment() {},
    async markEntryMetadataDeleted() {},
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
    async listenOperationHistory() {
      return () => undefined;
    },
    async listenSettingsChanged() {
      return () => undefined;
    },
    async listenEntryMetadataChanged() {
      return () => undefined;
    },
    async setWatchRoots(request) {
      interactions.watchRootUpdates?.push({
        directoryPaths: [...request.directoryPaths],
        navigationParentPaths: [...request.navigationParentPaths]
      });
    },
    async listenFileSystemChanges(handler) {
      interactions.fileSystemChangeListeners?.push(handler);
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
    async copyEntries(paths, destination, options) {
      if (overrides.copyEntries) {
        return overrides.copyEntries(paths, destination, options);
      }
      interactions.copyCalls.push({ paths: [...paths], destination });
    },
    async moveEntries(paths, destination, options) {
      if (overrides.moveEntries) {
        return overrides.moveEntries(paths, destination, options);
      }
      interactions.moveCalls.push({ paths: [...paths], destination });
    },
    async deleteEntries(paths) {
      if (overrides.deleteEntries) {
        return overrides.deleteEntries(paths);
      }
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
    async undoLatestOperation() {
      return { ...createOperationTask("undo-latest"), kind: "undo" };
    },
    async undoOperation(recordId) {
      return { ...createOperationTask(`undo-${recordId}`), kind: "undo" };
    },
    async setSystemFileClipboard(paths, mode) {
      interactions.systemClipboardWrites?.push({ paths: [...paths], mode });
    },
    async readSystemFileClipboard() {
      interactions.systemClipboardReads = (interactions.systemClipboardReads ?? 0) + 1;
      return overrides.readSystemFileClipboard ? overrides.readSystemFileClipboard() : null;
    },
    async startSystemFileDrag(paths) {
      interactions.systemDragStarts?.push([...paths]);
      return null;
    },
    async showNativeContextMenu(paths: string[], x: number, y: number) {
      interactions.nativeContextMenus.push({ paths: [...paths], x, y });
      return true;
    },
    async showNativeBackgroundContextMenu(directoryPath: string, x: number, y: number) {
      interactions.nativeBackgroundContextMenus?.push({ directoryPath, x, y });
      return { opened: true };
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
      if (overrides.resolveNavigationTargets) {
        return overrides.resolveNavigationTargets(paths);
      }
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

export function installDomEnvironment() {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost"
  });

  globalThis.window = dom.window as typeof globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLInputElement = dom.window.HTMLInputElement;
  globalThis.Node = dom.window.Node;
  installLegacyInputEventPatch(dom);
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

export async function flushEffects() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export async function waitFor(predicate: () => boolean, message: string) {
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

export function createEntry(parentPath: string, name: string, kind: EntryViewModel["kind"] = "file"): EntryViewModel {
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
    createdLabel: "",
    modifiedLabel: "2026-04-21 10:00",
    accessedLabel: "",
    extension: kind === "folder" ? "" : name.includes(".") ? `.${name.split(".").pop()}` : "",
    attributes: kind === "folder" ? ["D"] : ["A"],
    accentColor: "#0f6cbd",
    tags: [],
    comment: "",
    description: name
  };
}

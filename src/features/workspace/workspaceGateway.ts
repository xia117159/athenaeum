import {
  createMockWorkspaceBootstrap,
  searchMockCatalog
} from "./mockData";
import {
  createRemoteRootUri
} from "./remoteUri";
import {
  listRemoteProfilesRequired,
  loadWorkspaceTreeChildren,
  resolveWorkspaceDirectory
} from "./workspaceDirectoryGateway";
import {
  hydratePanels,
  mergeBootstrapWithSession
} from "./workspaceBootstrapSession";
import {
  hasTauriRuntime,
  invokeWithBrowserFallback,
  readSystemFileClipboard as readNativeSystemFileClipboard,
  setSystemFileClipboard as setNativeSystemFileClipboard,
  startSystemFileDrag as startNativeSystemFileDrag,
  showNativeBackgroundContextMenu as openNativeBackgroundContextMenu,
  showNativeContextMenu as openNativeContextMenu
} from "./workspaceIpc";
import {
  migrateLegacyWorkspaceSession,
  readPersistedSession,
  writeWorkspaceSession
} from "./workspaceSessionStore";
import { cancelWorkspaceSearch, runWorkspaceSearch } from "./workspaceSearch";
import {
  cancelWorkspaceOperation,
  copyWorkspaceEntries,
  createWorkspaceDirectory,
  createWorkspaceFile,
  deleteWorkspaceEntries,
  listWorkspaceOperationHistory,
  listWorkspaceOperationTasks,
  listenWorkspaceOperationHistory,
  listenWorkspaceOperationTasks,
  moveWorkspaceEntries,
  renameWorkspaceEntry,
  undoLatestWorkspaceOperation,
  undoWorkspaceOperation
} from "./workspaceOperationsGateway";
import {
  deleteWorkspaceBookmark,
  deleteWorkspaceHotlist,
  deleteWorkspaceRemoteProfile,
  deleteWorkspaceNavigationItem,
  markWorkspaceNavigationItemOpened,
  saveWorkspaceBookmark,
  saveWorkspaceColorRules,
  saveWorkspaceDetailsRowHeight,
  saveWorkspaceHotlist,
  saveWorkspaceNavigationItem,
  saveWorkspaceLayout,
  saveWorkspaceRemoteProfile,
  saveWorkspaceSettingsModel,
  saveWorkspaceShortcuts,
  saveWorkspaceTheme,
  reorderWorkspaceNavigationItems,
  listenWorkspaceSettingsChanged,
  testWorkspaceRemoteProfile,
  getWorkspaceRemoteHostKey,
  trustWorkspaceRemoteHostKey,
  type WorkspaceSettingsProjection
} from "./workspaceSettingsGateway";
import {
  openWorkspacePathWithSystemDefault,
  resolveWorkspaceNavigationTargets
} from "./workspaceNavigationGateway";
import {
  listenWorkspaceFsChanges,
  setWorkspaceWatchRoots
} from "./workspaceLiveRefreshGateway";
import {
  mapWorkspaceBootstrap
} from "./workspaceMappers";
import {
  getWorkspaceItemProperties
} from "./workspacePropertiesGateway";
import type {
  RemoteHostKeyInfo as BackendRemoteHostKeyInfo,
  OperationHistoryEventEnvelope,
  OperationHistoryListSnapshot,
  OperationIntent,
  OperationTaskEventEnvelope,
  OperationTaskListSnapshot,
  OperationTaskSnapshot,
  RemoteTestResult as BackendRemoteTestResult,
  RemoteTrustHostKeyRequest as BackendRemoteTrustHostKeyRequest,
  WorkspaceBootstrap as BackendWorkspaceBootstrap
} from "../../app/types";
import type {
  DirectoryNode,
  DirectorySnapshot,
  LayoutRatios,
  NavigationItem,
  NavigationItemUpsertRequest,
  NativeBackgroundContextMenuOptions,
  NativeBackgroundContextMenuResult,
  NavigationTargetInfo,
  PanelLayoutMode,
  RemoteConnectionProfile,
  SearchProgressState,
  SettingsModel,
  SystemFileClipboard,
  WorkspaceFsChangedEvent,
  WorkspaceWatchRootsRequest,
  WorkspaceBootstrap,
  WorkspaceState,
  ItemProperties
} from "./types";

export interface WorkspaceGateway {
  loadBootstrap(): Promise<WorkspaceBootstrap>;
  resolveDirectory(path: string): Promise<DirectorySnapshot>;
  loadTreeChildren(path: string): Promise<DirectoryNode[]>;
  search(
    query: WorkspaceState["search"]["query"],
    scopePaths: string[],
    options?: { searchId?: string; onProgress?: (progress: SearchProgressState) => void }
  ): Promise<WorkspaceState["search"]["results"]>;
  cancelSearch(searchId: string): Promise<void>;
  getItemProperties(requestId: string, path: string, includeDirectorySize?: boolean): Promise<ItemProperties>;
  saveSession(state: WorkspaceState): Promise<void>;
  saveLayout(layoutMode: PanelLayoutMode, layoutRatios: LayoutRatios, treeVisible: boolean): Promise<void>;
  saveShortcuts(shortcuts: SettingsModel["shortcuts"]): Promise<void>;
  saveColorRules(colorRules: SettingsModel["colorRules"]): Promise<void>;
  saveDetailsRowHeight(value: number): Promise<void>;
  saveTheme(theme: SettingsModel["theme"]): Promise<void>;
  saveSettingsModel(model: SettingsModel): Promise<void>;
  saveBookmark(path: string, label: string): Promise<Pick<WorkspaceState, "bookmarks" | "hotlist">>;
  deleteBookmark(id: string): Promise<Pick<WorkspaceState, "bookmarks" | "hotlist">>;
  saveHotlist(path: string, label: string): Promise<Pick<WorkspaceState, "bookmarks" | "hotlist">>;
  deleteHotlist(id: string): Promise<Pick<WorkspaceState, "bookmarks" | "hotlist">>;
  saveNavigationItem(item: NavigationItem | NavigationItemUpsertRequest): Promise<{ navigationItems: NavigationItem[] }>;
  deleteNavigationItem(id: string): Promise<{ navigationItems: NavigationItem[] }>;
  reorderNavigationItems(ids: string[]): Promise<{ navigationItems: NavigationItem[] }>;
  markNavigationItemOpened(id: string): Promise<{ navigationItems: NavigationItem[] }>;
  resolveNavigationTargets(paths: string[]): Promise<NavigationTargetInfo[]>;
  openPathWithSystemDefault(path: string): Promise<void>;
  saveRemoteProfile(profile: RemoteConnectionProfile, password?: string): Promise<{ remoteProfiles: RemoteConnectionProfile[] }>;
  deleteRemoteProfile(id: string): Promise<{ remoteProfiles: RemoteConnectionProfile[] }>;
  testRemoteProfile(profile: RemoteConnectionProfile, password?: string): Promise<BackendRemoteTestResult>;
  getRemoteHostKey(profileId: string): Promise<BackendRemoteHostKeyInfo>;
  trustRemoteHostKey(request: BackendRemoteTrustHostKeyRequest): Promise<BackendRemoteHostKeyInfo>;
  listOperationTasks(): Promise<OperationTaskListSnapshot>;
  listOperationHistory(): Promise<OperationHistoryListSnapshot>;
  listenOperationTasks(handler: (event: OperationTaskEventEnvelope) => void): Promise<() => void>;
  listenOperationHistory(handler: (event: OperationHistoryEventEnvelope) => void): Promise<() => void>;
  listenSettingsChanged(handler: (event: WorkspaceSettingsProjection) => void): Promise<() => void>;
  setWatchRoots(request: WorkspaceWatchRootsRequest): Promise<void>;
  listenFileSystemChanges(handler: (event: WorkspaceFsChangedEvent) => void): Promise<() => void>;
  copyEntries(
    paths: string[],
    destination: string,
    options?: Partial<Pick<OperationIntent, "requestId" | "source" | "panelId" | "tabId">>
  ): Promise<OperationTaskSnapshot | void>;
  moveEntries(
    paths: string[],
    destination: string,
    options?: Partial<Pick<OperationIntent, "requestId" | "source" | "panelId" | "tabId">>
  ): Promise<OperationTaskSnapshot | void>;
  deleteEntries(
    paths: string[],
    options?: Partial<Pick<OperationIntent, "requestId" | "source" | "panelId" | "tabId">>
  ): Promise<OperationTaskSnapshot | void>;
  renameEntry(
    source: string,
    newName: string,
    options?: Partial<Pick<OperationIntent, "requestId" | "source" | "panelId" | "tabId">>
  ): Promise<OperationTaskSnapshot | void>;
  createDirectory(
    parent: string,
    name: string,
    options?: Partial<Pick<OperationIntent, "requestId" | "source" | "panelId" | "tabId">>
  ): Promise<OperationTaskSnapshot | void>;
  createFile(
    parent: string,
    name: string,
    options?: Partial<Pick<OperationIntent, "requestId" | "source" | "panelId" | "tabId">>
  ): Promise<OperationTaskSnapshot | void>;
  cancelOperation(taskId: string): Promise<OperationTaskSnapshot>;
  undoLatestOperation(requestId?: string): Promise<OperationTaskSnapshot>;
  undoOperation(recordId: string, requestId?: string): Promise<OperationTaskSnapshot>;
  setSystemFileClipboard(paths: string[], mode: SystemFileClipboard["mode"]): Promise<void>;
  readSystemFileClipboard(): Promise<SystemFileClipboard | null>;
  startSystemFileDrag(paths: string[]): Promise<SystemFileClipboard["mode"] | null>;
  showNativeContextMenu(paths: string[], x: number, y: number): Promise<boolean>;
  showNativeBackgroundContextMenu(
    directoryPath: string,
    x: number,
    y: number,
    options: NativeBackgroundContextMenuOptions
  ): Promise<NativeBackgroundContextMenuResult>;
}

export {
  createRemoteRootUri,
  planCopyOrMoveEntries,
  planCreateDirectory,
  planCreateFile,
  planDeleteEntries,
  planRenameEntry
} from "./remoteUri";
export {
  mapDirectoryListingToSnapshot,
  mapFavoriteCollections,
  mapSettingsSnapshotToWorkspaceSettings,
  mapWorkspaceBootstrap
} from "./workspaceMappers";

export function createWorkspaceGateway(): WorkspaceGateway {
  // 防护：维护当前 watch roots 状态，防止频繁调用后端
  let currentWatchRootsKey = "";

  return {
    async loadBootstrap() {
      if (!hasTauriRuntime()) {
        return createMockWorkspaceBootstrap("mock");
      }

      const backendBootstrap = await invokeWithBrowserFallback<BackendWorkspaceBootstrap>(
        "initialize_workspace",
        {},
        () => {
          throw new Error("Workspace bootstrap data is unavailable");
        }
      );

      let bootstrap = mapWorkspaceBootstrap(backendBootstrap);
      const remoteProfiles = backendBootstrap.settings.remoteProfiles;
      const seedPaths = [
        backendBootstrap.initialPath,
        backendBootstrap.settings.bookmarks[0]?.path,
        backendBootstrap.settings.hotlist[0]?.path,
        remoteProfiles[0] ? createRemoteRootUri(remoteProfiles[0]) : undefined,
        backendBootstrap.drives[1]?.path
      ].filter((value): value is string => Boolean(value));

      bootstrap = await hydratePanels(bootstrap, seedPaths, remoteProfiles);
      migrateLegacyWorkspaceSession();
      return mergeBootstrapWithSession(bootstrap, readPersistedSession(), remoteProfiles);
    },

    async resolveDirectory(path: string) {
      const profiles = await listRemoteProfilesRequired();
      return resolveWorkspaceDirectory(path, profiles);
    },

    async loadTreeChildren(path: string) {
      const profiles = await listRemoteProfilesRequired();
      return loadWorkspaceTreeChildren(path, profiles);
    },

    async search(query, scopePaths, options) {
      if (!hasTauriRuntime()) {
        return searchMockCatalog(query, scopePaths);
      }

      const profiles = await listRemoteProfilesRequired();
      return runWorkspaceSearch(query, scopePaths, profiles, {
        searchId: options?.searchId,
        onProgress: options?.onProgress
      });
    },

    async cancelSearch(searchId: string) {
      if (!hasTauriRuntime()) {
        return;
      }

      await cancelWorkspaceSearch(searchId);
    },

    async getItemProperties(requestId, path, includeDirectorySize = false) {
      const profiles = await listRemoteProfilesRequired();
      return getWorkspaceItemProperties(
        {
          requestId,
          path,
          includeDirectorySize
        },
        profiles
      );
    },

    async saveSession(state: WorkspaceState) {
      writeWorkspaceSession(state);
    },

    async saveLayout(layoutMode, layoutRatios, treeVisible) {
      await saveWorkspaceLayout(layoutMode, layoutRatios, treeVisible);
    },

    async saveShortcuts(shortcuts) {
      await saveWorkspaceShortcuts(shortcuts);
    },

    async saveColorRules(colorRules) {
      await saveWorkspaceColorRules(colorRules);
    },

    async saveDetailsRowHeight(value) {
      await saveWorkspaceDetailsRowHeight(value);
    },

    async saveTheme(theme) {
      await saveWorkspaceTheme(theme);
    },

    async saveSettingsModel(model) {
      await saveWorkspaceSettingsModel(model);
    },

    async saveBookmark(path, label) {
      return saveWorkspaceBookmark(path, label);
    },

    async deleteBookmark(id) {
      return deleteWorkspaceBookmark(id);
    },

    async saveHotlist(path, label) {
      return saveWorkspaceHotlist(path, label);
    },

    async deleteHotlist(id) {
      return deleteWorkspaceHotlist(id);
    },

    async saveNavigationItem(item) {
      return saveWorkspaceNavigationItem(item);
    },

    async deleteNavigationItem(id) {
      return deleteWorkspaceNavigationItem(id);
    },

    async reorderNavigationItems(ids) {
      return reorderWorkspaceNavigationItems(ids);
    },

    async markNavigationItemOpened(id) {
      return markWorkspaceNavigationItemOpened(id);
    },

    async resolveNavigationTargets(paths) {
      return resolveWorkspaceNavigationTargets(paths);
    },

    async openPathWithSystemDefault(path) {
      await openWorkspacePathWithSystemDefault(path);
    },

    async saveRemoteProfile(profile, password) {
      return saveWorkspaceRemoteProfile(profile, password);
    },

    async deleteRemoteProfile(id) {
      return deleteWorkspaceRemoteProfile(id);
    },

    async testRemoteProfile(profile, password) {
      return testWorkspaceRemoteProfile(profile, password);
    },

    async getRemoteHostKey(profileId) {
      return getWorkspaceRemoteHostKey(profileId);
    },

    async trustRemoteHostKey(request) {
      return trustWorkspaceRemoteHostKey(request);
    },

    async listOperationTasks() {
      return listWorkspaceOperationTasks();
    },

    async listOperationHistory() {
      return listWorkspaceOperationHistory();
    },

    async listenOperationTasks(handler) {
      return listenWorkspaceOperationTasks(handler);
    },

    async listenOperationHistory(handler) {
      return listenWorkspaceOperationHistory(handler);
    },

    async listenSettingsChanged(handler) {
      return listenWorkspaceSettingsChanged(handler);
    },
    async setWatchRoots(request) {
      // 防护：只在 roots 真正变化时才调用后端
      const key = JSON.stringify({
        dir: request.directoryPaths.sort(),
        nav: request.navigationParentPaths.sort()
      });
      if (currentWatchRootsKey === key) {
        return;
      }
      currentWatchRootsKey = key;
      return setWorkspaceWatchRoots(request);
    },
    async listenFileSystemChanges(handler) {
      return listenWorkspaceFsChanges(handler);
    },

    async copyEntries(paths, destination, options) {
      return copyWorkspaceEntries(paths, destination, {}, options);
    },

    async moveEntries(paths, destination, options) {
      return moveWorkspaceEntries(paths, destination, {}, options);
    },

    async deleteEntries(paths, options) {
      return deleteWorkspaceEntries(paths, {}, options);
    },

    async renameEntry(source, newName, options) {
      return renameWorkspaceEntry(source, newName, {}, options);
    },

    async createDirectory(parent, name, options) {
      return createWorkspaceDirectory(parent, name, {}, options);
    },

    async createFile(parent, name, options) {
      return createWorkspaceFile(parent, name, {}, options);
    },

    async cancelOperation(taskId) {
      return cancelWorkspaceOperation(taskId);
    },

    async undoLatestOperation(requestId) {
      return undoLatestWorkspaceOperation(requestId);
    },

    async undoOperation(recordId, requestId) {
      return undoWorkspaceOperation(recordId, requestId);
    },

    async setSystemFileClipboard(paths, mode) {
      await setNativeSystemFileClipboard(paths, mode);
    },

    async readSystemFileClipboard() {
      return readNativeSystemFileClipboard();
    },

    async startSystemFileDrag(paths) {
      return startNativeSystemFileDrag(paths);
    },

    async showNativeContextMenu(paths, x, y) {
      return openNativeContextMenu(paths, x, y);
    },

    async showNativeBackgroundContextMenu(directoryPath, x, y, options) {
      return openNativeBackgroundContextMenu(directoryPath, x, y, options);
    }
  };
}

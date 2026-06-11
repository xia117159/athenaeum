import { listen } from "@tauri-apps/api/event";
import type {
  RemoteHostKeyInfo,
  RemoteProfile as BackendRemoteProfile,
  RemoteTestResult as BackendRemoteTestResult,
  RemoteTrustHostKeyRequest,
  SettingsSnapshot as BackendSettingsSnapshot
} from "../../app/types";
import type {
  LayoutRatios,
  NavigationItem,
  NavigationItemUpsertRequest,
  PanelLayoutMode,
  RemoteConnectionProfile,
  SettingsModel,
  WorkspaceState
} from "./types";
import {
  createBrowserSettingsSnapshot,
  toBackendColorRule,
  toBackendLayout,
  toBackendRemoteProfile,
  toBackendSettingsModelUpdate,
  toBackendShortcut,
  toBackendTheme,
  toNavigationItemUpsertRequest,
  toRemoteProfileUpsertRequest
} from "./workspaceBackendDtos";
import { hasTauriRuntime, invokeRequired, invokeWithBrowserFallback, type WorkspaceInvoke } from "./workspaceIpc";
import {
  mapFavoriteCollections,
  mapNavigationItems,
  mapSettingsSnapshotToWorkspaceSettings,
  mapRemoteProfiles,
  normalizeDetailsRowHeight
} from "./workspaceMappers";

type RuntimeHost = object | null | undefined;

type WorkspaceSettingsRuntime = {
  invoke?: WorkspaceInvoke;
  runtimeHost?: RuntimeHost;
  createId?: (prefix: string) => string;
  listen?: WorkspaceSettingsListen;
};

type WorkspaceEvent<T> = {
  payload: T;
};

export type WorkspaceSettingsListen = <T>(
  eventName: string,
  handler: (event: WorkspaceEvent<T>) => void | Promise<void>
) => Promise<() => void>;

function createDefaultId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}`;
}

function createRuntimeId(prefix: string, runtime: WorkspaceSettingsRuntime) {
  return runtime.createId ? runtime.createId(prefix) : createDefaultId(prefix);
}

export async function saveWorkspaceLayout(
  layoutMode: PanelLayoutMode,
  layoutRatios: LayoutRatios,
  runtime: WorkspaceSettingsRuntime = {}
) {
  await invokeWithBrowserFallback<BackendSettingsSnapshot>(
    "save_ui_layout",
    {
      layout: toBackendLayout(layoutMode, layoutRatios)
    },
    async () => createBrowserSettingsSnapshot(),
    runtime.invoke,
    runtime.runtimeHost
  );
}

export async function saveWorkspaceShortcuts(
  shortcuts: SettingsModel["shortcuts"],
  runtime: WorkspaceSettingsRuntime = {}
) {
  await invokeWithBrowserFallback<BackendSettingsSnapshot>(
    "save_shortcuts",
    {
      shortcuts: shortcuts.map(toBackendShortcut)
    },
    async () => createBrowserSettingsSnapshot(),
    runtime.invoke,
    runtime.runtimeHost
  );
}

export async function saveWorkspaceColorRules(
  colorRules: SettingsModel["colorRules"],
  runtime: WorkspaceSettingsRuntime = {}
) {
  for (const [index, rule] of colorRules.entries()) {
    await invokeWithBrowserFallback<BackendSettingsSnapshot>(
      "save_color_rule",
      {
        rule: toBackendColorRule(rule, index)
      },
      async () => createBrowserSettingsSnapshot(),
      runtime.invoke,
      runtime.runtimeHost
    );
  }
}

export async function saveWorkspaceDetailsRowHeight(value: number, runtime: WorkspaceSettingsRuntime = {}) {
  await invokeWithBrowserFallback<BackendSettingsSnapshot>(
    "save_details_row_height",
    {
      detailsRowHeight: normalizeDetailsRowHeight(value)
    },
    async () => createBrowserSettingsSnapshot(),
    runtime.invoke,
    runtime.runtimeHost
  );
}

export async function saveWorkspaceTheme(theme: SettingsModel["theme"], runtime: WorkspaceSettingsRuntime = {}) {
  await invokeWithBrowserFallback<BackendSettingsSnapshot>(
    "save_ui_theme",
    {
      theme: toBackendTheme(theme)
    },
    async () => createBrowserSettingsSnapshot({ theme: toBackendTheme(theme) }),
    runtime.invoke,
    runtime.runtimeHost
  );
}

export async function saveWorkspaceSettingsModel(model: SettingsModel, runtime: WorkspaceSettingsRuntime = {}) {
  await invokeWithBrowserFallback<BackendSettingsSnapshot>(
    "save_settings_model",
    {
      model: toBackendSettingsModelUpdate(model)
    },
    async () =>
      createBrowserSettingsSnapshot({
        shortcuts: model.shortcuts.map(toBackendShortcut),
        colorRules: model.colorRules.map(toBackendColorRule),
        detailsRowHeight: normalizeDetailsRowHeight(model.detailsRowHeight),
        theme: toBackendTheme(model.theme)
      }),
    runtime.invoke,
    runtime.runtimeHost
  );
}

export type WorkspaceSettingsProjection = ReturnType<typeof mapSettingsSnapshotToWorkspaceSettings>;

export async function listenWorkspaceSettingsChanged(
  handler: (payload: WorkspaceSettingsProjection) => void,
  runtime: WorkspaceSettingsRuntime = {}
) {
  if (!hasTauriRuntime(runtime.runtimeHost)) {
    return () => undefined;
  }

  const listenFn = runtime.listen ?? listen;
  return listenFn<BackendSettingsSnapshot>("settings_changed", (event) =>
    handler(mapSettingsSnapshotToWorkspaceSettings(event.payload))
  );
}

export async function saveWorkspaceBookmark(path: string, label: string, runtime: WorkspaceSettingsRuntime = {}) {
  const bookmark = {
    id: createRuntimeId("bookmark", runtime),
    name: label,
    path
  };
  const snapshot = await invokeWithBrowserFallback<BackendSettingsSnapshot>(
    "save_bookmark",
    { bookmark },
    async () => createBrowserSettingsSnapshot({ bookmarks: [bookmark] }),
    runtime.invoke,
    runtime.runtimeHost
  );
  return mapFavoriteCollections(snapshot);
}

export async function deleteWorkspaceBookmark(id: string, runtime: WorkspaceSettingsRuntime = {}) {
  const snapshot = await invokeWithBrowserFallback<BackendSettingsSnapshot>(
    "delete_bookmark",
    { id },
    async () => createBrowserSettingsSnapshot(),
    runtime.invoke,
    runtime.runtimeHost
  );
  return mapFavoriteCollections(snapshot);
}

export async function saveWorkspaceHotlist(path: string, label: string, runtime: WorkspaceSettingsRuntime = {}) {
  const entry = {
    id: createRuntimeId("hotlist", runtime),
    name: label,
    path
  };
  const snapshot = await invokeWithBrowserFallback<BackendSettingsSnapshot>(
    "save_hotlist_entry",
    { entry },
    async () => createBrowserSettingsSnapshot({ hotlist: [entry] }),
    runtime.invoke,
    runtime.runtimeHost
  );
  return mapFavoriteCollections(snapshot);
}

export async function deleteWorkspaceHotlist(id: string, runtime: WorkspaceSettingsRuntime = {}) {
  const snapshot = await invokeWithBrowserFallback<BackendSettingsSnapshot>(
    "delete_hotlist_entry",
    { id },
    async () => createBrowserSettingsSnapshot(),
    runtime.invoke,
    runtime.runtimeHost
  );
  return mapFavoriteCollections(snapshot);
}

export async function saveWorkspaceNavigationItem(
  item: NavigationItem | NavigationItemUpsertRequest,
  runtime: WorkspaceSettingsRuntime = {}
) {
  const snapshot = await invokeWithBrowserFallback<BackendSettingsSnapshot>(
    "save_navigation_item",
    { request: toNavigationItemUpsertRequest(item) },
    async () =>
      createBrowserSettingsSnapshot({
        navigationItems: [
          {
            id: "id" in item && item.id ? item.id : createRuntimeId("navigation", runtime),
            displayName: item.displayName?.trim() || item.path.split(/[\\/]/).filter(Boolean).pop() || item.path,
            description: item.description.trim(),
            path: item.path.trim(),
            targetKind: "missing",
            targetStatus: "missing",
            sortOrder: 1,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString()
          }
        ]
      }),
    runtime.invoke,
    runtime.runtimeHost
  );
  return {
    navigationItems: mapNavigationItems(snapshot)
  };
}

export async function deleteWorkspaceNavigationItem(id: string, runtime: WorkspaceSettingsRuntime = {}) {
  const snapshot = await invokeWithBrowserFallback<BackendSettingsSnapshot>(
    "delete_navigation_item",
    { id },
    async () => createBrowserSettingsSnapshot(),
    runtime.invoke,
    runtime.runtimeHost
  );
  return {
    navigationItems: mapNavigationItems(snapshot)
  };
}

export async function reorderWorkspaceNavigationItems(ids: string[], runtime: WorkspaceSettingsRuntime = {}) {
  const snapshot = await invokeWithBrowserFallback<BackendSettingsSnapshot>(
    "reorder_navigation_items",
    { ids },
    async () => createBrowserSettingsSnapshot(),
    runtime.invoke,
    runtime.runtimeHost
  );
  return {
    navigationItems: mapNavigationItems(snapshot)
  };
}

export async function markWorkspaceNavigationItemOpened(id: string, runtime: WorkspaceSettingsRuntime = {}) {
  const snapshot = await invokeWithBrowserFallback<BackendSettingsSnapshot>(
    "mark_navigation_item_opened",
    { id },
    async () =>
      createBrowserSettingsSnapshot({
        navigationItems: [
          {
            id,
            displayName: id,
            description: "",
            path: id,
            targetKind: "missing",
            targetStatus: "missing",
            sortOrder: 1,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            lastOpenedAt: new Date(0).toISOString()
          }
        ]
      }),
    runtime.invoke,
    runtime.runtimeHost
  );
  return {
    navigationItems: mapNavigationItems(snapshot)
  };
}

export async function saveWorkspaceRemoteProfile(
  profile: RemoteConnectionProfile,
  password?: string,
  runtime: WorkspaceSettingsRuntime = {}
) {
  const profiles = await invokeRequired<BackendRemoteProfile[]>(
    "save_remote_profile",
    {
      request: toRemoteProfileUpsertRequest(profile, password)
    },
    async () => [toBackendRemoteProfile(profile)],
    runtime.invoke,
    runtime.runtimeHost
  );

  return {
    remoteProfiles: mapRemoteProfiles(profiles)
  };
}

export async function deleteWorkspaceRemoteProfile(id: string, runtime: WorkspaceSettingsRuntime = {}) {
  const profiles = await invokeRequired<BackendRemoteProfile[]>(
    "delete_remote_profile",
    { id },
    async () => [],
    runtime.invoke,
    runtime.runtimeHost
  );

  return {
    remoteProfiles: mapRemoteProfiles(profiles)
  };
}

export async function testWorkspaceRemoteProfile(
  profile: RemoteConnectionProfile,
  password?: string,
  runtime: WorkspaceSettingsRuntime = {}
): Promise<BackendRemoteTestResult> {
  return invokeRequired<BackendRemoteTestResult>(
    "test_remote_profile",
    {
      request: toRemoteProfileUpsertRequest(profile, password)
    },
    async () => ({
      success: true,
      message: "Mock remote connection test succeeded",
      adapter: "curl",
      details: []
    }),
    runtime.invoke,
    runtime.runtimeHost
  );
}

export async function getWorkspaceRemoteHostKey(profileId: string, runtime: WorkspaceSettingsRuntime = {}) {
  return invokeRequired<RemoteHostKeyInfo>(
    "get_remote_host_key",
    { profileId },
    async () => ({
      profileId,
      host: "mock.remote",
      port: 22,
      algorithm: "ssh-ed25519",
      fingerprintSha256: "SHA256:mock",
      keyBase64: "mock",
      knownHostsEntry: "mock.remote ssh-ed25519 mock",
      trustState: "unknown"
    }),
    runtime.invoke,
    runtime.runtimeHost
  );
}

export async function trustWorkspaceRemoteHostKey(request: RemoteTrustHostKeyRequest, runtime: WorkspaceSettingsRuntime = {}) {
  return invokeRequired<RemoteHostKeyInfo>(
    "trust_remote_host_key",
    { request },
    async () => ({
      profileId: request.profileId,
      host: request.host,
      port: request.port,
      algorithm: request.algorithm,
      fingerprintSha256: "SHA256:mock",
      keyBase64: request.keyBase64,
      knownHostsEntry: `${request.host} ${request.algorithm} ${request.keyBase64}`,
      trustState: "trusted"
    }),
    runtime.invoke,
    runtime.runtimeHost
  );
}

export type FavoriteCollections = Pick<WorkspaceState, "bookmarks" | "hotlist">;
export type NavigationCollection = { navigationItems: NavigationItem[] };

import { listen } from "@tauri-apps/api/event";
import { hasTauriRuntime, invokeRequired, type WorkspaceInvoke } from "./workspaceIpc";
import type { WorkspaceFsChangedEvent, WorkspaceWatchRootsRequest } from "./types";

type RuntimeHost = object | null | undefined;
type WorkspaceListen = <T>(
  eventName: string,
  handler: (event: { payload: T }) => void | Promise<void>
) => Promise<() => void>;

export async function setWorkspaceWatchRoots(
  request: WorkspaceWatchRootsRequest,
  invokeFn?: WorkspaceInvoke,
  runtimeHost?: RuntimeHost
) {
  const hasRuntime = hasTauriRuntime(runtimeHost);
  console.log("[LiveRefresh] setWorkspaceWatchRoots called:", {
    hasRuntime,
    directoryPaths: request.directoryPaths,
    navigationParentPaths: request.navigationParentPaths
  });

  await invokeRequired<void>(
    "set_workspace_watch_roots",
    {
      request: {
        directoryPaths: request.directoryPaths,
        navigationParentPaths: request.navigationParentPaths
      }
    },
    () => {
      console.log("[LiveRefresh] Using browser fallback (no Tauri runtime)");
      return undefined;
    },
    invokeFn,
    runtimeHost
  );

  console.log("[LiveRefresh] setWorkspaceWatchRoots completed");
}

export function listenWorkspaceFsChanges(
  handler: (event: WorkspaceFsChangedEvent) => void | Promise<void>,
  runtime: { listen?: WorkspaceListen; runtimeHost?: RuntimeHost } = {}
) {
  const runtimeHost = runtime.runtimeHost ?? (typeof window === "undefined" ? undefined : window);
  const hasRuntime = hasTauriRuntime(runtimeHost);
  console.log("[LiveRefresh] listenWorkspaceFsChanges called:", { hasRuntime });

  if (!hasRuntime) {
    console.log("[LiveRefresh] No Tauri runtime detected, returning noop");
    return Promise.resolve(() => undefined);
  }

  const listenFn = runtime.listen ?? listen;
  console.log("[LiveRefresh] Setting up event listener for workspace_fs_changed");

  return listenFn<WorkspaceFsChangedEvent>("workspace_fs_changed", (event) => {
    console.log("[LiveRefresh] Received workspace_fs_changed event:", event.payload);
    handler(event.payload);
  });
}

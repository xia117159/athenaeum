import type { NavigationTargetInfo } from "../../app/types";
import type { NavigationTargetInfo as WorkspaceNavigationTargetInfo } from "./types";
import { invokeRequired, type WorkspaceInvoke } from "./workspaceIpc";

type RuntimeHost = object | null | undefined;

type WorkspaceNavigationRuntime = {
  invoke?: WorkspaceInvoke;
  runtimeHost?: RuntimeHost;
};

function mapTargetInfo(info: NavigationTargetInfo): WorkspaceNavigationTargetInfo {
  return {
    path: info.path,
    normalizedPath: info.normalizedPath ?? undefined,
    canonicalPath: info.canonicalPath ?? undefined,
    displayName: info.displayName,
    targetKind: info.targetKind,
    targetStatus: info.targetStatus,
    message: info.message ?? undefined,
    exists: info.exists,
    isLocal: info.isLocal,
    parentPath: info.parentPath ?? undefined
  };
}

export async function resolveWorkspaceNavigationTargets(paths: string[], runtime: WorkspaceNavigationRuntime = {}) {
  const infos = await invokeRequired<NavigationTargetInfo[]>(
    "resolve_navigation_targets",
    { paths },
    async () =>
      paths.map((path) => ({
        path,
        normalizedPath: path,
        canonicalPath: null,
        displayName: path.split(/[\\/]/).filter(Boolean).pop() || path,
        targetKind: "missing",
        targetStatus: "missing",
        message: "Browser fallback cannot check this path.",
        exists: false,
        isLocal: !path.startsWith("ftp://") && !path.startsWith("sftp://"),
        parentPath: null
      })),
    runtime.invoke,
    runtime.runtimeHost
  );
  return infos.map(mapTargetInfo);
}

export async function openWorkspacePathWithSystemDefault(path: string, runtime: WorkspaceNavigationRuntime = {}) {
  await invokeRequired<void>(
    "open_path_with_system_default",
    { path },
    async () => undefined,
    runtime.invoke,
    runtime.runtimeHost
  );
}


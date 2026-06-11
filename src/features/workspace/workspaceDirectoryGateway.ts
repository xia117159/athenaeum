import type {
  DirectoryListing as BackendDirectoryListing,
  EntryViewModel as BackendEntryViewModel,
  RemoteProfile as BackendRemoteProfile,
  TreeNode as BackendTreeNode
} from "../../app/types";
import { normalizeLocationPath } from "./mockData";
import { normalizeRemotePath, resolveRemotePath } from "./remoteUri";
import { invokeRequired, invokeWithBrowserFallback, type WorkspaceInvoke } from "./workspaceIpc";
import { mapDirectoryListingToSnapshot } from "./workspaceMappers";
import type { DirectoryNode, DirectorySnapshot } from "./types";

type RuntimeHost = object | null | undefined;

type WorkspaceDirectoryRuntime = {
  invoke?: WorkspaceInvoke;
  runtimeHost?: RuntimeHost;
};

function isRemoteUriPath(path: string) {
  return path.startsWith("ftp://") || path.startsWith("sftp://");
}

export async function listRemoteProfilesRequired(runtime: WorkspaceDirectoryRuntime = {}) {
  return invokeRequired<BackendRemoteProfile[]>(
    "list_remote_profiles",
    {},
    async () => [],
    runtime.invoke,
    runtime.runtimeHost
  );
}

export async function resolveWorkspaceDirectory(
  path: string,
  profiles: BackendRemoteProfile[],
  runtime: WorkspaceDirectoryRuntime = {}
) {
  const remote = resolveRemotePath(path, profiles);
  if (remote) {
    const entries = await invokeRequired<BackendEntryViewModel[]>(
      "list_remote_directory",
      {
        request: {
          profileId: remote.profile.id,
          path: remote.remotePath
        }
      },
      async () => [],
      runtime.invoke,
      runtime.runtimeHost
    );

    const listing: BackendDirectoryListing = {
      location: {
        kind: remote.profile.protocol,
        path: remote.remotePath,
        connectionId: remote.profile.id
      },
      entries,
      parent: remote.remotePath === normalizeRemotePath(remote.profile.rootPath) ? null : undefined,
      canGoUp: true
    };
    return mapDirectoryListingToSnapshot(listing, profiles);
  }

  if (isRemoteUriPath(path)) {
    throw new Error(`未找到远程连接配置：${path}`);
  }

  const normalizedPath = normalizeLocationPath(path);
  const listing = await invokeWithBrowserFallback<BackendDirectoryListing>(
    "list_directory",
    { path: normalizedPath },
    async () => ({
      location: { kind: "local", path: normalizedPath },
      entries: [],
      parent: null,
      canGoUp: false
    }),
    runtime.invoke,
    runtime.runtimeHost
  );
  return mapDirectoryListingToSnapshot(listing, profiles);
}

export function mapTreeNodes(
  nodes: BackendTreeNode[],
  kind: DirectoryNode["kind"] = "folder"
): DirectoryNode[] {
  return nodes.map((node) => ({
    id: node.path,
    label: node.name,
    path: node.path,
    kind,
    expandable: node.hasChildren,
    loaded: false,
    children: []
  }));
}

export function buildRemoteTreeNodes(path: string, snapshot: DirectorySnapshot): DirectoryNode[] {
  return snapshot.entries
    .filter((entry) => entry.kind === "folder")
    .map((entry) => ({
      id: entry.path,
      label: entry.name,
      path: entry.path,
      kind: "folder",
      badge: path,
      expandable: true,
      loaded: false,
      children: []
    }));
}

export async function loadWorkspaceTreeChildren(
  path: string,
  profiles: BackendRemoteProfile[],
  runtime: WorkspaceDirectoryRuntime = {}
) {
  const remote = resolveRemotePath(path, profiles);
  if (remote) {
    const snapshot = await resolveWorkspaceDirectory(path, profiles, runtime);
    return buildRemoteTreeNodes(path, snapshot);
  }

  if (isRemoteUriPath(path)) {
    throw new Error(`未找到远程连接配置：${path}`);
  }

  const children = await invokeWithBrowserFallback<BackendTreeNode[]>(
    "get_tree_children",
    { path: normalizeLocationPath(path) },
    async () => [],
    runtime.invoke,
    runtime.runtimeHost
  );
  return mapTreeNodes(children);
}

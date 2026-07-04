import type {
  DirectoryListing as BackendDirectoryListing,
  DriveRoot as BackendDriveRoot,
  EntryViewModel as BackendEntryViewModel,
  RemoteProfile as BackendRemoteProfile,
  TreeNode as BackendTreeNode
} from "../../app/types";
import { normalizeLocationPath } from "./mockData";
import { normalizeRemotePath, resolveRemotePath } from "./remoteUri";
import { invokeRequired, invokeWithBrowserFallback, type WorkspaceInvoke } from "./workspaceIpc";
import { mapDirectoryListingToSnapshot } from "./workspaceMappers";
import type { DirectoryNode, DirectorySnapshot, EntryViewModel } from "./types";
import { THIS_PC_PATH } from "./types";

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

export async function listWorkspaceDriveRoots(
  runtime: WorkspaceDirectoryRuntime = {}
): Promise<BackendDriveRoot[]> {
  return invokeWithBrowserFallback<BackendDriveRoot[]>(
    "list_drive_roots",
    {},
    async () => getMockDriveRoots(),
    runtime.invoke,
    runtime.runtimeHost
  );
}

function getMockDriveRoots(): BackendDriveRoot[] {
  return [
    { path: "C:\\", label: "本地磁盘 (C:)", driveType: "local", totalBytes: 500_000_000_000, availableBytes: 120_000_000_000 },
    { path: "D:\\", label: "数据 (D:)", driveType: "local", totalBytes: 1_000_000_000_000, availableBytes: 600_000_000_000 },
    { path: "E:\\", label: "可移动磁盘 (E:)", driveType: "removable", totalBytes: 32_000_000_000, availableBytes: 10_000_000_000 },
    { path: "Z:\\", label: "网络驱动器 (Z:)", driveType: "network", totalBytes: null, availableBytes: null }
  ];
}

export function formatDriveSize(size?: number | null) {
  if (size == null) return "--";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  if (unitIndex === 0) return `${Math.round(value)} ${units[unitIndex]}`;
  const rendered = Number.isInteger(value) ? value.toFixed(0) : value.toFixed(value >= 10 ? 0 : 1);
  return `${rendered} ${units[unitIndex]}`;
}

function buildDriveEntry(drive: BackendDriveRoot): EntryViewModel {
  const enterable = drive.driveType !== "network" && drive.driveType !== "unknown";
  return {
    id: drive.path,
    name: drive.label,
    kind: "folder",
    path: drive.path,
    parentPath: THIS_PC_PATH,
    sizeBytes: drive.totalBytes,
    sizeLabel: drive.totalBytes != null ? formatDriveSize(drive.totalBytes) : "--",
    modifiedLabel: "--",
    extension: "",
    attributes: enterable ? [] : ["N"],
    accentColor: "#29659f",
    tags: [],
    description: enterable ? drive.label : `${drive.label} (不可进入)`,
    driveInfo: {
      driveType: drive.driveType,
      totalBytes: drive.totalBytes,
      availableBytes: drive.availableBytes,
      enterable
    }
  };
}

export function buildThisPcSnapshot(drives: BackendDriveRoot[]): DirectorySnapshot {
  return {
    location: {
      kind: "virtual",
      label: THIS_PC_PATH,
      path: THIS_PC_PATH,
      subtitle: "此电脑"
    },
    breadcrumbs: [
      { id: THIS_PC_PATH, label: THIS_PC_PATH, path: THIS_PC_PATH }
    ],
    entries: drives.map(buildDriveEntry)
  };
}

export async function resolveWorkspaceDirectory(
  path: string,
  profiles: BackendRemoteProfile[],
  runtime: WorkspaceDirectoryRuntime = {}
) {
  if (path === THIS_PC_PATH) {
    const drives = await listWorkspaceDriveRoots(runtime);
    return buildThisPcSnapshot(drives);
  }

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
    isHidden: node.isHidden ?? false,
    isSystem: node.isSystem ?? false,
    isProtectedOperatingSystem: node.isProtectedOperatingSystem ?? false,
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
      isHidden: entry.isHidden ?? false,
      isSystem: entry.isSystem ?? false,
      isProtectedOperatingSystem: entry.isProtectedOperatingSystem ?? false,
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

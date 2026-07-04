import type {
  ItemProperties as BackendItemProperties,
  ItemPropertiesRequest as BackendItemPropertiesRequest,
  ItemPropertiesTarget as BackendItemPropertiesTarget,
  RemoteProfile as BackendRemoteProfile
} from "../../app/types";
import { normalizeLocationPath } from "./mockData";
import { resolveRemotePath } from "./remoteUri";
import { invokeWithBrowserFallback, type WorkspaceInvoke } from "./workspaceIpc";
import type { ItemProperties, ItemPropertiesTarget } from "./types";

type RuntimeHost = object | null | undefined;

type WorkspacePropertiesRuntime = {
  invoke?: WorkspaceInvoke;
  runtimeHost?: RuntimeHost;
};

export type WorkspaceItemPropertiesInput = {
  requestId: string;
  path: string;
  includeDirectorySize?: boolean;
};

function isRemoteUriPath(path: string) {
  return path.startsWith("ftp://") || path.startsWith("sftp://");
}

function normalizeRemoteProtocol(protocol: BackendRemoteProfile["protocol"]): "ftp" | "sftp" {
  if (protocol !== "ftp" && protocol !== "sftp") {
    throw new Error(`不支持的远程协议：${protocol}`);
  }
  return protocol;
}

function extensionFromName(name: string) {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index) : "";
}

function leafNameFromPath(path: string) {
  const trimmed = path.replace(/[\\/]+$/, "");
  const separator = trimmed.includes("/") ? "/" : "\\";
  return trimmed.split(separator).filter(Boolean).pop() ?? trimmed;
}

function parentPathFromPath(path: string) {
  const trimmed = path.replace(/[\\/]+$/, "");
  const separator = trimmed.includes("/") ? "/" : "\\";
  const index = trimmed.lastIndexOf(separator);
  if (index < 0) {
    return "";
  }
  if (/^[A-Za-z]:$/.test(trimmed.slice(0, index))) {
    return `${trimmed.slice(0, index)}\\`;
  }
  return trimmed.slice(0, index) || separator;
}

export function createItemPropertiesRequest(
  input: WorkspaceItemPropertiesInput,
  profiles: BackendRemoteProfile[]
): BackendItemPropertiesRequest {
  const remote = resolveRemotePath(input.path, profiles);
  const target: BackendItemPropertiesTarget = remote
    ? {
        kind: "remote",
        protocol: normalizeRemoteProtocol(remote.profile.protocol),
        profileId: remote.profile.id,
        remotePath: remote.remotePath,
        displayPath: input.path
      }
    : {
        kind: "local",
        path: normalizeLocationPath(input.path)
      };

  if (!remote && isRemoteUriPath(input.path)) {
    throw new Error(`未找到远程连接配置：${input.path}`);
  }

  return {
    requestId: input.requestId,
    target,
    includeDirectorySize: input.includeDirectorySize ?? false
  };
}

function mapTarget(target: BackendItemPropertiesTarget): ItemPropertiesTarget {
  return target.kind === "remote"
    ? {
        kind: "remote",
        protocol: target.protocol,
        profileId: target.profileId,
        remotePath: target.remotePath,
        displayPath: target.displayPath
      }
    : {
        kind: "local",
        path: normalizeLocationPath(target.path)
      };
}

function mapBackendItemProperties(item: BackendItemProperties): ItemProperties {
  return {
    ...item,
    target: mapTarget(item.target),
    kind: item.kind === "directory" ? "folder" : "file",
    fieldStates: item.fieldStates.map((fieldState) => ({
      field: fieldState.field,
      state: fieldState.state,
      message: fieldState.message ?? undefined
    })),
    directorySizeState: {
      ...item.directorySizeState,
      message: item.directorySizeState.message ?? undefined
    },
    parentPath: item.parentPath ?? undefined,
    extension: item.extension ?? undefined,
    sizeBytes: item.sizeBytes ?? null,
    allocatedBytes: item.allocatedBytes ?? null,
    createdAt: item.createdAt ?? null,
    modifiedAt: item.modifiedAt ?? null,
    accessedAt: item.accessedAt ?? null,
    errorMessage: item.errorMessage ?? undefined
  };
}

function createBrowserFallbackProperties(request: BackendItemPropertiesRequest): ItemProperties {
  const target = mapTarget(request.target);
  const displayPath = target.kind === "remote" ? target.displayPath : target.path;
  const actualPath = target.kind === "remote" ? target.remotePath : target.path;
  const name = leafNameFromPath(displayPath);
  const extension = extensionFromName(name);

  return {
    requestId: request.requestId,
    target,
    displayPath,
    actualPath,
    parentPath: parentPathFromPath(displayPath),
    name,
    extension,
    kind: "file",
    sizeBytes: null,
    allocatedBytes: null,
    createdAt: null,
    modifiedAt: null,
    accessedAt: null,
    isHidden: false,
    isReadOnly: false,
    isSymlink: false,
    directorySizeState: {
      state: "notComputed",
      message: "浏览器预览未计算目录大小"
    },
    fieldStates: [
      { field: "sizeBytes", state: "notAvailable", message: "浏览器预览不可用" },
      { field: "allocatedBytes", state: "notAvailable", message: "浏览器预览不可用" },
      { field: "createdAt", state: "notAvailable", message: "浏览器预览不可用" },
      { field: "modifiedAt", state: "notAvailable", message: "浏览器预览不可用" },
      { field: "accessedAt", state: "notAvailable", message: "浏览器预览不可用" }
    ]
  };
}

export async function getWorkspaceItemProperties(
  input: WorkspaceItemPropertiesInput,
  profiles: BackendRemoteProfile[],
  runtime: WorkspacePropertiesRuntime = {}
) {
  const request = createItemPropertiesRequest(input, profiles);
  const item = await invokeWithBrowserFallback<BackendItemProperties>(
    "get_item_properties",
    { request },
    async () => createBrowserFallbackProperties(request) as unknown as BackendItemProperties,
    runtime.invoke,
    runtime.runtimeHost
  );
  return mapBackendItemProperties(item);
}

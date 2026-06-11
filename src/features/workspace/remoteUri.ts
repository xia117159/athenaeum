import type { RemoteProfile as BackendRemoteProfile } from "../../app/types";
import { normalizeLocationPath } from "./mockData";

export type WorkspaceOperationCommand = {
  command: string;
  args: Record<string, unknown>;
};

export function normalizeRemotePath(path: string) {
  const normalized = path
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .join("/");
  return normalized ? `/${normalized}` : "/";
}

export function trimTrailingSlash(path: string) {
  return path !== "/" && path.endsWith("/") ? path.slice(0, -1) : path;
}

function defaultRemotePort(protocol: BackendRemoteProfile["protocol"]) {
  if (protocol === "ftp") {
    return 21;
  }
  if (protocol === "sftp") {
    return 22;
  }
  return null;
}

function formatRemoteHost(host: string) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function createRemoteAuthority(profile: BackendRemoteProfile, includeDefaultPort = false) {
  const defaultPort = defaultRemotePort(profile.protocol);
  const port = profile.port && (includeDefaultPort || profile.port !== defaultPort) ? `:${profile.port}` : "";
  return `${profile.protocol}://${profile.username}@${formatRemoteHost(profile.host)}${port}`;
}

export function createRemoteRootUri(profile: BackendRemoteProfile) {
  return `${createRemoteAuthority(profile)}${normalizeRemotePath(profile.rootPath)}`;
}

export function createRemoteUri(profile: BackendRemoteProfile, remotePath: string) {
  return `${createRemoteAuthority(profile)}${normalizeRemotePath(remotePath)}`;
}

export function resolveRemotePath(path: string, profiles: BackendRemoteProfile[]) {
  const matches = profiles
    .flatMap((profile) => {
      const authorities = Array.from(new Set([createRemoteAuthority(profile), createRemoteAuthority(profile, true)]));
      return authorities.map((authority) => ({
        profile,
        rootUri: `${authority}${normalizeRemotePath(profile.rootPath)}`,
        authority
      }));
    })
    .filter(({ rootUri }) => path === rootUri || path.startsWith(`${trimTrailingSlash(rootUri)}/`))
    .sort((left, right) => right.rootUri.length - left.rootUri.length);

  const match = matches[0];
  if (!match) {
    return null;
  }

  const remotePath = normalizeRemotePath(path.slice(match.authority.length));
  return {
    profile: match.profile,
    rootUri: match.rootUri,
    remotePath
  };
}

function isRemoteUriPath(path: string) {
  return path.startsWith("ftp://") || path.startsWith("sftp://");
}

function requireResolvedRemotePath(path: string, profiles: BackendRemoteProfile[]) {
  const remote = resolveRemotePath(path, profiles);
  if (!remote && isRemoteUriPath(path)) {
    throw new Error(`Remote profile was not found for ${path}`);
  }
  return remote;
}

function commonRemoteProfile(remotes: Array<NonNullable<ReturnType<typeof resolveRemotePath>>>) {
  if (remotes.length === 0) {
    return null;
  }
  const [first] = remotes;
  return remotes.every((remote) => remote.profile.id === first.profile.id) ? first.profile : null;
}

export function planCopyOrMoveEntries(
  operation: "copy" | "move",
  paths: string[],
  destination: string,
  profiles: BackendRemoteProfile[]
): WorkspaceOperationCommand[] {
  const remoteDestination = requireResolvedRemotePath(destination, profiles);
  const resolvedSources = paths.map((path) => ({
    original: path,
    remote: requireResolvedRemotePath(path, profiles)
  }));
  const remoteSources = resolvedSources.filter((source) => source.remote);

  if (remoteSources.length > 0 && remoteSources.length !== resolvedSources.length) {
    throw new Error("Mixed local and remote sources are not supported");
  }

  if (remoteSources.length === 0) {
    if (remoteDestination) {
      const localSources = resolvedSources.map((source) => normalizeLocationPath(source.original));
      const commands: WorkspaceOperationCommand[] = [
        {
          command: "upload_remote_files",
          args: {
            request: {
              profileId: remoteDestination.profile.id,
              password: null,
              sources: localSources,
              destination: remoteDestination.remotePath
            }
          }
        }
      ];

      if (operation === "move") {
        commands.push({
          command: "delete_entries",
          args: {
            request: {
              sources: localSources
            }
          }
        });
      }

      return commands;
    }

    return [
      {
        command: operation === "copy" ? "copy_entries" : "move_entries",
        args: {
          request: {
            sources: resolvedSources.map((source) => normalizeLocationPath(source.original)),
            destination: normalizeLocationPath(destination)
          }
        }
      }
    ];
  }

  const sourceProfile = commonRemoteProfile(remoteSources.map((source) => source.remote!));
  if (!sourceProfile) {
    throw new Error("Remote sources from different profiles are not supported");
  }

  if (!remoteDestination) {
    const remoteSourcePaths = remoteSources.map((source) => source.remote!.remotePath);
    const commands: WorkspaceOperationCommand[] = [
      {
        command: "download_remote_entries",
        args: {
          request: {
            profileId: sourceProfile.id,
            password: null,
            sources: remoteSourcePaths,
            destination: normalizeLocationPath(destination)
          }
        }
      }
    ];

    if (operation === "move") {
      commands.push({
        command: "delete_remote_entries",
        args: {
          request: {
            profileId: sourceProfile.id,
            password: null,
            sources: remoteSourcePaths,
            destination: null
          }
        }
      });
    }

    return commands;
  }

  if (remoteDestination.profile.id !== sourceProfile.id) {
    return [
      {
        command: "transfer_remote_entries",
        args: {
          request: {
            operation,
            sourceProfileId: sourceProfile.id,
            sourcePassword: null,
            destinationProfileId: remoteDestination.profile.id,
            destinationPassword: null,
            sources: remoteSources.map((source) => source.remote!.remotePath),
            destination: remoteDestination.remotePath
          }
        }
      }
    ];
  }

  return [
    {
      command: operation === "copy" ? "copy_remote_entries" : "move_remote_entries",
      args: {
        request: {
          profileId: sourceProfile.id,
          password: null,
          sources: remoteSources.map((source) => source.remote!.remotePath),
          destination: remoteDestination.remotePath
        }
      }
    }
  ];
}

export function planDeleteEntries(paths: string[], profiles: BackendRemoteProfile[]): WorkspaceOperationCommand[] {
  const localSources: string[] = [];
  const remoteSourcesByProfile = new Map<string, { profile: BackendRemoteProfile; sources: string[] }>();

  for (const path of paths) {
    const remote = requireResolvedRemotePath(path, profiles);
    if (!remote) {
      localSources.push(normalizeLocationPath(path));
      continue;
    }
    const bucket = remoteSourcesByProfile.get(remote.profile.id) ?? {
      profile: remote.profile,
      sources: []
    };
    bucket.sources.push(remote.remotePath);
    remoteSourcesByProfile.set(remote.profile.id, bucket);
  }

  const commands: WorkspaceOperationCommand[] = [];
  if (localSources.length > 0) {
    commands.push({
      command: "delete_entries",
      args: {
        request: {
          sources: localSources
        }
      }
    });
  }

  for (const bucket of remoteSourcesByProfile.values()) {
    commands.push({
      command: "delete_remote_entries",
      args: {
        request: {
          profileId: bucket.profile.id,
          password: null,
          sources: bucket.sources,
          destination: null
        }
      }
    });
  }

  return commands;
}

export function planRenameEntry(
  source: string,
  newName: string,
  profiles: BackendRemoteProfile[]
): WorkspaceOperationCommand[] {
  const remote = requireResolvedRemotePath(source, profiles);
  if (!remote) {
    return [
      {
        command: "rename_entry",
        args: {
          request: {
            source: normalizeLocationPath(source),
            newName
          }
        }
      }
    ];
  }

  return [
    {
      command: "rename_remote_entry",
      args: {
        request: {
          profileId: remote.profile.id,
          password: null,
          source: remote.remotePath,
          newName
        }
      }
    }
  ];
}

export function planCreateDirectory(
  parent: string,
  name: string,
  profiles: BackendRemoteProfile[]
): WorkspaceOperationCommand[] {
  const remote = requireResolvedRemotePath(parent, profiles);
  if (!remote) {
    return [
      {
        command: "create_directory",
        args: {
          request: {
            parent: normalizeLocationPath(parent),
            name
          }
        }
      }
    ];
  }

  return [
    {
      command: "create_remote_directory",
      args: {
        request: {
          profileId: remote.profile.id,
          password: null,
          parent: remote.remotePath,
          name
        }
      }
    }
  ];
}

export function planCreateFile(
  parent: string,
  name: string,
  profiles: BackendRemoteProfile[]
): WorkspaceOperationCommand[] {
  const remote = requireResolvedRemotePath(parent, profiles);
  if (remote) {
    throw new Error("Remote file creation is not supported yet");
  }

  return [
    {
      command: "create_file",
      args: {
        request: {
          parent: normalizeLocationPath(parent),
          name
        }
      }
    }
  ];
}

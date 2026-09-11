import { getFolderListingRows } from "./folderExpansion";
import { createRemoteUri, resolveRemotePath } from "./remoteUri";
import { toBackendRemoteProfile } from "./workspaceBackendDtos";
import { isSizingPathRepresentable } from "./directorySizeMapping";
import { listingSizeIdentityIsReliable } from "./directorySizes";
import { getPathComparisonKey, isSameOrDescendantPath, pathsEqual } from "./workspacePathRelations";
import type { DirectorySizeTarget } from "./directorySizeTypes";
import type { RemoteConnectionProfile, TabState, WorkspaceState, PanelId } from "./types";

export interface DirectorySizeContext {
  identity: string;
  target: DirectorySizeTarget;
  toBackendPath(path: string): string;
  fromBackendPath(path: string): string;
}

export function directorySizeContext(tab: TabState, profiles: RemoteConnectionProfile[]): DirectorySizeContext {
  const rootPath = tab.snapshot.location.path;
  if (tab.snapshot.sizeIdentityReliable === false || !isSizingPathRepresentable(rootPath, tab.snapshot.location.kind === "local")) {
    throw new Error("当前列表路径无法可靠映射，目录大小暂不可用");
  }
  if (tab.snapshot.location.kind === "local") return {
    // Ordinary listings already supply their canonical path. Do not casefold a
    // statistics scope: Unicode folding and case-sensitive roots can collide.
    identity: `local:${rootPath}`, target: { kind: "local", path: rootPath },
    toBackendPath: (path) => path, fromBackendPath: (path) => path
  };
  const remote = resolveRemotePath(rootPath, profiles.map(toBackendRemoteProfile));
  if (!remote) throw new Error("未找到当前目录的远程连接配置，请重新连接后计算大小");
  const target: DirectorySizeTarget = { kind: "remote", profileId: remote.profile.id, path: remote.remotePath };
  // The backend DTO deliberately omits credentials. Never embed a password in an identity or request.
  return {
    identity: JSON.stringify([target, remote.profile]), target,
    toBackendPath(path) {
      if (!isSizingPathRepresentable(path, false)) throw new Error("大小查询路径无法可靠映射");
      const child = resolveRemotePath(path, [remote.profile]);
      if (!child || !isSameOrDescendantPath(rootPath, path)) throw new Error("大小查询超出当前目录");
      return child.remotePath;
    },
    fromBackendPath(path) {
      if (!isSizingPathRepresentable(path, false)) throw new Error("大小结果路径无法可靠映射");
      const canonical = createRemoteUri(remote.profile, path);
      const canonicalRoot = createRemoteUri(remote.profile, remote.remotePath);
      return pathsEqual(canonical, canonicalRoot) ? rootPath : `${rootPath.replace(/\/$/, "")}${canonical.slice(canonicalRoot.replace(/\/$/, "").length)}`;
    }
  };
}

/** Only directories are looked up, including each visible row's immediate parent. */
export function directorySizeLookupPaths(state: WorkspaceState, panelId: PanelId, tab: TabState): string[] {
  const root = tab.snapshot.location.path;
  if (!listingSizeIdentityIsReliable(tab, root)) return [];
  const paths = new Map<string, string>([[getPathComparisonKey(root), root]]);
  const rows = getFolderListingRows(tab, state.fileVisibility, state.activePanelId === panelId ? state.search.filterText : "",
    state.settings.model.folderExpansionEnabled === true);
  for (const { entry } of rows) {
    if (!listingSizeIdentityIsReliable(tab, entry.parentPath)) continue;
    if (isSameOrDescendantPath(root, entry.parentPath)) paths.set(getPathComparisonKey(entry.parentPath), entry.parentPath);
    if (entry.kind === "folder" && !entry.attributes.includes("L") && isSameOrDescendantPath(root, entry.path)) {
      paths.set(getPathComparisonKey(entry.path), entry.path);
    }
  }
  return [...paths.values()];
}

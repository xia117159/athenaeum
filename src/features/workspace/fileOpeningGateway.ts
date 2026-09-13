import type { AssociationProgramInfo, FileOpenProgress, FileOpenRequest, FileOpenResult, FileOpenTarget } from "../../app/fileAssociations";
import type { RemoteConnectionProfile } from "./types";
import { Channel } from "@tauri-apps/api/core";
import { hasTauriRuntime, invokeRequired, type WorkspaceInvoke } from "./workspaceIpc";
import { resolveRemotePath } from "./remoteUri";
import { toBackendRemoteProfile } from "./workspaceBackendDtos";

export interface FileOpeningRuntime {
  invoke?: WorkspaceInvoke;
  runtimeHost?: object | null;
  createProgressChannel?: (handler: (progress: FileOpenProgress) => void) => unknown;
}

export function fileOpenTarget(path: string, profiles: RemoteConnectionProfile[]): FileOpenTarget {
  const remote = resolveRemotePath(path, profiles.map(toBackendRemoteProfile));
  if (remote) return {kind:"remote", profileId:remote.profile.id, path:remote.remotePath};
  if (/^(ftp|sftp):\/\//i.test(path)) throw new Error("找不到此远程文件对应的连接配置");
  return {kind:"local", path};
}
function desktopCommand<T>(command: string, args: Record<string, unknown>, runtime: FileOpeningRuntime): Promise<T> {
  if (!hasTauriRuntime(runtime.runtimeHost)) return Promise.reject(new Error("此操作需要 Windows 桌面版"));
  return invokeRequired<T>(command, args, () => { throw new Error("此操作需要 Windows 桌面版"); }, runtime.invoke, runtime.runtimeHost);
}
export async function openWorkspaceFile(request: FileOpenRequest, onProgress: (progress: FileOpenProgress) => void, runtime: FileOpeningRuntime = {}): Promise<FileOpenResult> {
  if (!hasTauriRuntime(runtime.runtimeHost)) throw new Error("此操作需要 Windows 桌面版");
  const channel = runtime.createProgressChannel ? runtime.createProgressChannel(onProgress) : new Channel<FileOpenProgress>(onProgress);
  return desktopCommand("open_file", {request, onProgress:channel}, runtime);
}
export async function cancelWorkspaceFileOpen(requestId: string, runtime: FileOpeningRuntime = {}): Promise<boolean> {
  return desktopCommand("cancel_file_open", {requestId}, runtime);
}
export async function inspectAssociationPrograms(paths: string[], runtime: FileOpeningRuntime = {}): Promise<AssociationProgramInfo[]> {
  const unique = [...new Set(paths.filter(Boolean))];
  const result: AssociationProgramInfo[] = [];
  for (let index = 0; index < unique.length; index += 64) {
    result.push(...await desktopCommand<AssociationProgramInfo[]>("inspect_association_programs", {paths:unique.slice(index, index + 64)}, runtime));
  }
  return result;
}
export async function chooseAssociationProgram(runtime: FileOpeningRuntime = {}): Promise<string | null> {
  return desktopCommand("choose_association_program", {}, runtime);
}

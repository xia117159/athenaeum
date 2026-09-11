import { listen } from "@tauri-apps/api/event";
import type { DirectorySizeSnapshot, DirectorySizesGateway } from "./directorySizeTypes";
import { hasTauriRuntime, invokeRequired, type WorkspaceInvoke } from "./workspaceIpc";

export interface DirectorySizeRuntime {
  invoke?: WorkspaceInvoke;
  runtimeHost?: object | null;
  listen?: <T>(eventName: string, handler: (event: { payload: T }) => void) => Promise<() => void>;
}

export function createDirectorySizesGateway(runtime: DirectorySizeRuntime = {}): DirectorySizesGateway {
  async function invoke<T>(command: string, args: Record<string, unknown>, fallback: () => T | Promise<T>) {
    try { return await invokeRequired(command, args, fallback, runtime.invoke, runtime.runtimeHost); }
    catch (error) { throw new Error(`目录大小统计（${command}）失败：${error instanceof Error ? error.message : String(error)}`); }
  }
  return {
    subscribe: (request) => invoke("subscribe_directory_sizes", { request }, () => ({
      consumerId: request.consumerId, generation: 0, sequence: 0, phase: "failed", totalBytes: null, knownBytes: "0",
      files: 0, directories: 0, skippedLinks: 0, skippedSpecial: 0, errors: 0, freshness: "snapshot",
      reason: "目录大小计算仅在桌面应用中可用"
    } as DirectorySizeSnapshot)),
    release: (consumerId) => invoke("release_directory_sizes", { consumerId }, () => undefined),
    lookup: (request) => invoke("lookup_directory_sizes", { request }, () => ({
      consumerId: request.consumerId, generation: request.generation, sequence: 0, stale: true, directories: []
    })),
    listen: async (handler) => {
      if (!hasTauriRuntime(runtime.runtimeHost) && !runtime.listen) return () => undefined;
      return (runtime.listen ?? listen)<DirectorySizeSnapshot>("directory_sizes_changed", (event) => handler(event.payload));
    }
  };
}

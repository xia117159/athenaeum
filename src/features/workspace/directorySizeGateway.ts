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
    updateViews: (request) => invoke("update_directory_size_views", { request }, () => ({ acceptedRevision: request.revision, ownerEpoch: "browser", truncated: false })),
    listenViewsFlush: async (handler) => {
      if (!hasTauriRuntime(runtime.runtimeHost) && !runtime.listen) return () => undefined;
      return (runtime.listen ?? listen)<import("./directorySizeViewsTypes").DirectorySizeViewsFlushRequested>("directory_size_views_flush_requested", (event) => handler(event.payload));
    },
    lookupCache: (request) => invoke("lookup_directory_size_cache", { request }, () => ({ ...request, revision: "0",
      entries: request.entries.map((entry) => ({ path: entry.path, status: "miss" as const, record: null })) })),
    listenCache: async (handler) => {
      if (!hasTauriRuntime(runtime.runtimeHost) && !runtime.listen) return () => undefined;
      return (runtime.listen ?? listen)<import("./directorySizeCacheTypes").DirectorySizeCacheUpdated>("directory_size_cache_updated", (event) => handler(event.payload));
    },
    diagnostics: (path) => invoke("get_directory_size_diagnostics", { path }, () => {
      throw new Error("目录大小诊断仅在桌面应用中可用");
    }),
    subscribe: (request) => invoke("subscribe_directory_sizes", { request }, () => ({
      consumerId: request.consumerId, generation: 0, sequence: 0, phase: "failed", totalBytes: null, knownBytes: "0",
      files: 0, directories: 0, skippedLinks: 0, skippedSpecial: 0, errors: 0, freshness: "snapshot",
      reason: "目录大小计算仅在桌面应用中可用"
    } as DirectorySizeSnapshot)),
    release: (consumerId, handoff) => invoke("release_directory_sizes", { consumerId, ...handoff }, () => undefined),
    lookup: (request) => invoke("lookup_directory_sizes", { request }, () => ({
      consumerId: request.consumerId, generation: request.generation, sequence: 0, stale: true, directories: []
    })),
    listen: async (handler) => {
      if (!hasTauriRuntime(runtime.runtimeHost) && !runtime.listen) return () => undefined;
      return (runtime.listen ?? listen)<DirectorySizeSnapshot>("directory_sizes_changed", (event) => handler(event.payload));
    }
  };
}

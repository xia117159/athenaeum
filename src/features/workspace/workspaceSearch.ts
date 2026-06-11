import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  RemoteProfile as BackendRemoteProfile,
  SearchFinished as BackendSearchFinished,
  SearchProgress as BackendSearchProgress,
  SearchQuery as BackendSearchQuery,
  SearchResult as BackendSearchResult
} from "../../app/types";
import { normalizeLocationPath } from "./mockData";
import { resolveRemotePath } from "./remoteUri";
import type { WorkspaceInvoke } from "./workspaceIpc";
import { labelFromPath } from "./workspaceMappers";
import type { SearchProgressState, SearchQuery, SearchResult } from "./types";

type WorkspaceEvent<T> = {
  payload: T;
};

export type WorkspaceListen = <T>(
  eventName: string,
  handler: (event: WorkspaceEvent<T>) => void | Promise<void>
) => Promise<() => void>;

type WorkspaceSearchRuntime = {
  searchId?: string;
  createSearchId?: () => string;
  invoke?: WorkspaceInvoke;
  listen?: WorkspaceListen;
  onProgress?: (progress: SearchProgressState) => void;
};

export function createDefaultSearchId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `search-${Date.now()}`;
}

export function resolveSearchRoots(scopePaths: string[], profiles: BackendRemoteProfile[]) {
  return scopePaths
    .map((path) => {
      const remote = resolveRemotePath(path, profiles);
      return remote ? null : normalizeLocationPath(path);
    })
    .filter((path): path is string => Boolean(path));
}

export function createBackendSearchQuery(
  searchId: string,
  roots: string[],
  query: SearchQuery
): BackendSearchQuery {
  return {
    searchId,
    roots,
    namePattern: query.name.trim() || null,
    contentPattern: query.content.trim() || null,
    nameMode: query.nameMode,
    contentMode: query.contentMode,
    extensions: query.extensionFilterText
      .split(";")
      .map((extension) => extension.trim().replace(/^\./, ""))
      .filter(Boolean),
    extensionFilterMode: query.extensionFilterMode,
    includeFolders: query.includeFolders,
    recursive: query.recursive,
    includeHidden: false,
    caseSensitive: query.caseSensitive,
    maxFileSizeBytes: 1024 * 1024
  };
}

function mapSearchProgress(progress: BackendSearchProgress): SearchProgressState {
  return {
    searchId: progress.searchId,
    scannedEntries: progress.scannedEntries,
    matchedEntries: progress.matchedEntries,
    cancelled: false,
    statusText: `已扫描 ${progress.scannedEntries} 项，匹配 ${progress.matchedEntries} 项`
  };
}

function mapSearchFinished(finished: BackendSearchFinished): SearchProgressState {
  const prefix = finished.cancelled ? "搜索已取消" : "搜索完成";
  return {
    searchId: finished.searchId,
    scannedEntries: finished.scannedEntries,
    matchedEntries: finished.matchedEntries,
    cancelled: finished.cancelled,
    statusText: `${prefix}：已扫描 ${finished.scannedEntries} 项，匹配 ${finished.matchedEntries} 项`
  };
}

export function mapSearchResult(result: BackendSearchResult): SearchResult {
  const parentPath = normalizeLocationPath(result.parent);
  const location = {
    kind: "local" as const,
    label: labelFromPath(parentPath),
    path: parentPath,
    subtitle: "搜索结果"
  };

  return {
    id: `${result.searchId}:${result.path}`,
    name: result.name,
    kind: result.isDirectory ? "folder" : "file",
    path: normalizeLocationPath(result.path),
    parentPath,
    openPath: result.isDirectory ? normalizeLocationPath(result.path) : parentPath,
    location,
    match: result.excerpt ?? result.matchedOn.join(", ")
  };
}

export async function runWorkspaceSearch(
  query: SearchQuery,
  scopePaths: string[],
  profiles: BackendRemoteProfile[],
  runtime: WorkspaceSearchRuntime = {}
) {
  const roots = resolveSearchRoots(scopePaths, profiles);
  if (roots.length === 0 || (!query.name.trim() && !query.content.trim())) {
    return [];
  }

  const createSearchId = runtime.createSearchId ?? createDefaultSearchId;
  const invokeFn = runtime.invoke ?? invoke;
  const listenFn = runtime.listen ?? listen;
  const searchId = runtime.searchId ?? createSearchId();
  const results: SearchResult[] = [];
  const cleanup: Array<() => void> = [];

  return new Promise<SearchResult[]>(async (resolve, reject) => {
    const disposeAll = async () => {
      await Promise.all(cleanup.map((dispose) => dispose()));
    };

    try {
      cleanup.push(
        await listenFn<BackendSearchResult>("search_result", (event) => {
          if (event.payload.searchId === searchId) {
            results.push(mapSearchResult(event.payload));
          }
        })
      );
      cleanup.push(
        await listenFn<BackendSearchProgress>("search_progress", (event) => {
          if (event.payload.searchId === searchId) {
            runtime.onProgress?.(mapSearchProgress(event.payload));
          }
        })
      );
      cleanup.push(
        await listenFn<BackendSearchFinished>("search_finished", async (event) => {
          if (event.payload.searchId !== searchId) {
            return;
          }
          runtime.onProgress?.(mapSearchFinished(event.payload));
          await disposeAll();
          resolve(results);
        })
      );
      cleanup.push(
        await listenFn<string>("search_failed", async (event) => {
          await disposeAll();
          reject(new Error(event.payload));
        })
      );

      await invokeFn("start_search", {
        query: createBackendSearchQuery(searchId, roots, query)
      });
    } catch (error) {
      await disposeAll();
      reject(error);
    }
  });
}

export async function cancelWorkspaceSearch(
  searchId: string,
  runtime: Pick<WorkspaceSearchRuntime, "invoke"> = {}
) {
  const invokeFn = runtime.invoke ?? invoke;
  await invokeFn("cancel_search", { searchId });
}

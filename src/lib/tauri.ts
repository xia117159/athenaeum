import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  createMockSettings,
  getMockBootstrap,
  getMockListing,
  getMockTreeChildren,
  searchMockFilesystem
} from "../app/mockData";
import type {
  Bookmark,
  ColorRule,
  DirectoryListing,
  HotlistEntry,
  RemoteProfile,
  SearchQuery,
  SearchResult,
  SettingsSnapshot,
  ShortcutBinding,
  TreeNode,
  UiLayout,
  WorkspaceBootstrap
} from "../app/types";

function hasTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invokeWithFallback<T>(command: string, args: Record<string, unknown>, fallback: () => Promise<T> | T) {
  if (!hasTauriRuntime()) {
    return await fallback();
  }

  try {
    return await invoke<T>(command, args);
  } catch (error) {
    console.warn(`Falling back from ${command}`, error);
    return await fallback();
  }
}

export async function bootstrapWorkspace(): Promise<WorkspaceBootstrap> {
  return invokeWithFallback("initialize_workspace", {}, () => getMockBootstrap());
}

export async function loadDirectory(path: string): Promise<DirectoryListing> {
  return invokeWithFallback("list_directory", { path }, () => getMockListing(path));
}

export async function loadTreeChildren(path: string): Promise<TreeNode[]> {
  return invokeWithFallback("get_tree_children", { path }, () => getMockTreeChildren(path));
}

export async function saveBookmark(bookmark: Bookmark): Promise<SettingsSnapshot> {
  return invokeWithFallback("save_bookmark", { bookmark }, () => {
    const snapshot = createMockSettings();
    return {
      ...snapshot,
      bookmarks: [...snapshot.bookmarks.filter((item) => item.id !== bookmark.id), bookmark]
    };
  });
}

export async function saveHotlistEntry(entry: HotlistEntry): Promise<SettingsSnapshot> {
  return invokeWithFallback("save_hotlist_entry", { entry }, () => {
    const snapshot = createMockSettings();
    return {
      ...snapshot,
      hotlist: [...snapshot.hotlist.filter((item) => item.id !== entry.id), entry]
    };
  });
}

export async function saveShortcuts(shortcuts: ShortcutBinding[]): Promise<SettingsSnapshot> {
  return invokeWithFallback("save_shortcuts", { shortcuts }, () => ({ ...createMockSettings(), shortcuts }));
}

export async function saveUiLayout(layout: UiLayout): Promise<SettingsSnapshot> {
  return invokeWithFallback("save_ui_layout", { layout }, () => ({ ...createMockSettings(), layout }));
}

export async function saveColorRule(rule: ColorRule): Promise<SettingsSnapshot> {
  return invokeWithFallback("save_color_rule", { rule }, () => {
    const snapshot = createMockSettings();
    return {
      ...snapshot,
      colorRules: [...snapshot.colorRules.filter((item) => item.id !== rule.id), rule]
    };
  });
}

export async function listRemoteProfiles(): Promise<RemoteProfile[]> {
  return invokeWithFallback("list_remote_profiles", {}, () => createMockSettings().remoteProfiles);
}

export async function deleteEntries(paths: string[]) {
  return invokeWithFallback("delete_entries", { request: { sources: paths } }, async () => ({ affectedPaths: paths }));
}

export async function copyEntries(paths: string[], destination: string) {
  return invokeWithFallback(
    "copy_entries",
    { request: { sources: paths, destination } },
    async () => ({ affectedPaths: paths.map((path) => `${destination}\\${path.split("\\").pop()}`) })
  );
}

export async function moveEntries(paths: string[], destination: string) {
  return invokeWithFallback(
    "move_entries",
    { request: { sources: paths, destination } },
    async () => ({ affectedPaths: paths.map((path) => `${destination}\\${path.split("\\").pop()}`) })
  );
}

export async function renameEntry(source: string, newName: string) {
  return invokeWithFallback(
    "rename_entry",
    { request: { source, newName } },
    async () => ({ affectedPaths: [`${source.slice(0, Math.max(source.lastIndexOf("\\"), 1))}\\${newName}`] })
  );
}

export async function createDirectory(parent: string, name: string) {
  return invokeWithFallback(
    "create_directory",
    { request: { parent, name } },
    async () => ({ affectedPaths: [`${parent}\\${name}`] })
  );
}

export async function createFile(parent: string, name: string) {
  return invokeWithFallback(
    "create_file",
    { request: { parent, name } },
    async () => ({ affectedPaths: [`${parent}\\${name}`] })
  );
}

async function runMockSearch(query: SearchQuery): Promise<SearchResult[]> {
  return searchMockFilesystem({ ...query, searchId: query.searchId ?? crypto.randomUUID() });
}

export async function runSearch(query: SearchQuery): Promise<SearchResult[]> {
  if (!hasTauriRuntime()) {
    return runMockSearch(query);
  }

  const results: SearchResult[] = [];
  const unlisteners: UnlistenFn[] = [];

  const cleanup = async () => {
    await Promise.all(unlisteners.map((dispose) => dispose()));
  };

  return new Promise<SearchResult[]>(async (resolve, reject) => {
    try {
      unlisteners.push(
        await listen<SearchResult>("search_result", (event) => {
          results.push(event.payload);
        })
      );
      unlisteners.push(
        await listen("search_finished", async () => {
          await cleanup();
          resolve(results);
        })
      );
      unlisteners.push(
        await listen<string>("search_failed", async (event) => {
          await cleanup();
          reject(new Error(event.payload));
        })
      );

      await invoke("start_search", { query });
    } catch (error) {
      await cleanup();
      reject(error);
    }
  });
}

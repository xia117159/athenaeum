export const WORKSPACE_SEARCH_HISTORY_STORAGE_KEY = "SimpleFileManager.workspace.searchHistory.v1";
export const WORKSPACE_SEARCH_NAME_HISTORY_STORAGE_KEY = "SimpleFileManager.workspace.searchNameHistory.v1";
export const MAX_WORKSPACE_SEARCH_HISTORY_ITEMS = 20;

export type WorkspaceSearchHistoryKind = "name" | "content";
type WorkspaceStorage = Pick<Storage, "getItem" | "setItem">;

function getStorageKey(kind: WorkspaceSearchHistoryKind) {
  return kind === "name" ? WORKSPACE_SEARCH_NAME_HISTORY_STORAGE_KEY : WORKSPACE_SEARCH_HISTORY_STORAGE_KEY;
}

function getDefaultStorage(): WorkspaceStorage | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function normalizeSearchHistory(items: string[]) {
  const seen = new Set<string>();
  const history: string[] = [];

  for (const item of items) {
    const value = item.trim();
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) {
      continue;
    }
    seen.add(key);
    history.push(value);
    if (history.length >= MAX_WORKSPACE_SEARCH_HISTORY_ITEMS) {
      break;
    }
  }

  return history;
}

export function readSearchHistory(
  kind: WorkspaceSearchHistoryKind = "content",
  storage: WorkspaceStorage | null | undefined = getDefaultStorage()
) {
  if (!storage) {
    return [];
  }

  try {
    const raw = storage.getItem(getStorageKey(kind));
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? normalizeSearchHistory(parsed.filter((item): item is string => typeof item === "string")) : [];
  } catch {
    return [];
  }
}

export function writeSearchHistory(
  kind: WorkspaceSearchHistoryKind,
  history: string[],
  storage: WorkspaceStorage | null | undefined = getDefaultStorage()
) {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(getStorageKey(kind), JSON.stringify(normalizeSearchHistory(history)));
  } catch {
    // Keep search usable even if browser storage is unavailable.
  }
}

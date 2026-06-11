import type { DirectorySnapshot, TabState } from "./types";
import { cloneColumns } from "./workspaceMappers";

export const NAVIGATION_VIRTUAL_PATH = "navigation://shortcuts" as const;
export const NAVIGATION_TAB_ID = "navigation-tab";

export function createNavigationSnapshot(): DirectorySnapshot {
  return {
    location: {
      kind: "virtual",
      label: "导航",
      path: NAVIGATION_VIRTUAL_PATH,
      subtitle: "导航快捷入口"
    },
    breadcrumbs: [
      {
        id: NAVIGATION_VIRTUAL_PATH,
        label: "导航",
        path: NAVIGATION_VIRTUAL_PATH
      }
    ],
    entries: []
  };
}

export function createNavigationTab(id = NAVIGATION_TAB_ID): TabState {
  const snapshot = createNavigationSnapshot();
  return {
    id,
    title: "导航",
    kind: "navigation",
    virtualPath: NAVIGATION_VIRTUAL_PATH,
    snapshot,
    addressDraft: "导航",
    history: [],
    historyIndex: 0,
    selectedEntryIds: [],
    expandedNodePaths: [],
    viewMode: "details",
    sort: {
      columnId: "name",
      direction: "asc"
    },
    columns: cloneColumns(),
    status: "ready"
  };
}

export function isNavigationTab(tab: TabState | undefined): tab is TabState & { kind: "navigation" } {
  return tab?.kind === "navigation";
}

export function isDirectoryTab(tab: TabState | undefined): tab is TabState & { kind: "directory" } {
  return tab?.kind === "directory";
}

export function isDirectoryLikeTab(tab: TabState | undefined): tab is TabState & { kind: "directory" | "search-results" } {
  return Boolean(tab && tab.kind !== "navigation");
}

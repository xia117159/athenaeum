import { createMockWorkspaceBootstrap } from "./mockData";
import type { DirectorySnapshot, EntryViewModel, WorkspaceState } from "./types";

export function expansionEntry(parentPath: string, name: string, kind: EntryViewModel["kind"] = "folder", extra: Partial<EntryViewModel> = {}): EntryViewModel {
  const separator = parentPath.includes("://") ? "/" : "\\";
  const path = `${parentPath}${parentPath.endsWith(separator) ? "" : separator}${name}`;
  return { id: path, path, parentPath, name, kind, sizeLabel: kind === "folder" ? "--" : "2 KB", modifiedLabel: "2026-09-10 10:00",
    extension: kind === "file" ? ".txt" : "", attributes: [], accentColor: "", tags: [], description: "", ...extra };
}

export function expansionSnapshot(path: string, entries: EntryViewModel[]): DirectorySnapshot {
  const kind = path.startsWith("ftp://") ? "ftp" : path.startsWith("sftp://") ? "sftp" : "local";
  return { location: { path, kind, label: path }, breadcrumbs: [{ id: path, path, label: path }], entries };
}

export function expansionFixture(kind: "local" | "ftp" | "sftp" = "local") {
  const path = kind === "local" ? "C:\\files" : `${kind}://alice@server/home`;
  const parent = expansionEntry(path, "parent");
  const sibling = expansionEntry(path, "sibling");
  const child = expansionEntry(parent.path, "child.txt", "file");
  const nested = expansionEntry(parent.path, "nested");
  const bootstrap = createMockWorkspaceBootstrap("tauri");
  bootstrap.layoutMode = "single";
  bootstrap.activePanelId = "panel-1";
  bootstrap.settingsModel = { ...bootstrap.settingsModel, folderExpansionEnabled: true };
  const tab = { ...bootstrap.panels["panel-1"].tabs[0], snapshot: expansionSnapshot(path, [sibling, parent]),
    history: [path], historyIndex: 0, selectedEntryIds: [], folderExpansion: undefined };
  bootstrap.panels["panel-1"] = { ...bootstrap.panels["panel-1"], tabs: [tab], activeTabId: tab.id };
  return { bootstrap, path, parent, sibling, child, nested, tabId: tab.id };
}

export function expansionInteractions() {
  return {
    resolvedPaths: [] as string[], copyCalls: [] as Array<{ paths: string[]; destination: string }>,
    moveCalls: [] as Array<{ paths: string[]; destination: string }>, deleteCalls: [] as Array<{ paths: string[] }>,
    renameCalls: [] as Array<{ source: string; newName: string }>, createDirectoryCalls: [] as Array<{ parent: string; name: string }>,
    createFileCalls: [] as Array<{ parent: string; name: string }>, treeLoadPaths: [] as string[], savedDetailsRowHeights: [] as number[],
    savedSettingsModels: [] as WorkspaceState["settings"]["model"][], nativeContextMenus: [] as Array<{ paths: string[]; x: number; y: number }>,
    systemClipboardWrites: [] as Array<{ paths: string[]; mode: "copy" | "cut" }>, systemOpens: [] as string[],
    watchRootUpdates: [] as Array<{ directoryPaths: string[]; navigationParentPaths: string[]; gitSentinelPaths?: string[] }>
  };
}

import type {
  ColorRule as BackendColorRule,
  DirectoryListing as BackendDirectoryListing,
  EntryViewModel as BackendEntryViewModel,
  RemoteProfile as BackendRemoteProfile,
  SettingsSnapshot as BackendSettingsSnapshot,
  ShortcutBinding as BackendShortcutBinding,
  UiLayout as BackendUiLayout,
  WorkspaceBootstrap as BackendWorkspaceBootstrap
} from "../../app/types";
import { normalizeLocationPath } from "./mockData";
import { createRemoteRootUri, createRemoteUri, resolveRemotePath, trimTrailingSlash } from "./remoteUri";
import type {
  BookmarkItem,
  ColumnDefinition,
  DirectoryNode,
  DirectorySnapshot,
  LayoutRatios,
  NavigationItem,
  PanelId,
  PanelState,
  RemoteConnectionProfile,
  SettingsModel,
  TabState,
  WorkspaceBootstrap
} from "./types";

export const DEFAULT_COLUMNS: ColumnDefinition[] = [
  { id: "name", label: "名称", visible: true, width: "2.2fr", align: "left" },
  { id: "type", label: "类型", visible: true, width: "1.1fr", align: "left" },
  { id: "size", label: "大小", visible: true, width: "0.9fr", align: "right" },
  { id: "modified", label: "修改时间", visible: true, width: "1.2fr", align: "left" },
  { id: "tags", label: "标签", visible: true, width: "1.1fr", align: "left" },
  { id: "location", label: "位置", visible: false, width: "1.3fr", align: "left" }
];

export function cloneColumns(columns: ColumnDefinition[] = DEFAULT_COLUMNS): ColumnDefinition[] {
  return columns.map((column) => ({ ...column }));
}

const DEFAULT_SHORTCUTS: SettingsModel["shortcuts"] = [
  {
    id: "focus-next-panel",
    action: "切换到下一个面板",
    scope: "workspace",
    binding: "Tab",
    description: "按顺序切换可见面板焦点。"
  },
  {
    id: "open-search",
    action: "打开搜索面板",
    scope: "workspace",
    binding: "Ctrl+F",
    description: "打开停靠式搜索面板。"
  },
  {
    id: "copy",
    action: "复制",
    scope: "listing",
    binding: "Ctrl+C",
    description: "复制当前选中项。"
  },
  {
    id: "paste",
    action: "粘贴",
    scope: "listing",
    binding: "Ctrl+V",
    description: "将剪贴板内容粘贴到当前目录。"
  },
  {
    id: "cut",
    action: "剪切",
    scope: "listing",
    binding: "Ctrl+X",
    description: "剪切当前选中项。"
  },
  {
    id: "drag-move",
    action: "拖放时移动",
    scope: "listing",
    binding: "Shift",
    description: "拖放文件或文件夹时执行移动而不是复制。"
  },
  {
    id: "create-folder",
    action: "新建文件夹",
    scope: "listing",
    binding: "Ctrl+Shift+N",
    description: "在当前目录中新建文件夹。"
  },
  {
    id: "delete",
    action: "删除",
    scope: "listing",
    binding: "Delete",
    description: "删除当前选中项。"
  },
  {
    id: "rename",
    action: "重命名",
    scope: "listing",
    binding: "F2",
    description: "重命名当前选中项。"
  },
  {
    id: "refresh",
    action: "刷新",
    scope: "panel",
    binding: "F5",
    description: "刷新当前面板。"
  },
  {
    id: "navigate-up",
    action: "上一级",
    scope: "panel",
    binding: "Alt+Up",
    description: "打开当前文件夹的上一级。"
  },
  {
    id: "navigate-forward",
    action: "回到下一级",
    scope: "panel",
    binding: "Alt+Right",
    description: "回到历史中的下一级文件夹。"
  },
  {
    id: "new-tab",
    action: "新建标签页",
    scope: "panel",
    binding: "Ctrl+T",
    description: "在当前面板中新建标签页。"
  },
  {
    id: "close-tab",
    action: "关闭标签页",
    scope: "panel",
    binding: "Ctrl+W",
    description: "当存在多个标签页时关闭当前标签页。"
  }
];

export const DEFAULT_DETAILS_ROW_HEIGHT = 24;
export const DEFAULT_THEME: SettingsModel["theme"] = {
  panelFocusAccent: "#0f6cbd",
  tabMinWidth: 96
};
export const DEFAULT_LAYOUT_RATIOS: LayoutRatios = {
  primary: 0.52,
  tripleSecondary: 0.54,
  quadLeftSecondary: 0.54,
  quadRightSecondary: 0.54,
  tree: 0.28,
  search: 0.28
};
export const PANEL_IDS: PanelId[] = ["panel-1", "panel-2", "panel-3", "panel-4"];

function clamp(min: number, value: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeDetailsRowHeight(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_DETAILS_ROW_HEIGHT;
  }

  return clamp(24, Math.round(value), 72);
}

export function normalizeTabMinWidth(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_THEME.tabMinWidth;
  }

  return Math.max(1, Math.round(value));
}

export function normalizeThemeAccentColor(value?: string | null) {
  if (!value || !/^#[0-9a-fA-F]{6}$/.test(value.trim())) {
    return DEFAULT_THEME.panelFocusAccent;
  }

  return value.trim().toLowerCase();
}

export function labelFromPath(path: string) {
  if (path.startsWith("ftp://") || path.startsWith("sftp://")) {
    const withoutTrailingSlash = path.endsWith("/") ? path.slice(0, -1) : path;
    const segments = withoutTrailingSlash.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? withoutTrailingSlash;
  }

  const normalized = path.endsWith("\\") ? path.slice(0, -1) : path;
  if (/^[A-Za-z]:$/.test(normalized)) {
    return normalized;
  }

  const segments = normalized.split("\\").filter(Boolean);
  return segments[segments.length - 1] ?? normalized;
}

function buildLocalBreadcrumbs(path: string) {
  const normalized = normalizeLocationPath(path);
  if (/^[A-Za-z]:\\$/.test(normalized)) {
    return [
      {
        id: normalized,
        label: normalized.slice(0, 2),
        path: normalized
      }
    ];
  }

  const drive = normalized.slice(0, 3);
  const breadcrumbs = [
    {
      id: drive,
      label: drive.slice(0, 2),
      path: drive
    }
  ];
  const parts = normalized.slice(3).split("\\").filter(Boolean);
  let currentPath = drive.endsWith("\\") ? drive.slice(0, -1) : drive;
  for (const part of parts) {
    currentPath = `${currentPath}\\${part}`;
    breadcrumbs.push({
      id: currentPath,
      label: part,
      path: currentPath
    });
  }
  return breadcrumbs;
}

function buildRemoteBreadcrumbs(path: string, profile: BackendRemoteProfile) {
  const rootUri = createRemoteRootUri(profile);
  const breadcrumbs = [
    {
      id: rootUri,
      label: profile.name,
      path: rootUri
    }
  ];

  if (path === rootUri) {
    return breadcrumbs;
  }

  const relative = path.slice(trimTrailingSlash(rootUri).length).replace(/^\/+/, "");
  let currentPath = trimTrailingSlash(rootUri);
  for (const segment of relative.split("/").filter(Boolean)) {
    currentPath = `${currentPath}/${segment}`;
    breadcrumbs.push({
      id: currentPath,
      label: segment,
      path: currentPath
    });
  }

  return breadcrumbs;
}

function formatFileSize(size?: number | null) {
  if (size == null) {
    return "--";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  if (unitIndex === 0) {
    return `${Math.round(value)} ${units[unitIndex]}`;
  }
  const rendered = Number.isInteger(value) ? value.toFixed(0) : value.toFixed(value >= 10 ? 0 : 1);
  return `${rendered} ${units[unitIndex]}`;
}

function formatModifiedLabel(modifiedAt?: string | null) {
  if (!modifiedAt) {
    return "--";
  }

  const date = new Date(modifiedAt);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`;
}

function describeEntry(entry: BackendEntryViewModel) {
  if (entry.kind === "directory") {
    return entry.isHidden ? "隐藏文件夹" : "文件夹";
  }
  if (entry.isReadOnly) {
    return "只读文件";
  }
  if (entry.isHidden) {
    return "隐藏文件";
  }
  if (entry.isSymlink) {
    return "符号链接";
  }
  return "文件";
}

function createLocationLabel(path: string, profile?: BackendRemoteProfile) {
  if (profile && path === createRemoteRootUri(profile)) {
    return profile.name;
  }
  return labelFromPath(path);
}

function createLocationSubtitle(kind: "local" | "ftp" | "sftp", profile?: BackendRemoteProfile) {
  if (profile) {
    return `${kind.toUpperCase()} · ${profile.host}:${profile.port}`;
  }
  return kind === "local" ? "本地文件系统" : `${kind.toUpperCase()} 位置`;
}

function localizeShortcutAction(action: string) {
  const dictionary: Record<string, string> = {
    Copy: "复制",
    copy: "复制",
    Cut: "剪切",
    cut: "剪切",
    Paste: "粘贴",
    paste: "粘贴",
    Delete: "删除",
    delete: "删除",
    Rename: "重命名",
    rename: "重命名",
    Refresh: "刷新",
    refresh: "刷新",
    "Next panel": "切换到下一个面板",
    "focus-next-panel": "切换到下一个面板",
    "Search drawer": "打开搜索面板",
    "open-search": "打开搜索面板",
    "New tab": "新建标签页",
    "new-tab": "新建标签页",
    "Close tab": "关闭标签页",
    "close-tab": "关闭标签页",
    "Navigate up": "上一级",
    "navigate-up": "上一级",
    "Navigate forward": "回到下一级",
    "navigate-forward": "回到下一级",
    "Drag move": "拖放时移动",
    "drag-move": "拖放时移动",
    "create-folder": "新建文件夹"
  };
  return dictionary[action] ?? action;
}

function localizeShortcutDescription(action: string) {
  const dictionary: Record<string, string> = {
    Copy: "复制当前选中项。",
    copy: "复制当前选中项。",
    Cut: "剪切当前选中项。",
    cut: "剪切当前选中项。",
    Paste: "将剪贴板内容粘贴到当前目录。",
    paste: "将剪贴板内容粘贴到当前目录。",
    Delete: "删除当前选中项。",
    delete: "删除当前选中项。",
    Rename: "重命名当前选中项。",
    rename: "重命名当前选中项。",
    Refresh: "刷新当前面板。",
    refresh: "刷新当前面板。",
    "Next panel": "按顺序切换可见面板焦点。",
    "focus-next-panel": "按顺序切换可见面板焦点。",
    "Search drawer": "打开停靠式搜索面板。",
    "open-search": "打开停靠式搜索面板。",
    "New tab": "在当前面板中新建标签页。",
    "new-tab": "在当前面板中新建标签页。",
    "Close tab": "关闭当前活动标签页。",
    "close-tab": "关闭当前活动标签页。",
    "Navigate up": "打开当前文件夹的上一级。",
    "navigate-up": "打开当前文件夹的上一级。",
    "Navigate forward": "回到历史中的下一级文件夹。",
    "navigate-forward": "回到历史中的下一级文件夹。",
    "Drag move": "拖放文件或文件夹时执行移动而不是复制。",
    "drag-move": "拖放文件或文件夹时执行移动而不是复制。",
    "create-folder": "在当前目录中新建文件夹。"
  };
  return dictionary[action] ?? action;
}

function localizeColorRulePreview(rule: BackendColorRule) {
  const targetMap: Record<string, string> = {
    any: "任意项",
    file: "文件",
    directory: "文件夹"
  };
  const modeMap: Record<string, string> = {
    extension: "扩展名匹配",
    nameContains: "名称包含",
    pathContains: "路径包含",
    hidden: "隐藏属性",
    readOnly: "只读属性"
  };
  return `${targetMap[rule.target] ?? "任意项"} · ${modeMap[rule.mode] ?? rule.mode}`;
}

function createRemoteUriFromBackend(
  remotePath: string,
  connectionId: string | null | undefined,
  profiles: BackendRemoteProfile[]
) {
  const profile = profiles.find((item) => item.id === connectionId);
  return profile ? createRemoteUri(profile, remotePath) : remotePath;
}

function mapEntryViewModel(
  entry: BackendEntryViewModel,
  currentPath: string,
  profiles: BackendRemoteProfile[]
) {
  const remoteProfile =
    entry.location.kind === "local"
      ? undefined
      : profiles.find((profile) => profile.id === entry.location.connectionId) ??
        resolveRemotePath(createRemoteUriFromBackend(entry.location.path, entry.location.connectionId, profiles), profiles)?.profile;

  const resolvedPath =
    entry.location.kind === "local"
      ? normalizeLocationPath(entry.path)
      : remoteProfile
        ? createRemoteUri(remoteProfile, entry.path)
        : entry.path;
  const extension = entry.extension ? (entry.extension.startsWith(".") ? entry.extension : `.${entry.extension}`) : "";
  const attributes = [
    entry.kind === "directory" ? "D" : "A",
    ...(entry.isHidden ? ["H"] : []),
    ...(entry.isReadOnly ? ["R"] : []),
    ...(entry.isSymlink ? ["L"] : [])
  ];

  return {
    id: resolvedPath,
    name: entry.name,
    kind: entry.kind === "directory" ? "folder" : "file",
    path: resolvedPath,
    parentPath: currentPath,
    sizeLabel: entry.kind === "directory" ? "--" : formatFileSize(entry.size),
    modifiedLabel: formatModifiedLabel(entry.modifiedAt),
    extension,
    attributes,
    accentColor: entry.decoration.colorHex ?? (entry.kind === "directory" ? "#2f6b57" : "#29659f"),
    tags: entry.decoration.tags ? [...entry.decoration.tags] : [],
    description: describeEntry(entry)
  } satisfies DirectorySnapshot["entries"][number];
}

function cloneDirectorySnapshot(snapshot: DirectorySnapshot): DirectorySnapshot {
  return {
    location: { ...snapshot.location },
    breadcrumbs: snapshot.breadcrumbs.map((breadcrumb) => ({ ...breadcrumb })),
    entries: snapshot.entries.map((entry) => ({
      ...entry,
      attributes: [...entry.attributes],
      tags: [...entry.tags]
    }))
  };
}

export function mapDirectoryListingToSnapshot(
  listing: BackendDirectoryListing,
  profiles: BackendRemoteProfile[] = []
): DirectorySnapshot {
  const isRemote = listing.location.kind !== "local";
  const remoteProfile = isRemote
    ? profiles.find((profile) => profile.id === listing.location.connectionId) ?? null
    : null;
  const locationPath = isRemote && remoteProfile
    ? createRemoteUri(remoteProfile, listing.location.path)
    : normalizeLocationPath(listing.location.path);
  const kind = listing.location.kind;

  return {
    location: {
      kind,
      label: createLocationLabel(locationPath, remoteProfile ?? undefined),
      path: locationPath,
      subtitle: createLocationSubtitle(kind, remoteProfile ?? undefined)
    },
    breadcrumbs:
      isRemote && remoteProfile ? buildRemoteBreadcrumbs(locationPath, remoteProfile) : buildLocalBreadcrumbs(locationPath),
    entries: listing.entries.map((entry) => mapEntryViewModel(entry, locationPath, profiles))
  };
}

function mapBookmarkItem(
  item: { id: string; name: string; path: string },
  kind: BookmarkItem["kind"],
  tint: string
): BookmarkItem {
  return {
    id: item.id,
    label: item.name,
    path: item.path,
    tint,
    note: item.path,
    kind
  };
}

export function mapFavoriteCollections(settings: BackendSettingsSnapshot) {
  return {
    bookmarks: settings.bookmarks.map((bookmark) => mapBookmarkItem(bookmark, "bookmark", "#2266a8")),
    hotlist: settings.hotlist.map((entry) => mapBookmarkItem(entry, "hotlist", "#8d6b2c"))
  };
}

export function mapNavigationItems(settings: Pick<BackendSettingsSnapshot, "navigationItems">): NavigationItem[] {
  return [...(settings.navigationItems ?? [])]
    .map((item) => ({
      id: item.id,
      displayName: item.displayName,
      description: item.description,
      path: item.path,
      targetKind: item.targetKind,
      targetStatus: item.targetStatus,
      statusMessage: item.statusMessage ?? undefined,
      sortOrder: item.sortOrder,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      lastOpenedAt: item.lastOpenedAt ?? undefined
    }))
    .sort((left, right) => left.sortOrder - right.sortOrder || left.displayName.localeCompare(right.displayName, "zh-CN"));
}

export function mapRemoteProfile(profile: BackendRemoteProfile): RemoteConnectionProfile {
  return {
    id: profile.id,
    name: profile.name,
    protocol: profile.protocol as RemoteConnectionProfile["protocol"],
    host: profile.host,
    port: profile.port,
    username: profile.username,
    rootPath: profile.rootPath,
    authKind: profile.authKind ?? "password",
    privateKeyPath: profile.privateKeyPath ?? undefined,
    passiveMode: profile.passiveMode ?? true,
    ignoreHostKey: profile.ignoreHostKey ?? false,
    connectTimeoutSecs: profile.connectTimeoutSecs ?? 10,
    commandTimeoutSecs: profile.commandTimeoutSecs ?? 20
  };
}

export function mapRemoteProfiles(profiles: BackendRemoteProfile[]) {
  return profiles.map(mapRemoteProfile);
}

function buildColorRuleMatcher(rule: BackendColorRule) {
  const suffix = rule.pattern ? `:${rule.pattern}` : "";
  return `${rule.mode}${suffix}`;
}

function mergeShortcutDefaults(shortcuts: SettingsModel["shortcuts"]) {
  const byId = new Map(shortcuts.map((shortcut) => [shortcut.id, shortcut]));
  const merged = DEFAULT_SHORTCUTS.map((shortcut) => ({
    ...shortcut,
    ...(byId.get(shortcut.id) ?? {})
  }));
  const knownIds = new Set(merged.map((shortcut) => shortcut.id));
  return [...merged, ...shortcuts.filter((shortcut) => !knownIds.has(shortcut.id))];
}

export function mapSettingsModel(settings: BackendSettingsSnapshot): SettingsModel {
  return {
    shortcuts: mergeShortcutDefaults(
      settings.shortcuts.map((shortcut: BackendShortcutBinding) => ({
        id: shortcut.id,
        action: localizeShortcutAction(shortcut.action),
        scope:
          shortcut.scope === "listing" || shortcut.scope === "panel" || shortcut.scope === "workspace"
            ? shortcut.scope
            : "workspace",
        binding: shortcut.accelerator,
        description: localizeShortcutDescription(shortcut.action)
      }))
    ),
    colorRules: settings.colorRules.map((rule) => ({
      id: rule.id,
      label: rule.name,
      matcher: buildColorRuleMatcher(rule),
      color: rule.colorHex,
      previewText: localizeColorRulePreview(rule)
    })),
    tagRules: settings.tagDefinitions.map((definition) => ({
      id: definition.id,
      label: definition.name,
      matcher: `tag:${definition.name}`,
      accentColor: definition.colorHex,
      quickFilter: definition.name
    })),
    columns: cloneColumns(),
    detailsRowHeight: normalizeDetailsRowHeight(settings.detailsRowHeight),
    theme: {
      panelFocusAccent: normalizeThemeAccentColor(settings.theme?.panelFocusAccent),
      tabMinWidth: normalizeTabMinWidth(settings.theme?.tabMinWidth)
    }
  };
}

export function mapSettingsSnapshotToWorkspaceSettings(settings: BackendSettingsSnapshot) {
  const favorites = mapFavoriteCollections(settings);
  return {
    ...favorites,
    navigationItems: mapNavigationItems(settings),
    remoteProfiles: mapRemoteProfiles(settings.remoteProfiles),
    settingsModel: mapSettingsModel(settings)
  };
}

export function normalizeSettingsModel(settingsModel: SettingsModel): SettingsModel {
  return {
    shortcuts: mergeShortcutDefaults(settingsModel.shortcuts),
    colorRules: settingsModel.colorRules,
    tagRules: settingsModel.tagRules,
    columns: settingsModel.columns.length > 0 ? cloneColumns(settingsModel.columns) : cloneColumns(),
    detailsRowHeight: normalizeDetailsRowHeight(settingsModel.detailsRowHeight),
    theme: {
      panelFocusAccent: normalizeThemeAccentColor(settingsModel.theme?.panelFocusAccent),
      tabMinWidth: normalizeTabMinWidth(settingsModel.theme?.tabMinWidth)
    }
  };
}

export function createTabFromSnapshot(
  snapshot: DirectorySnapshot,
  id: string,
  overrides: Partial<Omit<TabState, "id" | "snapshot" | "title" | "addressDraft">> & { title?: string } = {}
): TabState {
  const tabSnapshot = cloneDirectorySnapshot(snapshot);
  const history =
    overrides.history && overrides.history.length > 0
      ? overrides.history.map((item) => normalizeLocationPath(item))
      : [tabSnapshot.location.path];
  const historyIndex = Math.min(Math.max(overrides.historyIndex ?? history.length - 1, 0), history.length - 1);
  const expandedNodePaths = overrides.expandedNodePaths
    ? Array.from(new Set(overrides.expandedNodePaths.map((item) => normalizeLocationPath(item))))
    : tabSnapshot.breadcrumbs.map((breadcrumb) => breadcrumb.path);
  return {
    id,
    title: overrides.title ?? tabSnapshot.location.label,
    titleOverride: overrides.titleOverride ?? overrides.title,
    kind: "directory",
    snapshot: tabSnapshot,
    addressDraft: tabSnapshot.location.path,
    history,
    historyIndex,
    selectedEntryIds: overrides.selectedEntryIds ? [...overrides.selectedEntryIds] : [],
    expandedNodePaths,
    viewMode: overrides.viewMode ?? "details",
    sort: overrides.sort
      ? { ...overrides.sort }
      : {
          columnId: "name",
          direction: "asc"
        },
    columns: overrides.columns ? cloneColumns(overrides.columns) : cloneColumns(),
    status: overrides.status ?? "ready",
    locked: overrides.locked,
    reconnect: overrides.reconnect
      ? {
          ...overrides.reconnect
        }
      : undefined
  };
}

export function createPanelState(
  panelId: PanelId,
  label: string,
  snapshot: DirectorySnapshot,
  tabId: string,
  columns: ColumnDefinition[] = DEFAULT_COLUMNS
): PanelState {
  const tab = createTabFromSnapshot(snapshot, tabId, { columns });
  return {
    id: panelId,
    label,
    tabs: [tab],
    activeTabId: tab.id
  };
}

function mapLayoutRatios(layout: BackendUiLayout | undefined): LayoutRatios {
  if (!layout) {
    return { ...DEFAULT_LAYOUT_RATIOS };
  }

  const sidebarRatio = clamp(0.18, layout.sidebarWidth / 960, 0.45);
  const panelProportions = layout.panelProportions ?? [];
  const firstPair = (panelProportions[0] ?? 1) + (panelProportions[1] ?? 1);
  const primary = clamp(0.2, (panelProportions[0] ?? 1) / firstPair, 0.8);

  return {
    primary,
    tripleSecondary: DEFAULT_LAYOUT_RATIOS.tripleSecondary,
    quadLeftSecondary: DEFAULT_LAYOUT_RATIOS.quadLeftSecondary,
    quadRightSecondary: DEFAULT_LAYOUT_RATIOS.quadRightSecondary,
    tree: sidebarRatio,
    search: DEFAULT_LAYOUT_RATIOS.search
  };
}

function mapDirectoryTree(drives: BackendWorkspaceBootstrap["drives"], remoteProfiles: BackendRemoteProfile[]) {
  const localRoots: DirectoryNode[] = drives.map((drive) => ({
    id: drive.path,
    label: drive.label,
    path: drive.path,
    kind: "drive",
    badge: "本地磁盘",
    expandable: true,
    loaded: false,
    children: []
  }));

  const remoteRoots: DirectoryNode[] = remoteProfiles.map((profile) => ({
    id: profile.id,
    label: profile.name,
    path: createRemoteRootUri(profile),
    kind: "remote-root",
    badge: `${profile.protocol.toUpperCase()} 远程`,
    expandable: true,
    loaded: false,
    children: []
  }));

  return [...localRoots, ...remoteRoots];
}

export function mapWorkspaceBootstrap(bootstrap: BackendWorkspaceBootstrap): WorkspaceBootstrap {
  const initialSnapshot = mapDirectoryListingToSnapshot(bootstrap.initialListing, bootstrap.settings.remoteProfiles);
  const settingsModel = mapSettingsModel(bootstrap.settings);
  const panels = Object.fromEntries(
    PANEL_IDS.map((panelId, index) => [
      panelId,
      createPanelState(panelId, `面板 ${index + 1}`, initialSnapshot, `${panelId}-tab-1`, settingsModel.columns)
    ])
  ) as WorkspaceBootstrap["panels"];

  return {
    source: "tauri",
    layoutMode: bootstrap.settings.layout.layoutMode,
    layoutRatios: mapLayoutRatios(bootstrap.settings.layout),
    panels,
    activePanelId: "panel-1",
    directoryTree: mapDirectoryTree(bootstrap.drives, bootstrap.settings.remoteProfiles),
    bookmarks: bootstrap.settings.bookmarks.map((bookmark) => mapBookmarkItem(bookmark, "bookmark", "#2266a8")),
    hotlist: bootstrap.settings.hotlist.map((item) => mapBookmarkItem(item, "hotlist", "#8d6b2c")),
    navigationItems: mapNavigationItems(bootstrap.settings),
    remoteProfiles: mapRemoteProfiles(bootstrap.settings.remoteProfiles),
    settingsModel
  };
}

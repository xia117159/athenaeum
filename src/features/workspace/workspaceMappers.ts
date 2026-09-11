import type {
  DirectoryListing as BackendDirectoryListing,
  EntryViewModel as BackendEntryViewModel,
  RemoteProfile as BackendRemoteProfile,
  SettingsSnapshot as BackendSettingsSnapshot,
  ShortcutBinding as BackendShortcutBinding,
  UiLayout as BackendUiLayout,
  WorkspaceBootstrap as BackendWorkspaceBootstrap
} from "../../app/types";
import { normalizeLocationPath } from "./mockData";
import { directoryListingIdentityIsReliable } from "./directorySizeMapping";
import { normalizeNavigationColumns } from "./NavigationTabColumns";
import { createRemoteRootUri, createRemoteUri, resolveRemotePath, trimTrailingSlash } from "./remoteUri";
import {
  cloneColumns,
  DEFAULT_COLUMNS,
  DEFAULT_METADATA_RETENTION_HOURS,
  DEFAULT_TOOLTIP_HOVER_DELAY_MS
} from "./workspaceFileListDefaults";
import type {
  BookmarkItem,
  ColumnDefinition,
  DirectoryNode,
  DirectorySnapshot,
  FileVisibilityState,
  InformationPanelState,
  LayoutRatios,
  NavigationItem,
  PanelId,
  PanelState,
  RemoteConnectionProfile,
  SettingsSection,
  SettingsModel,
  TabState,
  WorkspaceBootstrap
} from "./types";
import { DEFAULT_FILE_VISIBILITY } from "./workspaceVisibility";
import type { ColorFilterRule } from "./colorFilterTypes";

export { cloneColumns, DEFAULT_COLUMNS, DEFAULT_METADATA_RETENTION_HOURS, DEFAULT_TOOLTIP_HOVER_DELAY_MS } from "./workspaceFileListDefaults";
export { cloneNavigationColumns, NAVIGATION_COLUMNS, normalizeNavigationColumns } from "./NavigationTabColumns";

const DEFAULT_COLUMN_BY_ID = new Map(DEFAULT_COLUMNS.map((column) => [column.id, column] as const));

function mapColorFilterRule(rule: ColorFilterRule): ColorFilterRule {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    target: rule.target,
    expression: rule.expression,
    caseSensitive: rule.caseSensitive,
    foregroundColorHex: rule.foregroundColorHex,
    backgroundColorHex: rule.backgroundColorHex,
    priority: rule.priority,
    migrationDiagnostic: rule.migrationDiagnostic ?? null
  };
}

function normalizeColumnId(value?: string | null): ColumnDefinition["id"] | null {
  return DEFAULT_COLUMNS.some((column) => column.id === value) ? (value as ColumnDefinition["id"]) : null;
}

function normalizeColumnAlign(value?: string | null): ColumnDefinition["align"] {
  return value === "right" ? "right" : "left";
}

export function normalizeColumns(
  columns?: Array<{
    id?: string | null;
    label?: string | null;
    visible?: boolean | null;
    width?: string | null;
    align?: string | null;
  }> | null
): ColumnDefinition[] {
  if (!columns || columns.length === 0) {
    return cloneColumns();
  }

  const seen = new Set<ColumnDefinition["id"]>();
  const normalized: ColumnDefinition[] = [];
  const normalizedById = new Map<ColumnDefinition["id"], ColumnDefinition>();
  for (const column of columns) {
    const id = normalizeColumnId(column.id);
    if (!id || seen.has(id)) {
      continue;
    }
    const fallback = DEFAULT_COLUMN_BY_ID.get(id)!;
    seen.add(id);
    const normalizedColumn = {
      id,
      label: typeof column.label === "string" && column.label.trim() ? column.label : fallback.label,
      visible: typeof column.visible === "boolean" ? column.visible : fallback.visible,
      width: typeof column.width === "string" && column.width.trim() ? column.width : fallback.width,
      align: normalizeColumnAlign(column.align)
    };
    normalized.push(normalizedColumn);
    normalizedById.set(id, normalizedColumn);
  }

  if (seen.size < DEFAULT_COLUMNS.length) {
    return DEFAULT_COLUMNS.map((column) => normalizedById.get(column.id) ?? { ...column });
  }

  for (const column of DEFAULT_COLUMNS) {
    if (!seen.has(column.id)) {
      normalized.push({ ...column });
    }
  }

  return normalized.length > 0 ? normalized : cloneColumns();
}

export const DEFAULT_SHORTCUTS: SettingsModel["shortcuts"] = [
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
    id: "copy-name",
    action: "复制名称",
    scope: "listing",
    binding: "Alt+Shift+N",
    description: "复制当前选中项的名称到系统剪贴板。"
  },
  {
    id: "copy-path",
    action: "复制路径",
    scope: "listing",
    binding: "Alt+Shift+P",
    description: "复制当前选中项的完整路径到系统剪贴板。"
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
    id: "context-menu-toggle",
    action: "右键菜单切换",
    scope: "context-menu",
    binding: "Shift",
    description: "右键时临时切换 Windows 系统菜单与软件自定义菜单。"
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
  },
  {
    id: "select-previous",
    action: "上一项",
    scope: "listing",
    binding: "Up",
    description: "在列表中单选上一项。"
  },
  {
    id: "select-next",
    action: "下一项",
    scope: "listing",
    binding: "Down",
    description: "在列表中单选下一项。"
  },
  {
    id: "select-first",
    action: "第一项",
    scope: "listing",
    binding: "Home",
    description: "单选列表第一项。"
  },
  {
    id: "select-last",
    action: "最后一项",
    scope: "listing",
    binding: "End",
    description: "单选列表最后一项。"
  },
  {
    id: "select-previous-page",
    action: "上一页",
    scope: "listing",
    binding: "PageUp",
    description: "在列表中向上翻页单选。"
  },
  {
    id: "select-next-page",
    action: "下一页",
    scope: "listing",
    binding: "PageDown",
    description: "在列表中向下翻页单选。"
  },
  {
    id: "select-previous-column",
    action: "上一列",
    scope: "listing",
    binding: "Left",
    description: "在图标/平铺/内容视图中单选左一列。"
  },
  {
    id: "select-next-column",
    action: "下一列",
    scope: "listing",
    binding: "Right",
    description: "在图标/平铺/内容视图中单选右一列。"
  },
  {
    id: "extend-previous",
    action: "扩展到上一项",
    scope: "listing",
    binding: "Shift+Up",
    description: "以当前选中项为起点，多选到上一项。"
  },
  {
    id: "extend-next",
    action: "扩展到下一项",
    scope: "listing",
    binding: "Shift+Down",
    description: "以当前选中项为起点，多选到下一项。"
  },
  {
    id: "extend-first",
    action: "扩展到第一项",
    scope: "listing",
    binding: "Shift+Home",
    description: "以当前选中项为起点，多选到列表顶。"
  },
  {
    id: "extend-last",
    action: "扩展到最后一项",
    scope: "listing",
    binding: "Shift+End",
    description: "以当前选中项为起点，多选到列表底。"
  },
  {
    id: "select-all",
    action: "全选",
    scope: "listing",
    binding: "Ctrl+A",
    description: "选中当前列表中的全部项。"
  },
  {
    id: "clear-selection",
    action: "清除选择",
    scope: "listing",
    binding: "Escape",
    description: "清除列表中的多选，恢复为无选中。"
  },
  {
    id: "open-entry",
    action: "打开",
    scope: "listing",
    binding: "Enter",
    description: "打开当前选中的文件夹或文件。"
  }
];

export const DEFAULT_DETAILS_ROW_HEIGHT = 24;
export const DEFAULT_THEME: SettingsModel["theme"] = {
  panelFocusAccent: "#0f6cbd",
  activeTabBackground: "#ffffff",
  dropHighlightFill: "#0f6cbd",
  dropHighlightBorder: "#0f6cbd",
  sizeBarLow: "#dceaf7",
  sizeBarHigh: "#3979b7",
  tabMinWidth: 96
};
export const DEFAULT_CONTEXT_MENU_SETTINGS: SettingsModel["contextMenu"] = {
  defaultMenu: "native"
};
export const DEFAULT_LAYOUT_RATIOS: LayoutRatios = {
  primary: 0.52,
  tripleSecondary: 0.54,
  quadLeftSecondary: 0.54,
  quadRightSecondary: 0.54,
  tree: 0.28,
  search: 0.28
};
export const DEFAULT_INFORMATION_PANEL: InformationPanelState = {
  expanded: false,
  activeTab: "properties",
  properties: {
    status: "idle"
  }
};
export const PANEL_IDS: PanelId[] = ["panel-1", "panel-2", "panel-3", "panel-4"];

function clamp(min: number, value: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeDetailsRowHeight(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_DETAILS_ROW_HEIGHT;
  }

  return clamp(12, Math.round(value), 72);
}

export function normalizeTooltipHoverDelayMs(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TOOLTIP_HOVER_DELAY_MS;
  }

  return clamp(0, Math.round(value), 5000);
}

export function normalizeMetadataRetentionHours(value?: number | null) {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_METADATA_RETENTION_HOURS;
  }

  return Math.max(0, Math.round(value));
}

export function normalizeTabMinWidth(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_THEME.tabMinWidth;
  }

  return Math.max(1, Math.round(value));
}

export function normalizeThemeAccentColor(value?: string | null, fallback = DEFAULT_THEME.panelFocusAccent) {
  if (!value || !/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value.trim())) {
    return fallback;
  }

  return value.trim().toLowerCase();
}

export function normalizeContextMenuDefault(value?: string | null): SettingsModel["contextMenu"]["defaultMenu"] {
  return value === "custom" ? "custom" : "native";
}

export function normalizeSettingsSection(value?: string | null): SettingsSection {
  switch (value) {
    case "shortcuts":
    case "file-list":
    case "menu-mouse":
    case "appearance":
    case "color-rules":
    case "tag-rules":
    case "connections":
      return value;
    case "theme":
      return "appearance";
    case "rules":
      return "file-list";
    default:
      return "shortcuts";
  }
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

function formatDateLabel(value?: string | null) {
  if (!value) {
    return "--";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`;
}

function describeEntry(entry: BackendEntryViewModel) {
  if (entry.isProtectedOperatingSystem) {
    return "受保护的操作系统文件";
  }
  if (entry.isSystem) {
    return entry.kind === "directory" ? "系统文件夹" : "系统文件";
  }
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
    "Context menu toggle": "右键菜单切换",
    "context-menu-toggle": "右键菜单切换",
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
    "Context menu toggle": "右键时临时切换 Windows 系统菜单与软件自定义菜单。",
    "context-menu-toggle": "右键时临时切换 Windows 系统菜单与软件自定义菜单。",
    "create-folder": "在当前目录中新建文件夹。"
  };
  return dictionary[action] ?? action;
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
    ...(entry.isSystem ? ["S"] : []),
    ...(entry.isProtectedOperatingSystem ? ["P"] : []),
    ...(entry.isReadOnly ? ["R"] : []),
    ...(entry.isSymlink ? ["L"] : [])
  ];

  return {
    id: resolvedPath,
    name: entry.name,
    kind: entry.kind === "directory" ? "folder" : "file",
    path: resolvedPath,
    parentPath: currentPath,
    sizeBytes: entry.kind === "directory" ? null : entry.size ?? null,
    sizeLabel: entry.kind === "directory" ? "--" : formatFileSize(entry.size),
    createdLabel: formatDateLabel(entry.createdAt),
    modifiedLabel: formatDateLabel(entry.modifiedAt),
    accessedLabel: formatDateLabel(entry.accessedAt),
    extension,
    attributes,
    isHidden: entry.isHidden,
    isSystem: entry.isSystem ?? false,
    isProtectedOperatingSystem: entry.isProtectedOperatingSystem ?? false,
    accentColor: entry.kind === "directory" ? "#2f6b57" : "#29659f",
    foregroundColorHex: entry.decoration.foregroundColorHex ?? null,
    backgroundColorHex: entry.decoration.backgroundColorHex ?? null,
    tags: entry.decoration.tags ? [...entry.decoration.tags] : [],
    comment: entry.comment ?? "",
    description: describeEntry(entry)
  } satisfies DirectorySnapshot["entries"][number];
}

function cloneDirectorySnapshot(snapshot: DirectorySnapshot): DirectorySnapshot {
  return {
    sizeFingerprint: snapshot.sizeFingerprint,
    sizeIdentityReliable: snapshot.sizeIdentityReliable,
    location: { ...snapshot.location },
    breadcrumbs: snapshot.breadcrumbs.map((breadcrumb) => ({ ...breadcrumb })),
    entries: snapshot.entries.map((entry) => ({
      ...entry,
      attributes: [...entry.attributes],
      isHidden: entry.isHidden,
      isSystem: entry.isSystem,
      isProtectedOperatingSystem: entry.isProtectedOperatingSystem,
      tags: [...entry.tags],
      driveInfo: entry.driveInfo ? { ...entry.driveInfo } : undefined
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
  const entries = listing.entries.map((entry) => mapEntryViewModel(entry, locationPath, profiles));
  const sizeIdentityReliable = directoryListingIdentityIsReliable(listing, locationPath, entries);

  return {
    sizeFingerprint: sizeIdentityReliable ? listing.sizeFingerprint : null,
    sizeIdentityReliable,
    location: {
      kind,
      label: createLocationLabel(locationPath, remoteProfile ?? undefined),
      path: locationPath,
      subtitle: createLocationSubtitle(kind, remoteProfile ?? undefined)
    },
    breadcrumbs:
      isRemote && remoteProfile ? buildRemoteBreadcrumbs(locationPath, remoteProfile) : buildLocalBreadcrumbs(locationPath),
    entries
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
    commandTimeoutSecs: profile.commandTimeoutSecs ?? 20,
    credentialTarget: profile.credentialTarget ?? undefined,
    password: profile.password ?? undefined
  };
}

export function mapRemoteProfiles(profiles: BackendRemoteProfile[]) {
  return profiles.map(mapRemoteProfile);
}

function mergeShortcutDefaults(shortcuts: SettingsModel["shortcuts"]) {
  const byId = new Map(shortcuts.map((shortcut) => [shortcut.id, shortcut]));
  return DEFAULT_SHORTCUTS.map((shortcut) => ({
    ...shortcut,
    ...(byId.get(shortcut.id) ?? {})
  }));
}

export function mapSettingsModel(settings: BackendSettingsSnapshot): SettingsModel {
  return {
    shortcuts: mergeShortcutDefaults(
      settings.shortcuts.map((shortcut: BackendShortcutBinding) => ({
        id: shortcut.id,
        action: localizeShortcutAction(shortcut.action),
        scope:
          shortcut.scope === "listing" ||
          shortcut.scope === "panel" ||
          shortcut.scope === "workspace" ||
          shortcut.scope === "context-menu"
            ? shortcut.scope
            : "workspace",
        binding: shortcut.accelerator,
        description: localizeShortcutDescription(shortcut.action)
      }))
    ),
    colorRules: settings.colorFilter.rules.map(mapColorFilterRule),
    colorFilterEnabled: settings.colorFilter.enabled,
    colorFilterRevision: settings.colorFilter.revision,
    colorRulesRevision: settings.colorFilter.rulesRevision,
    tagRules: settings.tagDefinitions.map((definition) => ({
      id: definition.id,
      label: definition.name,
      matcher: `tag:${definition.name}`,
      accentColor: definition.colorHex,
      quickFilter: definition.name
    })),
    columns: normalizeColumns(settings.columns),
    navigationColumns: normalizeNavigationColumns(settings.navigationColumns),
    detailsRowHeight: normalizeDetailsRowHeight(settings.detailsRowHeight),
    folderExpansionEnabled: settings.folderExpansionEnabled === true,
    tooltipHoverDelayMs: normalizeTooltipHoverDelayMs(settings.tooltipHoverDelayMs),
    metadataRetentionHours: normalizeMetadataRetentionHours(settings.metadataRetentionHours),
    fileVisibility: normalizeFileVisibility(settings.fileVisibility),
    contextMenu: {
      defaultMenu: normalizeContextMenuDefault(settings.contextMenu?.defaultMenu)
    },
    theme: {
      panelFocusAccent: normalizeThemeAccentColor(settings.theme?.panelFocusAccent),
      activeTabBackground: normalizeThemeAccentColor(settings.theme?.activeTabBackground, DEFAULT_THEME.activeTabBackground),
      dropHighlightFill: normalizeThemeAccentColor(settings.theme?.dropHighlightFill),
      dropHighlightBorder: normalizeThemeAccentColor(settings.theme?.dropHighlightBorder),
      sizeBarLow: normalizeThemeAccentColor(settings.theme?.sizeBarLow, DEFAULT_THEME.sizeBarLow),
      sizeBarHigh: normalizeThemeAccentColor(settings.theme?.sizeBarHigh, DEFAULT_THEME.sizeBarHigh),
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
    colorFilterEnabled: settingsModel.colorFilterEnabled ?? true,
    colorFilterRevision: settingsModel.colorFilterRevision ?? "0",
    colorRulesRevision: settingsModel.colorRulesRevision ?? "0",
    tagRules: settingsModel.tagRules,
    columns: normalizeColumns(settingsModel.columns),
    navigationColumns: normalizeNavigationColumns(settingsModel.navigationColumns),
    detailsRowHeight: normalizeDetailsRowHeight(settingsModel.detailsRowHeight),
    folderExpansionEnabled: settingsModel.folderExpansionEnabled === true,
    tooltipHoverDelayMs: normalizeTooltipHoverDelayMs(settingsModel.tooltipHoverDelayMs),
    metadataRetentionHours: normalizeMetadataRetentionHours(settingsModel.metadataRetentionHours),
    fileVisibility: normalizeFileVisibility(settingsModel.fileVisibility),
    contextMenu: {
      defaultMenu: normalizeContextMenuDefault(settingsModel.contextMenu?.defaultMenu)
    },
    theme: {
      panelFocusAccent: normalizeThemeAccentColor(settingsModel.theme?.panelFocusAccent),
      activeTabBackground: normalizeThemeAccentColor(settingsModel.theme?.activeTabBackground, DEFAULT_THEME.activeTabBackground),
      dropHighlightFill: normalizeThemeAccentColor(settingsModel.theme?.dropHighlightFill),
      dropHighlightBorder: normalizeThemeAccentColor(settingsModel.theme?.dropHighlightBorder),
      sizeBarLow: normalizeThemeAccentColor(settingsModel.theme?.sizeBarLow, DEFAULT_THEME.sizeBarLow),
      sizeBarHigh: normalizeThemeAccentColor(settingsModel.theme?.sizeBarHigh, DEFAULT_THEME.sizeBarHigh),
      tabMinWidth: normalizeTabMinWidth(settingsModel.theme?.tabMinWidth)
    }
  };
}

export function normalizeFileVisibility(
  visibility?: Partial<FileVisibilityState> | null
): FileVisibilityState {
  return {
    showHidden: visibility?.showHidden === true,
    showSystem: visibility?.showSystem === true,
    hideProtectedOperatingSystemFiles:
      visibility?.hideProtectedOperatingSystemFiles ?? DEFAULT_FILE_VISIBILITY.hideProtectedOperatingSystemFiles
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

  const remoteRoots: DirectoryNode[] = remoteProfiles.map((profile) => {
    const path = createRemoteRootUri(profile);
    return {
      id: profile.id,
      label: profile.name,
      path,
      kind: "remote-root",
      badge: `${profile.protocol.toUpperCase()} 远程`,
      expandable: true,
      loaded: false,
      children: []
    };
  });

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
    startupDiagnostics: [...(bootstrap.startupDiagnostics ?? [])],
    layoutMode: bootstrap.settings.layout.layoutMode,
    layoutRatios: mapLayoutRatios(bootstrap.settings.layout),
    treeVisible: bootstrap.settings.layout.showTree !== false,
    informationPanel: { ...DEFAULT_INFORMATION_PANEL },
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

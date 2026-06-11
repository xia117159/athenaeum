import type {
  ColorRule as BackendColorRule,
  RemoteProfile as BackendRemoteProfile,
  RemoteProfileUpsertRequest as BackendRemoteProfileUpsertRequest,
  NavigationItemUpsertRequest as BackendNavigationItemUpsertRequest,
  SettingsModelUpdate as BackendSettingsModelUpdate,
  SettingsSnapshot as BackendSettingsSnapshot,
  ShortcutBinding as BackendShortcutBinding,
  UiLayout as BackendUiLayout,
  UiTheme as BackendUiTheme
} from "../../app/types";
import type { LayoutRatios, NavigationItem, NavigationItemUpsertRequest, PanelLayoutMode, RemoteConnectionProfile, SettingsModel } from "./types";
import {
  DEFAULT_DETAILS_ROW_HEIGHT,
  DEFAULT_LAYOUT_RATIOS,
  DEFAULT_THEME,
  normalizeTabMinWidth,
  normalizeThemeAccentColor
} from "./workspaceMappers";

export function toBackendLayout(layoutMode: PanelLayoutMode, layoutRatios: LayoutRatios): BackendUiLayout {
  return {
    layoutMode,
    panelProportions: [layoutRatios.primary, 1 - layoutRatios.primary],
    sidebarWidth: Math.round(layoutRatios.tree * 960),
    showTree: true,
    showSearch: true
  };
}

export function toBackendShortcut(shortcut: SettingsModel["shortcuts"][number]): BackendShortcutBinding {
  return {
    id: shortcut.id,
    action: shortcut.id,
    accelerator: shortcut.binding,
    scope: shortcut.scope
  };
}

export function toBackendColorRule(rule: SettingsModel["colorRules"][number], index: number): BackendColorRule {
  const [modeToken, patternToken] = rule.matcher.split(":", 2);
  const mode = (modeToken || "nameContains") as BackendColorRule["mode"];

  return {
    id: rule.id,
    name: rule.label,
    target: "any",
    mode,
    pattern: patternToken ?? null,
    colorHex: rule.color,
    priority: index + 1
  };
}

export function toBackendTheme(theme: SettingsModel["theme"]): BackendUiTheme {
  return {
    panelFocusAccent: normalizeThemeAccentColor(theme.panelFocusAccent),
    tabMinWidth: normalizeTabMinWidth(theme.tabMinWidth)
  };
}

export function toBackendSettingsModelUpdate(model: SettingsModel): BackendSettingsModelUpdate {
  return {
    shortcuts: model.shortcuts.map(toBackendShortcut),
    colorRules: model.colorRules.map(toBackendColorRule),
    detailsRowHeight: model.detailsRowHeight,
    theme: toBackendTheme(model.theme)
  };
}

export function toBackendRemoteProfile(profile: RemoteConnectionProfile): BackendRemoteProfile {
  return {
    id: profile.id,
    name: profile.name,
    protocol: profile.protocol,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    rootPath: profile.rootPath,
    authKind: profile.authKind,
    privateKeyPath: profile.privateKeyPath ?? null,
    passiveMode: profile.passiveMode,
    ignoreHostKey: profile.ignoreHostKey,
    connectTimeoutSecs: profile.connectTimeoutSecs,
    commandTimeoutSecs: profile.commandTimeoutSecs
  };
}

export function toRemoteProfileUpsertRequest(
  profile: RemoteConnectionProfile,
  password?: string
): BackendRemoteProfileUpsertRequest {
  return {
    profile: toBackendRemoteProfile(profile),
    password: password ?? null
  };
}

export function toNavigationItemUpsertRequest(
  item: NavigationItem | NavigationItemUpsertRequest
): BackendNavigationItemUpsertRequest {
  const displayName = item.displayName?.trim();
  return {
    id: "id" in item ? item.id : undefined,
    displayName: displayName ? displayName : undefined,
    description: item.description.trim(),
    path: item.path.trim()
  };
}

export function createBrowserSettingsSnapshot(
  overrides: Partial<BackendSettingsSnapshot> = {}
): BackendSettingsSnapshot {
  return {
    bookmarks: [],
    hotlist: [],
    navigationItems: [],
    tagDefinitions: [],
    entryTags: [],
    colorRules: [],
    shortcuts: [],
    detailsRowHeight: DEFAULT_DETAILS_ROW_HEIGHT,
    theme: toBackendTheme(DEFAULT_THEME),
    layout: toBackendLayout("dual", DEFAULT_LAYOUT_RATIOS),
    remoteProfiles: [],
    ...overrides
  };
}

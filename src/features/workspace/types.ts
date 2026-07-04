import type {
  OperationHistoryRecord,
  OperationIntent,
  OperationPathRef,
  OperationTaskSnapshot
} from "../../app/types";

export type DataSource = "mock" | "tauri";

export const THIS_PC_PATH = "此电脑";
export type PanelLayoutMode = "single" | "dual" | "triple" | "quad";
export type PanelId = "panel-1" | "panel-2" | "panel-3" | "panel-4";
export type SettingsSection =
  | "shortcuts"
  | "file-list"
  | "menu-mouse"
  | "appearance"
  | "color-rules"
  | "tag-rules"
  | "connections";
export type LocationKind = "local" | "ftp" | "sftp" | "virtual";
export type EntryKind = "file" | "folder";
export type GitFileStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict" | "clean";
export type ColumnId =
  | "name"
  | "type"
  | "extension"
  | "size"
  | "created"
  | "modified"
  | "accessed"
  | "tags"
  | "comment"
  | "location";
export type ShortcutScope = "workspace" | "panel" | "listing" | "context-menu";

/**
 * 列表键盘导航的移动意图。
 * - delta:      距当前焦点 ±N 格（方向键一格、PageUp/Down 一页）。
 * - absolute:  跳到列表首项或末项（Home/End）。
 */
export type EntryFocusMove =
  | { kind: "delta"; delta: number }
  | { kind: "absolute"; position: "first" | "last" }
  | { kind: "page"; direction: "up" | "down"; pageSize: number };
export type ContextMenuDefault = "native" | "custom";
export type RemoteAuthKind = "password" | "keyFile" | "anonymous";
export type SortDirection = "asc" | "desc";
export type RemoteConnectionState = "unknown" | "connecting" | "connected" | "error";
export type TabViewMode =
  | "extra-large-icons"
  | "large-icons"
  | "medium-icons"
  | "small-icons"
  | "list"
  | "details"
  | "tiles"
  | "content";

export interface LocationDescriptor {
  kind: LocationKind;
  label: string;
  path: string;
  subtitle?: string;
}

export interface BreadcrumbItem {
  id: string;
  label: string;
  path: string;
}

export interface DirectoryNode {
  id: string;
  label: string;
  path: string;
  kind: "drive" | "folder" | "remote-root";
  badge?: string;
  connectionState?: RemoteConnectionState;
  errorMessage?: string;
  isHidden?: boolean;
  isSystem?: boolean;
  isProtectedOperatingSystem?: boolean;
  expandable: boolean;
  loaded?: boolean;
  children: DirectoryNode[];
}

export interface EntryViewModel {
  id: string;
  name: string;
  kind: EntryKind;
  path: string;
  parentPath: string;
  sizeBytes?: number | null;
  sizeLabel: string;
  createdLabel?: string;
  modifiedLabel: string;
  accessedLabel?: string;
  extension: string;
  attributes: string[];
  isHidden?: boolean;
  isSystem?: boolean;
  isProtectedOperatingSystem?: boolean;
  accentColor: string;
  tags: string[];
  comment?: string;
  description: string;
  contentText?: string;
  driveInfo?: {
    driveType: string;
    totalBytes: number | null;
    availableBytes: number | null;
    enterable: boolean;
  };
}

export interface DirectorySnapshot {
  location: LocationDescriptor;
  breadcrumbs: BreadcrumbItem[];
  entries: EntryViewModel[];
}

export interface SelectionPathReplacement {
  fromPath: string;
  toPath: string;
}

export interface SearchQuery {
  name: string;
  content: string;
  nameMode: SearchContentMode;
  contentMode: SearchContentMode;
  extensionFilterText: string;
  extensionFilterMode: SearchExtensionFilterMode;
  includeFolders: boolean;
  recursive: boolean;
  caseSensitive: boolean;
  scope: "active-panel" | "all-panels";
}

export type SearchContentMode = "normal" | "wildcard" | "regex";
export type SearchTabId = "name" | "content";
export type SearchExtensionFilterMode = "include" | "exclude";

export interface SearchResult {
  id: string;
  name: string;
  kind: EntryKind;
  path: string;
  parentPath: string;
  openPath: string;
  location: LocationDescriptor;
  match: string;
}

export interface BookmarkItem {
  id: string;
  label: string;
  path: string;
  tint: string;
  note: string;
  kind: "bookmark" | "hotlist";
}

export interface ShortcutBinding {
  id: string;
  action: string;
  scope: ShortcutScope;
  binding: string;
  description: string;
}

export interface ColorRule {
  id: string;
  label: string;
  matcher: string;
  color: string;
  previewText: string;
}

export interface TagRule {
  id: string;
  label: string;
  matcher: string;
  accentColor: string;
  quickFilter: string;
}

export interface ColumnDefinition {
  id: ColumnId;
  label: string;
  visible: boolean;
  width: string;
  align: "left" | "right";
}

export type NavigationTargetKind = "file" | "folder" | "missing" | "unknown" | "remoteUnsupported";
export type NavigationTargetStatus =
  | "ok"
  | "missing"
  | "permissionDenied"
  | "unsupportedRemote"
  | "invalidPath"
  | "unknownError";
export type NavigationColumnId = "name" | "kind" | "path" | "comment" | "status" | "lastOpened";

export interface NavigationColumnDefinition {
  id: NavigationColumnId;
  label: string;
  visible: boolean;
  width: string;
  align: "left" | "right";
}

export interface NavigationItemUpsertRequest {
  id?: string;
  displayName?: string;
  description: string;
  path: string;
}

export interface NavigationItem {
  id: string;
  displayName: string;
  description: string;
  path: string;
  targetKind: NavigationTargetKind;
  targetStatus: NavigationTargetStatus;
  statusMessage?: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string | null;
}

export interface NavigationTargetInfo {
  path: string;
  normalizedPath?: string | null;
  canonicalPath?: string | null;
  displayName: string;
  targetKind: NavigationTargetKind;
  targetStatus: NavigationTargetStatus;
  message?: string | null;
  exists: boolean;
  isLocal: boolean;
  parentPath?: string | null;
}

export interface NavigationState {
  items: NavigationItem[];
  selectedItemIds: string[];
  /**
   * Shift 区间多选锚点（NavigationItem.id）。纯方向键/点击/重置会清空为 null。
   * 仅内存态，不持久化。
   */
  selectionAnchorId?: string | null;
  /**
   * Shift 区间的光标端 id（与锚点配对），仅在 Shift 区间操作期间维护，纯方向键/点击/重置会清空为 null。
   * 仅内存态。显式记录光标端是为了在区间随光标反向回退时仍能确定上次光标位置。
   */
  selectionCursorId?: string | null;
  filterText: string;
  status: "idle" | "checking" | "saving";
  gitStatusCache: Record<string, Record<string, GitFileStatus>>;
  gitStatusLoadingDirs: string[];
}

export interface ThemeSettings {
  panelFocusAccent: string;
  activeTabBackground: string;
  dropHighlightFill: string;
  dropHighlightBorder: string;
  tabMinWidth: number;
}

export interface ContextMenuSettings {
  defaultMenu: ContextMenuDefault;
}

export interface SortState {
  columnId: ColumnId;
  direction: SortDirection;
}

export interface SettingsModel {
  shortcuts: ShortcutBinding[];
  colorRules: ColorRule[];
  tagRules: TagRule[];
  columns: ColumnDefinition[];
  navigationColumns: NavigationColumnDefinition[];
  detailsRowHeight: number;
  tooltipHoverDelayMs: number;
  metadataRetentionHours: number | null;
  contextMenu: ContextMenuSettings;
  theme: ThemeSettings;
}

export interface ClipboardState {
  mode: "copy" | "cut";
  paths: string[];
}

export type SystemFileClipboard = ClipboardState;

export interface WindowsDragDropEnvironment {
  isElevated: boolean;
  integrityLevel: string;
  explorerToAppDragBlocked: boolean;
  message?: string | null;
}

export interface InlineEditState {
  mode: "create-folder" | "create-file" | "rename";
  value: string;
  kind: EntryKind;
  parentPath: string;
  entryId?: string;
  originalName?: string;
  originalPath?: string;
}

export interface NotificationItem {
  id: string;
  intent: "info" | "success" | "warning" | "danger";
  message: string;
}

export interface ContextMenuState {
  x: number;
  y: number;
  panelId: PanelId;
  tabId: string;
  mode: "custom" | "system-fallback";
  scope: "panel" | "selection" | "tab" | "comment";
  columnId?: ColumnId;
  entryPath?: string;
}

export interface EntryDragPayload {
  sourcePanelId: PanelId;
  sourceTabId: string;
  paths: string[];
}

export type {
  OperationHistoryRecord,
  OperationIntent,
  OperationPathRef,
  OperationTaskSnapshot
};

export interface OperationWorkspaceState {
  tasksOpen: boolean;
  tasks: OperationTaskSnapshot[];
  taskSequence: number;
  history: OperationHistoryRecord[];
  historySequence: number;
}

export type InformationPanelTab = "properties" | "search" | "history";

export type ItemPropertyField =
  | "name"
  | "extension"
  | "kind"
  | "parentPath"
  | "sizeBytes"
  | "allocatedBytes"
  | "createdAt"
  | "modifiedAt"
  | "accessedAt"
  | "attributes"
  | "directorySize";

export type ItemPropertyFieldAvailability =
  | "available"
  | "notAvailable"
  | "unsupported"
  | "permissionDenied"
  | "readFailed"
  | "notComputed"
  | "computing";

export interface ItemPropertyFieldState {
  field: ItemPropertyField;
  state: ItemPropertyFieldAvailability;
  message?: string;
}

export interface DirectorySizeState {
  state: "notApplicable" | "notComputed" | "computing" | "available" | "failed";
  sizeBytes?: number | null;
  message?: string;
}

export type ItemPropertiesTarget =
  | {
      kind: "local";
      path: string;
    }
  | {
      kind: "remote";
      protocol: Exclude<LocationKind, "local" | "virtual">;
      profileId: string;
      remotePath: string;
      displayPath: string;
    };

export interface ItemProperties {
  requestId: string;
  target: ItemPropertiesTarget;
  displayPath: string;
  actualPath: string;
  parentPath?: string | null;
  name: string;
  extension?: string | null;
  kind: EntryKind;
  sizeBytes?: number | null;
  allocatedBytes?: number | null;
  createdAt?: string | null;
  modifiedAt?: string | null;
  accessedAt?: string | null;
  isHidden: boolean;
  isReadOnly: boolean;
  isSymlink: boolean;
  directorySizeState: DirectorySizeState;
  fieldStates: ItemPropertyFieldState[];
  errorMessage?: string | null;
}

export interface MultiSelectionPropertiesSummary {
  selectionKey: string;
  count: number;
  knownSizeBytes: number;
  unknownSizeCount: number;
  directoryCount: number;
  commonParentPath?: string;
  commonKind?: EntryKind;
  commonExtension?: string;
  fieldStates: ItemPropertyFieldState[];
}

export interface PropertiesPanelState {
  requestId?: string;
  targetKey?: string;
  status: "idle" | "loading" | "ready" | "failed";
  item?: ItemProperties;
  summary?: MultiSelectionPropertiesSummary;
  errorMessage?: string;
}

export interface InformationPanelState {
  expanded: boolean;
  activeTab: InformationPanelTab;
  properties: PropertiesPanelState;
}

export interface NativeContextMenuRequest {
  panelId: PanelId;
  tabId: string;
  target?: "selection" | "background";
  paths: string[];
  directoryPath?: string;
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
}

export type NativeBackgroundContextMenuAction =
  | { type: "createFile" }
  | { type: "createFolder" }
  | { type: "setViewMode"; viewMode: TabViewMode }
  | { type: "setSort"; columnId?: ColumnId; direction?: SortDirection }
  | { type: "paste" };

export interface NativeBackgroundContextMenuOptions {
  viewMode: TabViewMode;
  sort: SortState;
  canPaste: boolean;
}

export interface NativeBackgroundContextMenuResult {
  opened: boolean;
  action?: NativeBackgroundContextMenuAction;
}

export type NativeSelectionContextMenuAction =
  | { type: "copyName" }
  | { type: "copyFullPath" }
  | { type: "copyParentPath" }
  | { type: "copyNameWithoutExtension" }
  | { type: "copyExtension" };

export interface NativeSelectionContextMenuShortcuts {
  copyName: string;
  copyFullPath: string;
}

export interface NativeSelectionContextMenuResult {
  opened: boolean;
  action?: NativeSelectionContextMenuAction;
}

export interface WorkspaceWatchRootsRequest {
  directoryPaths: string[];
  navigationParentPaths: string[];
  gitSentinelPaths?: string[];
}

export interface WorkspaceFsChangedEvent {
  roots: string[];
  directoryRoots: string[];
  navigationParentRoots: string[];
  gitChangedRoots?: string[];
  sequence: number;
}

export interface RemoteConnectionProfile {
  id: string;
  name: string;
  protocol: Exclude<LocationKind, "local" | "virtual">;
  host: string;
  port: number;
  username: string;
  rootPath: string;
  authKind: RemoteAuthKind;
  privateKeyPath?: string;
  passiveMode: boolean;
  ignoreHostKey: boolean;
  connectTimeoutSecs: number;
  commandTimeoutSecs: number;
  credentialTarget?: string;
  password?: string;
}

export interface SearchState {
  loading: boolean;
  filterText: string;
  activeTab: SearchTabId;
  query: SearchQuery;
  results: SearchResult[];
  histories: Record<SearchTabId, string[]>;
  history: string[];
  selectedHistoryIndex?: number;
  progress?: SearchProgressState;
}

export interface SearchProgressState {
  searchId?: string;
  scannedEntries: number;
  matchedEntries: number;
  cancelled: boolean;
  statusText: string;
}

export interface SettingsSurfaceState {
  section: SettingsSection;
  model: SettingsModel;
}

export interface FileVisibilityState {
  showHidden: boolean;
  showSystem: boolean;
  hideProtectedOperatingSystemFiles: boolean;
}

export type TabKind = "directory" | "search-results" | "navigation";

export interface SearchTabState {
  sourceTabId?: string;
  sourcePath?: string;
  query: SearchQuery;
  results: SearchResult[];
  progress?: SearchProgressState;
}

export interface TabState {
  id: string;
  title: string;
  titleOverride?: string;
  locked?: boolean;
  kind: TabKind;
  snapshot: DirectorySnapshot;
  addressDraft: string;
  history: string[];
  historyIndex: number;
  selectedEntryIds: string[];
  /**
   * Shift 区间选中的锚点条目 id。仅在按下 Shift 进行区间多选时确立，
   * 纯方向键/点击/进入新目录会复位为 null。仅内存态（不参与会话持久化）。
   * 用 id 而非 index，避免在排序/筛选变动导致 ordered 顺序变化时锚点漂移。
   */
  selectionAnchorId?: string | null;
  /**
   * Shift 区间的光标端条目 id（与锚点配对使用）。仅在 Shift 区间操作期间维护，
   * 纯方向键/点击/进入新目录会复位为 null。仅内存态。显式记录光标端是为了在
   * "区间随光标在锚点两侧反向回退"时仍能确定上次光标位置（仅靠 selectedEntryIds
   * 的末项无法推断光标端方向）。
   */
  selectionCursorId?: string | null;
  expandedNodePaths: string[];
  viewMode: TabViewMode;
  sort: SortState;
  columns: ColumnDefinition[];
  status: "ready" | "loading" | "reconnect-required";
  virtualPath?: "navigation://shortcuts";
  inlineEdit?: InlineEditState;
  search?: SearchTabState;
  gitStatus?: Record<string, GitFileStatus>;
  reconnect?: {
    path: string;
    profileId?: string;
    message?: string;
  };
}

export interface PanelState {
  id: PanelId;
  label: string;
  tabs: TabState[];
  activeTabId: string;
}

export interface LayoutRatios {
  primary: number;
  tripleSecondary: number;
  quadLeftSecondary: number;
  quadRightSecondary: number;
  tree: number;
  search: number;
}

export interface WorkspaceBootstrap {
  source: DataSource;
  layoutMode: PanelLayoutMode;
  layoutRatios: LayoutRatios;
  treeVisible: boolean;
  informationPanel: InformationPanelState;
  panels: Record<PanelId, PanelState>;
  activePanelId: PanelId;
  directoryTree: DirectoryNode[];
  bookmarks: BookmarkItem[];
  hotlist: BookmarkItem[];
  navigationItems: NavigationItem[];
  remoteProfiles: RemoteConnectionProfile[];
  settingsModel: SettingsModel;
}

export interface WorkspaceState {
  status: "loading" | "ready";
  source: DataSource;
  layoutMode: PanelLayoutMode;
  layoutRatios: LayoutRatios;
  treeVisible: boolean;
  fileVisibility: FileVisibilityState;
  syncScroll: boolean;
  panels: Record<PanelId, PanelState>;
  activePanelId: PanelId;
  directoryTree: DirectoryNode[];
  bookmarks: BookmarkItem[];
  hotlist: BookmarkItem[];
  navigation: NavigationState;
  remoteProfiles: RemoteConnectionProfile[];
  search: SearchState;
  informationPanel: InformationPanelState;
  settings: SettingsSurfaceState;
  clipboard?: ClipboardState;
  notifications: NotificationItem[];
  contextMenu?: ContextMenuState;
  operations: OperationWorkspaceState;
  keyboardNavToken?: symbol;
}

import type {
  ConflictResolutionKind,
  OperationConflictRequest,
  OperationHistoryRecord,
  OperationIntent,
  OperationPathRef,
  OperationTaskSnapshot
} from "../../app/types";

export type DataSource = "mock" | "tauri";
export type PanelLayoutMode = "single" | "dual" | "triple" | "quad";
export type PanelId = "panel-1" | "panel-2" | "panel-3" | "panel-4";
export type SettingsSection = "shortcuts" | "theme" | "rules" | "connections";
export type LocationKind = "local" | "ftp" | "sftp" | "virtual";
export type EntryKind = "file" | "folder";
export type ColumnId = "name" | "type" | "size" | "modified" | "tags" | "location";
export type ShortcutScope = "workspace" | "panel" | "listing";
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
  modifiedLabel: string;
  extension: string;
  attributes: string[];
  accentColor: string;
  tags: string[];
  description: string;
  contentText?: string;
}

export interface DirectorySnapshot {
  location: LocationDescriptor;
  breadcrumbs: BreadcrumbItem[];
  entries: EntryViewModel[];
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
  filterText: string;
  status: "idle" | "checking" | "saving";
}

export interface ThemeSettings {
  panelFocusAccent: string;
  tabMinWidth: number;
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
  detailsRowHeight: number;
  theme: ThemeSettings;
}

export interface ClipboardState {
  mode: "copy" | "cut";
  paths: string[];
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
  scope: "panel" | "selection" | "tab";
}

export interface EntryDragPayload {
  sourcePanelId: PanelId;
  sourceTabId: string;
  paths: string[];
}

export type {
  ConflictResolutionKind,
  OperationConflictRequest,
  OperationHistoryRecord,
  OperationIntent,
  OperationPathRef,
  OperationTaskSnapshot
};

export interface OperationConflictDialogState {
  request: OperationConflictRequest;
  renameValue: string;
  selectedResolution: ConflictResolutionKind;
  applyToAll: boolean;
  resolving: boolean;
}

export interface OperationWorkspaceState {
  tasksOpen: boolean;
  tasks: OperationTaskSnapshot[];
  taskSequence: number;
  history: OperationHistoryRecord[];
  historySequence: number;
  conflictDialog?: OperationConflictDialogState;
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
  paths: string[];
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
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
  expandedNodePaths: string[];
  viewMode: TabViewMode;
  sort: SortState;
  columns: ColumnDefinition[];
  status: "ready" | "loading" | "reconnect-required";
  virtualPath?: "navigation://shortcuts";
  inlineEdit?: InlineEditState;
  search?: SearchTabState;
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
}

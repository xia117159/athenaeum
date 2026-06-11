export type PanelLayoutMode = "single" | "dual" | "triple" | "quad";
export type LocationKind = "local" | "ftp" | "sftp";
export type EntryKind = "file" | "directory";

export interface LocationDescriptor {
  kind: LocationKind;
  path: string;
  connectionId?: string | null;
}

export interface EntryDecoration {
  colorHex?: string | null;
  tags: string[];
}

export interface EntryViewModel {
  path: string;
  name: string;
  extension?: string | null;
  kind: EntryKind;
  size?: number | null;
  modifiedAt?: string | null;
  isHidden: boolean;
  isReadOnly: boolean;
  isSymlink: boolean;
  location: LocationDescriptor;
  decoration: EntryDecoration;
}

export interface DirectoryListing {
  location: LocationDescriptor;
  entries: EntryViewModel[];
  parent?: string | null;
  canGoUp: boolean;
}

export interface TreeNode {
  path: string;
  name: string;
  hasChildren: boolean;
}

export interface DriveInfo {
  path: string;
  label: string;
}

export interface Bookmark {
  id: string;
  name: string;
  path: string;
}

export interface HotlistEntry {
  id: string;
  name: string;
  path: string;
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

export interface TagDefinition {
  id: string;
  name: string;
  colorHex: string;
}

export interface EntryTag {
  path: string;
  tagIds: string[];
}

export interface ColorRule {
  id: string;
  name: string;
  target: "any" | "file" | "directory";
  mode: "extension" | "nameContains" | "pathContains" | "hidden" | "readOnly";
  pattern?: string | null;
  colorHex: string;
  priority: number;
}

export interface UiLayout {
  layoutMode: PanelLayoutMode;
  panelProportions: number[];
  sidebarWidth: number;
  showTree: boolean;
  showSearch: boolean;
}

export interface UiTheme {
  panelFocusAccent: string;
  tabMinWidth: number;
}

export interface ShortcutBinding {
  id: string;
  action: string;
  accelerator: string;
  scope: string;
}

export type RemoteAuthKind = "password" | "keyFile" | "anonymous";

export interface RemoteProfile {
  id: string;
  name: string;
  protocol: LocationKind;
  host: string;
  port: number;
  username: string;
  rootPath: string;
  authKind?: RemoteAuthKind;
  privateKeyPath?: string | null;
  passiveMode?: boolean;
  ignoreHostKey?: boolean;
  connectTimeoutSecs?: number;
  commandTimeoutSecs?: number;
}

export interface RemoteProfileUpsertRequest {
  profile: RemoteProfile;
  password?: string | null;
}

export interface RemoteTestResult {
  success: boolean;
  message: string;
  adapter: "curl" | "sftp" | "unsupported";
  details: string[];
}

export interface RemoteHostKeyInfo {
  profileId: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprintSha256: string;
  keyBase64: string;
  knownHostsEntry: string;
  trustState: "trusted" | "unknown" | "mismatch";
}

export interface RemoteTrustHostKeyRequest {
  profileId: string;
  host: string;
  port: number;
  algorithm: string;
  keyBase64: string;
}

export interface SettingsSnapshot {
  bookmarks: Bookmark[];
  hotlist: HotlistEntry[];
  navigationItems?: NavigationItem[];
  tagDefinitions: TagDefinition[];
  entryTags: EntryTag[];
  colorRules: ColorRule[];
  shortcuts: ShortcutBinding[];
  detailsRowHeight: number;
  theme?: UiTheme;
  layout: UiLayout;
  remoteProfiles: RemoteProfile[];
}

export interface SettingsModelUpdate {
  shortcuts: ShortcutBinding[];
  colorRules: ColorRule[];
  detailsRowHeight: number;
  theme: UiTheme;
}

export interface WorkspaceBootstrap {
  drives: DriveInfo[];
  initialPath: string;
  initialListing: DirectoryListing;
  settings: SettingsSnapshot;
}

export interface SearchQuery {
  searchId?: string;
  roots: string[];
  namePattern?: string | null;
  contentPattern?: string | null;
  nameMode: SearchContentMode;
  contentMode: SearchContentMode;
  extensions: string[];
  extensionFilterMode: SearchExtensionFilterMode;
  includeFolders: boolean;
  recursive: boolean;
  includeHidden: boolean;
  caseSensitive: boolean;
  maxFileSizeBytes?: number | null;
}

export type SearchContentMode = "normal" | "wildcard" | "regex";
export type SearchExtensionFilterMode = "include" | "exclude";

export interface SearchResult {
  searchId: string;
  path: string;
  name: string;
  parent: string;
  isDirectory: boolean;
  matchedOn: string[];
  excerpt?: string | null;
}

export interface SearchProgress {
  searchId: string;
  scannedEntries: number;
  matchedEntries: number;
}

export interface SearchFinished extends SearchProgress {
  cancelled: boolean;
}

export type OperationIntentKind = "copy" | "move" | "delete" | "rename" | "createDirectory" | "createFile" | "undo";
export type OperationRequestSource = "toolbar" | "contextMenu" | "shortcut" | "dragDrop" | "paste" | "inlineEdit";

export type OperationPathRef =
  | { kind: "local"; path: string }
  | { kind: "remote"; profileId: string; remotePath: string; protocol: "ftp" | "sftp" };

export type ConflictResolutionKind = "replace" | "skip" | "keepBoth" | "rename" | "mergeDirectory";

export interface ConflictPolicy {
  defaultResolution?: "ask" | "skip" | "keepBoth" | null;
  allowApplyToAll: boolean;
}

export interface OperationIntent {
  requestId: string;
  source: OperationRequestSource;
  panelId?: string | null;
  tabId?: string | null;
  kind: OperationIntentKind;
  sources?: OperationPathRef[] | null;
  destination?: OperationPathRef | null;
  sourcePath?: OperationPathRef | null;
  newName?: string | null;
  parent?: OperationPathRef | null;
  name?: string | null;
  undoRecordId?: string | null;
  conflictPolicy?: ConflictPolicy | null;
}

export type OperationTaskStatus =
  | "queued"
  | "scanning"
  | "running"
  | "waitingConflict"
  | "cancelling"
  | "cancelled"
  | "succeeded"
  | "failed"
  | "partialSucceeded";

export interface OperationTaskSnapshot {
  taskId: string;
  requestId: string;
  kind: OperationIntentKind;
  label: string;
  status: OperationTaskStatus;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  totalEntries?: number | null;
  completedEntries: number;
  failedEntries: number;
  totalBytes?: number | null;
  completedBytes?: number | null;
  currentPath?: string | null;
  message?: string | null;
  cancelable: boolean;
  undoable: boolean;
  affectedRoots: OperationPathRef[];
  entryResults: OperationEntryResult[];
  sequence: number;
  updatedAt: string;
}

export interface OperationTaskListSnapshot {
  tasks: OperationTaskSnapshot[];
  taskSequence: number;
}

export interface OperationTaskEventEnvelope {
  taskId: string;
  sequence: number;
  updatedAt: string;
  snapshot: OperationTaskSnapshot;
}

export interface OperationConflictRequest {
  conflictId: string;
  taskId: string;
  createdAt: string;
  source?: OperationPathRef | null;
  destination: OperationPathRef;
  existingKind: "file" | "directory" | "unknown";
  incomingKind: "file" | "directory" | "unknown";
  suggestedName?: string | null;
  allowedResolutions: ConflictResolutionKind[];
  message: string;
}

export interface OperationConflictResolution {
  conflictId: string;
  resolution: ConflictResolutionKind;
  newName?: string | null;
  applyToAll: boolean;
}

export interface OperationEntryResult {
  entryResultId: string;
  source?: OperationPathRef | null;
  destination?: OperationPathRef | null;
  kind: "created" | "moved" | "trashed" | "deleted" | "renamed" | "skipped" | "failed";
  error?: OperationError | null;
}

export interface OperationError {
  code:
    | "notFound"
    | "permissionDenied"
    | "alreadyExists"
    | "invalidPath"
    | "fileInUse"
    | "cancelled"
    | "conflictUnresolved"
    | "remoteUnsupported"
    | "ioError"
    | "unknown";
  message: string;
  path?: OperationPathRef | null;
  retryable: boolean;
  source: "localFs" | "remoteFs" | "taskService" | "journalStore" | "trashService";
}

export type OperationHistoryStatus =
  | "undoable"
  | "undoing"
  | "undone"
  | "expired"
  | "blocked"
  | "failed"
  | "notUndoable"
  | "pendingConfirmation";

export interface OperationHistoryRecord {
  recordId: string;
  taskId: string;
  kind: OperationIntentKind;
  label: string;
  status: OperationHistoryStatus;
  createdAt: string;
  updatedAt: string;
  undoTaskId?: string | null;
  blockedReason?: string | null;
  payloadExpiresAt?: string | null;
  affectedRoots: OperationPathRef[];
}

export interface OperationHistoryListSnapshot {
  records: OperationHistoryRecord[];
  historySequence: number;
}

export interface OperationHistoryEventEnvelope {
  record: OperationHistoryRecord;
  historySequence: number;
}

export interface TabState {
  id: string;
  title: string;
  path: string;
  listing: DirectoryListing;
  history: string[];
  historyIndex: number;
  selectedPaths: string[];
}

export interface PanelState {
  id: string;
  tabs: TabState[];
  activeTabId: string;
}

export interface ClipboardState {
  mode: "copy" | "cut";
  paths: string[];
}

export interface SearchViewState {
  namePattern: string;
  contentPattern: string;
  extensions: string;
  nameMode: SearchContentMode;
  contentMode: SearchContentMode;
  extensionFilterMode: SearchExtensionFilterMode;
  includeFolders: boolean;
  recursive: boolean;
  includeHidden: boolean;
  running: boolean;
  results: SearchResult[];
}

export interface NotificationItem {
  id: string;
  intent: "info" | "success" | "warning" | "danger";
  message: string;
}

export interface ContextMenuState {
  x: number;
  y: number;
  paths: string[];
  mode: "custom" | "system-fallback";
}

export interface WorkspaceState {
  ready: boolean;
  drives: DriveInfo[];
  layout: UiLayout;
  panels: PanelState[];
  activePanelId: string;
  bookmarks: Bookmark[];
  hotlist: HotlistEntry[];
  tagDefinitions: TagDefinition[];
  colorRules: ColorRule[];
  shortcuts: ShortcutBinding[];
  remoteProfiles: RemoteProfile[];
  tree: Record<string, TreeNode[]>;
  expandedTreeNodes: string[];
  search: SearchViewState;
  clipboard?: ClipboardState;
  notifications: NotificationItem[];
  settingsOpen: boolean;
  contextMenu?: ContextMenuState;
  error?: string;
}

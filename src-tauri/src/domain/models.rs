use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

mod remote;
mod settings;

pub use remote::*;
pub use settings::*;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PanelLayoutMode {
    Single,
    Dual,
    Triple,
    Quad,
}

impl Default for PanelLayoutMode {
    fn default() -> Self {
        Self::Dual
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LocationKind {
    Local,
    Ftp,
    Sftp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocationDescriptor {
    pub kind: LocationKind,
    pub path: String,
    pub connection_id: Option<String>,
}

impl LocationDescriptor {
    pub fn local(path: impl Into<String>) -> Self {
        Self {
            kind: LocationKind::Local,
            path: path.into(),
            connection_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EntryDecoration {
    pub color_hex: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EntryViewModel {
    pub path: String,
    pub name: String,
    pub extension: Option<String>,
    pub kind: EntryKind,
    pub size: Option<u64>,
    pub created_at: Option<DateTime<Utc>>,
    pub modified_at: Option<DateTime<Utc>>,
    pub accessed_at: Option<DateTime<Utc>>,
    pub is_hidden: bool,
    pub is_system: bool,
    pub is_protected_operating_system: bool,
    pub is_read_only: bool,
    pub is_symlink: bool,
    pub location: LocationDescriptor,
    pub decoration: EntryDecoration,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub location: LocationDescriptor,
    pub entries: Vec<EntryViewModel>,
    pub parent: Option<String>,
    pub can_go_up: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWatchRootsRequest {
    #[serde(default)]
    pub directory_paths: Vec<String>,
    #[serde(default)]
    pub navigation_parent_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFsChangedEvent {
    pub roots: Vec<String>,
    pub directory_roots: Vec<String>,
    pub navigation_parent_roots: Vec<String>,
    pub sequence: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ItemPropertyField {
    Name,
    Extension,
    Kind,
    ParentPath,
    SizeBytes,
    AllocatedBytes,
    CreatedAt,
    ModifiedAt,
    AccessedAt,
    Attributes,
    DirectorySize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ItemPropertyFieldAvailability {
    Available,
    NotAvailable,
    Unsupported,
    PermissionDenied,
    ReadFailed,
    NotComputed,
    Computing,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ItemPropertyFieldState {
    pub field: ItemPropertyField,
    pub state: ItemPropertyFieldAvailability,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DirectorySizeAvailability {
    NotApplicable,
    NotComputed,
    Computing,
    Available,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySizeState {
    pub state: DirectorySizeAvailability,
    pub size_bytes: Option<u64>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ItemPropertiesTarget {
    Local {
        path: String,
    },
    Remote {
        protocol: LocationKind,
        profile_id: String,
        remote_path: String,
        display_path: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ItemPropertiesRequest {
    pub request_id: String,
    pub target: ItemPropertiesTarget,
    #[serde(default)]
    pub include_directory_size: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ItemProperties {
    pub request_id: String,
    pub target: ItemPropertiesTarget,
    pub display_path: String,
    pub actual_path: String,
    pub parent_path: Option<String>,
    pub name: String,
    pub extension: Option<String>,
    pub kind: EntryKind,
    pub size_bytes: Option<u64>,
    pub allocated_bytes: Option<u64>,
    pub created_at: Option<DateTime<Utc>>,
    pub modified_at: Option<DateTime<Utc>>,
    pub accessed_at: Option<DateTime<Utc>>,
    pub is_hidden: bool,
    pub is_read_only: bool,
    pub is_symlink: bool,
    pub directory_size_state: DirectorySizeState,
    pub field_states: Vec<ItemPropertyFieldState>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub path: String,
    pub name: String,
    pub has_children: bool,
    pub is_hidden: bool,
    pub is_system: bool,
    pub is_protected_operating_system: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FileSystemIconKind {
    File,
    Folder,
    Drive,
    RemoteRoot,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SystemIconImageList {
    SysSmall,
    Small,
    Large,
    ExtraLarge,
    Jumbo,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SystemIconRequest {
    pub kind: FileSystemIconKind,
    pub path: Option<String>,
    pub extension: Option<String>,
    pub size: u32,
    #[serde(default)]
    pub image_list: Option<SystemIconImageList>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SystemIconBitmap {
    pub width: u32,
    pub height: u32,
    pub rgba_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    pub path: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HotlistEntry {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NavigationTargetKind {
    File,
    Folder,
    Missing,
    Unknown,
    RemoteUnsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NavigationTargetStatus {
    Ok,
    Missing,
    PermissionDenied,
    UnsupportedRemote,
    InvalidPath,
    UnknownError,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NavigationItemUpsertRequest {
    pub id: Option<String>,
    pub display_name: Option<String>,
    pub description: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NavigationItem {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub path: String,
    pub target_kind: NavigationTargetKind,
    pub target_status: NavigationTargetStatus,
    pub status_message: Option<String>,
    pub sort_order: u32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub last_opened_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NavigationTargetInfo {
    pub path: String,
    pub normalized_path: Option<String>,
    pub canonical_path: Option<String>,
    pub display_name: String,
    pub target_kind: NavigationTargetKind,
    pub target_status: NavigationTargetStatus,
    pub message: Option<String>,
    pub exists: bool,
    pub is_local: bool,
    pub parent_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TagDefinition {
    pub id: String,
    pub name: String,
    pub color_hex: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EntryTag {
    pub path: String,
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ColorRuleTarget {
    Any,
    File,
    Directory,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ColorRuleMode {
    Extension,
    NameContains,
    PathContains,
    Hidden,
    ReadOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ColorRule {
    pub id: String,
    pub name: String,
    pub target: ColorRuleTarget,
    pub mode: ColorRuleMode,
    pub pattern: Option<String>,
    pub color_hex: String,
    pub priority: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UiLayout {
    pub layout_mode: PanelLayoutMode,
    pub panel_proportions: Vec<f32>,
    pub sidebar_width: f32,
    pub show_tree: bool,
    pub show_search: bool,
}

impl UiLayout {
    pub fn fallback() -> Self {
        Self {
            layout_mode: PanelLayoutMode::Dual,
            panel_proportions: vec![0.5, 0.5],
            sidebar_width: 280.0,
            show_tree: true,
            show_search: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UiTheme {
    pub panel_focus_accent: String,
    #[serde(default = "default_active_tab_background")]
    pub active_tab_background: String,
    #[serde(default = "default_drop_highlight_color")]
    pub drop_highlight_fill: String,
    #[serde(default = "default_drop_highlight_color")]
    pub drop_highlight_border: String,
    #[serde(default = "default_tab_min_width")]
    pub tab_min_width: u32,
}

impl Default for UiTheme {
    fn default() -> Self {
        Self {
            panel_focus_accent: "#0f6cbd".into(),
            active_tab_background: default_active_tab_background(),
            drop_highlight_fill: default_drop_highlight_color(),
            drop_highlight_border: default_drop_highlight_color(),
            tab_min_width: default_tab_min_width(),
        }
    }
}

fn default_active_tab_background() -> String {
    "#ffffff".into()
}

fn default_drop_highlight_color() -> String {
    "#0f6cbd".into()
}

fn default_tab_min_width() -> u32 {
    96
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ContextMenuDefaultMenu {
    Native,
    Custom,
}

impl Default for ContextMenuDefaultMenu {
    fn default() -> Self {
        Self::Native
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContextMenuSettings {
    #[serde(default)]
    pub default_menu: ContextMenuDefaultMenu,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum NativeBackgroundContextMenuViewMode {
    ExtraLargeIcons,
    LargeIcons,
    MediumIcons,
    SmallIcons,
    List,
    Details,
    Tiles,
    Content,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NativeBackgroundContextMenuSortColumn {
    Name,
    Modified,
    Type,
    Size,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NativeBackgroundContextMenuSortDirection {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeBackgroundContextMenuSortState {
    pub column_id: NativeBackgroundContextMenuSortColumn,
    pub direction: NativeBackgroundContextMenuSortDirection,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeBackgroundContextMenuOptions {
    pub view_mode: NativeBackgroundContextMenuViewMode,
    pub sort: NativeBackgroundContextMenuSortState,
    pub can_paste: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum NativeBackgroundContextMenuAction {
    CreateFile,
    CreateFolder,
    SetViewMode {
        #[serde(rename = "viewMode")]
        view_mode: NativeBackgroundContextMenuViewMode,
    },
    SetSort {
        #[serde(rename = "columnId")]
        #[serde(skip_serializing_if = "Option::is_none")]
        column_id: Option<NativeBackgroundContextMenuSortColumn>,
        #[serde(skip_serializing_if = "Option::is_none")]
        direction: Option<NativeBackgroundContextMenuSortDirection>,
    },
    Paste,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeBackgroundContextMenuResult {
    pub opened: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<NativeBackgroundContextMenuAction>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SystemFileClipboardMode {
    Copy,
    Cut,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SystemFileClipboard {
    pub mode: SystemFileClipboardMode,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SystemFileOperationKind {
    Copy,
    Move,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SystemFileOperationRequest {
    pub sources: Vec<String>,
    pub destination: String,
    pub operation: SystemFileOperationKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowsDragDropEnvironment {
    pub is_elevated: bool,
    pub integrity_level: String,
    pub explorer_to_app_drag_blocked: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutBinding {
    pub id: String,
    pub action: String,
    pub accelerator: String,
    pub scope: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowsShellContract {
    pub native_context_menu_supported: bool,
    pub custom_context_menu_supported: bool,
    pub ctrl_right_click_custom_menu: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SearchContentMode {
    Normal,
    Wildcard,
    Regex,
}

impl Default for SearchContentMode {
    fn default() -> Self {
        Self::Normal
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionFilterMode {
    Include,
    Exclude,
}

impl Default for ExtensionFilterMode {
    fn default() -> Self {
        Self::Include
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub search_id: Option<String>,
    pub roots: Vec<String>,
    pub name_pattern: Option<String>,
    pub content_pattern: Option<String>,
    #[serde(default)]
    pub name_mode: SearchContentMode,
    #[serde(default)]
    pub content_mode: SearchContentMode,
    #[serde(default)]
    pub extensions: Vec<String>,
    #[serde(default)]
    pub extension_filter_mode: ExtensionFilterMode,
    #[serde(default)]
    pub include_folders: bool,
    #[serde(default = "default_search_recursive")]
    pub recursive: bool,
    pub include_hidden: bool,
    pub case_sensitive: bool,
    pub max_file_size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub search_id: String,
    pub path: String,
    pub name: String,
    pub parent: String,
    pub is_directory: bool,
    pub matched_on: Vec<String>,
    pub excerpt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchTaskStarted {
    pub search_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchFinished {
    pub search_id: String,
    pub cancelled: bool,
    pub scanned_entries: usize,
    pub matched_entries: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OperationIntentKind {
    Copy,
    Move,
    Delete,
    Rename,
    CreateDirectory,
    CreateFile,
    Undo,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OperationRequestSource {
    Toolbar,
    ContextMenu,
    Shortcut,
    DragDrop,
    Paste,
    InlineEdit,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum OperationPathRef {
    Local {
        path: String,
    },
    Remote {
        profile_id: String,
        remote_path: String,
        protocol: LocationKind,
    },
}

impl OperationPathRef {
    pub fn local_path(&self) -> Option<&str> {
        match self {
            OperationPathRef::Local { path } => Some(path),
            OperationPathRef::Remote { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConflictDefaultResolution {
    Ask,
    Skip,
    KeepBoth,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictPolicy {
    pub default_resolution: Option<ConflictDefaultResolution>,
    pub allow_apply_to_all: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationIntent {
    pub request_id: String,
    pub source: OperationRequestSource,
    pub panel_id: Option<String>,
    pub tab_id: Option<String>,
    pub kind: OperationIntentKind,
    pub sources: Option<Vec<OperationPathRef>>,
    pub destination: Option<OperationPathRef>,
    pub source_path: Option<OperationPathRef>,
    pub new_name: Option<String>,
    pub parent: Option<OperationPathRef>,
    pub name: Option<String>,
    pub undo_record_id: Option<String>,
    pub conflict_policy: Option<ConflictPolicy>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OperationTaskStatus {
    Queued,
    Scanning,
    Running,
    WaitingConflict,
    Cancelling,
    Cancelled,
    Succeeded,
    Failed,
    PartialSucceeded,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OperationErrorCode {
    NotFound,
    PermissionDenied,
    AlreadyExists,
    InvalidPath,
    FileInUse,
    Cancelled,
    ConflictUnresolved,
    RemoteUnsupported,
    IoError,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OperationErrorSource {
    LocalFs,
    RemoteFs,
    TaskService,
    JournalStore,
    TrashService,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationError {
    pub code: OperationErrorCode,
    pub message: String,
    pub path: Option<OperationPathRef>,
    pub retryable: bool,
    pub source: OperationErrorSource,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OperationEntryResultKind {
    Created,
    Moved,
    Trashed,
    Deleted,
    Renamed,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationEntryResult {
    pub entry_result_id: String,
    pub source: Option<OperationPathRef>,
    pub destination: Option<OperationPathRef>,
    pub kind: OperationEntryResultKind,
    pub error: Option<OperationError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationTaskSnapshot {
    pub task_id: String,
    pub request_id: String,
    pub kind: OperationIntentKind,
    pub label: String,
    pub status: OperationTaskStatus,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub total_entries: Option<usize>,
    pub completed_entries: usize,
    pub failed_entries: usize,
    pub total_bytes: Option<u64>,
    pub completed_bytes: Option<u64>,
    pub current_path: Option<String>,
    pub message: Option<String>,
    pub cancelable: bool,
    pub undoable: bool,
    pub affected_roots: Vec<OperationPathRef>,
    pub entry_results: Vec<OperationEntryResult>,
    pub sequence: u64,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationTaskListSnapshot {
    pub tasks: Vec<OperationTaskSnapshot>,
    pub task_sequence: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationTaskEventEnvelope {
    pub task_id: String,
    pub sequence: u64,
    pub updated_at: DateTime<Utc>,
    pub snapshot: OperationTaskSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OperationEntryKindSnapshot {
    File,
    Directory,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConflictResolutionKind {
    Replace,
    Skip,
    KeepBoth,
    Rename,
    MergeDirectory,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationConflictRequest {
    pub conflict_id: String,
    pub task_id: String,
    pub created_at: DateTime<Utc>,
    pub source: Option<OperationPathRef>,
    pub destination: OperationPathRef,
    pub existing_kind: OperationEntryKindSnapshot,
    pub incoming_kind: OperationEntryKindSnapshot,
    pub suggested_name: Option<String>,
    pub allowed_resolutions: Vec<ConflictResolutionKind>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationConflictResolution {
    pub conflict_id: String,
    pub resolution: ConflictResolutionKind,
    pub new_name: Option<String>,
    pub apply_to_all: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OperationHistoryStatus {
    Undoable,
    Undoing,
    Undone,
    Expired,
    Blocked,
    Failed,
    NotUndoable,
    PendingConfirmation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationHistoryRecord {
    pub record_id: String,
    pub task_id: String,
    pub kind: OperationIntentKind,
    pub label: String,
    pub status: OperationHistoryStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub undo_task_id: Option<String>,
    pub blocked_reason: Option<String>,
    pub payload_expires_at: Option<DateTime<Utc>>,
    pub affected_roots: Vec<OperationPathRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationHistoryListSnapshot {
    pub records: Vec<OperationHistoryRecord>,
    pub history_sequence: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationHistoryEventEnvelope {
    pub record: OperationHistoryRecord,
    pub history_sequence: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchProgress {
    pub search_id: String,
    pub scanned_entries: usize,
    pub matched_entries: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBootstrap {
    pub drives: Vec<DriveInfo>,
    pub initial_path: String,
    pub initial_listing: DirectoryListing,
    pub settings: SettingsSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileOperationRequest {
    pub sources: Vec<String>,
    pub destination: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenameRequest {
    pub source: String,
    pub new_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateDirectoryRequest {
    pub parent: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateFileRequest {
    pub parent: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub affected_paths: Vec<String>,
}

fn default_search_recursive() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::{
        NativeBackgroundContextMenuAction, NativeBackgroundContextMenuResult,
        NativeBackgroundContextMenuSortColumn, NativeBackgroundContextMenuSortDirection,
        NativeBackgroundContextMenuViewMode, NavigationItem, NavigationItemUpsertRequest,
        NavigationTargetInfo, NavigationTargetKind, NavigationTargetStatus, RemoteHostKeyInfo,
        RemoteHostKeyTrustState, RemoteTransferOperation, RemoteTransferRequest,
        RemoteTrustHostKeyRequest, UiTheme, WindowsDragDropEnvironment, WorkspaceFsChangedEvent,
    };

    #[test]
    fn remote_transfer_request_uses_camel_case_contract_fields() {
        let request: RemoteTransferRequest = serde_json::from_str(
            r#"{
        "operation": "move",
        "sourceProfileId": "remote-a",
        "sourcePassword": null,
        "destinationProfileId": "remote-b",
        "destinationPassword": "secret",
        "sources": ["/root/report.txt"],
        "destination": "/inbox"
      }"#,
        )
        .expect("transfer request should deserialize");

        assert_eq!(request.operation, RemoteTransferOperation::Move);
        assert_eq!(request.source_profile_id, "remote-a");
        assert_eq!(request.destination_profile_id, "remote-b");
        assert_eq!(request.destination_password.as_deref(), Some("secret"));
        assert_eq!(request.sources, vec!["/root/report.txt"]);
        assert_eq!(request.destination, "/inbox");
    }

    #[test]
    fn remote_host_key_contract_uses_camel_case_fields() {
        let info = RemoteHostKeyInfo {
            profile_id: "remote-a".into(),
            host: "192.168.1.12".into(),
            port: 6666,
            algorithm: "ssh-ed25519".into(),
            fingerprint_sha256: "SHA256:abc".into(),
            key_base64: "AAAA".into(),
            known_hosts_entry: "[192.168.1.12]:6666 ssh-ed25519 AAAA".into(),
            trust_state: RemoteHostKeyTrustState::Unknown,
        };

        let value = serde_json::to_value(&info).expect("host key info should serialize");
        assert_eq!(value["profileId"], "remote-a");
        assert_eq!(value["fingerprintSha256"], "SHA256:abc");
        assert_eq!(value["keyBase64"], "AAAA");
        assert_eq!(
            value["knownHostsEntry"],
            "[192.168.1.12]:6666 ssh-ed25519 AAAA"
        );
        assert_eq!(value["trustState"], "unknown");

        let request: RemoteTrustHostKeyRequest = serde_json::from_str(
            r#"{
        "profileId": "remote-a",
        "host": "192.168.1.12",
        "port": 6666,
        "algorithm": "ssh-ed25519",
        "keyBase64": "AAAA"
      }"#,
        )
        .expect("trust host key request should deserialize");

        assert_eq!(request.profile_id, "remote-a");
        assert_eq!(request.key_base64, "AAAA");
    }

    #[test]
    fn ui_theme_contract_uses_camel_case_focus_accent() {
        let theme = UiTheme {
            panel_focus_accent: "#c02f7a80".into(),
            active_tab_background: "#ffffffcc".into(),
            drop_highlight_fill: "#1f9d5566".into(),
            drop_highlight_border: "#b91c1c40".into(),
            tab_min_width: 132,
        };

        let value = serde_json::to_value(&theme).expect("theme should serialize");

        assert_eq!(value["panelFocusAccent"], "#c02f7a80");
        assert_eq!(value["activeTabBackground"], "#ffffffcc");
        assert_eq!(value["dropHighlightFill"], "#1f9d5566");
        assert_eq!(value["dropHighlightBorder"], "#b91c1c40");
        assert_eq!(value["tabMinWidth"], 132);
    }

    #[test]
    fn native_background_context_menu_result_uses_frontend_action_contract() {
        let view_result = NativeBackgroundContextMenuResult {
            opened: true,
            action: Some(NativeBackgroundContextMenuAction::SetViewMode {
                view_mode: NativeBackgroundContextMenuViewMode::Tiles,
            }),
        };
        let view_value =
            serde_json::to_value(&view_result).expect("native action result should serialize");

        assert_eq!(view_value["opened"], true);
        assert_eq!(view_value["action"]["type"], "setViewMode");
        assert_eq!(view_value["action"]["viewMode"], "tiles");

        let sort_result = NativeBackgroundContextMenuResult {
            opened: true,
            action: Some(NativeBackgroundContextMenuAction::SetSort {
                column_id: Some(NativeBackgroundContextMenuSortColumn::Size),
                direction: Some(NativeBackgroundContextMenuSortDirection::Desc),
            }),
        };
        let sort_value =
            serde_json::to_value(&sort_result).expect("native sort action should serialize");

        assert_eq!(sort_value["action"]["type"], "setSort");
        assert_eq!(sort_value["action"]["columnId"], "size");
        assert_eq!(sort_value["action"]["direction"], "desc");
    }

    #[test]
    fn windows_drag_drop_environment_uses_camel_case_contract_fields() {
        let environment = WindowsDragDropEnvironment {
            is_elevated: true,
            integrity_level: "high".into(),
            explorer_to_app_drag_blocked: true,
            message: Some("Explorer file drops are blocked while elevated.".into()),
        };

        let value = serde_json::to_value(&environment).expect("environment should serialize");

        assert_eq!(value["isElevated"], true);
        assert_eq!(value["integrityLevel"], "high");
        assert_eq!(value["explorerToAppDragBlocked"], true);
        assert_eq!(
            value["message"],
            "Explorer file drops are blocked while elevated."
        );
    }

    #[test]
    fn navigation_item_contract_uses_camel_case_fields() {
        let item = NavigationItem {
            id: "nav-1".into(),
            display_name: "Docs".into(),
            description: "Pinned docs".into(),
            path: "C:\\Docs".into(),
            target_kind: NavigationTargetKind::Folder,
            target_status: NavigationTargetStatus::Ok,
            status_message: None,
            sort_order: 2,
            created_at: chrono::DateTime::parse_from_rfc3339("2026-06-08T09:00:00Z")
                .unwrap()
                .with_timezone(&chrono::Utc),
            updated_at: chrono::DateTime::parse_from_rfc3339("2026-06-08T09:05:00Z")
                .unwrap()
                .with_timezone(&chrono::Utc),
            last_opened_at: None,
        };

        let value = serde_json::to_value(&item).expect("navigation item should serialize");

        assert_eq!(value["displayName"], "Docs");
        assert_eq!(value["targetKind"], "folder");
        assert_eq!(value["targetStatus"], "ok");
        assert_eq!(value["sortOrder"], 2);

        let request: NavigationItemUpsertRequest = serde_json::from_str(
            r#"{
        "id": "nav-1",
        "displayName": "Docs",
        "description": "Pinned docs",
        "path": "C:\\Docs"
      }"#,
        )
        .expect("navigation upsert request should deserialize");

        assert_eq!(request.id.as_deref(), Some("nav-1"));
        assert_eq!(request.display_name.as_deref(), Some("Docs"));
        assert_eq!(request.description, "Pinned docs");
        assert_eq!(request.path, "C:\\Docs");
    }

    #[test]
    fn workspace_fs_changed_event_uses_camel_case_contract_fields() {
        let event = WorkspaceFsChangedEvent {
            roots: vec!["D:\\Projects\\Atlas".into()],
            directory_roots: vec!["D:\\Projects\\Atlas".into()],
            navigation_parent_roots: vec!["C:\\Users\\Admin\\Documents".into()],
            sequence: 7,
        };

        let value = serde_json::to_value(&event).expect("fs changed event should serialize");

        assert_eq!(value["roots"][0], "D:\\Projects\\Atlas");
        assert_eq!(value["directoryRoots"][0], "D:\\Projects\\Atlas");
        assert_eq!(
            value["navigationParentRoots"][0],
            "C:\\Users\\Admin\\Documents"
        );
        assert_eq!(value["sequence"], 7);
    }

    #[test]
    fn navigation_target_info_contract_can_report_invalid_and_missing_paths() {
        let info = NavigationTargetInfo {
            path: "ftp://example/root".into(),
            normalized_path: None,
            canonical_path: None,
            display_name: "ftp://example/root".into(),
            target_kind: NavigationTargetKind::RemoteUnsupported,
            target_status: NavigationTargetStatus::UnsupportedRemote,
            message: Some("remote targets are not supported yet".into()),
            exists: false,
            is_local: false,
            parent_path: None,
        };

        let value = serde_json::to_value(&info).expect("target info should serialize");

        assert_eq!(value["normalizedPath"], serde_json::Value::Null);
        assert_eq!(value["canonicalPath"], serde_json::Value::Null);
        assert_eq!(value["targetKind"], "remoteUnsupported");
        assert_eq!(value["targetStatus"], "unsupportedRemote");
        assert_eq!(value["isLocal"], false);
        assert_eq!(value["parentPath"], serde_json::Value::Null);
    }
}

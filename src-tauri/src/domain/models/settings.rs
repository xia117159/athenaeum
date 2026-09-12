use serde::{Deserialize, Serialize};

use super::{
    Bookmark, ColorFilterConfigSnapshot, ContextMenuSettings, EntryTag, FileAssociationRule, HotlistEntry,
    NavigationItem, RemoteProfile, ShortcutBinding, TagDefinition, UiLayout, UiTheme,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DetailColumnTextAlign {
    Left,
    Right,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DetailColumnDefinition {
    pub id: String,
    pub label: String,
    pub visible: bool,
    pub width: String,
    pub align: DetailColumnTextAlign,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileVisibilitySettings {
    pub show_hidden: bool,
    pub show_system: bool,
    pub hide_protected_operating_system_files: bool,
}

impl Default for FileVisibilitySettings {
    fn default() -> Self {
        Self {
            show_hidden: false,
            show_system: false,
            hide_protected_operating_system_files: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    #[serde(default)]
    pub file_associations: Vec<FileAssociationRule>,
    pub bookmarks: Vec<Bookmark>,
    pub hotlist: Vec<HotlistEntry>,
    #[serde(default)]
    pub navigation_items: Vec<NavigationItem>,
    pub tag_definitions: Vec<TagDefinition>,
    pub entry_tags: Vec<EntryTag>,
    pub color_filter: ColorFilterConfigSnapshot,
    pub shortcuts: Vec<ShortcutBinding>,
    pub columns: Vec<DetailColumnDefinition>,
    pub navigation_columns: Vec<DetailColumnDefinition>,
    pub details_row_height: u16,
    #[serde(default = "default_size_bar_mode")]
    pub size_bar_mode: String,
    #[serde(default)]
    pub folder_expansion_enabled: bool,
    pub tooltip_hover_delay_ms: u32,
    pub metadata_retention_hours: Option<u64>,
    #[serde(default)]
    pub file_visibility: FileVisibilitySettings,
    #[serde(default)]
    pub context_menu: ContextMenuSettings,
    pub theme: UiTheme,
    pub layout: UiLayout,
    pub remote_profiles: Vec<RemoteProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsModelUpdate {
    #[serde(default)]
    pub file_associations: Option<Vec<FileAssociationRule>>,
    pub shortcuts: Vec<ShortcutBinding>,
    pub columns: Vec<DetailColumnDefinition>,
    pub navigation_columns: Vec<DetailColumnDefinition>,
    pub details_row_height: u16,
    #[serde(default = "default_size_bar_mode")]
    pub size_bar_mode: String,
    #[serde(default)]
    pub folder_expansion_enabled: bool,
    pub tooltip_hover_delay_ms: u32,
    pub metadata_retention_hours: Option<u64>,
    #[serde(default)]
    pub file_visibility: FileVisibilitySettings,
    #[serde(default)]
    pub context_menu: ContextMenuSettings,
    pub theme: UiTheme,
}

fn default_size_bar_mode() -> String {
    "folder-total".into()
}

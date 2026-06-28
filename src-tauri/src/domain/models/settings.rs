use serde::{Deserialize, Serialize};

use super::{
    Bookmark, ColorRule, ContextMenuSettings, EntryTag, HotlistEntry, NavigationItem, RemoteProfile,
    ShortcutBinding, TagDefinition, UiLayout, UiTheme,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    pub bookmarks: Vec<Bookmark>,
    pub hotlist: Vec<HotlistEntry>,
    #[serde(default)]
    pub navigation_items: Vec<NavigationItem>,
    pub tag_definitions: Vec<TagDefinition>,
    pub entry_tags: Vec<EntryTag>,
    pub color_rules: Vec<ColorRule>,
    pub shortcuts: Vec<ShortcutBinding>,
    pub columns: Vec<DetailColumnDefinition>,
    pub details_row_height: u16,
    pub tooltip_hover_delay_ms: u32,
    pub metadata_retention_hours: Option<u64>,
    #[serde(default)]
    pub context_menu: ContextMenuSettings,
    pub theme: UiTheme,
    pub layout: UiLayout,
    pub remote_profiles: Vec<RemoteProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsModelUpdate {
    pub shortcuts: Vec<ShortcutBinding>,
    pub color_rules: Vec<ColorRule>,
    pub columns: Vec<DetailColumnDefinition>,
    pub details_row_height: u16,
    pub tooltip_hover_delay_ms: u32,
    pub metadata_retention_hours: Option<u64>,
    #[serde(default)]
    pub context_menu: ContextMenuSettings,
    pub theme: UiTheme,
}

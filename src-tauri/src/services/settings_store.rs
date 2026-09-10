use std::{collections::{HashMap, HashSet}, fs, path::PathBuf};

use anyhow::{bail, Context, Result};

use crate::domain::models::{
    ContextMenuSettings, DetailColumnDefinition, DetailColumnTextAlign, FileVisibilitySettings,
    ShortcutBinding, UiLayout, UiTheme,
};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsStore {
    pub layout: UiLayout,
    #[serde(default = "default_detail_columns")]
    pub detail_columns: Vec<DetailColumnDefinition>,
    #[serde(default = "default_navigation_columns")]
    pub navigation_columns: Vec<DetailColumnDefinition>,
    #[serde(default = "default_details_row_height")]
    pub details_row_height: u16,
    #[serde(default)]
    pub folder_expansion_enabled: bool,
    #[serde(default = "default_tooltip_hover_delay_ms")]
    pub tooltip_hover_delay_ms: u32,
    #[serde(default = "default_metadata_retention_hours")]
    pub metadata_retention_hours: Option<u64>,
    #[serde(default)]
    pub file_visibility: FileVisibilitySettings,
    #[serde(default)]
    pub context_menu: ContextMenuSettings,
    #[serde(default)]
    pub theme: UiTheme,
    #[serde(skip)]
    file_path: Option<PathBuf>,
}

impl Default for SettingsStore {
    fn default() -> Self {
        Self {
            layout: UiLayout::fallback(),
            detail_columns: default_detail_columns(),
            navigation_columns: default_navigation_columns(),
            details_row_height: default_details_row_height(),
            folder_expansion_enabled: false,
            tooltip_hover_delay_ms: default_tooltip_hover_delay_ms(),
            metadata_retention_hours: default_metadata_retention_hours(),
            file_visibility: FileVisibilitySettings::default(),
            context_menu: ContextMenuSettings::default(),
            theme: UiTheme::default(),
            file_path: None,
        }
    }
}

impl SettingsStore {
    pub fn load_default() -> Self {
        Self::default()
    }

    pub fn load_from(file_path: PathBuf) -> Result<Self> {
        if !file_path.exists() {
            return Ok(Self {
                file_path: Some(file_path),
                ..Self::default()
            });
        }

        let content = fs::read_to_string(&file_path).context("failed to read settings store")?;
        let mut store: Self =
            serde_json::from_str(&content).context("failed to parse settings store")?;
        store.layout = normalize_layout(store.layout);
        store.detail_columns = normalize_detail_columns(store.detail_columns);
        store.navigation_columns = normalize_navigation_columns(store.navigation_columns);
        store.details_row_height = normalize_details_row_height(store.details_row_height);
        store.tooltip_hover_delay_ms =
            normalize_tooltip_hover_delay_ms(store.tooltip_hover_delay_ms);
        store.metadata_retention_hours =
            normalize_metadata_retention_hours(store.metadata_retention_hours);
        store.context_menu = normalize_context_menu(store.context_menu);
        store.theme = normalize_theme(store.theme);
        store.file_path = Some(file_path);
        Ok(store)
    }

    pub fn attach_path(&mut self, file_path: PathBuf) {
        self.file_path = Some(file_path);
    }

    pub fn persist(&self) -> Result<()> {
        let file_path = self
            .file_path
            .as_ref()
            .context("settings store path not initialized")?;
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent).context("failed to create settings directory")?;
        }

        let temp_path = file_path.with_extension("json.tmp");
        let content =
            serde_json::to_vec_pretty(self).context("failed to serialize settings store")?;
        fs::write(&temp_path, content).context("failed to write settings store temp file")?;
        if file_path.exists() {
            fs::remove_file(file_path).context("failed to replace settings store file")?;
        }
        fs::rename(&temp_path, file_path).context("failed to commit settings store file")?;
        Ok(())
    }

    pub fn set_layout(&mut self, layout: UiLayout) {
        self.layout = normalize_layout(layout);
    }

    pub fn set_detail_columns(&mut self, columns: Vec<DetailColumnDefinition>) {
        self.detail_columns = normalize_detail_columns(columns);
    }

    pub fn set_navigation_columns(&mut self, columns: Vec<DetailColumnDefinition>) {
        self.navigation_columns = normalize_navigation_columns(columns);
    }

    pub fn set_details_row_height(&mut self, details_row_height: u16) {
        self.details_row_height = normalize_details_row_height(details_row_height);
    }

    pub fn set_folder_expansion_enabled(&mut self, enabled: bool) {
        self.folder_expansion_enabled = enabled;
    }

    pub fn set_tooltip_hover_delay_ms(&mut self, value: u32) {
        self.tooltip_hover_delay_ms = normalize_tooltip_hover_delay_ms(value);
    }

    pub fn set_metadata_retention_hours(&mut self, value: Option<u64>) {
        self.metadata_retention_hours = normalize_metadata_retention_hours(value);
    }

    pub fn set_file_visibility(&mut self, value: FileVisibilitySettings) {
        self.file_visibility = value;
    }

    pub fn set_context_menu(&mut self, context_menu: ContextMenuSettings) {
        self.context_menu = normalize_context_menu(context_menu);
    }

    pub fn set_theme(&mut self, theme: UiTheme) {
        self.theme = normalize_theme(theme);
    }
}

pub fn validate_shortcuts(shortcuts: &[ShortcutBinding]) -> Result<()> {
    let mut seen = HashSet::new();
    for shortcut in shortcuts {
        let action = shortcut.action.trim();
        let accelerator = shortcut.accelerator.trim();
        let scope = shortcut.scope.trim().to_ascii_lowercase();
        if action.is_empty() {
            bail!("shortcut action cannot be empty");
        }
        if accelerator.is_empty() {
            bail!("shortcut accelerator cannot be empty");
        }

        let dedupe_key = format!("{scope}:{}", accelerator.to_ascii_lowercase());
        if !seen.insert(dedupe_key) {
            bail!(
                "duplicate shortcut binding for scope {} and accelerator {}",
                shortcut.scope,
                shortcut.accelerator
            );
        }
    }
    Ok(())
}

fn normalize_layout(mut layout: UiLayout) -> UiLayout {
    layout
        .panel_proportions
        .retain(|value| value.is_finite() && *value > 0.0);
    if layout.panel_proportions.is_empty() {
        layout.panel_proportions = UiLayout::fallback().panel_proportions;
    }

    let sum: f32 = layout.panel_proportions.iter().sum();
    if sum > 0.0 {
        for value in &mut layout.panel_proportions {
            *value /= sum;
        }
    }

    if !layout.sidebar_width.is_finite() || layout.sidebar_width < 180.0 {
        layout.sidebar_width = UiLayout::fallback().sidebar_width;
    }

    layout
}

fn default_detail_columns() -> Vec<DetailColumnDefinition> {
    vec![
        detail_column("name", "名称", true, "240px", DetailColumnTextAlign::Left),
        detail_column("type", "类型", true, "112px", DetailColumnTextAlign::Left),
        detail_column("extension", "扩展名", true, "96px", DetailColumnTextAlign::Left),
        detail_column("size", "大小", true, "96px", DetailColumnTextAlign::Right),
        detail_column("created", "创建日期", true, "148px", DetailColumnTextAlign::Left),
        detail_column("modified", "修改日期", true, "148px", DetailColumnTextAlign::Left),
        detail_column("accessed", "访问日期", true, "148px", DetailColumnTextAlign::Left),
        detail_column("tags", "标签", true, "120px", DetailColumnTextAlign::Left),
        detail_column("comment", "注释", true, "220px", DetailColumnTextAlign::Left),
        detail_column("location", "位置", false, "220px", DetailColumnTextAlign::Left),
    ]
}

fn default_navigation_columns() -> Vec<DetailColumnDefinition> {
    vec![
        detail_column("name", "\u{540d}\u{79f0}", true, "220px", DetailColumnTextAlign::Left),
        detail_column("kind", "\u{7c7b}\u{578b}", true, "96px", DetailColumnTextAlign::Left),
        detail_column("path", "\u{8def}\u{5f84}", true, "180px", DetailColumnTextAlign::Left),
        detail_column("comment", "\u{6ce8}\u{91ca}", true, "112px", DetailColumnTextAlign::Left),
        detail_column("status", "\u{72b6}\u{6001}", true, "80px", DetailColumnTextAlign::Left),
        detail_column(
            "lastOpened",
            "\u{6700}\u{8fd1}\u{6253}\u{5f00}",
            true,
            "132px",
            DetailColumnTextAlign::Left,
        ),
    ]
}

fn detail_column(
    id: &str,
    label: &str,
    visible: bool,
    width: &str,
    align: DetailColumnTextAlign,
) -> DetailColumnDefinition {
    DetailColumnDefinition {
        id: id.into(),
        label: label.into(),
        visible,
        width: width.into(),
        align,
    }
}

fn normalize_detail_columns(columns: Vec<DetailColumnDefinition>) -> Vec<DetailColumnDefinition> {
    if columns.is_empty() {
        return default_detail_columns();
    }

    let defaults = default_detail_columns();
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for column in columns {
        if !defaults.iter().any(|item| item.id == column.id) || !seen.insert(column.id.clone()) {
            continue;
        }
        let fallback = defaults
            .iter()
            .find(|item| item.id == column.id)
            .expect("validated default column");
        normalized.push(DetailColumnDefinition {
            id: column.id,
            label: if column.label.trim().is_empty() {
                fallback.label.clone()
            } else {
                column.label
            },
            visible: column.visible,
            width: if column.width.trim().is_empty() {
                fallback.width.clone()
            } else {
                column.width
            },
            align: column.align,
        });
    }

    if seen.len() < defaults.len() {
        let mut normalized_by_id: HashMap<String, DetailColumnDefinition> = normalized
            .into_iter()
            .map(|column| (column.id.clone(), column))
            .collect();
        return defaults
            .into_iter()
            .map(|column| normalized_by_id.remove(&column.id).unwrap_or(column))
            .collect();
    }

    normalized
}

fn normalize_navigation_columns(columns: Vec<DetailColumnDefinition>) -> Vec<DetailColumnDefinition> {
    if columns.is_empty() {
        return default_navigation_columns();
    }

    let defaults = default_navigation_columns();
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for column in columns {
        if !defaults.iter().any(|item| item.id == column.id) || !seen.insert(column.id.clone()) {
            continue;
        }
        let fallback = defaults
            .iter()
            .find(|item| item.id == column.id)
            .expect("validated default navigation column");
        normalized.push(DetailColumnDefinition {
            id: column.id,
            label: if column.label.trim().is_empty() {
                fallback.label.clone()
            } else {
                column.label
            },
            visible: column.visible,
            width: if column.width.trim().is_empty() {
                fallback.width.clone()
            } else {
                column.width
            },
            align: column.align,
        });
    }

    if seen.len() < defaults.len() {
        let mut normalized_by_id: HashMap<String, DetailColumnDefinition> = normalized
            .into_iter()
            .map(|column| (column.id.clone(), column))
            .collect();
        return defaults
            .into_iter()
            .map(|column| normalized_by_id.remove(&column.id).unwrap_or(column))
            .collect();
    }

    if is_legacy_default_navigation_columns(&normalized, &defaults) {
        return defaults;
    }

    normalized
}

fn is_legacy_default_navigation_columns(
    columns: &[DetailColumnDefinition],
    defaults: &[DetailColumnDefinition],
) -> bool {
    let legacy_widths = [
        ("name", "240px"),
        ("kind", "112px"),
        ("path", "220px"),
        ("comment", "148px"),
        ("status", "120px"),
        ("lastOpened", "148px"),
    ];

    columns.len() == defaults.len()
        && columns.iter().zip(defaults.iter()).all(|(column, fallback)| {
            let legacy_width = legacy_widths
                .iter()
                .find_map(|(id, width)| (*id == column.id).then_some(*width));
            column.id == fallback.id
                && column.label == fallback.label
                && column.visible
                && column.align == fallback.align
                && legacy_width == Some(column.width.as_str())
        })
}

fn normalize_details_row_height(details_row_height: u16) -> u16 {
    details_row_height.clamp(12, 72)
}

fn normalize_tooltip_hover_delay_ms(value: u32) -> u32 {
    value.min(5000)
}

fn normalize_metadata_retention_hours(value: Option<u64>) -> Option<u64> {
    value
}

fn normalize_context_menu(context_menu: ContextMenuSettings) -> ContextMenuSettings {
    context_menu
}

fn normalize_tab_min_width(tab_min_width: u32) -> u32 {
    tab_min_width.max(1)
}

fn normalize_hex_color(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    let valid_hex = (trimmed.len() == 7 || trimmed.len() == 9)
        && trimmed.starts_with('#')
        && trimmed
            .chars()
            .skip(1)
            .all(|character| character.is_ascii_hexdigit());

    if valid_hex {
        trimmed.to_ascii_lowercase()
    } else {
        fallback.to_string()
    }
}

fn normalize_theme(mut theme: UiTheme) -> UiTheme {
    let defaults = UiTheme::default();
    theme.panel_focus_accent =
        normalize_hex_color(&theme.panel_focus_accent, &defaults.panel_focus_accent);
    theme.active_tab_background =
        normalize_hex_color(&theme.active_tab_background, &defaults.active_tab_background);
    theme.drop_highlight_fill =
        normalize_hex_color(&theme.drop_highlight_fill, &defaults.drop_highlight_fill);
    theme.drop_highlight_border =
        normalize_hex_color(&theme.drop_highlight_border, &defaults.drop_highlight_border);
    theme.tab_min_width = normalize_tab_min_width(theme.tab_min_width);
    theme
}

fn default_details_row_height() -> u16 {
    24
}

fn default_tooltip_hover_delay_ms() -> u32 {
    200
}

fn default_metadata_retention_hours() -> Option<u64> {
    Some(720)
}

#[cfg(test)]
mod tests {
    use std::{env, fs, path::PathBuf};

    use super::{validate_shortcuts, SettingsStore};
    use crate::domain::models::{
        ContextMenuDefaultMenu, ContextMenuSettings, DetailColumnDefinition, DetailColumnTextAlign,
        FileVisibilitySettings, PanelLayoutMode, ShortcutBinding, UiLayout, UiTheme,
    };

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(name: &str) -> Self {
            let path = env::temp_dir().join(format!(
                "athenaeum-settings-{name}-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir_all(&path).expect("failed to create temp directory");
            Self { path }
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn validate_shortcuts_rejects_duplicate_scope_accelerators() {
        let bindings = vec![
            ShortcutBinding {
                id: "a".into(),
                action: "copy".into(),
                accelerator: "Ctrl+C".into(),
                scope: "workspace".into(),
            },
            ShortcutBinding {
                id: "b".into(),
                action: "cancel".into(),
                accelerator: "ctrl+c".into(),
                scope: "workspace".into(),
            },
        ];

        assert!(validate_shortcuts(&bindings).is_err());
    }

    #[test]
    fn persist_round_trip_preserves_layout() {
        let temp = TestDir::new("persist");
        let file_path = temp.path.join("layout.toml");
        let mut store = SettingsStore::load_default();
        store.attach_path(file_path.clone());
        store.set_layout(UiLayout {
            layout_mode: PanelLayoutMode::Triple,
            panel_proportions: vec![2.0, 2.0, 4.0],
            sidebar_width: 320.0,
            show_tree: true,
            show_search: false,
        });
        store.persist().expect("failed to persist settings");

        let reloaded = SettingsStore::load_from(file_path).expect("failed to reload settings");
        assert_eq!(reloaded.layout.layout_mode, PanelLayoutMode::Triple);
        let sum: f32 = reloaded.layout.panel_proportions.iter().sum();
        assert!((sum - 1.0).abs() < 0.0001);
    }

    #[test]
    fn persist_round_trip_preserves_details_row_height() {
        let temp = TestDir::new("details-row-height");
        let file_path = temp.path.join("layout.toml");
        let mut store = SettingsStore::load_default();
        store.attach_path(file_path.clone());
        store.set_details_row_height(68);
        store.persist().expect("failed to persist settings");

        let reloaded = SettingsStore::load_from(file_path).expect("failed to reload settings");
        assert_eq!(reloaded.details_row_height, 68);
    }

    #[test]
    fn folder_expansion_setting_defaults_and_persists() {
        let temp = TestDir::new("folder-expansion");
        let file_path = temp.path.join("settings.json");
        let mut legacy = serde_json::to_value(SettingsStore::default()).unwrap();
        legacy
            .as_object_mut()
            .unwrap()
            .remove("folderExpansionEnabled");
        let defaulted: SettingsStore = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(defaulted).unwrap()["folderExpansionEnabled"],
            false
        );
        for enabled in [true, false] {
            legacy["folderExpansionEnabled"] = serde_json::json!(enabled);
            let mut store: SettingsStore = serde_json::from_value(legacy.clone()).unwrap();
            store.attach_path(file_path.clone());
            store.persist().unwrap();
            let loaded = SettingsStore::load_from(file_path.clone()).unwrap();
            assert_eq!(
                serde_json::to_value(loaded).unwrap()["folderExpansionEnabled"],
                enabled
            );
        }
    }

    #[test]
    fn details_row_height_allows_dense_twelve_pixel_rows() {
        let mut store = SettingsStore::load_default();
        store.set_details_row_height(4);
        assert_eq!(store.details_row_height, 12);
    }

    #[test]
    fn persist_round_trip_preserves_file_list_behavior_settings() {
        let temp = TestDir::new("file-list-behavior");
        let file_path = temp.path.join("layout.toml");
        let mut store = SettingsStore::load_default();
        store.attach_path(file_path.clone());
        store.set_tooltip_hover_delay_ms(6400);
        store.set_metadata_retention_hours(None);
        store.persist().expect("failed to persist settings");

        let reloaded = SettingsStore::load_from(file_path).expect("failed to reload settings");
        assert_eq!(reloaded.tooltip_hover_delay_ms, 5000);
        assert_eq!(reloaded.metadata_retention_hours, None);
    }

    #[test]
    fn persist_round_trip_preserves_global_file_visibility() {
        let temp = TestDir::new("file-visibility");
        let file_path = temp.path.join("layout.toml");
        let mut store = SettingsStore::load_default();
        store.attach_path(file_path.clone());
        store.set_file_visibility(FileVisibilitySettings {
            show_hidden: true,
            show_system: true,
            hide_protected_operating_system_files: false,
        });
        store.persist().expect("persist settings");

        let reloaded = SettingsStore::load_from(file_path.clone()).expect("reload settings");
        reloaded.persist().expect("persist reloaded settings");
        let round_trip = SettingsStore::load_from(file_path).expect("reload persisted settings");

        assert!(round_trip.file_visibility.show_hidden);
        assert!(round_trip.file_visibility.show_system);
        assert!(
            !round_trip
                .file_visibility
                .hide_protected_operating_system_files
        );
    }

    #[test]
    fn legacy_settings_default_to_hidden_and_system_files_not_shown() {
        let temp = TestDir::new("legacy-file-visibility");
        let file_path = temp.path.join("layout.toml");
        let mut serialized = serde_json::to_value(SettingsStore::load_default())
            .expect("serialize default settings");
        serialized
            .as_object_mut()
            .expect("settings object")
            .remove("fileVisibility");
        fs::write(
            &file_path,
            serde_json::to_vec_pretty(&serialized).expect("serialize legacy settings"),
        )
        .expect("seed legacy settings");

        let reloaded = SettingsStore::load_from(file_path).expect("reload legacy settings");

        assert!(!reloaded.file_visibility.show_hidden);
        assert!(!reloaded.file_visibility.show_system);
        assert!(
            reloaded
                .file_visibility
                .hide_protected_operating_system_files
        );
    }

    #[test]
    fn metadata_retention_hours_has_zero_floor_and_supports_finite_values() {
        let mut store = SettingsStore::load_default();
        store.set_metadata_retention_hours(Some(48));
        assert_eq!(store.metadata_retention_hours, Some(48));
        store.set_metadata_retention_hours(Some(0));
        assert_eq!(store.metadata_retention_hours, Some(0));
    }

    #[test]
    fn persist_round_trip_preserves_detail_columns() {
        let temp = TestDir::new("detail-columns");
        let file_path = temp.path.join("layout.toml");
        let mut store = SettingsStore::load_default();
        store.attach_path(file_path.clone());
        store.set_detail_columns(vec![
            DetailColumnDefinition {
                id: "name".into(),
                label: "Name".into(),
                visible: true,
                width: "240px".into(),
                align: DetailColumnTextAlign::Left,
            },
            DetailColumnDefinition {
                id: "comment".into(),
                label: "Comment".into(),
                visible: true,
                width: "220px".into(),
                align: DetailColumnTextAlign::Left,
            },
        ]);
        store.persist().expect("failed to persist settings");

        let reloaded = SettingsStore::load_from(file_path).expect("failed to reload settings");
        assert_eq!(reloaded.detail_columns.len(), 10);
        assert_eq!(reloaded.detail_columns[8].id, "comment");
        assert!(reloaded.detail_columns[8].visible);
    }

    #[test]
    fn persist_round_trip_preserves_navigation_columns() {
        let temp = TestDir::new("navigation-columns");
        let file_path = temp.path.join("layout.toml");
        let mut store = SettingsStore::load_default();
        store.attach_path(file_path.clone());
        store.set_navigation_columns(vec![
            DetailColumnDefinition {
                id: "path".into(),
                label: "Path".into(),
                visible: true,
                width: "336px".into(),
                align: DetailColumnTextAlign::Left,
            },
            DetailColumnDefinition {
                id: "name".into(),
                label: "Name".into(),
                visible: false,
                width: "240px".into(),
                align: DetailColumnTextAlign::Left,
            },
        ]);
        store.persist().expect("failed to persist settings");

        let reloaded = SettingsStore::load_from(file_path).expect("failed to reload settings");
        assert_eq!(reloaded.navigation_columns.len(), 6);
        assert_eq!(reloaded.navigation_columns[0].id, "name");
        assert!(!reloaded.navigation_columns[0].visible);
        assert_eq!(reloaded.navigation_columns[2].id, "path");
        assert_eq!(reloaded.navigation_columns[2].width, "336px");
    }

    #[test]
    fn default_navigation_columns_use_compact_details_widths() {
        let store = SettingsStore::load_default();

        let widths: Vec<&str> = store
            .navigation_columns
            .iter()
            .map(|column| column.width.as_str())
            .collect();

        assert_eq!(widths, ["220px", "96px", "180px", "112px", "80px", "132px"]);
    }

    #[test]
    fn legacy_default_navigation_columns_migrate_to_compact_widths() {
        let mut store = SettingsStore::load_default();
        store.set_navigation_columns(vec![
            DetailColumnDefinition {
                id: "name".into(),
                label: "\u{540d}\u{79f0}".into(),
                visible: true,
                width: "240px".into(),
                align: DetailColumnTextAlign::Left,
            },
            DetailColumnDefinition {
                id: "kind".into(),
                label: "\u{7c7b}\u{578b}".into(),
                visible: true,
                width: "112px".into(),
                align: DetailColumnTextAlign::Left,
            },
            DetailColumnDefinition {
                id: "path".into(),
                label: "\u{8def}\u{5f84}".into(),
                visible: true,
                width: "220px".into(),
                align: DetailColumnTextAlign::Left,
            },
            DetailColumnDefinition {
                id: "comment".into(),
                label: "\u{6ce8}\u{91ca}".into(),
                visible: true,
                width: "148px".into(),
                align: DetailColumnTextAlign::Left,
            },
            DetailColumnDefinition {
                id: "status".into(),
                label: "\u{72b6}\u{6001}".into(),
                visible: true,
                width: "120px".into(),
                align: DetailColumnTextAlign::Left,
            },
            DetailColumnDefinition {
                id: "lastOpened".into(),
                label: "\u{6700}\u{8fd1}\u{6253}\u{5f00}".into(),
                visible: true,
                width: "148px".into(),
                align: DetailColumnTextAlign::Left,
            },
        ]);

        let widths: Vec<&str> = store
            .navigation_columns
            .iter()
            .map(|column| column.width.as_str())
            .collect();

        assert_eq!(widths, ["220px", "96px", "180px", "112px", "80px", "132px"]);
    }

    #[test]
    fn persist_round_trip_preserves_context_menu_default() {
        let temp = TestDir::new("context-menu");
        let file_path = temp.path.join("layout.toml");
        let mut store = SettingsStore::load_default();
        store.attach_path(file_path.clone());
        store.set_context_menu(ContextMenuSettings {
            default_menu: ContextMenuDefaultMenu::Custom,
        });
        store.persist().expect("failed to persist settings");

        let reloaded = SettingsStore::load_from(file_path).expect("failed to reload settings");
        assert_eq!(
            reloaded.context_menu.default_menu,
            ContextMenuDefaultMenu::Custom
        );
    }

    #[test]
    fn persist_round_trip_preserves_theme_focus_accent() {
        let temp = TestDir::new("theme");
        let file_path = temp.path.join("layout.toml");
        let mut store = SettingsStore::load_default();
        store.attach_path(file_path.clone());
        store.set_theme(UiTheme {
            panel_focus_accent: "#c02f7a80".into(),
            active_tab_background: "#ffffffcc".into(),
            drop_highlight_fill: "#1f9d5566".into(),
            drop_highlight_border: "#b91c1c40".into(),
            tab_min_width: 132,
        });
        store.persist().expect("failed to persist settings");

        let reloaded = SettingsStore::load_from(file_path).expect("failed to reload settings");
        assert_eq!(reloaded.theme.panel_focus_accent, "#c02f7a80");
        assert_eq!(reloaded.theme.active_tab_background, "#ffffffcc");
        assert_eq!(reloaded.theme.drop_highlight_fill, "#1f9d5566");
        assert_eq!(reloaded.theme.drop_highlight_border, "#b91c1c40");
        assert_eq!(reloaded.theme.tab_min_width, 132);
    }

    #[test]
    fn theme_normalizes_invalid_drop_highlight_colors_to_defaults() {
        let mut store = SettingsStore::load_default();
        store.set_theme(UiTheme {
            panel_focus_accent: "#0f6cbd".into(),
            active_tab_background: "#12345".into(),
            drop_highlight_fill: "not-a-color".into(),
            drop_highlight_border: "#ZZZZZZ".into(),
            tab_min_width: 96,
        });

        let defaults = UiTheme::default();
        assert_eq!(
            store.theme.active_tab_background,
            defaults.active_tab_background
        );
        assert_eq!(store.theme.drop_highlight_fill, defaults.drop_highlight_fill);
        assert_eq!(
            store.theme.drop_highlight_border,
            defaults.drop_highlight_border
        );
    }

    #[test]
    fn theme_tab_min_width_has_one_pixel_floor_and_no_upper_cap() {
        let mut store = SettingsStore::load_default();

        store.set_theme(UiTheme {
            panel_focus_accent: "#0f6cbd".into(),
            tab_min_width: 0,
            ..UiTheme::default()
        });
        assert_eq!(store.theme.tab_min_width, 1);

        store.set_theme(UiTheme {
            panel_focus_accent: "#0f6cbd".into(),
            tab_min_width: 4096,
            ..UiTheme::default()
        });
        assert_eq!(store.theme.tab_min_width, 4096);
    }
}

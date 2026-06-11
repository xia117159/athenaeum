use std::{
  collections::HashSet,
  fs,
  path::PathBuf
};

use anyhow::{bail, Context, Result};

use crate::domain::models::{ShortcutBinding, UiLayout, UiTheme};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsStore {
  pub layout: UiLayout,
  #[serde(default = "default_details_row_height")]
  pub details_row_height: u16,
  #[serde(default)]
  pub theme: UiTheme,
  #[serde(skip)]
  file_path: Option<PathBuf>
}

impl Default for SettingsStore {
  fn default() -> Self {
    Self {
      layout: UiLayout::fallback(),
      details_row_height: default_details_row_height(),
      theme: UiTheme::default(),
      file_path: None
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
    let mut store: Self = serde_json::from_str(&content).context("failed to parse settings store")?;
    store.layout = normalize_layout(store.layout);
    store.details_row_height = normalize_details_row_height(store.details_row_height);
    store.theme = normalize_theme(store.theme);
    store.file_path = Some(file_path);
    Ok(store)
  }

  pub fn attach_path(&mut self, file_path: PathBuf) {
    self.file_path = Some(file_path);
  }

  pub fn persist(&self) -> Result<()> {
    let file_path = self.file_path.as_ref().context("settings store path not initialized")?;
    if let Some(parent) = file_path.parent() {
      fs::create_dir_all(parent).context("failed to create settings directory")?;
    }

    let temp_path = file_path.with_extension("json.tmp");
    let content = serde_json::to_vec_pretty(self).context("failed to serialize settings store")?;
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

  pub fn set_details_row_height(&mut self, details_row_height: u16) {
    self.details_row_height = normalize_details_row_height(details_row_height);
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
      bail!("duplicate shortcut binding for scope {} and accelerator {}", shortcut.scope, shortcut.accelerator);
    }
  }
  Ok(())
}

fn normalize_layout(mut layout: UiLayout) -> UiLayout {
  layout.panel_proportions.retain(|value| value.is_finite() && *value > 0.0);
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

fn normalize_details_row_height(details_row_height: u16) -> u16 {
  details_row_height.clamp(24, 72)
}

fn normalize_tab_min_width(tab_min_width: u32) -> u32 {
  tab_min_width.max(1)
}

fn normalize_theme(mut theme: UiTheme) -> UiTheme {
  let value = theme.panel_focus_accent.trim();
  let valid_hex = value.len() == 7
    && value.starts_with('#')
    && value
      .chars()
      .skip(1)
      .all(|character| character.is_ascii_hexdigit());

  theme.panel_focus_accent = if valid_hex {
    value.to_ascii_lowercase()
  } else {
    UiTheme::default().panel_focus_accent
  };
  theme.tab_min_width = normalize_tab_min_width(theme.tab_min_width);
  theme
}

fn default_details_row_height() -> u16 {
  24
}

#[cfg(test)]
mod tests {
  use std::{env, fs, path::PathBuf};

  use super::{validate_shortcuts, SettingsStore};
  use crate::domain::models::{PanelLayoutMode, ShortcutBinding, UiLayout, UiTheme};

  struct TestDir {
    path: PathBuf
  }

  impl TestDir {
    fn new(name: &str) -> Self {
      let path = env::temp_dir().join(format!("simplefilemanager-settings-{name}-{}", uuid::Uuid::new_v4()));
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
        scope: "workspace".into()
      },
      ShortcutBinding {
        id: "b".into(),
        action: "cancel".into(),
        accelerator: "ctrl+c".into(),
        scope: "workspace".into()
      }
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
      show_search: false
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
  fn persist_round_trip_preserves_theme_focus_accent() {
    let temp = TestDir::new("theme");
    let file_path = temp.path.join("layout.toml");
    let mut store = SettingsStore::load_default();
    store.attach_path(file_path.clone());
    store.set_theme(UiTheme {
      panel_focus_accent: "#c02f7a".into(),
      tab_min_width: 132
    });
    store.persist().expect("failed to persist settings");

    let reloaded = SettingsStore::load_from(file_path).expect("failed to reload settings");
    assert_eq!(reloaded.theme.panel_focus_accent, "#c02f7a");
    assert_eq!(reloaded.theme.tab_min_width, 132);
  }

  #[test]
  fn theme_tab_min_width_has_one_pixel_floor_and_no_upper_cap() {
    let mut store = SettingsStore::load_default();

    store.set_theme(UiTheme {
      panel_focus_accent: "#0f6cbd".into(),
      tab_min_width: 0
    });
    assert_eq!(store.theme.tab_min_width, 1);

    store.set_theme(UiTheme {
      panel_focus_accent: "#0f6cbd".into(),
      tab_min_width: 4096
    });
    assert_eq!(store.theme.tab_min_width, 4096);
  }
}

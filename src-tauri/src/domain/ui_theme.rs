use serde::{Deserialize, Serialize};

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
    #[serde(default = "default_size_bar_low")]
    pub size_bar_low: String,
    #[serde(default = "default_size_bar_high")]
    pub size_bar_high: String,
    #[serde(default = "default_menu_hover_background")]
    pub menu_hover_background: String,
    #[serde(default = "default_menu_hover_text")]
    pub menu_hover_text: String,
    #[serde(default = "default_file_hover_border")]
    pub file_hover_border: String,
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
            size_bar_low: default_size_bar_low(),
            size_bar_high: default_size_bar_high(),
            menu_hover_background: default_menu_hover_background(),
            menu_hover_text: default_menu_hover_text(),
            file_hover_border: default_file_hover_border(),
            tab_min_width: default_tab_min_width(),
        }
    }
}

fn default_active_tab_background() -> String { "#ffffff".into() }
fn default_drop_highlight_color() -> String { "#0f6cbd".into() }
fn default_size_bar_low() -> String { "#dceaf7".into() }
fn default_size_bar_high() -> String { "#3979b7".into() }
fn default_menu_hover_background() -> String { "#e5f1fb".into() }
fn default_menu_hover_text() -> String { "#1f1f1f".into() }
fn default_file_hover_border() -> String { "#91c9f7".into() }
fn default_tab_min_width() -> u32 { 96 }

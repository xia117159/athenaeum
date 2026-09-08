use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ColorRuleTarget {
    Any,
    File,
    Directory,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ColorRule {
    #[serde(default = "color_rule_schema_version")]
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub target: ColorRuleTarget,
    pub expression: String,
    pub case_sensitive: bool,
    pub foreground_color_hex: Option<String>,
    pub background_color_hex: Option<String>,
    pub priority: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migration_diagnostic: Option<String>,
    #[serde(skip)]
    pub(crate) migration_source: Option<Value>,
}

pub const fn color_rule_schema_version() -> u32 {
    2
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ColorRuleInput {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub target: ColorRuleTarget,
    pub expression: String,
    pub case_sensitive: bool,
    pub foreground_color_hex: Option<String>,
    pub background_color_hex: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ColorFilterConfigSnapshot {
    pub enabled: bool,
    pub rules: Vec<ColorRule>,
    pub revision: String,
    pub rules_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ColorFilterMutationResult {
    pub snapshot: ColorFilterConfigSnapshot,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ColorFilterValidationSpan {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ColorFilterValidationResult {
    pub valid: bool,
    pub message: Option<String>,
    pub span: Option<ColorFilterValidationSpan>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceColorRulesRequest {
    pub rules: Vec<ColorRuleInput>,
    pub base_rules_revision: String,
    pub force: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum ReplaceColorRulesResult {
    Applied {
        snapshot: ColorFilterConfigSnapshot,
        #[serde(default)]
        warnings: Vec<String>,
    },
    Conflict {
        snapshot: ColorFilterConfigSnapshot,
        #[serde(default)]
        warnings: Vec<String>,
    },
}

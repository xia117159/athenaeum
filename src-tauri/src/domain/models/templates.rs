use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TemplateRecoveryItem {
    pub original_path: String,
    pub recovery_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TemplateEntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreationTemplateEntry {
    pub name: String,
    pub path: String,
    pub relative_path: String,
    pub kind: TemplateEntryKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreationTemplateListing {
    pub root_path: String,
    pub relative_path: String,
    pub entries: Vec<CreationTemplateEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTemplateItemsRequest {
    pub request_id: String,
    pub template_root: String,
    pub relative_paths: Vec<String>,
    pub destination: String,
    pub panel_id: Option<String>,
    pub tab_id: Option<String>,
}

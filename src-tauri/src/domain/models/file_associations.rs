use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct FileAssociationRule {
    pub id: String,
    pub patterns: String,
    pub executable_path: String,
    pub arguments_template: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FileOpenTarget {
    Local { path: String },
    Remote { profile_id: String, path: String },
}

impl FileOpenTarget {
    pub fn path(&self) -> &str {
        match self {
            Self::Local { path } | Self::Remote { path, .. } => path,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOpenRequest {
    pub request_id: String,
    pub target: FileOpenTarget,
    pub association_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FileOpenResult {
    Opened {
        local_path: String,
        association_id: Option<String>,
    },
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileOpenPhase {
    Preparing,
    Downloading,
    Opening,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOpenProgress {
    pub phase: FileOpenPhase,
    pub completed_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssociationProgramInfo {
    pub path: String,
    pub display_name: String,
    pub exists: bool,
}

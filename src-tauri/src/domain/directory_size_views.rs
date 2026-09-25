use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySizeViewScope { pub path: String, pub priority: u8 }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDirectorySizeViewsRequest {
    pub revision: u32, pub scopes: Vec<DirectorySizeViewScope>,
    #[serde(default)] pub owner_epoch: Option<String>,
    #[serde(default)] pub shutdown_nonce: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySizeViewsAck { pub accepted_revision: u32, pub owner_epoch: String, pub truncated: bool }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySizeViewsFlushRequested { pub nonce: String, pub owner_epoch: String }

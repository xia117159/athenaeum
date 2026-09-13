use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub use crate::services::file_identity::FileIdentity as Identity;

pub(super) fn same_identity(left: &Identity, right: &Identity) -> bool {
    // NTFS name tunneling can change creation time during a same-object rename. On
    // NTFS/ReFS use the complete stable volume/file ID, never timestamps as identity.
    // The conservative fallback on other filesystems still requires all fields.
    left == right
        || (left.stable
            && right.stable
            && left.version == right.version
            && left.volume == right.volume
            && left.id_bits == right.id_bits
            && left.id == right.id
            && left.kind == right.kind)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedStream {
    pub name: String,
    pub digest: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedNode {
    pub relative_path: PathBuf,
    pub identity: Identity,
    pub digest: Option<Vec<u8>>,
    pub streams: Vec<OwnedStream>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedTree {
    pub path: PathBuf,
    pub parent_identity: Identity,
    pub nodes: Vec<OwnedNode>,
    pub recovery_path: PathBuf,
    pub recovery_prepared: bool,
    pub recovery_moved: bool,
    pub recovery_was_hidden: bool,
}
#[cfg(windows)]
#[path = "owned_windows.rs"]
mod platform;
#[cfg(windows)]
pub use platform::{digest, purge_recovery, refresh_recovery_locations, remove};

pub fn recovery_items(trees: &[OwnedTree]) -> Vec<crate::domain::models::TemplateRecoveryItem> {
    trees
        .iter()
        .filter(|tree| tree.recovery_moved)
        .map(|tree| crate::domain::models::TemplateRecoveryItem {
            original_path: tree.path.to_string_lossy().into_owned(),
            recovery_path: tree.recovery_path.to_string_lossy().into_owned(),
        })
        .collect()
}

#[cfg(all(test, windows))]
#[path = "owned_tests.rs"]
mod tests;

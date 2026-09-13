use anyhow::{bail, Context, Result};
use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIdentity {
    pub version: u32,
    pub volume: u64,
    pub id: [u8; 16],
    pub id_bits: u8,
    pub created: i64,
    pub kind: u32,
    pub stable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntrySnapshot {
    pub path: PathBuf,
    pub identity: FileIdentity,
    pub parent_identity: FileIdentity,
    pub is_directory: bool,
    pub modified: Option<DateTime<FixedOffset>>,
    pub created: Option<DateTime<FixedOffset>>,
    pub length: u64,
}

#[cfg(windows)]
#[path = "native_windows.rs"]
mod platform;
#[cfg(windows)]
pub use platform::{snapshot, GroupGuard};

#[cfg(not(windows))]
pub fn snapshot(_path: &Path) -> Result<EntrySnapshot> {
    bail!("此平台不支持安全批量重命名");
}

pub fn same_name(left: &str, right: &str) -> bool {
    compare_names(left, right).is_eq()
}
pub fn compare_names(left: &str, right: &str) -> std::cmp::Ordering {
    if left.is_empty() || right.is_empty() {
        return left.len().cmp(&right.len());
    }
    #[cfg(windows)]
    {
        use windows::Win32::Globalization::{
            CompareStringOrdinal, CSTR_GREATER_THAN, CSTR_LESS_THAN,
        };
        let left = left.encode_utf16().collect::<Vec<_>>();
        let right = right.encode_utf16().collect::<Vec<_>>();
        match unsafe { CompareStringOrdinal(&left, &right, true) } {
            CSTR_LESS_THAN => std::cmp::Ordering::Less,
            CSTR_GREATER_THAN => std::cmp::Ordering::Greater,
            _ => std::cmp::Ordering::Equal,
        }
    }
    #[cfg(not(windows))]
    {
        left.to_uppercase().cmp(&right.to_uppercase())
    }
}

pub fn path_eq(left: &Path, right: &Path) -> bool {
    same_name(&left.to_string_lossy(), &right.to_string_lossy())
}

pub fn rewrite_descendant(path: &Path, from: &Path, to: &Path) -> PathBuf {
    let parts = path.components().collect::<Vec<_>>();
    let prefix = from.components().collect::<Vec<_>>();
    if parts.len() < prefix.len()
        || !parts.iter().zip(&prefix).all(|(a, b)| {
            same_name(
                &a.as_os_str().to_string_lossy(),
                &b.as_os_str().to_string_lossy(),
            )
        })
    {
        return path.to_path_buf();
    }
    let mut rewritten = to.to_path_buf();
    for part in &parts[prefix.len()..] {
        rewritten.push(part.as_os_str());
    }
    rewritten
}

pub fn validate_snapshot(expected: &EntrySnapshot, check_metadata: bool) -> Result<()> {
    let actual = snapshot(&expected.path)?;
    if actual.identity != expected.identity
        || actual.parent_identity != expected.parent_identity
        || actual.path != expected.path
    {
        bail!("源项目已被替换或改名：{}", expected.path.display());
    }
    if check_metadata && (actual.modified != expected.modified || actual.length != expected.length)
    {
        bail!(
            "源项目自预览后已改变，请重新预览：{}",
            expected.path.display()
        );
    }
    Ok(())
}

pub fn name_of(path: &Path) -> Result<&str> {
    path.file_name()
        .and_then(|name| name.to_str())
        .context("无法读取有效的文件名")
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn snapshot_preserves_long_directory_entry_identity_and_hardlinks() {
        let root = std::env::temp_dir().join(format!("athenaeum-batch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("Test.txt");
        let link = root.join("Alias.txt");
        std::fs::write(&file, "original-content").unwrap();
        std::fs::hard_link(&file, &link).unwrap();
        let first = snapshot(&file).expect("snapshot of a real local file");
        let second = snapshot(&link).unwrap();
        assert_eq!(
            first.identity, second.identity,
            "hardlinks share an object identity"
        );
        assert_ne!(first.path, second.path, "directory entries remain distinct");
        assert_eq!(first.path.file_name().unwrap(), "Test.txt");
        assert!(first.created.is_some());
        assert_eq!(first.length, 16);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn handle_rename_moves_only_the_selected_entry_and_never_replaces() {
        let root = std::env::temp_dir().join(format!("athenaeum-batch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("Test.txt");
        std::fs::write(&file, "original").unwrap();
        std::fs::write(root.join("occupied.txt"), "external").unwrap();
        let original = snapshot(&file).unwrap();
        {
            let guard = GroupGuard::new(&root, &original.parent_identity).unwrap();
            let handle = guard.open_source(&file, &original.identity).unwrap();
            handle.rename_to(&guard, "renamed.txt").unwrap();
            assert_eq!(
                std::fs::read_to_string(root.join("renamed.txt")).unwrap(),
                "original"
            );
            assert!(!file.exists());
            assert!(handle.rename_to(&guard, "occupied.txt").is_err());
            assert_eq!(
                std::fs::read_to_string(root.join("occupied.txt")).unwrap(),
                "external"
            );
        }
        assert_eq!(
            snapshot(&root.join("renamed.txt")).unwrap().identity,
            original.identity
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn group_locks_ancestors_and_rejects_a_replaced_source() {
        let root = std::env::temp_dir().join(format!("athenaeum-batch-{}", uuid::Uuid::new_v4()));
        let parent = root.join("nested");
        std::fs::create_dir_all(&parent).unwrap();
        let file = parent.join("Test.txt");
        std::fs::write(&file, "original").unwrap();
        let expected = snapshot(&file).unwrap();
        {
            let guard = GroupGuard::new(&parent, &expected.parent_identity).unwrap();
            assert!(std::fs::rename(&root, root.with_extension("moved")).is_err());
            std::fs::rename(&file, parent.join("external-move.txt")).unwrap();
            std::fs::write(&file, "replacement").unwrap();
            assert!(guard.open_source(&file, &expected.identity).is_err());
            assert_eq!(std::fs::read_to_string(&file).unwrap(), "replacement");
        }
        std::fs::remove_dir_all(&root).unwrap();
    }
}

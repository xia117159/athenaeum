use std::{
    ffi::OsString,
    fs,
    path::{Component, Path, PathBuf},
};

use super::{file_identity, inspect_identity, EntryType, FileIdentity, UndoAction, UndoPayload};

#[cfg(test)]
thread_local! {
    static RESOLVED_ENTRY_KEY_FAILURE: std::cell::RefCell<Option<PathBuf>> = const {
        std::cell::RefCell::new(None)
    };
}

#[cfg(test)]
pub(super) fn set_resolved_entry_key_failure(path: Option<PathBuf>) {
    RESOLVED_ENTRY_KEY_FAILURE.with(|current| *current.borrow_mut() = path);
}

#[cfg(test)]
fn should_fail_resolved_entry_key(path: &Path) -> bool {
    RESOLVED_ENTRY_KEY_FAILURE.with(|current| current.borrow().as_deref() == Some(path))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct InspectedPathIdentity {
    object_chain: Vec<FileIdentity>,
    entry_key: PathBuf,
}

pub(super) struct IdentityInspectionError {
    object_prefix: Vec<FileIdentity>,
}

pub(super) enum PathIdentityBarrier {
    Exact(InspectedPathIdentity),
    ObjectPrefix(Vec<FileIdentity>),
}

impl IdentityInspectionError {
    fn new(object_prefix: Vec<FileIdentity>) -> Self {
        Self { object_prefix }
    }

    pub(super) fn into_barrier(self) -> Option<PathIdentityBarrier> {
        (!self.object_prefix.is_empty())
            .then_some(PathIdentityBarrier::ObjectPrefix(self.object_prefix))
    }
}

impl From<InspectedPathIdentity> for PathIdentityBarrier {
    fn from(identity: InspectedPathIdentity) -> Self {
        Self::Exact(identity)
    }
}

impl PathIdentityBarrier {
    pub(super) fn overlaps(&self, identity: &InspectedPathIdentity) -> bool {
        match self {
            Self::Exact(failed) => failed.overlaps(identity),
            Self::ObjectPrefix(prefix) => prefix
                .iter()
                .zip(&identity.object_chain)
                .all(|(left, right)| left == right),
        }
    }
}

impl InspectedPathIdentity {
    pub(super) fn inspect(
        root_parts: &[OsString],
        root: &Path,
        path: &Path,
    ) -> Result<Self, IdentityInspectionError> {
        let parts =
            normalized_components(path).ok_or_else(|| IdentityInspectionError::new(Vec::new()))?;
        if !is_strict_descendant(root_parts, &parts) {
            return Err(IdentityInspectionError::new(Vec::new()));
        }
        let suffix = path.components().skip(root_parts.len()).collect::<Vec<_>>();
        let mut current = root.to_path_buf();
        let root_identity =
            inspect_identity(&current).map_err(|_| IdentityInspectionError::new(Vec::new()))?;
        let mut object_chain = vec![root_identity];
        if object_chain[0].entry_type != EntryType::Directory {
            return Err(IdentityInspectionError::new(object_chain));
        }
        for (index, component) in suffix.iter().enumerate() {
            let Component::Normal(value) = component else {
                return Err(IdentityInspectionError::new(object_chain));
            };
            current.push(value);
            let identity = inspect_identity(&current)
                .map_err(|_| IdentityInspectionError::new(object_chain.clone()))?;
            object_chain.push(identity);
            if index + 1 < suffix.len() && identity.entry_type == EntryType::LinkOrReparse {
                return Err(IdentityInspectionError::new(object_chain));
            }
        }
        Self::from_chain(path, object_chain.clone())
            .ok_or_else(|| IdentityInspectionError::new(object_chain))
    }

    pub(super) fn from_chain(path: &Path, object_chain: Vec<FileIdentity>) -> Option<Self> {
        Some(Self {
            object_chain,
            entry_key: resolved_entry_key(path)?,
        })
    }

    pub(super) fn same_entry(&self, other: &Self) -> bool {
        self.object_chain == other.object_chain && self.entry_key == other.entry_key
    }

    pub(super) fn overlaps(&self, other: &Self) -> bool {
        let object_prefix_matches = self
            .object_chain
            .iter()
            .zip(&other.object_chain)
            .all(|(left, right)| left == right);
        object_prefix_matches
            && (self.object_chain.len() != other.object_chain.len()
                || self.entry_key == other.entry_key)
    }

    #[cfg(test)]
    pub(super) fn for_test(object_chain: Vec<FileIdentity>, entry_key: PathBuf) -> Self {
        Self {
            object_chain,
            entry_key,
        }
    }
}

#[cfg(windows)]
fn resolved_entry_key(path: &Path) -> Option<PathBuf> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows::{core::PCWSTR, Win32::Storage::FileSystem::GetLongPathNameW};

    #[cfg(test)]
    if should_fail_resolved_entry_key(path) {
        return None;
    }
    let source = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let required = unsafe { GetLongPathNameW(PCWSTR(source.as_ptr()), None) };
    if required == 0 {
        return None;
    }
    let mut resolved = vec![0; required as usize];
    let written = unsafe { GetLongPathNameW(PCWSTR(source.as_ptr()), Some(&mut resolved)) };
    if written == 0 || written as usize >= resolved.len() {
        return None;
    }
    resolved.truncate(written as usize);
    Some(PathBuf::from(OsString::from_wide(&resolved)))
}

#[cfg(not(windows))]
fn resolved_entry_key(path: &Path) -> Option<PathBuf> {
    #[cfg(test)]
    if should_fail_resolved_entry_key(path) {
        return None;
    }
    Some(path.to_path_buf())
}

pub(super) struct VerifiedCleanupRoot {
    components: Vec<OsString>,
    identity: FileIdentity,
}

impl VerifiedCleanupRoot {
    pub(super) fn new(root: &Path) -> Result<Self, String> {
        let components = normalized_components(root)
            .ok_or_else(|| format!("unsafe operation-trash root: {}", root.display()))?;
        Ok(Self {
            components,
            identity: inspect_cleanup_root(root)?,
        })
    }

    pub(super) fn components(&self) -> &[OsString] {
        &self.components
    }

    pub(super) fn ensure_current(&self, root: &Path) -> Result<(), String> {
        if inspect_cleanup_root(root)? != self.identity {
            return Err(format!(
                "operation-trash root identity changed during cleanup: {}",
                root.display()
            ));
        }
        Ok(())
    }
}

fn inspect_cleanup_root(root: &Path) -> Result<FileIdentity, String> {
    let metadata = fs::symlink_metadata(root).map_err(|error| {
        format!(
            "cannot inspect operation-trash root {}: {error}",
            root.display()
        )
    })?;
    let identity = file_identity(root, &metadata).ok_or_else(|| {
        format!(
            "cannot determine operation-trash root identity: {}",
            root.display()
        )
    })?;
    if identity.entry_type != EntryType::Directory {
        return Err(format!(
            "operation-trash root is not an ordinary directory: {}",
            root.display()
        ));
    }
    Ok(identity)
}

pub(super) fn normalized_components(path: &Path) -> Option<Vec<OsString>> {
    if !path.is_absolute() {
        return None;
    }
    path.components()
        .map(|component| match component {
            Component::Prefix(prefix) => Some(prefix.as_os_str().to_os_string()),
            Component::RootDir => Some(OsString::from(std::path::MAIN_SEPARATOR_STR)),
            Component::Normal(value) => Some(value.to_os_string()),
            Component::CurDir | Component::ParentDir => None,
        })
        .collect()
}

pub(super) fn is_strict_descendant(root: &[OsString], candidate: &[OsString]) -> bool {
    candidate.len() > root.len() && &candidate[..root.len()] == root
}

pub(in crate::services::operation_service) fn restore_trash_paths(
    payload: &UndoPayload,
) -> Vec<PathBuf> {
    payload
        .actions
        .iter()
        .filter_map(|action| match action {
            UndoAction::RestoreTrash { trash_path, .. } => Some(trash_path.clone()),
            _ => None,
        })
        .collect()
}

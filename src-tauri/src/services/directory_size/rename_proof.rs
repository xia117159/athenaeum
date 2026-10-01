use std::path::{Path, PathBuf};
use super::{target::normalize_local_path, watch::RootIdentity};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ObjectProof {
    pub identity: RootIdentity,
    pub attributes: u32,
    pub modified: u64,
    pub bytes: u64,
    pub directory: bool,
}

#[cfg(windows)]
pub(super) fn read_proof(path: &str) -> Option<ObjectProof> {
    use windows::Win32::{Foundation::CloseHandle, Storage::FileSystem::*};
    let path = windows_core::HSTRING::from(path);
    let handle = unsafe { CreateFileW(&path, FILE_READ_ATTRIBUTES.0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        None, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, None) }.ok()?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    let result = unsafe { GetFileInformationByHandle(handle, &mut info) };
    let _ = unsafe { CloseHandle(handle) };
    result.ok()?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 { return None; }
    Some(ObjectProof {
        identity: RootIdentity([u64::from(info.dwVolumeSerialNumber), (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
            (u64::from(info.ftCreationTime.dwHighDateTime) << 32) | u64::from(info.ftCreationTime.dwLowDateTime), 0]),
        attributes: info.dwFileAttributes,
        modified: (u64::from(info.ftLastWriteTime.dwHighDateTime) << 32) | u64::from(info.ftLastWriteTime.dwLowDateTime),
        bytes: (u64::from(info.nFileSizeHigh) << 32) | u64::from(info.nFileSizeLow),
        directory: info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0,
    })
}
#[cfg(not(windows))]
pub(super) fn read_proof(_path: &str) -> Option<ObjectProof> { None }

#[derive(Clone, Debug)]
pub(super) struct RenameItem {
    pub from: String, pub to: String, pub current: String,
    pub proof: ObjectProof, pub parent: RootIdentity,
}

pub(super) fn contains(root: &str, path: &str) -> bool {
    path == root || path.strip_prefix(root.trim_end_matches('\\')).is_some_and(|rest| rest.starts_with('\\'))
}
pub(super) fn overlaps(a: &str, b: &str) -> bool { contains(a, b) || contains(b, a) }
pub(super) fn rewrite(path: &str, from: &str, to: &str) -> String {
    if contains(from, path) { format!("{to}{}", &path[from.len()..]) } else { path.into() }
}
pub(super) fn normalize(path: &Path) -> Option<String> { normalize_local_path(path.to_str()?).ok() }
pub(super) fn parent(path: &str) -> Option<&str> { Path::new(path).parent()?.to_str() }

pub(super) fn prepare_items(paths: &[(PathBuf, PathBuf)]) -> Option<Vec<RenameItem>> {
    if paths.is_empty() || paths.len() > 2048 { return None; }
    let mut items: Vec<RenameItem> = vec![];
    for (from, to) in paths {
        let from = normalize(from)?; let to = normalize(to)?;
        if from == to { continue; }
        let proof = read_proof(&from)?;
        let parent_proof = read_proof(parent(&from)?)?;
        if !parent_proof.directory || parent(&from) != parent(&to) || Path::new(&to).try_exists().ok()? { return None; }
        // Windows namespace equivalence is deliberately more conservative than
        // cache identity: optimization never supports swaps/case-only aliases.
        if crate::services::batch_rename::native::same_name(&from, &to) { return None; }
        for item in &items {
            if [&from, &to].iter().any(|path| [&item.from, &item.to].iter().any(|other|
                overlaps(path, other) || crate::services::batch_rename::native::same_name(path, other))) { return None; }
        }
        items.push(RenameItem { current: from.clone(), from, to, proof, parent: parent_proof.identity });
    }
    Some(items)
}

pub(super) fn final_proofs_match(items: &[RenameItem]) -> bool {
    items.iter().all(|item| item.current == item.to && read_proof(&item.to).as_ref() == Some(&item.proof)
        && parent(&item.to).and_then(read_proof).is_some_and(|proof| proof.directory && proof.identity == item.parent))
}

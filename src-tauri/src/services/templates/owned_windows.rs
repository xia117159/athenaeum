use super::super::{
    compare_names,
    native::{DirectoryGuard, EntryHandle},
    same_path, streams,
};
use super::{same_identity, OwnedNode, OwnedTree};
use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

pub fn digest(
    file: &mut File,
    path: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(&str, u64),
) -> Result<Vec<u8>> {
    file.seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 256 * 1024];
    loop {
        check_cancel(cancel)?;
        let len = file.read(&mut buffer)?;
        if len == 0 {
            break;
        }
        hasher.update(&buffer[..len]);
        progress(&path.to_string_lossy(), len as u64);
    }
    Ok(hasher.finalize().to_vec())
}

fn check_cancel(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::SeqCst) {
        bail!("已取消校验，副本已保留");
    }
    Ok(())
}

struct Members(HashMap<PathBuf, Vec<String>>);
impl Members {
    fn new(tree: &OwnedTree, cancel: &AtomicBool) -> Result<Self> {
        let mut index = HashMap::<PathBuf, Vec<String>>::new();
        for node in &tree.nodes {
            check_cancel(cancel)?;
            if let (Some(parent), Some(name)) =
                (node.relative_path.parent(), node.relative_path.file_name())
            {
                index
                    .entry(parent.into())
                    .or_default()
                    .push(name.to_str().context("副本名称不是有效 Unicode")?.into());
            }
        }
        for names in index.values_mut() {
            names.sort_by(|a, b| compare_names(a, b));
        }
        Ok(Self(index))
    }
    fn check(
        &self,
        path: &Path,
        relative: &Path,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(&str, u64),
    ) -> Result<()> {
        let expected = self.0.get(relative).map(Vec::as_slice).unwrap_or_default();
        for entry in fs::read_dir(path)? {
            check_cancel(cancel)?;
            let entry = entry?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("副本名称不是有效 Unicode"))?;
            if expected
                .binary_search_by(|candidate| compare_names(candidate, &name))
                .is_err()
            {
                bail!("副本中已添加新内容，未撤销：{}", entry.path().display());
            }
            progress(&entry.path().to_string_lossy(), 0);
        }
        Ok(())
    }
}

fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).with_context(|| format!("无法校验副本：{}", path.display())),
    }
}

fn parent(tree: &OwnedTree) -> Result<DirectoryGuard> {
    let parent_path = tree.path.parent().context("无效的副本父目录")?;
    let recovery_parent = tree.recovery_path.parent().context("无效恢复路径")?;
    let name = tree
        .recovery_path
        .file_name()
        .and_then(|name| name.to_str())
        .context("无效恢复名称")?;
    let suffix = name
        .strip_prefix(".athenaeum-template-recovery-")
        .context("无效恢复位置")?;
    let id = uuid::Uuid::parse_str(suffix).context("无效恢复位置标识")?;
    if suffix != id.to_string()
        || !same_path(parent_path, recovery_parent)
        || same_path(&tree.path, &tree.recovery_path)
    {
        bail!(
            "恢复位置不在原父目录，未处理：{}",
            tree.recovery_path.display()
        );
    }
    let guard = DirectoryGuard::open(parent_path)?;
    if !same_identity(&guard.identity, &tree.parent_identity) {
        bail!("副本父目录已被替换：{}", parent_path.display());
    }
    Ok(guard)
}

fn root_node(tree: &OwnedTree) -> Result<&OwnedNode> {
    tree.nodes
        .first()
        .filter(|node| node.relative_path.as_os_str().is_empty())
        .context("副本根身份清单不存在")
}

/// Reconstruct display locations from a durable intent left by an interrupted undo.
/// Destructive operations still re-open and verify every object with exclusive guards.
pub fn refresh_recovery_locations(trees: &mut [OwnedTree]) {
    for tree in trees
        .iter_mut()
        .filter(|tree| tree.recovery_prepared && !tree.recovery_moved)
    {
        let found = (|| -> Result<bool> {
            let _parent = parent(tree)?;
            let expected = &root_node(tree)?.identity;
            if !same_identity(
                &EntryHandle::inspect_identity(&tree.recovery_path)?,
                expected,
            ) {
                return Ok(false);
            }
            Ok(!exists(&tree.path)?
                || !same_identity(&EntryHandle::inspect_identity(&tree.path)?, expected))
        })();
        if matches!(found, Ok(true)) {
            tree.recovery_moved = true;
        }
    }
}

#[derive(Default)]
struct ContentGuards {
    _entries: Vec<EntryHandle>,
    _streams: Vec<File>,
}
fn validate(
    tree: &OwnedTree,
    base: &Path,
    root: &EntryHandle,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(&str, u64),
) -> Result<ContentGuards> {
    let members = Members::new(tree, cancel)?;
    let mut guards = ContentGuards {
        _entries: Vec::new(),
        _streams: Vec::new(),
    };
    for node in &tree.nodes {
        check_cancel(cancel)?;
        let path = if node.relative_path.as_os_str().is_empty() {
            base.to_path_buf()
        } else {
            base.join(&node.relative_path)
        };
        let handle = if node.relative_path.as_os_str().is_empty() {
            root
        } else {
            if !exists(&path)? {
                continue;
            }
            guards._entries.push(EntryHandle::open(&path, false)?);
            guards._entries.last().unwrap()
        };
        if !same_identity(&handle.identity, &node.identity) || !same_path(&handle.path()?, &path) {
            bail!("副本已被替换，未撤销：{}", path.display());
        }
        if node.identity.is_directory() {
            members.check(&path, &node.relative_path, cancel, progress)?;
        } else if node.digest.as_ref()
            != Some(&digest(
                &mut handle.file.try_clone()?,
                &path,
                cancel,
                progress,
            )?)
        {
            bail!("副本内容已修改或未完整记录，未撤销：{}", path.display());
        }
        guards._streams.extend(streams::validate(
            handle,
            &path,
            &node.streams,
            cancel,
            progress,
        )?);
    }
    Ok(guards)
}

type ReadyRoot = (usize, DirectoryGuard, EntryHandle, ContentGuards);

fn preflight(
    trees: &mut [OwnedTree],
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(&str, u64),
    check_contents: bool,
) -> Result<Vec<ReadyRoot>> {
    let mut ready = Vec::new();
    // Validate the whole batch before any move. Unknown recovery names are never adopted.
    for (index, tree) in trees.iter_mut().enumerate() {
        check_cancel(cancel)?;
        let parent = parent(tree)?;
        let expected = &root_node(tree)?.identity;
        let recovered = if exists(&tree.recovery_path)? {
            if !tree.recovery_prepared {
                bail!("恢复位置已被占用：{}", tree.recovery_path.display());
            }
            Some(EntryHandle::open(&tree.recovery_path, true)?)
        } else {
            None
        };
        if let Some(recovered) = recovered {
            let original_is_same = exists(&tree.path)?
                && same_identity(&EntryHandle::inspect_identity(&tree.path)?, expected);
            if !same_identity(&recovered.identity, expected) || original_is_same {
                bail!(
                    "恢复副本身份不符或位置有歧义：{}",
                    tree.recovery_path.display()
                );
            }
            recovered.set_hidden(true)?;
            tree.recovery_moved = true;
            continue; // Previous attempt moved it; never touch a new object at the old name.
        }
        let source = exists(&tree.path)?
            .then(|| EntryHandle::open(&tree.path, true))
            .transpose()?;
        let Some(source) = source else {
            continue;
        };
        if !same_identity(&source.identity, expected) {
            bail!("副本已被替换，未撤销：{}", tree.path.display());
        }
        let contents = if check_contents {
            validate(tree, &tree.path, &source, cancel, progress)?
        } else {
            ContentGuards::default()
        };
        ready.push((index, parent, source, contents));
    }
    check_cancel(cancel)?;
    Ok(ready)
}

pub fn remove(
    trees: &mut [OwnedTree],
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(&str, u64),
    checkpoint: &mut dyn FnMut(&[OwnedTree]) -> Result<()>,
    begin_move: &mut dyn FnMut() -> Result<()>,
) -> Result<()> {
    let topology = preflight(trees, cancel, progress, false)?;
    let previous = trees.to_vec();
    for (index, _, root, _) in &topology {
        trees[*index].recovery_prepared = true;
        trees[*index].recovery_was_hidden = root.hidden()?;
    }
    // A journal may live below one of the guarded ancestors. Release the initial topology
    // guards for its atomic replacement, then re-open and validate the entire batch. No
    // path or content from before the checkpoint is trusted during the actual move.
    drop(topology);
    if let Err(error) = checkpoint(trees) {
        trees.clone_from_slice(&previous);
        return Err(error);
    }
    let ready = preflight(trees, cancel, progress, true)?;
    check_cancel(cancel)?;
    begin_move()?;
    for (index, parent, root, contents) in ready {
        let tree = &mut trees[index];
        // Descendant share locks can prevent directory rename. The whole object is retained,
        // so any subsequent writes follow it into recovery after these locks are released.
        drop(contents);
        root.rename_to(
            &parent,
            tree.recovery_path.file_name().unwrap().to_str().unwrap(),
        )?;
        tree.recovery_moved = true;
        #[cfg(test)]
        AFTER_RECOVERY_MOVE.with(|hook| {
            if let Some(hook) = hook.borrow_mut().as_mut() {
                hook(&tree.path, &tree.recovery_path);
            }
        });
        let checked = validate(
            tree,
            &tree.recovery_path,
            &root,
            &AtomicBool::new(false),
            &mut |_, _| {},
        );
        if let Err(error) = checked {
            let restored =
                root.rename_to(&parent, tree.path.file_name().unwrap().to_str().unwrap());
            return match restored {
                Ok(()) => {
                    tree.recovery_moved = false;
                    Err(error).context("副本在校验后改变，已保留并恢复原位置")
                }
                Err(restore) => Err(error).context(format!(
                    "副本已保留在 {}，原位置恢复失败：{restore:#}",
                    tree.recovery_path.display()
                )),
            };
        }
        // No automatic permanent deletion occurs after the final validation.
        root.set_hidden(true)
            .with_context(|| format!("副本已保留在 {}", tree.recovery_path.display()))?;
        progress(&tree.recovery_path.to_string_lossy(), 0);
    }
    Ok(())
}

fn purge(path: &Path, handle: EntryHandle) -> Result<()> {
    if handle.identity.is_directory() {
        for entry in fs::read_dir(path)? {
            let child = entry?.path();
            let handle = EntryHandle::open(&child, true)?;
            purge(&child, handle)?;
        }
    }
    handle
        .delete()
        .with_context(|| format!("无法清理恢复副本：{}", path.display()))
}

/// Requires the user's explicit confirmation to permanently discard recovery assets.
/// The caller keeps the journal mapping when any purge fails, allowing safe retry.
pub fn purge_recovery(trees: &[OwnedTree]) -> Result<()> {
    let mut ready = Vec::new();
    for tree in trees.iter().filter(|tree| tree.recovery_prepared) {
        let parent = parent(tree)?;
        if !exists(&tree.recovery_path)? {
            continue;
        }
        let root = EntryHandle::open(&tree.recovery_path, true)?;
        if !same_identity(&root.identity, &root_node(tree)?.identity) {
            bail!("恢复位置已被替换，未清理：{}", tree.recovery_path.display());
        }
        if exists(&tree.path)? {
            if same_identity(&EntryHandle::inspect_identity(&tree.path)?, &root.identity) {
                bail!("原位置与恢复位置存在硬链接歧义，未清理");
            }
        }
        ready.push((parent, tree.recovery_path.clone(), root));
    }
    for (_parent, path, root) in ready {
        purge(&path, root)?;
    }
    Ok(())
}

#[cfg(test)]
thread_local! {
    pub(super) static AFTER_RECOVERY_MOVE: std::cell::RefCell<Option<Box<dyn FnMut(&Path, &Path)>>> = const { std::cell::RefCell::new(None) };
}

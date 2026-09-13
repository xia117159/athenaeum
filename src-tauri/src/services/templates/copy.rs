use super::{
    contains_path,
    native::{DirectoryGuard, EntryHandle},
    open_root,
    owned::{self, OwnedNode, OwnedTree},
    relative_path, relative_text, same_name, streams, validate_name,
};
use anyhow::{bail, Context, Result};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Default)]
pub struct CopyOutcome {
    pub created: Vec<(PathBuf, PathBuf)>,
    pub owned: Vec<OwnedTree>,
    pub failures: Vec<(PathBuf, String)>,
    pub cancelled: bool,
}
struct Planned {
    source: PathBuf,
    relative: PathBuf,
    directory: bool,
    base: String,
}

fn check_cancel(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::SeqCst) {
        bail!("已取消创建");
    }
    Ok(())
}
fn plan(root: &Path, destination: &Path, paths: &[String]) -> Result<Vec<Planned>> {
    if paths.is_empty() {
        bail!("请先选择模板");
    }
    let mut selected: Vec<Planned> = Vec::new();
    for text in paths {
        let relative = relative_path(text, false)?;
        let parent = DirectoryGuard::open(&root.join(&relative).parent().context("无效模板路径")?)?;
        let handle = EntryHandle::open(&parent.path.join(relative.file_name().unwrap()), false)?;
        let source = handle.path()?;
        if !contains_path(root, &source) {
            bail!("模板路径超出已配置的文件夹");
        }
        if handle.identity.is_directory() && contains_path(&source, destination) {
            bail!("不能把模板文件夹复制到自身或其子文件夹");
        }
        if selected
            .iter()
            .any(|item| super::same_path(&item.source, &source))
        {
            continue;
        }
        selected.push(Planned {
            relative: source.strip_prefix(root)?.to_path_buf(),
            source,
            directory: handle.identity.is_directory(),
            base: String::new(),
        });
    }
    let parents = selected
        .iter()
        .filter(|item| item.directory)
        .map(|item| item.source.clone())
        .collect::<Vec<_>>();
    selected.retain(|item| {
        !parents.iter().any(|parent| {
            !super::same_path(parent, &item.source) && contains_path(parent, &item.source)
        })
    });
    let names = selected
        .iter()
        .map(|item| {
            item.source
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        })
        .collect::<Vec<_>>();
    for (index, item) in selected.iter_mut().enumerate() {
        item.base = if names
            .iter()
            .filter(|name| same_name(name, &names[index]))
            .count()
            > 1
        {
            relative_text(&item.relative)?.replace('/', "-")
        } else {
            names[index].clone()
        };
        validate_name(&item.base)?;
    }
    Ok(selected)
}

fn numbered_name(base: &str, directory: bool, index: usize) -> String {
    if index == 0 {
        return base.into();
    }
    if !directory {
        if let Some(dot) = base.rfind('.').filter(|dot| *dot > 0) {
            return format!("{} ({index}){}", &base[..dot], &base[dot..]);
        }
    }
    format!("{base} ({index})")
}

fn copy_node(
    source: &Path,
    target: &Path,
    relative: &Path,
    tree: &mut OwnedTree,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(&str, u64),
) -> Result<()> {
    check_cancel(cancel)?;
    let metadata = fs::symlink_metadata(source)?;
    if super::native::is_reparse(&metadata) {
        bail!("模板不支持符号链接或目录联接：{}", source.display());
    }
    if metadata.is_dir() {
        let source_guard = DirectoryGuard::open(source)?;
        let target_handle = EntryHandle::create_directory(target)?;
        let index = tree.nodes.len();
        tree.nodes.push(OwnedNode {
            relative_path: relative.to_path_buf(),
            identity: target_handle.identity.clone(),
            digest: None,
            streams: Vec::new(),
        });
        streams::copy(
            &EntryHandle::open(source, false)?,
            source,
            target,
            &mut tree.nodes[index].streams,
            cancel,
            progress,
        )?;
        let mut children =
            fs::read_dir(&source_guard.path)?.collect::<std::io::Result<Vec<_>>>()?;
        children.sort_by(|a, b| {
            super::compare_names(
                &a.file_name().to_string_lossy(),
                &b.file_name().to_string_lossy(),
            )
        });
        for child in children {
            let name = child.file_name();
            validate_name(name.to_str().context("模板名称不是有效 Unicode")?)?;
            copy_node(
                &child.path(),
                &target.join(&name),
                &relative.join(&name),
                tree,
                cancel,
                progress,
            )
            .with_context(|| {
                format!(
                    "无法复制模板子项 {} 到 {}",
                    child.path().display(),
                    target.join(&name).display()
                )
            })?;
        }
        progress(&target.to_string_lossy(), 0);
    } else {
        let mut input = EntryHandle::open(source, false)?;
        let mut output = EntryHandle::create_file(target)?;
        let index = tree.nodes.len();
        tree.nodes.push(OwnedNode {
            relative_path: relative.to_path_buf(),
            identity: output.identity.clone(),
            digest: None,
            streams: Vec::new(),
        });
        let copied =
            streams::copy_contents(&mut input.file, &mut output.file, target, cancel, progress);
        match copied {
            Ok(hash) => tree.nodes[index].digest = Some(hash),
            Err(error) => {
                // Record only bytes in our still-protected handle, including a partial write.
                tree.nodes[index].digest = owned::digest(
                    &mut output.file,
                    target,
                    &AtomicBool::new(false),
                    &mut |_, _| {},
                )
                .ok();
                return Err(error);
            }
        }
        streams::copy(
            &input,
            source,
            target,
            &mut tree.nodes[index].streams,
            cancel,
            progress,
        )?;
    }
    Ok(())
}

pub fn create(
    root: &str,
    expected: &str,
    destination: &str,
    paths: &[String],
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(&str, u64),
) -> Result<CopyOutcome> {
    let root = open_root(root, expected)?;
    let destination = DirectoryGuard::open(Path::new(destination))?;
    let items = plan(&root.path, &destination.path, paths)?;
    let mut occupied = fs::read_dir(&destination.path)?
        .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
        .collect::<std::io::Result<Vec<_>>>()?;
    let mut out = CopyOutcome::default();
    for item in items {
        if cancel.load(Ordering::SeqCst) {
            out.cancelled = true;
            break;
        }
        let parent_guard = match DirectoryGuard::open(item.source.parent().unwrap()) {
            Ok(parent) => parent,
            Err(error) => {
                out.failures
                    .push((item.source.clone(), format!("{error:#}")));
                continue;
            }
        };
        let mut counter = 0usize;
        loop {
            let name = numbered_name(&item.base, item.directory, counter);
            if let Err(error) = validate_name(&name) {
                out.failures.push((item.source.clone(), error.to_string()));
                break;
            }
            if occupied.iter().any(|existing| same_name(existing, &name)) {
                counter += 1;
                continue;
            }
            let path = destination.path.join(&name);
            let mut tree = OwnedTree {
                path: path.clone(),
                parent_identity: destination.identity.clone(),
                nodes: Vec::new(),
                recovery_path: destination.path.join(format!(
                    ".athenaeum-template-recovery-{}",
                    uuid::Uuid::new_v4()
                )),
                recovery_prepared: false,
                recovery_moved: false,
                recovery_was_hidden: false,
            };
            let result = copy_node(
                &parent_guard.path.join(item.source.file_name().unwrap()),
                &path,
                Path::new(""),
                &mut tree,
                cancel,
                progress,
            );
            if tree.nodes.is_empty()
                && result
                    .as_ref()
                    .err()
                    .and_then(|e| e.downcast_ref::<std::io::Error>())
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::AlreadyExists)
            {
                occupied.push(name);
                counter += 1;
                continue;
            }
            occupied.push(name);
            match result {
                Ok(()) => {
                    out.created.push((item.source.clone(), path));
                    out.owned.push(tree);
                }
                Err(error) => {
                    let mut message = format!(
                        "无法复制 {} 到 {}：{error:#}",
                        item.source.display(),
                        path.display()
                    );
                    if !tree.nodes.is_empty() {
                        message.push_str(&format!(
                            "；不完整副本已保留，可从操作历史撤销：{}",
                            tree.path.display()
                        ));
                        out.owned.push(tree);
                    }
                    out.failures.push((item.source.clone(), message));
                }
            }
            break;
        }
        if cancel.load(Ordering::SeqCst) {
            out.cancelled = true;
            break;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests;

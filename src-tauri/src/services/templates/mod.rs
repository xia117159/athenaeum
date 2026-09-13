use crate::{
    domain::models::{CreationTemplateEntry, CreationTemplateListing, TemplateEntryKind},
    services::batch_rename::{
        native::{compare_names, same_name},
        plan,
    },
};
use anyhow::{bail, Context, Result};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[cfg(windows)]
pub mod copy;
#[cfg(windows)]
pub(crate) mod native;
pub mod owned;
pub mod picker;
#[cfg(windows)]
mod streams;

pub(super) fn validate_name(name: &str) -> Result<()> {
    plan::validate_name(name).map_err(anyhow::Error::msg)
}
pub(super) fn relative_path(text: &str, allow_root: bool) -> Result<PathBuf> {
    if text.is_empty() && allow_root {
        return Ok(PathBuf::new());
    }
    let mut path = PathBuf::new();
    for part in text.split(['/', '\\']) {
        validate_name(part)?;
        path.push(part);
    }
    Ok(path)
}
pub(super) fn relative_text(path: &Path) -> Result<String> {
    Ok(path
        .to_str()
        .context("模板路径不是有效 Unicode")?
        .replace('\\', "/"))
}
pub(super) fn same_path(left: &Path, right: &Path) -> bool {
    left.components().count() == right.components().count() && contains_path(left, right)
}
pub(super) fn contains_path(parent: &Path, child: &Path) -> bool {
    let a = parent.components().collect::<Vec<_>>();
    let b = child.components().collect::<Vec<_>>();
    b.len() >= a.len()
        && a.iter().zip(b).all(|(x, y)| {
            same_name(
                &x.as_os_str().to_string_lossy(),
                &y.as_os_str().to_string_lossy(),
            )
        })
}

#[cfg(windows)]
pub fn list(root: &str, expected: &str, relative: &str) -> Result<CreationTemplateListing> {
    let root = open_root(root, expected)?;
    let suffix = relative_path(relative, true)?;
    let folder = native::DirectoryGuard::open(&root.path.join(&suffix))?;
    let mut entries = Vec::new();
    for child in fs::read_dir(&folder.path).context("无法读取模板文件夹")? {
        let child = child.context("无法读取模板目录项目")?;
        let metadata = fs::symlink_metadata(child.path()).context("无法读取模板项目属性")?;
        if native::is_reparse(&metadata) {
            continue;
        }
        let name = child
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("模板名称不是有效 Unicode"))?;
        validate_name(&name)?;
        entries.push(CreationTemplateEntry {
            relative_path: relative_text(&suffix.join(&name))?,
            name,
            path: child.path().to_string_lossy().into_owned(),
            kind: if metadata.is_dir() {
                TemplateEntryKind::Directory
            } else {
                TemplateEntryKind::File
            },
        });
    }
    entries.sort_by(|a, b| {
        (a.kind != TemplateEntryKind::Directory)
            .cmp(&(b.kind != TemplateEntryKind::Directory))
            .then_with(|| compare_names(&a.name, &b.name))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(CreationTemplateListing {
        root_path: root.path.to_string_lossy().into_owned(),
        relative_path: relative_text(&suffix)?,
        entries,
    })
}

#[cfg(windows)]
pub(super) fn open_root(root: &str, expected: &str) -> Result<native::DirectoryGuard> {
    if root.trim().is_empty() {
        bail!("尚未配置模板文件夹，请打开新建项目设置");
    }
    let root = native::DirectoryGuard::open(Path::new(root.trim()))?;
    if !expected.trim().is_empty() {
        let expected = native::DirectoryGuard::open(Path::new(expected.trim()))
            .context("模板文件夹设置已改变或不可用，请刷新菜单")?;
        if !owned::same_identity(&root.identity, &expected.identity)
            || !same_path(&root.path, &expected.path)
        {
            bail!("模板文件夹设置已改变，请刷新菜单");
        }
    }
    Ok(root)
}

#[cfg(not(windows))]
pub fn list(_root: &str, _expected: &str, _relative: &str) -> Result<CreationTemplateListing> {
    bail!("新建项目目前仅支持 Windows 文件系统")
}

#[cfg(all(test, windows))]
mod tests;

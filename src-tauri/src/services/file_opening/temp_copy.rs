use anyhow::{bail, Context, Result};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(super) struct TempCopy {
    root: PathBuf,
    pub path: PathBuf,
    retained: bool,
}
impl TempCopy {
    pub fn create(base: &Path, name: &str) -> Result<Self> {
        validate_file_name(name)?;
        if !base.is_absolute() {
            bail!("临时目录必须是绝对路径");
        }
        let root = base.join(format!("athenaeum-open-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).context("无法创建临时文件目录")?;
        let path = root.join(name);
        Ok(Self {
            root,
            path,
            retained: false,
        })
    }
    pub fn validate(&self) -> Result<()> {
        let metadata = fs::symlink_metadata(&self.path).context("未能下载远程文件")?;
        if !metadata.file_type().is_file() {
            bail!("下载结果不是普通文件");
        }
        let root = fs::canonicalize(&self.root)?;
        let target = fs::canonicalize(&self.path)?;
        if target.parent() != Some(root.as_path()) {
            bail!("下载结果超出本次临时目录");
        }
        Ok(())
    }
    pub fn retain(&mut self) {
        self.retained = true;
    }
}
impl Drop for TempCopy {
    fn drop(&mut self) {
        if !self.retained {
            if let Err(error) = fs::remove_dir_all(&self.root) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    eprintln!("无法清理文件打开临时目录 {}: {error}", self.root.display());
                }
            }
        }
    }
}

pub(crate) fn validate_file_name(name: &str) -> Result<()> {
    let base = name.split('.').next().unwrap_or("").to_uppercase();
    let device = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            base.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        });
    if name.is_empty()
        || name.ends_with(['.', ' '])
        || name.encode_utf16().count() > 255
        || device
        || name
            .chars()
            .any(|ch| ch.is_control() || r#"\/:*?"<>|"#.contains(ch))
    {
        bail!("远程文件名不能用作 Windows 临时文件名：{name}");
    }
    Ok(())
}

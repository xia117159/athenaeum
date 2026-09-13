use crate::domain::models::AssociationProgramInfo;
use anyhow::{bail, Context, Result};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::SystemTime,
};

#[cfg(windows)]
#[path = "programs_windows.rs"]
mod native;

#[derive(Clone)]
struct CachedName {
    stamp: (u64, Option<SystemTime>),
    name: String,
}

#[derive(Default)]
pub struct ProgramInfoCache {
    names: Mutex<HashMap<PathBuf, CachedName>>,
}

impl ProgramInfoCache {
    pub fn inspect(&self, paths: &[String]) -> Vec<AssociationProgramInfo> {
        paths
            .iter()
            .map(|path| {
                let target = Path::new(path);
                let metadata = fs::metadata(target)
                    .ok()
                    .filter(|metadata| metadata.is_file());
                let stamp = metadata
                    .as_ref()
                    .map(|metadata| (metadata.len(), metadata.modified().ok()));
                let cached = self
                    .names
                    .lock()
                    .expect("program cache lock poisoned")
                    .get(target)
                    .cloned();
                let display_name = match (stamp, cached) {
                    (Some(stamp), Some(cached)) if stamp == cached.stamp => cached.name,
                    (Some(stamp), _) => {
                        let name = file_description(target).unwrap_or_else(|| fallback_name(path));
                        let mut names = self.names.lock().expect("program cache lock poisoned");
                        if names.len() >= 256 {
                            names.clear();
                        }
                        names.insert(
                            target.into(),
                            CachedName {
                                stamp,
                                name: name.clone(),
                            },
                        );
                        name
                    }
                    _ => {
                        self.names
                            .lock()
                            .expect("program cache lock poisoned")
                            .remove(target);
                        fallback_name(path)
                    }
                };
                AssociationProgramInfo {
                    path: path.clone(),
                    display_name,
                    exists: metadata.is_some(),
                }
            })
            .collect()
    }
}

fn fallback_name(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
        .to_string()
}

pub fn program_command(path: &str, args: &[String]) -> Result<Command> {
    let target = Path::new(super::rules::executable_path(path));
    if !target.is_absolute() {
        bail!("程序路径必须是完整的绝对路径");
    }
    let target =
        fs::canonicalize(target).with_context(|| format!("程序不存在或无法访问：{path}"))?;
    if !target.is_file() {
        bail!("程序路径不是文件：{path}");
    }
    // Check the resolved path, including Windows removal of terminal dots/spaces.
    if target
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("bat") || ext.eq_ignore_ascii_case("cmd"))
    {
        bail!("不能直接运行批处理脚本，请选择可执行程序（如 .exe）");
    }
    let mut command = Command::new(&target);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(parent) = target.parent() {
        command.current_dir(parent);
    }
    Ok(command)
}

#[cfg(windows)]
pub fn choose_program(owner: isize) -> Result<Option<String>> {
    crate::services::windows_sta::run(move || native::choose_program(owner))
}
#[cfg(not(windows))]
pub fn choose_program(_owner: isize) -> Result<Option<String>> {
    bail!("程序选择框需要 Windows 桌面版")
}

pub fn file_description(path: &Path) -> Option<String> {
    #[cfg(windows)]
    {
        native::file_description(path)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        None
    }
}

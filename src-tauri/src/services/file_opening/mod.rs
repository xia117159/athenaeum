pub mod registry;
mod temp_copy;
use super::file_associations;
use crate::domain::models::{
    FileAssociationRule, FileOpenPhase, FileOpenProgress, FileOpenRequest, FileOpenResult,
    FileOpenTarget,
};
use anyhow::{bail, Context, Result};
use registry::OpenJob;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Debug, Clone)]
pub struct FileOpenPlan {
    pub target: FileOpenTarget,
    pub association: Option<FileAssociationRule>,
}
#[derive(Debug)]
pub struct FileLaunch {
    pub path: PathBuf,
    pub program: Option<String>,
    pub arguments: Vec<String>,
    pub association_id: Option<String>,
}
pub fn plan_open(request: &FileOpenRequest, rules: &[FileAssociationRule]) -> Result<FileOpenPlan> {
    let path = request.target.path();
    if path.is_empty() || path.contains('\0') {
        bail!("文件路径无效");
    }
    let association = if let Some(id) = &request.association_id {
        Some(
            rules
                .iter()
                .find(|rule| &rule.id == id && file_associations::matches(rule, path))
                .context("关联已改变或不适用于此文件，请重新打开菜单")?,
        )
    } else {
        rules
            .iter()
            .find(|rule| file_associations::matches(rule, path))
    };
    Ok(FileOpenPlan {
        target: request.target.clone(),
        association: association.cloned(),
    })
}
pub fn execute(
    plan: &FileOpenPlan,
    job: &OpenJob,
    temp_base: &Path,
    mut download: impl FnMut(&FileOpenTarget, &Path, &AtomicBool, &mut dyn FnMut(u64)) -> Result<()>,
    mut launch: impl FnMut(&FileLaunch) -> Result<()>,
    mut progress: impl FnMut(FileOpenProgress),
) -> Result<FileOpenResult> {
    progress(FileOpenProgress {
        phase: FileOpenPhase::Preparing,
        completed_bytes: None,
    });
    if job.cancelled().load(Ordering::Acquire) {
        return Ok(FileOpenResult::Cancelled);
    }
    let mut copy = None;
    let path = match &plan.target {
        FileOpenTarget::Local { path } => {
            let path = PathBuf::from(path);
            if !path.is_absolute() || !fs::metadata(&path).is_ok_and(|metadata| metadata.is_file())
            {
                bail!("文件不存在、无法访问或不是普通文件：{}", path.display());
            }
            path
        }
        FileOpenTarget::Remote { path, .. } => {
            let name = path.rsplit('/').next().unwrap_or("");
            let temporary = temp_copy::TempCopy::create(temp_base, name)?;
            progress(FileOpenProgress {
                phase: FileOpenPhase::Downloading,
                completed_bytes: Some(0),
            });
            if job.cancelled().load(Ordering::Acquire) {
                return Ok(FileOpenResult::Cancelled);
            }
            let result = download(
                &plan.target,
                &temporary.path,
                job.cancelled(),
                &mut |bytes| {
                    progress(FileOpenProgress {
                        phase: FileOpenPhase::Downloading,
                        completed_bytes: Some(bytes),
                    });
                },
            );
            if job.cancelled().load(Ordering::Acquire) {
                return Ok(FileOpenResult::Cancelled);
            }
            result?;
            temporary.validate()?;
            let path = temporary.path.clone();
            copy = Some(temporary);
            path
        }
    };
    let local_path = path.to_string_lossy().into_owned();
    let invocation = FileLaunch {
        path,
        program: plan
            .association
            .as_ref()
            .map(|rule| rule.executable_path.clone()),
        arguments: plan
            .association
            .as_ref()
            .map(|rule| file_associations::file_arguments(&rule.arguments_template, &local_path))
            .transpose()?
            .unwrap_or_default(),
        association_id: plan.association.as_ref().map(|rule| rule.id.clone()),
    };
    if !job.begin_launch() {
        return Ok(FileOpenResult::Cancelled);
    }
    progress(FileOpenProgress {
        phase: FileOpenPhase::Opening,
        completed_bytes: None,
    });
    launch(&invocation)?;
    if let Some(copy) = &mut copy {
        copy.retain();
    }
    Ok(FileOpenResult::Opened {
        local_path,
        association_id: invocation.association_id,
    })
}

pub fn launch_file(invocation: &FileLaunch) -> Result<()> {
    if let Some(program) = &invocation.program {
        file_associations::programs::program_command(program, &invocation.arguments)?
            .spawn()
            .with_context(|| format!("无法启动程序：{program}"))?;
        Ok(())
    } else {
        let path = invocation.path.to_string_lossy().into_owned();
        #[cfg(windows)]
        {
            super::windows_sta::run(move || {
                super::windows_shell::open_path_with_system_default(path)
            })
        }
        #[cfg(not(windows))]
        {
            super::windows_shell::open_path_with_system_default(path)
        }
    }
}

#[cfg(test)]
mod tests;

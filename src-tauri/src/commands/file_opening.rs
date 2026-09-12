use crate::{
    domain::models::{
        AssociationProgramInfo, FileOpenProgress, FileOpenRequest, FileOpenResult, FileOpenTarget,
    },
    services::{file_associations::programs, file_opening, remote_service, AppState},
};
use std::sync::Arc;
use tauri::{ipc::Channel, State, WebviewWindow};

#[tauri::command]
pub async fn open_file(
    request: FileOpenRequest,
    on_progress: Channel<FileOpenProgress>,
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> Result<FileOpenResult, String> {
    let registration = state
        .file_open_jobs
        .register(window.label(), &request.request_id)
        .map_err(|error| error.to_string())?;
    let (plan, profile) = {
        let metadata = state.metadata.read().expect("metadata lock poisoned");
        let plan = file_opening::plan_open(&request, &metadata.file_associations)
            .map_err(|error| error.to_string())?;
        let profile = match &plan.target {
            FileOpenTarget::Remote { profile_id, .. } => Some(
                metadata
                    .remote_profiles
                    .iter()
                    .find(|profile| &profile.id == profile_id)
                    .cloned()
                    .ok_or("远程连接配置不存在，请重新连接")?,
            ),
            _ => None,
        };
        (plan, profile)
    };
    tauri::async_runtime::spawn_blocking(move || {
        let job = &registration.job;
        file_opening::execute(
            &plan,
            job,
            &std::env::temp_dir(),
            |target, local, cancelled, progress| {
                let FileOpenTarget::Remote { path, .. } = target else {
                    anyhow::bail!("下载目标不是远程文件");
                };
                let mut profile = profile
                    .clone()
                    .ok_or_else(|| anyhow::anyhow!("远程连接配置不可用"))?;
                if profile.password.is_none() {
                    profile.password = profile
                        .credential_target
                        .as_deref()
                        .and_then(remote_service::read_password_from_credential);
                }
                remote_service::open_download::download_file(
                    &profile, path, local, cancelled, progress,
                )
            },
            file_opening::launch_file,
            |progress| {
                if on_progress.send(progress).is_err() {
                    job.cancel();
                }
            },
        )
        .map_err(|error| format!("{error:#}"))
        // The registration guard removes this job on success, cancellation and failure.
    })
    .await
    .map_err(|error| format!("文件打开任务异常：{error}"))?
}

#[tauri::command]
pub fn cancel_file_open(
    request_id: String,
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> bool {
    state.file_open_jobs.cancel(window.label(), &request_id)
}

#[tauri::command]
pub async fn inspect_association_programs(
    paths: Vec<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<AssociationProgramInfo>, String> {
    if paths.len() > 64
        || paths
            .iter()
            .any(|path| path.len() > 32768 || path.contains('\0'))
    {
        return Err("程序信息请求过大或路径无效".into());
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.association_programs.inspect(&paths))
        .await
        .map_err(|error| format!("读取程序信息失败：{error}"))
}

#[tauri::command]
pub async fn choose_association_program(window: WebviewWindow) -> Result<Option<String>, String> {
    #[cfg(windows)]
    let owner = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
    #[cfg(not(windows))]
    let owner = {
        let _ = window;
        0
    };
    tauri::async_runtime::spawn_blocking(move || {
        programs::choose_program(owner).map_err(|error| format!("{error:#}"))
    })
    .await
    .map_err(|error| format!("程序选择框异常：{error}"))?
}

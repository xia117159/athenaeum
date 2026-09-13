use anyhow::{Context, Result};

pub fn choose(owner: isize) -> Result<Option<String>> {
    #[cfg(windows)]
    return crate::services::windows_sta::run(move || choose_windows(owner));
    #[cfg(not(windows))]
    {
        let _ = owner;
        anyhow::bail!("文件夹选择框仅支持 Windows")
    }
}

#[cfg(windows)]
fn choose_windows(owner: isize) -> Result<Option<String>> {
    use windows::{
        core::{w, HRESULT},
        Win32::{
            Foundation::{ERROR_CANCELLED, HWND},
            System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_INPROC_SERVER},
            UI::Shell::{
                FileOpenDialog, IFileOpenDialog, FOS_FORCEFILESYSTEM, FOS_PATHMUSTEXIST,
                FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
            },
        },
    };
    unsafe {
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
            .context("无法创建文件夹选择框")?;
        dialog.SetTitle(w!("选择模板文件夹"))?;
        dialog.SetOptions(
            dialog.GetOptions()? | FOS_PICKFOLDERS | FOS_PATHMUSTEXIST | FOS_FORCEFILESYSTEM,
        )?;
        match dialog.Show(Some(HWND(owner as *mut std::ffi::c_void))) {
            Err(error) if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) => {
                return Ok(None)
            }
            result => result.context("无法显示模板文件夹选择框")?,
        }
        let path = dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
        let result = path.to_string();
        CoTaskMemFree(Some(path.0.cast()));
        Ok(Some(result.context("无法读取所选文件夹路径")?))
    }
}

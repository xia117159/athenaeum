pub(crate) const MAIN_WEBVIEW_LABEL: &str = "main";

pub(crate) fn should_install_for_label(label: &str) -> bool {
    label == MAIN_WEBVIEW_LABEL
}

#[cfg(windows)]
mod imp {
    use anyhow::Context;
    use tauri::{Runtime, WebviewWindow};
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::ICoreWebView2,
        ProcessFailedEventHandler,
    };

    pub(crate) fn install<R: Runtime>(window: &WebviewWindow<R>) -> anyhow::Result<()> {
        window
            .with_webview(|webview| {
                let core: ICoreWebView2 = match unsafe { webview.controller().CoreWebView2() } {
                    Ok(core) => core,
                    Err(error) => {
                        eprintln!("failed to access WebView2 for crash recovery: {error}");
                        return;
                    }
                };

                let handler = ProcessFailedEventHandler::create(Box::new(|sender, _args| {
                    if let Some(sender) = sender {
                        // WebView2 automatically starts a replacement browser process after a
                        // crash. Reloading the current document clears the native crash page.
                        let _ = unsafe { sender.Reload() };
                    }
                    Ok(())
                }));
                let mut token = 0_i64;
                if let Err(error) = unsafe { core.add_ProcessFailed(&handler, &mut token) } {
                    eprintln!("failed to install WebView2 crash recovery: {error}");
                }
            })
            .context("failed to schedule WebView2 crash recovery")
    }
}

#[cfg(windows)]
pub(crate) use imp::install;

#[cfg(not(windows))]
pub(crate) fn install<R: tauri::Runtime>(
    _window: &tauri::WebviewWindow<R>,
) -> anyhow::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{should_install_for_label, MAIN_WEBVIEW_LABEL};

    #[test]
    fn recovery_is_installed_only_for_the_main_webview() {
        assert!(should_install_for_label(MAIN_WEBVIEW_LABEL));
        assert!(!should_install_for_label("settings"));
        assert!(!should_install_for_label("comment-editor"));
    }
}

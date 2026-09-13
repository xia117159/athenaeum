use anyhow::{Context, Result};
use windows::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
};

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}

/// Native dialogs and shell verbs must not inherit the blocking pool's COM mode.
pub(crate) fn run<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    std::thread::Builder::new()
        .name("windows-shell-sta".into())
        .spawn(move || with_apartment(operation))
        .context("无法创建 Windows 操作线程")?
        .join()
        .map_err(|_| anyhow::anyhow!("Windows 操作线程异常"))?
}

fn with_apartment<T>(operation: impl FnOnce() -> Result<T>) -> Result<T> {
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }
        .ok()
        .context("无法初始化 Windows 操作环境")?;
    let _apartment = Apartment;
    operation()
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::System::Com::{
        CoGetApartmentType, CoInitializeEx, CoUninitialize, APTTYPE, APTTYPEQUALIFIER,
        APTTYPE_MAINSTA, APTTYPE_MTA, APTTYPE_STA, COINIT_MULTITHREADED,
    };

    fn apartment() -> Result<APTTYPE, windows::core::Error> {
        let mut kind = APTTYPE::default();
        let mut qualifier = APTTYPEQUALIFIER::default();
        unsafe {
            CoGetApartmentType(&mut kind, &mut qualifier)?;
        }
        Ok(kind)
    }

    #[test]
    fn windows_sta_initializes_the_entire_operation_and_balances_errors() {
        std::thread::spawn(|| {
            let result: Result<()> = with_apartment(|| {
                assert!(
                    matches!(apartment().ok(), Some(APTTYPE_STA | APTTYPE_MAINSTA)),
                    "shell callbacks need an initialized STA"
                );
                anyhow::bail!("native operation failed");
            });
            assert_eq!(result.unwrap_err().to_string(), "native operation failed");
            // Other threads may create an implicit process-wide MTA meanwhile.
            // A leaked STA would reject this mode change with RPC_E_CHANGED_MODE.
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
                .ok()
                .expect("the completed operation must release its STA even on failure");
            unsafe {
                CoUninitialize();
            }
        })
        .join()
        .unwrap();
    }

    #[test]
    fn windows_sta_uses_a_fresh_thread_without_changing_an_mta_caller() {
        std::thread::spawn(|| {
            unsafe {
                CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap();
            }
            struct CallerApartment;
            impl Drop for CallerApartment {
                fn drop(&mut self) {
                    unsafe {
                        CoUninitialize();
                    }
                }
            }
            let _caller_apartment = CallerApartment;
            let caller = std::thread::current().id();
            run(move || {
                assert_ne!(std::thread::current().id(), caller);
                assert!(
                    matches!(apartment().ok(), Some(APTTYPE_STA | APTTYPE_MAINSTA)),
                    "a pool MTA must not determine shell apartment type"
                );
                Ok(())
            })
            .unwrap();
            assert_eq!(apartment().unwrap(), APTTYPE_MTA);
        })
        .join()
        .unwrap();
    }
}

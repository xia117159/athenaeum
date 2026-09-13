use anyhow::{bail, Result};
use windows::{
    core::Interface,
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        UI::Shell::{
            DefSubclassProc, IContextMenu, IContextMenu2, IContextMenu3, RemoveWindowSubclass,
            SetWindowSubclass,
        },
    },
};

const NATIVE_CONTEXT_MENU_SUBCLASS_ID: usize = 0xA7E;

enum MessageTarget {
    V3(IContextMenu3),
    V2(IContextMenu2),
}

impl MessageTarget {
    fn from_context_menu(context_menu: &IContextMenu) -> Option<Self> {
        context_menu
            .cast::<IContextMenu3>()
            .map(Self::V3)
            .or_else(|_| context_menu.cast::<IContextMenu2>().map(Self::V2))
            .ok()
    }

    unsafe fn handle(
        &self,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> windows::core::Result<LRESULT> {
        match self {
            Self::V3(context_menu) => {
                let mut result = LRESULT(0);
                context_menu.HandleMenuMsg2(
                    message,
                    wparam,
                    lparam,
                    Some(&mut result as *mut LRESULT),
                )?;
                Ok(result)
            }
            Self::V2(context_menu) => {
                context_menu.HandleMenuMsg(message, wparam, lparam)?;
                Ok(LRESULT(0))
            }
        }
    }
}

struct State {
    target: MessageTarget,
}

pub(crate) struct Guard {
    hwnd: HWND,
    state: *mut State,
}

impl Drop for Guard {
    fn drop(&mut self) {
        unsafe {
            let _ = RemoveWindowSubclass(
                self.hwnd,
                Some(subclass_proc),
                NATIVE_CONTEXT_MENU_SUBCLASS_ID,
            );
            drop(Box::from_raw(self.state));
        }
    }
}

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    ref_data: usize,
) -> LRESULT {
    if crate::services::native_menu_contract::shell_menu_message_requires_forwarding(message) {
        if let Some(state) = (ref_data as *const State).as_ref() {
            if let Ok(result) = state.target.handle(message, wparam, lparam) {
                return result;
            }
        }
    }

    DefSubclassProc(hwnd, message, wparam, lparam)
}

pub(crate) fn attach(hwnd: HWND, context_menu: &IContextMenu) -> Result<Option<Guard>> {
    let Some(target) = MessageTarget::from_context_menu(context_menu) else {
        return Ok(None);
    };
    let state = Box::into_raw(Box::new(State { target }));
    let installed = unsafe {
        SetWindowSubclass(
            hwnd,
            Some(subclass_proc),
            NATIVE_CONTEXT_MENU_SUBCLASS_ID,
            state as usize,
        )
        .as_bool()
    };
    if !installed {
        unsafe { drop(Box::from_raw(state)) };
        bail!("failed to attach shell context menu message handler");
    }

    Ok(Some(Guard { hwnd, state }))
}

use super::*;
use std::ops::Range;
use windows::{
    core::{HRESULT, PSTR, PWSTR},
    Win32::UI::{
        Shell::{CMF_CANRENAME, GCS_VERBW},
        WindowsAndMessaging::{
            DeleteMenu, GetMenuItemCount, GetMenuItemInfoW, InsertMenuItemW, MENUITEMINFOW,
            MFT_SEPARATOR, MF_BYPOSITION, MIIM_FTYPE, MIIM_ID, MIIM_STRING, MIIM_SUBMENU,
        },
    },
};

const SELECTION_CMD_BATCH_RENAME: u32 = 6;

fn shell_command_range(query_result: HRESULT) -> Result<Range<u32>> {
    query_result
        .ok()
        .context("failed to populate shell context menu")?;
    // QueryContextMenu returns the allocated command count in the low word.
    let end = SELECTION_SHELL_CMD_FIRST + (query_result.0 as u32 & 0xffff);
    if end > CMD_LAST + 1 {
        bail!("shell context menu allocated commands outside the offered range");
    }
    Ok(SELECTION_SHELL_CMD_FIRST..end)
}

fn shell_verb(
    context_menu: &IContextMenu,
    command: u32,
    shell_commands: &Range<u32>,
) -> Option<String> {
    if !shell_commands.contains(&command) {
        return None;
    }
    command_verb(context_menu, command, SELECTION_SHELL_CMD_FIRST)
}

pub(super) fn command_verb(context_menu: &IContextMenu, command: u32, first: u32) -> Option<String> {
    let offset = command.checked_sub(first)?;
    let mut text = [0u16; 128];
    unsafe {
        context_menu
            .GetCommandString(
                offset as usize,
                GCS_VERBW,
                None,
                PSTR(text.as_mut_ptr().cast()),
                text.len() as u32,
            )
            .ok()?;
    }
    Some(String::from_utf16_lossy(
        &text[..text.iter().position(|c| *c == 0).unwrap_or(text.len())],
    ))
}

fn remove_shell_rename(
    menu: HMENU,
    shell_commands: &Range<u32>,
    verb: &dyn Fn(u32) -> Option<String>,
) -> Result<()> {
    let count = unsafe { GetMenuItemCount(Some(menu)) };
    if count < 0 {
        return Err(windows::core::Error::from_win32())
            .context("failed to inspect shell context menu");
    }
    for position in (0..count).rev() {
        let mut item = MENUITEMINFOW {
            cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
            fMask: MIIM_FTYPE | MIIM_ID | MIIM_SUBMENU,
            ..Default::default()
        };
        unsafe {
            GetMenuItemInfoW(menu, position as u32, true, &mut item)?;
        }
        // Submenu headers and separators are not Shell commands, even if an ID is set.
        if !item.hSubMenu.0.is_null() {
            remove_shell_rename(item.hSubMenu, shell_commands, verb)?;
            continue;
        }
        if item.fType.contains(MFT_SEPARATOR) || !shell_commands.contains(&item.wID) {
            continue;
        }
        if verb(item.wID).is_some_and(|value| value.eq_ignore_ascii_case("rename")) {
            unsafe {
                DeleteMenu(menu, position as u32, MF_BYPOSITION)?;
            }
        }
    }
    Ok(())
}

fn configure_batch_rename(
    menu: HMENU,
    selection_count: usize,
    shortcuts: &NativeSelectionContextMenuShortcuts,
    shell_commands: &Range<u32>,
    verb: &dyn Fn(u32) -> Option<String>,
) -> Result<()> {
    if !shortcuts.allow_rename || selection_count < 2 {
        return Ok(());
    }
    remove_shell_rename(menu, shell_commands, verb)?;
    let mut label = menu_text(&menu_label_with_accelerator(
        "批量重命名",
        &shortcuts.rename,
    ));
    let item = MENUITEMINFOW {
        cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
        fMask: MIIM_ID | MIIM_STRING,
        wID: SELECTION_CMD_BATCH_RENAME,
        dwTypeData: PWSTR(label.as_mut_ptr()),
        ..Default::default()
    };
    // The existing separator marks the end of the top application section.
    unsafe { InsertMenuItemW(menu, SELECTION_CUSTOM_TOP_ITEM_COUNT - 1, true, &item) }
        .context("failed to insert batch rename menu item")
}

#[cfg(test)]
mod tests;

fn menu_label_with_accelerator(label: &str, accelerator: &str) -> String {
    if accelerator.is_empty() {
        label.to_string()
    } else {
        format!("{label}\t{accelerator}")
    }
}

fn append_selection_clipboard_submenu(
    menu: HMENU,
    shortcuts: &NativeSelectionContextMenuShortcuts,
) -> Result<()> {
    create_attached_submenu(menu, "到剪切板", |submenu| {
        append_menu_item(
            submenu,
            MENU_ITEM_FLAGS(0),
            SELECTION_CMD_COPY_NAME,
            &menu_label_with_accelerator("复制文件名", &shortcuts.copy_name),
        )?;
        append_menu_item(
            submenu,
            MENU_ITEM_FLAGS(0),
            SELECTION_CMD_COPY_FULL_PATH,
            &menu_label_with_accelerator("复制完整路径", &shortcuts.copy_full_path),
        )?;
        append_menu_item(
            submenu,
            MENU_ITEM_FLAGS(0),
            SELECTION_CMD_COPY_PARENT_PATH,
            "复制所在文件夹路径",
        )?;
        append_menu_item(
            submenu,
            MENU_ITEM_FLAGS(0),
            SELECTION_CMD_COPY_NAME_NO_EXT,
            "复制文件名（不含扩展名）",
        )?;
        append_menu_item(
            submenu,
            MENU_ITEM_FLAGS(0),
            SELECTION_CMD_COPY_EXTENSION,
            "复制扩展名",
        )
    })
}

fn custom_selection_action_for_command(
    command_id: u32,
) -> Option<NativeSelectionContextMenuAction> {
    match command_id {
        SELECTION_CMD_BATCH_RENAME => Some(NativeSelectionContextMenuAction::Rename),
        SELECTION_CMD_COPY_NAME => Some(NativeSelectionContextMenuAction::CopyName),
        SELECTION_CMD_COPY_FULL_PATH => Some(NativeSelectionContextMenuAction::CopyFullPath),
        SELECTION_CMD_COPY_PARENT_PATH => Some(NativeSelectionContextMenuAction::CopyParentPath),
        SELECTION_CMD_COPY_NAME_NO_EXT => {
            Some(NativeSelectionContextMenuAction::CopyNameWithoutExtension)
        }
        SELECTION_CMD_COPY_EXTENSION => Some(NativeSelectionContextMenuAction::CopyExtension),
        _ => None,
    }
}

fn prepare_context_menu(
    context_menu: &IContextMenu,
    selection_count: usize,
    shortcuts: &NativeSelectionContextMenuShortcuts,
) -> Result<(PopupMenu, Range<u32>)> {
    let popup = PopupMenu::create()?;
    append_selection_clipboard_submenu(popup.handle(), shortcuts)?;
    append_menu_separator(popup.handle())?;
    let query_result = unsafe {
        context_menu.QueryContextMenu(
            popup.handle(),
            SELECTION_CUSTOM_TOP_ITEM_COUNT,
            SELECTION_SHELL_CMD_FIRST,
            CMD_LAST,
            if shortcuts.allow_rename && selection_count == 1 {
                CMF_CANRENAME
            } else {
                CMF_NORMAL
            },
        )
    };
    let shell_commands = shell_command_range(query_result)?;
    configure_batch_rename(
        popup.handle(),
        selection_count,
        shortcuts,
        &shell_commands,
        &|command| shell_verb(context_menu, command, &shell_commands),
    )?;
    Ok((popup, shell_commands))
}

pub(super) fn show_context_menu(
    context_menu: &IContextMenu,
    hwnd: HWND,
    x: i32,
    y: i32,
    selection_count: usize,
    shortcuts: &NativeSelectionContextMenuShortcuts,
    handler: &super::super::NativeCommandHandler,
) -> Result<NativeSelectionContextMenuResult> {
    let (popup, shell_commands) = prepare_context_menu(context_menu, selection_count, shortcuts)?;
    if hwnd.0.is_null() {
        bail!("failed to resolve window handle");
    }
    let _menu_subclass = attach_context_menu_subclass(hwnd, context_menu)?;
    unsafe {
        let _ = SetForegroundWindow(hwnd);
    }

    let (menu_x, menu_y) = resolve_menu_position(x, y);
    unsafe {
        SetLastError(ERROR_SUCCESS);
    }
    let command_id = unsafe {
        TrackPopupMenuEx(
            popup.handle(),
            TPM_RIGHTBUTTON.0 | TPM_RETURNCMD.0,
            menu_x,
            menu_y,
            hwnd,
            None,
        )
    }
    .0 as u32;
    let menu_last_error = unsafe { GetLastError() };
    unsafe {
        let _ = PostMessageW(Some(hwnd), WM_NULL, WPARAM(0), LPARAM(0));
    }

    if command_id == 0 {
        return Ok(NativeSelectionContextMenuResult {
            opened: did_native_menu_open(command_id, menu_last_error),
            action: None,
        });
    }

    if let Some(action) = custom_selection_action_for_command(command_id) {
        return Ok(NativeSelectionContextMenuResult {
            opened: true,
            action: Some(action),
        });
    }

    // Native single-file rename and lazily added Shell rename both use the
    // application's existing rename flow for the captured selection.
    if shortcuts.allow_rename
        && shell_verb(context_menu, command_id, &shell_commands)
            .is_some_and(|verb| verb.eq_ignore_ascii_case("rename"))
    {
        return Ok(NativeSelectionContextMenuResult {
            opened: true,
            action: Some(NativeSelectionContextMenuAction::Rename),
        });
    }
    let verb = shell_verb(context_menu, command_id, &shell_commands);
    let _ = handler(verb.as_deref(), &mut || invoke_command(context_menu, hwnd, command_id, SELECTION_SHELL_CMD_FIRST));
    Ok(NativeSelectionContextMenuResult {
        opened: true,
        action: None,
    })
}

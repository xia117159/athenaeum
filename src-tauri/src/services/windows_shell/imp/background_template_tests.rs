use super::*;
use crate::domain::models::NativeBackgroundContextMenuSortState;
use windows::Win32::UI::WindowsAndMessaging::{
    GetMenuItemCount, GetMenuItemID, GetMenuStringW, MF_BYPOSITION,
};

#[test]
fn template_native_background_creation_items_are_contiguous_and_transfer_to_app() -> Result<()> {
    let menu = PopupMenu::create()?;
    append_background_custom_menu_items(
        menu.handle(),
        NativeBackgroundContextMenuOptions {
            view_mode: NativeBackgroundContextMenuViewMode::Details,
            sort: NativeBackgroundContextMenuSortState {
                column_id: NativeBackgroundContextMenuSortColumn::Name,
                direction: NativeBackgroundContextMenuSortDirection::Asc,
            },
            can_paste: false,
        },
    )?;
    let mut labels = Vec::new();
    for index in 0..3 {
        let mut buffer = [0u16; 128];
        let len = unsafe { GetMenuStringW(menu.handle(), index, Some(&mut buffer), MF_BYPOSITION) };
        labels.push(String::from_utf16_lossy(&buffer[..len as usize]));
    }
    assert_eq!(labels, ["新建文件", "新建文件夹", "新建项目"]);
    assert_eq!(
        unsafe { GetMenuItemCount(Some(menu.handle())) },
        BACKGROUND_CUSTOM_TOP_ITEM_COUNT as i32
    );
    let command = unsafe { GetMenuItemID(menu.handle(), 2) };
    assert_eq!(
        serde_json::to_value(custom_background_action_for_command(command))?,
        serde_json::json!({"type":"createTemplate"})
    );
    Ok(())
}

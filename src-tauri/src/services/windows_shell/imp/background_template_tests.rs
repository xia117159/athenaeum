use super::*;
use crate::domain::models::NativeBackgroundContextMenuSortState;
use windows::Win32::UI::WindowsAndMessaging::{
    GetMenuItemCount, GetMenuItemID, GetMenuStringW, GetSubMenu, MF_BYPOSITION,
};

#[test]
fn native_background_menu_omits_template_entry_and_preserves_other_items() -> Result<()> {
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
    let item_count = unsafe { GetMenuItemCount(Some(menu.handle())) };
    let mut labels = Vec::new();
    for index in 0..item_count {
        let mut buffer = [0u16; 128];
        let len = unsafe {
            GetMenuStringW(
                menu.handle(),
                index as u32,
                Some(&mut buffer),
                MF_BYPOSITION,
            )
        };
        labels.push(String::from_utf16_lossy(&buffer[..len as usize]));
    }
    assert_eq!(
        labels,
        ["新建文件", "新建文件夹", "视图", "排序方式", "粘贴", ""]
    );
    assert_eq!(item_count, BACKGROUND_CUSTOM_TOP_ITEM_COUNT as i32);
    for (index, action) in [(0, "createFile"), (1, "createFolder"), (4, "paste")] {
        let command = unsafe { GetMenuItemID(menu.handle(), index) };
        assert_eq!(
            serde_json::to_value(custom_background_action_for_command(command))?,
            serde_json::json!({"type": action})
        );
    }
    for index in [2, 3] {
        let submenu = unsafe { GetSubMenu(menu.handle(), index) };
        assert!(
            !submenu.is_invalid(),
            "view and sort remain native submenus"
        );
        assert!(unsafe { GetMenuItemCount(Some(submenu)) } > 0);
    }
    Ok(())
}

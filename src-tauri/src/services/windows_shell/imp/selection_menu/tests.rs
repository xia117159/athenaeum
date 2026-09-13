use super::*;
use std::{
    cell::RefCell,
    fs,
    os::windows::process::CommandExt,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetDesktopWindow, GetMenuItemID, GetMenuStringW, GetSubMenu, InsertMenuItemW,
};

fn menu_ids(menu: HMENU) -> Vec<u32> {
    unsafe {
        (0..GetMenuItemCount(Some(menu)))
            .map(|position| GetMenuItemID(menu, position))
            .collect()
    }
}

fn menu_item(menu: HMENU, position: u32) -> MENUITEMINFOW {
    let mut item = MENUITEMINFOW {
        cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
        fMask: MIIM_FTYPE | MIIM_ID | MIIM_SUBMENU,
        ..Default::default()
    };
    unsafe {
        GetMenuItemInfoW(menu, position, true, &mut item).unwrap();
    }
    item
}

fn menu_label(menu: HMENU, position: u32) -> String {
    let mut text = [0u16; 128];
    let length = unsafe { GetMenuStringW(menu, position, Some(&mut text), MF_BYPOSITION) };
    String::from_utf16_lossy(&text[..length as usize])
}

#[test]
fn batch_rename_is_last_custom_item_before_native_commands() {
    let popup = PopupMenu::create().unwrap();
    let shortcuts = NativeSelectionContextMenuShortcuts {
        allow_rename: true,
        rename: "Ctrl+Shift+M".into(),
        ..Default::default()
    };
    append_selection_clipboard_submenu(popup.handle(), &shortcuts).unwrap();
    append_menu_separator(popup.handle()).unwrap();
    append_menu_item(popup.handle(), MENU_ITEM_FLAGS(0), 1001, "Shell rename").unwrap();
    append_menu_item(popup.handle(), MENU_ITEM_FLAGS(0), 1002, "Open").unwrap();
    configure_batch_rename(popup.handle(), 2, &shortcuts, &(1000..1003), &|id| {
        (id == 1001).then(|| "ReNaMe".into())
    })
    .unwrap();
    let ids = menu_ids(popup.handle());
    assert_eq!(
        ids[1], SELECTION_CMD_BATCH_RENAME,
        "batch rename belongs at the end of the top custom section"
    );
    assert_eq!(menu_label(popup.handle(), 1), "批量重命名\tCtrl+Shift+M");
    assert!(menu_item(popup.handle(), 2).fType.contains(MFT_SEPARATOR));
    assert_eq!(ids.len(), 4, "do not add a second separator at the bottom");
    assert_eq!(ids[3], 1002);
    assert_eq!(
        ids.iter()
            .filter(|&&id| id == SELECTION_CMD_BATCH_RENAME)
            .count(),
        1
    );
    assert!(
        !ids.contains(&1001),
        "canonical Shell rename must not be duplicated"
    );
    assert!(ids.contains(&1002));
    let navigation = PopupMenu::create().unwrap();
    configure_batch_rename(
        navigation.handle(),
        1,
        &NativeSelectionContextMenuShortcuts::default(),
        &(1000..1000),
        &|_| panic!("navigation menus must not query rename verbs"),
    )
    .unwrap();
    assert_eq!(unsafe { GetMenuItemCount(Some(navigation.handle())) }, 0);
}

#[test]
fn rename_discovery_queries_only_shell_commands_not_menu_structure() {
    let popup = PopupMenu::create().unwrap();
    create_attached_submenu(popup.handle(), "Application submenu", |submenu| {
        append_menu_item(submenu, MENU_ITEM_FLAGS(0), 1, "Copy name")
    })
    .unwrap();
    append_menu_item(popup.handle(), MENU_ITEM_FLAGS(0), 1000, "Open").unwrap();
    create_attached_submenu(popup.handle(), "Shell submenu", |submenu| {
        append_menu_item(submenu, MENU_ITEM_FLAGS(0), 1001, "Properties")?;
        append_menu_item(submenu, MENU_ITEM_FLAGS(0), 1002, "Shell rename")?;
        append_menu_item(submenu, MENU_ITEM_FLAGS(0), CMD_LAST, "Unassigned command")?;
        append_menu_separator(submenu)
    })
    .unwrap();
    let separator = MENUITEMINFOW {
        cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
        fMask: MIIM_FTYPE | MIIM_ID,
        fType: MFT_SEPARATOR,
        wID: 1000,
        ..Default::default()
    };
    unsafe {
        InsertMenuItemW(popup.handle(), 3, true, &separator).unwrap();
    }
    let queried = RefCell::new(Vec::new());
    let shortcuts = NativeSelectionContextMenuShortcuts {
        allow_rename: true,
        ..Default::default()
    };
    configure_batch_rename(popup.handle(), 2, &shortcuts, &(1000..1003), &|id| {
        assert!(
            (1000..1003).contains(&id),
            "non-command/unallocated ID reached Shell: {id:#010x}"
        );
        queried.borrow_mut().push(id);
        (id == 1002).then(|| "rename".into())
    })
    .unwrap();
    let mut queried = queried.into_inner();
    queried.sort();
    assert_eq!(
        queried,
        vec![1000, 1001, 1002],
        "separator IDs must never be queried, even inside the command range"
    );
    let shell_submenu = unsafe { GetSubMenu(popup.handle(), 3) };
    let remaining = menu_ids(shell_submenu);
    assert_eq!(remaining.len(), 3);
    assert!(remaining.contains(&1001) && remaining.contains(&CMD_LAST));
    assert!(!remaining.contains(&1002));
    assert_eq!(menu_ids(unsafe { GetSubMenu(popup.handle(), 0) }), vec![1]);
}

#[test]
fn command_range_accepts_only_the_successful_shell_allocation() {
    let capacity = CMD_LAST - SELECTION_SHELL_CMD_FIRST + 1;
    for count in [0, 1, 3, capacity] {
        assert_eq!(
            shell_command_range(HRESULT(count as i32)).unwrap(),
            SELECTION_SHELL_CMD_FIRST..SELECTION_SHELL_CMD_FIRST + count,
        );
    }
    assert_eq!(
        shell_command_range(HRESULT(0x0004_0003)).unwrap(),
        1000..1003
    );
    assert!(shell_command_range(HRESULT((capacity + 1) as i32)).is_err());
    assert!(shell_command_range(HRESULT(0xffff)).is_err());
    assert!(shell_command_range(HRESULT(0x8000_4005u32 as i32)).is_err());
}

#[test]
fn empty_shell_allocation_keeps_menu_items_without_querying_them() {
    let popup = PopupMenu::create().unwrap();
    let shortcuts = NativeSelectionContextMenuShortcuts {
        allow_rename: true,
        ..Default::default()
    };
    append_selection_clipboard_submenu(popup.handle(), &shortcuts).unwrap();
    append_menu_separator(popup.handle()).unwrap();
    append_menu_item(popup.handle(), MENU_ITEM_FLAGS(0), 1000, "Unallocated").unwrap();
    configure_batch_rename(
        popup.handle(),
        2,
        &shortcuts,
        &shell_command_range(S_OK).unwrap(),
        &|_| panic!("an empty Shell allocation has no canonical verbs"),
    )
    .unwrap();
    let ids = menu_ids(popup.handle());
    assert_eq!(ids.len(), 4);
    assert!(ids.contains(&1000) && ids.contains(&SELECTION_CMD_BATCH_RENAME));
}

const PROBE_ENV: &str = "SFM_NATIVE_SELECTION_MENU_TEST_ROOT";
const PROBE_COMPLETE: &str = "all four native selection menus prepared";
const FIXTURE_FILES: [&str; 3] = ["alpha.txt", "beta.txt", "notes.md"];

struct MenuFixture(PathBuf);

impl MenuFixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("sfm-selection-menu-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let fixture = Self(root);
        fs::create_dir(fixture.0.join("folder")).unwrap();
        for name in FIXTURE_FILES {
            fs::write(fixture.0.join(name), name).unwrap();
        }
        fixture
    }
}

impl Drop for MenuFixture {
    fn drop(&mut self) {
        for name in FIXTURE_FILES.into_iter().chain(["probe.log"]) {
            let _ = fs::remove_file(self.0.join(name));
        }
        let _ = fs::remove_dir(self.0.join("folder"));
        let _ = fs::remove_dir(&self.0);
    }
}

fn prepare_real_shell_selections(root: &Path) -> Result<()> {
    // An access violation must fail the child process without a Windows error dialog.
    #[link(name = "kernel32")]
    extern "system" {
        fn SetErrorMode(mode: u32) -> u32;
    }
    unsafe {
        SetErrorMode(0x0002);
    } // SEM_NOGPFAULTERRORBOX, child process only.
    let _com = ComGuard::init()?;
    let cases: &[&[&str]] = &[
        &["alpha.txt"],
        &["alpha.txt", "beta.txt"],
        &["alpha.txt", "notes.md"],
        &["alpha.txt", "folder"],
    ];
    for names in cases {
        println!("preparing native menu for {names:?}");
        let paths = names.iter().map(|name| root.join(name)).collect::<Vec<_>>();
        let selection = bind_shell_selection(&paths)?;
        let context_menu: IContextMenu = unsafe {
            selection.parent_folder.GetUIObjectOf(
                GetDesktopWindow(),
                &selection.child_pidls,
                None,
            )?
        };
        let shortcuts = NativeSelectionContextMenuShortcuts {
            allow_rename: true,
            rename: "Ctrl+M".into(),
            ..Default::default()
        };
        let (popup, commands) = prepare_context_menu(&context_menu, paths.len(), &shortcuts)?;
        assert!(
            !commands.is_empty(),
            "fixture must exercise real Shell commands"
        );
        let ids = menu_ids(popup.handle());
        let custom_count = ids
            .iter()
            .filter(|&&id| id == SELECTION_CMD_BATCH_RENAME)
            .count();
        let mut native_rename_count = 0;
        for position in 0..ids.len() as u32 {
            let item = menu_item(popup.handle(), position);
            if item.hSubMenu.0.is_null()
                && !item.fType.contains(MFT_SEPARATOR)
                && shell_verb(&context_menu, item.wID, &commands)
                    .is_some_and(|verb| verb.eq_ignore_ascii_case("rename"))
            {
                native_rename_count += 1;
            }
        }
        if names.len() == 1 {
            assert_eq!(
                custom_count, 0,
                "single selection must use the native rename item"
            );
            assert_eq!(
                native_rename_count, 1,
                "Windows must supply the single rename item"
            );
            assert!(menu_item(popup.handle(), 1).fType.contains(MFT_SEPARATOR));
        } else {
            assert_eq!(custom_count, 1);
            assert_eq!(native_rename_count, 0);
            assert_eq!(ids[1], SELECTION_CMD_BATCH_RENAME);
            assert_eq!(menu_label(popup.handle(), 1), "批量重命名\tCtrl+M");
            assert!(menu_item(popup.handle(), 2).fType.contains(MFT_SEPARATOR));
        }
        for command in [
            0,
            SELECTION_CMD_BATCH_RENAME,
            SELECTION_SHELL_CMD_FIRST - 1,
            commands.end,
            CMD_LAST + 1,
            u32::MAX,
        ] {
            assert_eq!(shell_verb(&context_menu, command, &commands), None);
        }
        println!("prepared native menu for {names:?}");
    }
    println!("{PROBE_COMPLETE}");
    Ok(())
}

#[test]
fn real_shell_selection_preparation_is_safe() -> Result<()> {
    if let Some(root) = std::env::var_os(PROBE_ENV) {
        return prepare_real_shell_selections(Path::new(&root));
    }
    let fixture = MenuFixture::new();
    let log_path = fixture.0.join("probe.log");
    let log = fs::File::create(&log_path)?;
    // Isolate native faults from the rest of the test suite; exercise the production
    // menu preparation path, without displaying a menu or invoking file operations.
    let test_name = format!(
        "{}::real_shell_selection_preparation_is_safe",
        module_path!().split_once("::").unwrap().1
    );
    let mut child = Command::new(std::env::current_exe()?)
        .args(["--exact", &test_name, "--nocapture", "--test-threads=1"])
        .env(PROBE_ENV, &fixture.0)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .spawn()?;
    let deadline = Instant::now() + Duration::from_secs(45);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!(
                "native menu preparation timed out:\n{}",
                fs::read_to_string(&log_path)?
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let output = fs::read_to_string(&log_path)?;
    assert!(
        status.success(),
        "native menu preparation exited with {status}:\n{output}"
    );
    assert!(
        output.contains("1 passed") && output.contains(PROBE_COMPLETE),
        "native probe did not run all cases:\n{output}"
    );
    println!("{output}");
    for name in FIXTURE_FILES {
        assert_eq!(fs::read_to_string(fixture.0.join(name))?, name);
    }
    assert!(fixture.0.join("folder").is_dir());
    Ok(())
}

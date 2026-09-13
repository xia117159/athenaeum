use super::*;
use crate::services::templates::{copy, tests::TestDir};
use std::{
    fs,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

fn copied(root: &TestDir, dest: &TestDir, paths: &[&str]) -> Vec<OwnedTree> {
    let out = copy::create(
        &root.text(),
        &root.text(),
        &dest.text(),
        &paths
            .iter()
            .map(|path| path.to_string())
            .collect::<Vec<_>>(),
        &AtomicBool::new(false),
        &mut |_, _| {},
    )
    .unwrap();
    assert!(out.failures.is_empty(), "{:?}", out.failures);
    out.owned
}
fn undo(trees: &mut [OwnedTree]) -> anyhow::Result<()> {
    remove(
        trees,
        &AtomicBool::new(false),
        &mut |_, _| {},
        &mut |_| Ok(()),
        &mut || Ok(()),
    )
}

#[test]
fn template_recovery_revalidates_content_after_the_durable_checkpoint() {
    let root = TestDir::new();
    let dest = TestDir::new();
    fs::write(root.0.join("a.txt"), "original").unwrap();
    let mut trees = copied(&root, &dest, &["a.txt"]);
    let result = remove(
        &mut trees,
        &AtomicBool::new(false),
        &mut |_, _| {},
        &mut |_| {
            fs::write(
                dest.0.join("a.txt"),
                "edit while journal is being persisted",
            )
            .unwrap();
            Ok(())
        },
        &mut || panic!("changed content must fail before the move phase"),
    );
    assert!(format!("{:#}", result.unwrap_err()).contains("内容已修改"));
    assert_eq!(
        fs::read(dest.0.join("a.txt")).unwrap(),
        b"edit while journal is being persisted"
    );
    assert!(!trees[0].recovery_path.exists());
}

#[test]
fn template_recovery_checkpoint_failure_keeps_originals_and_unclaimed_paths() {
    let root = TestDir::new();
    let dest = TestDir::new();
    fs::write(root.0.join("a.txt"), "original").unwrap();
    let mut trees = copied(&root, &dest, &["a.txt"]);
    let result = remove(
        &mut trees,
        &AtomicBool::new(false),
        &mut |_, _| {},
        &mut |_| anyhow::bail!("injected journal checkpoint failure"),
        &mut || panic!("failed checkpoint must not move anything"),
    );
    assert!(result.is_err());
    assert!(!trees[0].recovery_prepared);
    assert!(!trees[0].recovery_path.exists());
    assert_eq!(fs::read(&trees[0].path).unwrap(), b"original");
}

#[test]
fn template_recovery_keeps_late_children_and_restores_original_location() {
    let root = TestDir::new();
    let dest = TestDir::new();
    fs::create_dir(root.0.join("project")).unwrap();
    fs::write(root.0.join("project/a.txt"), "original").unwrap();
    let mut trees = copied(&root, &dest, &["project"]);
    let result = remove(
        &mut trees,
        &AtomicBool::new(false),
        &mut |_, _| {},
        &mut |_| Ok(()),
        &mut || {
            fs::write(dest.0.join("project/late.txt"), "late external content").unwrap();
            Ok(())
        },
    );
    assert!(format!("{:#}", result.unwrap_err()).contains("校验后改变"));
    assert_eq!(
        fs::read(dest.0.join("project/late.txt")).unwrap(),
        b"late external content"
    );
    assert!(!trees[0].recovery_moved);
    assert!(!trees[0].recovery_path.exists());
}

#[test]
fn template_recovery_partial_move_reloads_without_touching_new_originals() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = TestDir::new();
    let dest = TestDir::new();
    fs::write(root.0.join("a.txt"), "a").unwrap();
    fs::write(root.0.join("b.txt"), "b").unwrap();
    let mut trees = copied(&root, &dest, &["a.txt", "b.txt"]);
    let first = trees[0].recovery_path.clone();
    let blocked = trees[1].recovery_path.clone();
    let mut durable = Vec::new();
    let result = remove(
        &mut trees,
        &AtomicBool::new(false),
        &mut |path, _| {
            if Path::new(path) == first {
                fs::write(&blocked, "foreign occupant").unwrap();
            }
        },
        &mut |prepared| {
            durable = serde_json::to_vec(prepared).unwrap();
            Ok(())
        },
        &mut || Ok(()),
    );
    assert!(result.is_err());
    assert!(trees[0].recovery_moved && !trees[1].recovery_moved);
    assert_eq!(fs::read(&first).unwrap(), b"a");
    assert_eq!(fs::read(&blocked).unwrap(), b"foreign occupant");
    fs::write(dest.0.join("a.txt"), "new original name").unwrap();
    let editor = fs::OpenOptions::new()
        .write(true)
        .share_mode(7)
        .open(dest.0.join("a.txt"))
        .unwrap();
    fs::remove_file(&blocked).unwrap();
    let mut reloaded: Vec<OwnedTree> = serde_json::from_slice(&durable).unwrap();
    refresh_recovery_locations(&mut reloaded);
    assert_eq!(recovery_items(&reloaded).len(), 1);
    undo(&mut reloaded).unwrap();
    assert_eq!(
        fs::read(dest.0.join("a.txt")).unwrap(),
        b"new original name"
    );
    assert_eq!(fs::read(&reloaded[1].recovery_path).unwrap(), b"b");
    // Reusing the formerly occupied recovery name exercises NTFS creation-time tunneling.
    purge_recovery(&reloaded).unwrap();
    drop(editor);
    assert_eq!(
        fs::read(dest.0.join("a.txt")).unwrap(),
        b"new original name"
    );
}

#[test]
fn template_recovery_reports_retained_location_when_original_name_is_reoccupied() {
    use super::platform::AFTER_RECOVERY_MOVE;
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            AFTER_RECOVERY_MOVE.with(|hook| *hook.borrow_mut() = None);
        }
    }
    let root = TestDir::new();
    let dest = TestDir::new();
    fs::create_dir(root.0.join("project")).unwrap();
    let mut trees = copied(&root, &dest, &["project"]);
    AFTER_RECOVERY_MOVE.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(|original, recovery| {
            fs::write(recovery.join("late.txt"), "late content").unwrap();
            fs::write(original, "new occupant").unwrap();
        }))
    });
    let reset = Reset;
    let message = format!("{:#}", undo(&mut trees).unwrap_err());
    drop(reset);
    assert!(message.contains(trees[0].recovery_path.to_str().unwrap()));
    assert!(message.contains("原位置恢复失败"));
    assert!(trees[0].recovery_moved);
    assert_eq!(fs::read(&trees[0].path).unwrap(), b"new occupant");
    assert_eq!(
        fs::read(trees[0].recovery_path.join("late.txt")).unwrap(),
        b"late content"
    );
    purge_recovery(&trees).unwrap();
    assert_eq!(fs::read(&trees[0].path).unwrap(), b"new occupant");
}

#[test]
fn template_recovery_rechecks_parent_identity_after_checkpoint() {
    let root = TestDir::new();
    let container = TestDir::new();
    let dest = TestDir(container.0.join("destination"));
    fs::create_dir(&dest.0).unwrap();
    fs::write(root.0.join("a.txt"), "original").unwrap();
    let mut trees = copied(&root, &dest, &["a.txt"]);
    let saved = container.0.join("saved-destination");
    let result = remove(
        &mut trees,
        &AtomicBool::new(false),
        &mut |_, _| {},
        &mut |_| {
            fs::rename(&dest.0, &saved).unwrap();
            fs::create_dir(&dest.0).unwrap();
            fs::write(dest.0.join("a.txt"), "foreign").unwrap();
            Ok(())
        },
        &mut || panic!("a replaced parent must not reach the move phase"),
    );
    assert!(format!("{:#}", result.unwrap_err()).contains("父目录已被替换"));
    assert_eq!(fs::read(dest.0.join("a.txt")).unwrap(), b"foreign");
    assert_eq!(fs::read(saved.join("a.txt")).unwrap(), b"original");
}

#[test]
fn template_recovery_refuses_reserved_names_replacements_and_ambiguous_hardlinks() {
    for scenario in ["reserved", "replacement", "hardlink"] {
        let root = TestDir::new();
        let dest = TestDir::new();
        fs::write(root.0.join("a.txt"), "original").unwrap();
        let mut trees = copied(&root, &dest, &["a.txt"]);
        let recovery = trees[0].recovery_path.clone();
        if scenario == "reserved" {
            fs::write(&recovery, "unowned").unwrap();
            assert!(undo(&mut trees).is_err());
            purge_recovery(&trees).unwrap();
            assert_eq!(fs::read(&recovery).unwrap(), b"unowned");
            assert_eq!(fs::read(&trees[0].path).unwrap(), b"original");
            continue;
        }
        undo(&mut trees).unwrap();
        if scenario == "replacement" {
            fs::rename(&recovery, dest.0.join("saved-original")).unwrap();
            fs::write(&recovery, "unowned").unwrap();
        } else {
            fs::hard_link(&recovery, &trees[0].path).unwrap();
        }
        assert!(undo(&mut trees).is_err(), "{scenario}");
        assert!(purge_recovery(&trees).is_err(), "{scenario}");
        assert!(recovery.exists());
        if scenario == "hardlink" {
            assert_eq!(fs::read(&trees[0].path).unwrap(), b"original");
        } else {
            assert_eq!(fs::read(&recovery).unwrap(), b"unowned");
        }
    }
}

#[test]
fn template_recovery_purge_does_not_follow_added_junctions() {
    let root = TestDir::new();
    let dest = TestDir::new();
    let outside = TestDir::new();
    fs::create_dir(root.0.join("project")).unwrap();
    fs::write(outside.0.join("keep.txt"), "outside").unwrap();
    let mut trees = copied(&root, &dest, &["project"]);
    undo(&mut trees).unwrap();
    let link = trees[0].recovery_path.join("external");
    let output = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&link)
        .arg(&outside.0)
        .output()
        .unwrap();
    assert!(output.status.success());
    let result = purge_recovery(&trees);
    fs::remove_dir(&link).unwrap();
    assert!(result.is_err());
    assert_eq!(fs::read(outside.0.join("keep.txt")).unwrap(), b"outside");
    purge_recovery(&trees).unwrap();
}

#[test]
fn template_recovery_large_membership_check_is_cancelable_and_rejects_unknown_members() {
    let root = TestDir::new();
    let dest = TestDir::new();
    fs::create_dir(root.0.join("many")).unwrap();
    for index in 0..512 {
        fs::write(root.0.join(format!("many/{index:04}.txt")), b"").unwrap();
    }
    let mut trees = copied(&root, &dest, &["many"]);
    let cancel = AtomicBool::new(false);
    let mut visited = 0;
    let result = remove(
        &mut trees,
        &cancel,
        &mut |_, bytes| {
            if bytes == 0 {
                visited += 1;
                if visited == 128 {
                    cancel.store(true, Ordering::SeqCst);
                }
            }
        },
        &mut |_| Ok(()),
        &mut || panic!("cancelled membership check cannot move"),
    );
    assert!(format!("{:#}", result.unwrap_err()).contains("已取消校验"));
    assert_eq!(visited, 128);
    assert_eq!(fs::read_dir(dest.0.join("many")).unwrap().count(), 512);
    fs::write(dest.0.join("many/unknown.txt"), "external").unwrap();
    assert!(format!("{:#}", undo(&mut trees).unwrap_err()).contains("unknown.txt"));
    assert_eq!(
        fs::read(dest.0.join("many/unknown.txt")).unwrap(),
        b"external"
    );
}

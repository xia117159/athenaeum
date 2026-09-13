use super::*;
use crate::services::templates::{owned, tests::TestDir};
use std::{fs, sync::atomic::Ordering};

fn run(root: &TestDir, dest: &TestDir, paths: &[&str]) -> CopyOutcome {
    create(
        &root.text(),
        &root.text(),
        &dest.text(),
        &paths.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        &AtomicBool::new(false),
        &mut |_, _| {},
    )
    .unwrap()
}
fn undo(outcome: &CopyOutcome) -> anyhow::Result<()> {
    owned::remove(
        &mut outcome.owned.clone(),
        &AtomicBool::new(false),
        &mut |_, _| {},
        &mut |_| Ok(()),
        &mut || Ok(()),
    )
}

fn visible_count(path: &Path) -> usize {
    use std::os::windows::fs::MetadataExt;
    fs::read_dir(path)
        .unwrap()
        .filter(|entry| {
            entry
                .as_ref()
                .unwrap()
                .metadata()
                .unwrap()
                .file_attributes()
                & 2
                == 0
        })
        .count()
}

#[test]
fn template_copy_preserves_file_and_directory_named_streams() {
    let root = TestDir::new();
    let dest = TestDir::new();
    fs::create_dir(root.0.join("project")).unwrap();
    fs::write(root.0.join("project/a.txt"), "original").unwrap();
    fs::write(root.0.join("project:notes"), "directory metadata").unwrap();
    fs::write(
        root.0.join("project/a.txt:Zone.Identifier"),
        "[ZoneTransfer]\r\nZoneId=3",
    )
    .unwrap();
    let out = run(&root, &dest, &["project"]);
    assert!(out.failures.is_empty(), "{:?}", out.failures);
    assert_eq!(
        fs::read(dest.0.join("project:notes")).unwrap(),
        b"directory metadata"
    );
    assert_eq!(
        fs::read(dest.0.join("project/a.txt:Zone.Identifier")).unwrap(),
        b"[ZoneTransfer]\r\nZoneId=3"
    );
    undo(&out).unwrap();
    assert!(!dest.0.join("project").exists());
}

#[test]
fn template_undo_rejects_added_file_or_directory_streams_after_journal_roundtrip() {
    for relative in ["project", "project/a.txt"] {
        let root = TestDir::new();
        let dest = TestDir::new();
        fs::create_dir(root.0.join("project")).unwrap();
        fs::write(root.0.join("project/a.txt"), "original").unwrap();
        let mut out = run(&root, &dest, &["project"]);
        out.owned = serde_json::from_slice(&serde_json::to_vec(&out.owned).unwrap()).unwrap();
        let stream = dest.0.join(format!("{relative}:notes"));
        fs::write(&stream, "external content").unwrap();
        assert!(
            undo(&out).is_err(),
            "a new named stream must block undo: {relative}"
        );
        assert_eq!(fs::read(&stream).unwrap(), b"external content");
        assert!(dest.0.join("project/a.txt").exists());
    }
}

#[test]
fn template_undo_preserves_a_stream_created_after_final_preflight() {
    use std::{io::Write, os::windows::fs::OpenOptionsExt};
    for directory in [false, true] {
        let root = TestDir::new();
        let dest = TestDir::new();
        if directory {
            fs::create_dir(root.0.join("item")).unwrap();
        } else {
            fs::write(root.0.join("item"), "original").unwrap();
        }
        let out = run(&root, &dest, &["item"]);
        let stream = dest.0.join("item:late-notes");
        let result = owned::remove(
            &mut out.owned.clone(),
            &AtomicBool::new(false),
            &mut |_, _| {},
            &mut |_| Ok(()),
            &mut || {
                let mut writer = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .share_mode(7)
                    .open(&stream)
                    .unwrap();
                writer.write_all(b"late external data").unwrap();
                Ok(())
            },
        );
        assert!(
            format!("{:#}", result.unwrap_err()).contains("校验后改变"),
            "late stream detection must restore the original location"
        );
        assert_eq!(fs::read(&stream).unwrap(), b"late external data");
    }
}

#[test]
fn template_recursive_copy_failure_identifies_the_actual_child_and_keeps_partial_copy() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = TestDir::new();
    let dest = TestDir::new();
    fs::create_dir_all(root.0.join("project/nested")).unwrap();
    let source = root.0.join("project/nested/busy.txt");
    let target = dest.0.join("project/nested/busy.txt");
    fs::write(&source, "busy").unwrap();
    let lock = fs::OpenOptions::new()
        .write(true)
        .share_mode(0)
        .open(&source)
        .unwrap();
    let out = run(&root, &dest, &["project"]);
    drop(lock);
    assert!(out.created.is_empty());
    assert_eq!(out.failures.len(), 1);
    let message = out.failures[0].1.replace('\\', "/");
    assert!(
        message.contains(&source.to_string_lossy().replace('\\', "/")),
        "{}",
        out.failures[0].1
    );
    assert!(
        message.contains(&target.to_string_lossy().replace('\\', "/")),
        "{}",
        out.failures[0].1
    );
    assert!(dest.0.join("project/nested").exists());
    undo(&out).unwrap();
    assert!(!dest.0.join("project").exists());
}

#[test]
fn template_copy_flattens_only_duplicate_complete_names_and_never_overwrites() {
    let root = TestDir::new();
    let dest = TestDir::new();
    for folder in ["工作总结", "汇报"] {
        fs::create_dir(root.0.join(folder)).unwrap();
        fs::write(root.0.join(folder).join("新文件.docx"), folder).unwrap();
    }
    fs::write(root.0.join("工作总结/新文件.pdf"), "pdf").unwrap();
    fs::write(dest.0.join("工作总结-新文件.docx"), "existing").unwrap();
    let out = run(
        &root,
        &dest,
        &[
            "工作总结/新文件.docx",
            "汇报/新文件.docx",
            "工作总结/新文件.pdf",
        ],
    );
    assert_eq!(out.created.len(), 3);
    assert_eq!(
        fs::read_to_string(dest.0.join("工作总结-新文件 (1).docx")).unwrap(),
        "工作总结"
    );
    assert_eq!(
        fs::read_to_string(dest.0.join("汇报-新文件.docx")).unwrap(),
        "汇报"
    );
    assert!(dest.0.join("新文件.pdf").exists());
    undo(&out).unwrap();
    assert_eq!(
        fs::read_to_string(dest.0.join("工作总结-新文件.docx")).unwrap(),
        "existing"
    );
    assert!(root.0.join("汇报/新文件.docx").exists());
    assert_eq!(visible_count(&dest.0), 1);
}

#[test]
fn template_copy_parent_selection_wins_and_folder_contents_are_copied() {
    let root = TestDir::new();
    let dest = TestDir::new();
    fs::create_dir_all(root.0.join("项目/src")).unwrap();
    fs::write(root.0.join("项目/src/main.cpp"), "code").unwrap();
    fs::write(root.0.join("Readme.md"), "doc").unwrap();
    let out = run(
        &root,
        &dest,
        &[
            "项目/src/main.cpp",
            "项目",
            "项目/src",
            "readme.MD",
            "Readme.md",
        ],
    );
    assert_eq!(out.created.len(), 2);
    assert_eq!(
        fs::read_to_string(dest.0.join("项目/src/main.cpp")).unwrap(),
        "code"
    );
    assert!(out.failures.is_empty());
    undo(&out).unwrap();
    assert_eq!(visible_count(&dest.0), 0);
}

#[test]
fn template_undo_refuses_edited_replaced_or_added_content_and_can_retry() {
    for mode in ["edit", "replace", "add"] {
        let root = TestDir::new();
        let dest = TestDir::new();
        fs::create_dir(root.0.join("项目")).unwrap();
        fs::write(root.0.join("项目/a.txt"), "original").unwrap();
        let out = run(&root, &dest, &["项目"]);
        let file = dest.0.join("项目/a.txt");
        match mode {
            "edit" => fs::write(&file, "edited").unwrap(),
            "replace" => {
                fs::rename(&file, dest.0.join("saved.txt")).unwrap();
                fs::write(&file, "original").unwrap();
            }
            _ => fs::write(dest.0.join("项目/external.txt"), "external").unwrap(),
        }
        assert!(undo(&out).is_err(), "{mode}");
        assert!(file.exists());
        if mode == "add" {
            fs::remove_file(dest.0.join("项目/external.txt")).unwrap();
            undo(&out).unwrap();
        }
    }
}

#[test]
fn template_copy_cancels_in_chunks_and_rejects_descendant_targets() {
    let root = TestDir::new();
    let dest = TestDir::new();
    fs::create_dir(root.0.join("folder")).unwrap();
    fs::write(root.0.join("large.bin"), vec![7; 1_000_000]).unwrap();
    let cancel = AtomicBool::new(false);
    let out = create(
        &root.text(),
        &root.text(),
        &dest.text(),
        &["large.bin".into()],
        &cancel,
        &mut |_, _| {
            cancel.store(true, Ordering::SeqCst);
        },
    )
    .unwrap();
    assert!(out.cancelled);
    assert_eq!(out.created.len(), 0);
    assert!(
        dest.0.join("large.bin").exists(),
        "partial copy stays recoverable until explicit undo"
    );
    assert!(out.failures[0].1.contains("large.bin"));
    undo(&out).unwrap();
    assert_eq!(visible_count(&dest.0), 0);
    assert!(create(
        &root.text(),
        &root.text(),
        &root.0.join("folder").to_string_lossy(),
        &["folder".into()],
        &AtomicBool::new(false),
        &mut |_, _| {}
    )
    .is_err());
}

#[test]
fn template_undo_locks_content_until_recovery_move() {
    let root = TestDir::new();
    let dest = TestDir::new();
    fs::write(root.0.join("a.txt"), "original").unwrap();
    let out = run(&root, &dest, &["a.txt"]);
    let mut reached = false;
    owned::remove(
        &mut out.owned.clone(),
        &AtomicBool::new(false),
        &mut |_, _| {},
        &mut |_| Ok(()),
        &mut || {
            reached = true;
            assert!(fs::write(dest.0.join("a.txt"), "external change").is_err());
            Ok(())
        },
    )
    .unwrap();
    assert!(reached);
    assert!(!dest.0.join("a.txt").exists());
}

#[test]
fn template_copy_locks_directory_handles_against_reparse_conversion() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = TestDir::new();
    let dest = TestDir::new();
    fs::create_dir(root.0.join("project")).unwrap();
    fs::write(root.0.join("project/file.txt"), "code").unwrap();
    let mut reached = false;
    create(
        &root.text(),
        &root.text(),
        &dest.text(),
        &["project".into()],
        &AtomicBool::new(false),
        &mut |_, _| {
            reached = true;
            for directory in [&root.0, &dest.0, &dest.0.join("project")] {
                let writer = fs::OpenOptions::new()
                    .access_mode(0x40000000)
                    .share_mode(7)
                    .custom_flags(0x02000000)
                    .open(directory);
                assert!(
                    writer.is_err(),
                    "directory write access could change a guarded path into a junction: {}",
                    directory.display()
                );
            }
        },
    )
    .unwrap();
    assert!(reached);
}

#[test]
fn template_directory_is_owned_atomically_before_registering_its_identity() {
    use crate::services::templates::native::AFTER_DIRECTORY_CREATE;
    use std::os::windows::fs::OpenOptionsExt;
    let root = TestDir::new();
    let dest = TestDir::new();
    fs::create_dir(root.0.join("project")).unwrap();
    AFTER_DIRECTORY_CREATE.with(|hook| {
        *hook.borrow_mut() =
            Some(Box::new(|path| {
                assert!(
                    fs::OpenOptions::new()
                        .access_mode(0x40000000)
                        .share_mode(7)
                        .custom_flags(0x02000000)
                        .open(path)
                        .is_err(),
                    "the directory must reject reparse writers before its identity is registered"
                );
                assert!(fs::rename(path, path.with_file_name("external-replacement")).is_err(),
            "the created directory must already be pinned before its identity is registered");
            }))
    });
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            AFTER_DIRECTORY_CREATE.with(|hook| *hook.borrow_mut() = None);
        }
    }
    let _reset = Reset;
    let out = run(&root, &dest, &["project"]);
    assert_eq!(out.created.len(), 1);
    undo(&out).unwrap();
}

#[test]
fn template_copy_retains_unverifiable_residuals_without_claiming_undo_ownership() {
    use crate::services::templates::native::FAIL_CREATED_IDENTITY;
    let root = TestDir::new();
    let dest = TestDir::new();
    fs::create_dir(root.0.join("project")).unwrap();
    fs::write(root.0.join("file.txt"), "code").unwrap();
    FAIL_CREATED_IDENTITY.with(|fail| fail.set(true));
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            FAIL_CREATED_IDENTITY.with(|fail| fail.set(false));
        }
    }
    let _reset = Reset;
    let out = run(&root, &dest, &["project", "file.txt"]);
    assert_eq!(out.created.len(), 0);
    assert_eq!(out.failures.len(), 2);
    assert_eq!(visible_count(&dest.0), 2);
    assert!(out.owned.is_empty());
    assert!(out
        .failures
        .iter()
        .all(|(_, message)| message.contains("手工处理") && message.contains(&dest.text())));
}

#[test]
fn template_copy_never_adopts_files_added_by_another_writer() {
    let root = TestDir::new();
    let dest = TestDir::new();
    fs::create_dir(root.0.join("project")).unwrap();
    fs::write(root.0.join("project/own.txt"), "original").unwrap();
    let mut added = false;
    let out = create(
        &root.text(),
        &root.text(),
        &dest.text(),
        &["project".into()],
        &AtomicBool::new(false),
        &mut |_, _| {
            if !added {
                fs::write(dest.0.join("project/external.txt"), "external").unwrap();
                added = true;
            }
        },
    )
    .unwrap();
    assert_eq!(out.created.len(), 1);
    assert!(undo(&out).unwrap_err().to_string().contains("新内容"));
    assert_eq!(
        fs::read_to_string(dest.0.join("project/external.txt")).unwrap(),
        "external"
    );
    assert!(dest.0.join("project/own.txt").exists());
}

#[test]
fn template_copy_cancellation_retains_finished_and_partial_copies_with_undo_manifests() {
    let root = TestDir::new();
    let dest = TestDir::new();
    fs::write(root.0.join("first.txt"), "first").unwrap();
    fs::write(root.0.join("large.bin"), vec![7; 1_000_000]).unwrap();
    let cancel = AtomicBool::new(false);
    let out = create(
        &root.text(),
        &root.text(),
        &dest.text(),
        &["first.txt".into(), "large.bin".into()],
        &cancel,
        &mut |path, _| {
            if path.ends_with("large.bin") {
                cancel.store(true, Ordering::SeqCst);
            }
        },
    )
    .unwrap();
    assert!(out.cancelled);
    assert_eq!(out.created.len(), 1);
    assert_eq!(out.owned.len(), 2);
    assert_eq!(
        fs::read_to_string(dest.0.join("first.txt")).unwrap(),
        "first"
    );
    assert!(dest.0.join("large.bin").exists());
    assert!(out.failures[0].1.contains("不完整副本已保留"));
    undo(&out).unwrap();
    assert_eq!(visible_count(&dest.0), 0);
}

#[test]
fn template_copy_handles_case_and_flattened_name_collisions_without_overwriting() {
    let root = TestDir::new();
    let dest = TestDir::new();
    for folder in ["A", "B"] {
        fs::create_dir(root.0.join(folder)).unwrap();
    }
    fs::write(root.0.join("A/report.TXT"), "A").unwrap();
    fs::write(root.0.join("B/REPORT.txt"), "B").unwrap();
    fs::write(root.0.join("A-report.TXT"), "flat").unwrap();
    let out = run(
        &root,
        &dest,
        &["A/report.TXT", "B/REPORT.txt", "A-report.TXT"],
    );
    assert_eq!(out.created.len(), 3);
    assert_eq!(
        fs::read_to_string(dest.0.join("A-report.TXT")).unwrap(),
        "A"
    );
    assert_eq!(
        fs::read_to_string(dest.0.join("A-report (1).TXT")).unwrap(),
        "flat"
    );
    assert_eq!(
        fs::read_to_string(dest.0.join("B-REPORT.txt")).unwrap(),
        "B"
    );
}

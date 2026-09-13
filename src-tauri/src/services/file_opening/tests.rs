use super::*;
use registry::FileOpenJobs;
use std::{
    fs,
    path::PathBuf,
    sync::{atomic::Ordering, Arc, Barrier},
};

struct TestRoot(PathBuf);
impl TestRoot {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("sfm-open-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn request(target: FileOpenTarget, association_id: Option<&str>) -> FileOpenRequest {
    FileOpenRequest {
        request_id: "open-1".into(),
        target,
        association_id: association_id.map(str::to_owned),
    }
}
fn rule(id: &str) -> FileAssociationRule {
    FileAssociationRule {
        id: id.into(),
        patterns: "txt".into(),
        executable_path: r"C:\Missing Editor.exe".into(),
        arguments_template: "--new-window {file}".into(),
    }
}
fn remote() -> FileOpenTarget {
    FileOpenTarget::Remote {
        profile_id: "sftp".into(),
        path: "/home/中文 file.TXT".into(),
    }
}

#[test]
fn file_opening_plan_uses_first_match_and_validates_explicit_id() {
    let rules = vec![
        FileAssociationRule {
            id: "blank".into(),
            ..Default::default()
        },
        rule("first"),
        rule("second"),
    ];
    let selected = plan_open(&request(remote(), None), &rules).unwrap();
    assert_eq!(selected.association.unwrap().id, "first");
    assert_eq!(
        plan_open(&request(remote(), Some("second")), &rules)
            .unwrap()
            .association
            .unwrap()
            .id,
        "second"
    );
    assert!(plan_open(&request(remote(), Some("deleted")), &rules).is_err());
    assert!(plan_open(
        &request(
            FileOpenTarget::Local {
                path: "C:\\file.md".into()
            },
            Some("first")
        ),
        &rules
    )
    .is_err());
    assert!(plan_open(&request(remote(), None), &[])
        .unwrap()
        .association
        .is_none());
}

#[test]
fn file_opening_registry_has_window_ownership_and_teardown_fences() {
    let jobs = FileOpenJobs::default();
    assert!(jobs.register("closed", "one").is_err());
    jobs.open_owner("main");
    let old = jobs.register("main", "one").unwrap();
    assert!(jobs.register("main", "one").is_err());
    assert!(!jobs.cancel("settings", "one"));
    assert!(!jobs.cancel("main", "unknown"));
    assert!(jobs.cancel("main", "one"));
    assert!(
        jobs.cancel("main", "one"),
        "repeat cancellation is idempotent"
    );
    assert!(!old.job.begin_launch());
    jobs.close_owner("main");
    assert!(old.job.cancelled().load(Ordering::Acquire));
    assert!(jobs.register("main", "two").is_err());
    jobs.open_owner("main");
    let new = jobs.register("main", "one").unwrap();
    drop(old);
    assert_eq!(
        jobs.active_count("main"),
        1,
        "old completion must not remove a new window's job"
    );
    assert!(new.job.begin_launch());
    assert!(
        !jobs.cancel("main", "one"),
        "cannot claim cancellation once launch starts"
    );
    drop(new);
    assert_eq!(jobs.active_count("main"), 0);
}

#[test]
fn file_opening_cancel_and_launch_are_mutually_exclusive() {
    for _ in 0..24 {
        let job = Arc::new(OpenJob::default());
        let barrier = Arc::new(Barrier::new(2));
        let cancelling = job.clone();
        let ready = barrier.clone();
        let cancel = std::thread::spawn(move || {
            ready.wait();
            cancelling.cancel()
        });
        barrier.wait();
        let launch = job.begin_launch();
        assert_ne!(
            launch,
            cancel.join().unwrap(),
            "an accepted cancellation forbids launch"
        );
    }
}

#[test]
fn file_opening_local_default_and_custom_receive_the_same_real_file() {
    let root = TestRoot::new();
    let path = root.0.join("中文 file.txt");
    fs::write(&path, "content").unwrap();
    for rules in [Vec::new(), vec![rule("editor")]] {
        let plan = plan_open(
            &request(
                FileOpenTarget::Local {
                    path: path.to_string_lossy().into(),
                },
                None,
            ),
            &rules,
        )
        .unwrap();
        let mut called = false;
        let result = execute(
            &plan,
            &OpenJob::default(),
            &root.0,
            |_, _, _, _| panic!("local file must not download"),
            |launch| {
                called = true;
                assert_eq!(launch.path, path);
                if !rules.is_empty() {
                    assert_eq!(launch.program.as_deref(), Some(r"C:\Missing Editor.exe"));
                    assert_eq!(
                        launch.arguments,
                        vec![
                            "--new-window".to_string(),
                            path.to_string_lossy().into_owned()
                        ]
                    );
                } else {
                    assert!(launch.program.is_none());
                }
                Ok(())
            },
            |_| {},
        )
        .unwrap();
        assert!(called);
        assert!(matches!(result, FileOpenResult::Opened { .. }));
    }
}

#[test]
fn file_opening_success_retains_unique_remote_copies() {
    let root = TestRoot::new();
    let plan = plan_open(&request(remote(), None), &[rule("editor")]).unwrap();
    let mut copies = Vec::new();
    for _ in 0..2 {
        let mut phases = Vec::new();
        let result = execute(
            &plan,
            &OpenJob::default(),
            &root.0,
            |_, target, _, progress| {
                fs::write(target, "remote content")?;
                progress(14);
                Ok(())
            },
            |launch| {
                assert_eq!(fs::read_to_string(&launch.path)?, "remote content");
                Ok(())
            },
            |progress| phases.push(progress.phase),
        )
        .unwrap();
        let FileOpenResult::Opened {
            local_path,
            association_id,
        } = result
        else {
            panic!("must open")
        };
        assert_eq!(association_id.as_deref(), Some("editor"));
        assert!(Path::new(&local_path).is_file());
        copies.push(local_path);
        assert_eq!(
            phases.first(),
            Some(&crate::domain::models::FileOpenPhase::Preparing)
        );
        assert_eq!(
            phases.last(),
            Some(&crate::domain::models::FileOpenPhase::Opening)
        );
    }
    assert_ne!(copies[0], copies[1]);
    assert_eq!(fs::read_to_string(&copies[0]).unwrap(), "remote content");
}

#[test]
fn file_opening_failures_and_accepted_cancellation_clean_only_their_copy() {
    let root = TestRoot::new();
    let plan = plan_open(&request(remote(), None), &[]).unwrap();
    for failure in ["download", "launch", "cancel"] {
        let job = OpenJob::default();
        let mut launched = false;
        let result = execute(
            &plan,
            &job,
            &root.0,
            |_, target, _, _| {
                fs::write(target, "partial")?;
                if failure == "cancel" {
                    assert!(job.cancel());
                }
                if failure == "download" {
                    anyhow::bail!("download failed");
                }
                Ok(())
            },
            |_| {
                launched = true;
                anyhow::bail!("launch failed")
            },
            |_| {},
        );
        if failure == "cancel" {
            assert_eq!(result.unwrap(), FileOpenResult::Cancelled);
        } else {
            assert!(result.is_err());
        }
        assert_eq!(launched, failure == "launch");
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 0);
    }
}

#[test]
fn file_opening_rejects_unsafe_names_and_non_file_outputs() {
    let root = TestRoot::new();
    for name in [
        "CON.txt",
        "bad:name.txt",
        "name.",
        "name ",
        "..",
        "LPT1.txt",
    ] {
        let plan = plan_open(
            &request(
                FileOpenTarget::Remote {
                    profile_id: "ftp".into(),
                    path: format!("/home/{name}"),
                },
                None,
            ),
            &[],
        )
        .unwrap();
        let mut downloaded = false;
        assert!(execute(
            &plan,
            &OpenJob::default(),
            &root.0,
            |_, _, _, _| {
                downloaded = true;
                Ok(())
            },
            |_| panic!("unsafe name must not open"),
            |_| {}
        )
        .is_err());
        assert!(!downloaded);
    }
    let plan = plan_open(&request(remote(), None), &[]).unwrap();
    assert!(execute(
        &plan,
        &OpenJob::default(),
        &root.0,
        |_, target, _, _| {
            fs::create_dir(target)?;
            Ok(())
        },
        |_| panic!("directory must not open"),
        |_| {}
    )
    .is_err());
    assert_eq!(fs::read_dir(&root.0).unwrap().count(), 0);
}

#[test]
fn file_opening_shutdown_waits_for_closed_and_replaced_owner_guards() {
    use std::sync::mpsc;
    use std::time::Duration;
    let jobs = FileOpenJobs::default();
    jobs.open_owner("main");
    let closed = jobs.register("main", "closed").unwrap();
    jobs.close_owner("main");
    jobs.open_owner("main");
    let replaced = jobs.register("main", "same-id").unwrap();
    jobs.open_owner("main");
    let current = jobs.register("main", "same-id").unwrap();
    let (started, start) = mpsc::channel();
    let (completed, completion) = mpsc::channel();
    let shutdown_jobs = jobs.clone();
    let shutdown = std::thread::spawn(move || {
        started.send(()).unwrap();
        shutdown_jobs.shutdown();
        completed.send(()).unwrap();
    });
    start.recv().unwrap();
    let before_any_guard = completion.recv_timeout(Duration::from_millis(50));
    assert!(closed.job.cancelled().load(Ordering::Acquire));
    assert!(replaced.job.cancelled().load(Ordering::Acquire));
    drop(current);
    drop(closed);
    let before_last_guard = completion.recv_timeout(Duration::from_millis(50));
    drop(replaced);
    shutdown.join().unwrap();
    assert!(
        matches!(before_any_guard, Err(mpsc::RecvTimeoutError::Timeout)),
        "shutdown returned before the registered work cleaned up"
    );
    assert!(
        matches!(before_last_guard, Err(mpsc::RecvTimeoutError::Timeout)),
        "replaced-owner work must remain part of shutdown"
    );
    completion.recv_timeout(Duration::from_secs(1)).unwrap();
}

#[test]
fn file_opening_shutdown_permanently_rejects_new_work() {
    let jobs = FileOpenJobs::default();
    jobs.open_owner("main");
    jobs.shutdown();
    jobs.open_owner("main");
    assert!(
        jobs.register("main", "late").is_err(),
        "a late page load must not reopen the shutdown registry"
    );
}

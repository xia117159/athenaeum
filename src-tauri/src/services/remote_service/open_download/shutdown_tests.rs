use super::{run_transfer, tests::Temporary};
use crate::{
    domain::models::{FileOpenResult, FileOpenTarget},
    services::file_opening::{execute, registry::FileOpenJobs, FileOpenPlan},
};
use std::os::windows::process::CommandExt;
use std::{
    fs,
    path::Path,
    process::Command,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use windows::Win32::{
    Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0},
    System::Threading::{
        OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    },
};

// Hold the exact helper-process handle so even a failing regression test cannot leak it.
struct ProcessGuard(HANDLE);
impl Drop for ProcessGuard {
    fn drop(&mut self) {
        unsafe {
            if WaitForSingleObject(self.0, 0) != WAIT_OBJECT_0 {
                let _ = TerminateProcess(self.0, 1);
                WaitForSingleObject(self.0, 5000);
            }
            let _ = CloseHandle(self.0);
        }
    }
}

fn plan(name: &str) -> FileOpenPlan {
    FileOpenPlan {
        target: FileOpenTarget::Remote {
            profile_id: "fixture".into(),
            path: format!("/root/{name}"),
        },
        association: None,
    }
}

fn exit_host(base: &Path) {
    let jobs = FileOpenJobs::default();
    jobs.open_owner("main");
    let success = jobs.register("main", "retained").unwrap();
    let result = execute(
        &plan("retained.txt"),
        &success.job,
        base,
        |_, target, _, _| {
            fs::write(target, b"retained")?;
            Ok(())
        },
        |_| Ok(()),
        |_| {},
    )
    .unwrap();
    let FileOpenResult::Opened { local_path, .. } = result else {
        panic!("successful fixture")
    };
    fs::write(base.join("retained-path"), local_path).unwrap();
    drop(success);

    let pending = jobs.register("main", "downloading").unwrap();
    let root = base.to_path_buf();
    let (started, ready) = mpsc::channel();
    thread::spawn(move || {
        let mut started = Some(started);
        let result = execute(
            &plan("partial.txt"),
            &pending.job,
            &root,
            |_, target, cancelled, progress| {
                let mut command = Command::new("powershell.exe");
                command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
                    "[IO.File]::WriteAllText($env:SFM_EXIT_TEST_PID,[string]$PID); [IO.File]::WriteAllText($env:SFM_EXIT_TEST_TARGET,'partial'); Start-Sleep -Seconds 30"]);
                command.env("SFM_EXIT_TEST_PID", root.join("transfer-pid"));
                command.env("SFM_EXIT_TEST_TARGET", target);
                fs::write(
                    root.join("partial-path"),
                    target.to_string_lossy().as_bytes(),
                )?;
                run_transfer(
                    command,
                    target,
                    cancelled,
                    Duration::from_secs(20),
                    &mut |bytes| {
                        progress(bytes);
                        if bytes > 0 {
                            if let Some(started) = started.take() {
                                started.send(()).unwrap();
                            }
                        }
                    },
                )
            },
            |_| panic!("cancelled transfer must never launch"),
            |_| {},
        );
        assert_eq!(result.unwrap(), FileOpenResult::Cancelled);
        drop(pending);
    });
    ready.recv_timeout(Duration::from_secs(10)).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !base.join("allow-exit").exists() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(5));
    }
    jobs.close_owner("main");
    jobs.shutdown();
    // Model Tao's process exit immediately after the application's exit gate.
    std::process::exit(0);
}

#[test]
fn file_open_download_shutdown_cleans_before_host_process_exit() {
    if let Some(base) = std::env::var_os("SFM_EXIT_TEST_HOST") {
        exit_host(Path::new(&base));
        return;
    }
    let root = Temporary::new();
    let mut host = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "services::remote_service::open_download::shutdown_tests::file_open_download_shutdown_cleans_before_host_process_exit", "--nocapture"])
        .env("SFM_EXIT_TEST_HOST", &root.0).creation_flags(0x08000000).spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let pid = loop {
        if let Some(pid) = fs::read_to_string(root.0.join("transfer-pid"))
            .ok()
            .and_then(|value| value.parse().ok())
        {
            break pid;
        }
        if Instant::now() >= deadline {
            let _ = host.kill();
            let _ = host.wait();
            panic!("transfer did not start");
        }
        thread::sleep(Duration::from_millis(5));
    };
    let process = ProcessGuard(unsafe {
        OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, false, pid).unwrap()
    });
    fs::write(root.0.join("allow-exit"), b"ready").unwrap();
    let status = loop {
        if let Some(status) = host.try_wait().unwrap() {
            break status;
        }
        if Instant::now() > deadline {
            let _ = host.kill();
            let _ = host.wait();
            panic!("host did not finish shutdown");
        }
        thread::sleep(Duration::from_millis(5));
    };
    let process_stopped = unsafe { WaitForSingleObject(process.0, 0) == WAIT_OBJECT_0 };
    let partial = fs::read_to_string(root.0.join("partial-path")).unwrap();
    let partial_removed = !Path::new(&partial).parent().unwrap().exists();
    let retained = fs::read_to_string(root.0.join("retained-path")).unwrap();
    drop(process);
    assert!(status.success());
    assert!(
        process_stopped,
        "shutdown returned while the download subprocess was alive"
    );
    assert!(
        partial_removed,
        "shutdown must remove the uncommitted temp directory before host exit"
    );
    assert_eq!(fs::read(retained).unwrap(), b"retained");
}

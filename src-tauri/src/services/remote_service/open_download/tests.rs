use super::super::size_metadata::ftp::{ListingCommand, TransportError};
use super::*;
use crate::services::directory_size::metadata::MetadataKind;
use std::{fs, io::Cursor, sync::atomic::Ordering};

pub(super) struct Temporary(pub(super) std::path::PathBuf);
impl Temporary {
    pub(super) fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("sfm-open-download-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

struct SftpFake {
    stat: ssh2::FileStat,
    opened_stat: ssh2::FileStat,
    opens: usize,
}
impl SftpFileSource for SftpFake {
    type Reader = Cursor<Vec<u8>>;
    fn lstat(&mut self, _: &str) -> Result<ssh2::FileStat> {
        Ok(self.stat.clone())
    }
    fn open(&mut self, _: &str) -> Result<(Self::Reader, ssh2::FileStat)> {
        self.opens += 1;
        Ok((Cursor::new(vec![42; 150_000]), self.opened_stat.clone()))
    }
}

fn stat(kind: MetadataKind) -> ssh2::FileStat {
    let (perm, size) = match kind {
        MetadataKind::File(size) => (Some(0o100644), Some(size)),
        MetadataKind::Directory => (Some(0o040755), None),
        MetadataKind::Link => (Some(0o120777), None),
        MetadataKind::Special => (Some(0o010600), None),
        MetadataKind::Unknown => (None, None),
    };
    ssh2::FileStat {
        size,
        uid: None,
        gid: None,
        perm,
        atime: None,
        mtime: None,
    }
}

#[test]
fn file_open_download_sftp_checks_both_types_before_creating_a_copy() {
    let dir = Temporary::new();
    let target = dir.0.join("file.txt");
    let flag = AtomicBool::new(false);
    let mut source = SftpFake {
        stat: stat(MetadataKind::File(150_000)),
        opened_stat: stat(MetadataKind::File(150_000)),
        opens: 0,
    };
    let mut bytes = vec![];
    download_sftp(
        &mut source,
        "/root/file.txt",
        &target,
        &flag,
        &mut |value| bytes.push(value),
    )
    .unwrap();
    assert_eq!(fs::read(&target).unwrap(), vec![42; 150_000]);
    assert_eq!(source.opens, 1);
    assert_eq!(bytes.last(), Some(&150_000));
    // Existing destinations must never be overwritten, even in an owned temp directory.
    assert!(download_sftp(&mut source, "/root/file.txt", &target, &flag, &mut |_| {}).is_err());
    fs::remove_file(&target).unwrap();
    for kind in [
        MetadataKind::Directory,
        MetadataKind::Link,
        MetadataKind::Unknown,
        MetadataKind::Special,
    ] {
        source.stat = stat(kind);
        source.opens = 0;
        assert!(download_sftp(&mut source, "/root/file.txt", &target, &flag, &mut |_| {}).is_err());
        assert_eq!(source.opens, 0);
        assert!(!target.exists());
        source.stat = stat(MetadataKind::File(2));
        source.opened_stat = stat(kind);
        assert!(download_sftp(&mut source, "/root/file.txt", &target, &flag, &mut |_| {}).is_err());
        assert_eq!(source.opens, 1);
        assert!(!target.exists());
    }
}

#[test]
fn file_open_download_cancellation_stops_copy_at_chunk_boundaries() {
    let flag = AtomicBool::new(false);
    let mut output = Vec::new();
    let mut input = Cursor::new(vec![7; 1_000_000]);
    let result = copy_cancellable(&mut input, &mut output, &flag, &mut |_| {
        flag.store(true, Ordering::Release)
    });
    assert!(result.is_err());
    assert!(!output.is_empty());
    assert!(output.len() < 1_000_000);
    let mut untouched = Vec::new();
    assert!(copy_cancellable(&mut input, &mut untouched, &flag, &mut |_| {}).is_err());
    assert!(untouched.is_empty());
    // A cancellation arriving during a blocking read must prevent the subsequent write.
    struct CancellingReader<'a>(&'a AtomicBool);
    impl Read for CancellingReader<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            buffer[0] = 9;
            self.0.store(true, Ordering::Release);
            Ok(1)
        }
    }
    flag.store(false, Ordering::Release);
    assert!(copy_cancellable(
        &mut CancellingReader(&flag),
        &mut untouched,
        &flag,
        &mut |_| {}
    )
    .is_err());
    assert!(untouched.is_empty());
}

struct FtpFake {
    lines: Vec<String>,
    calls: Vec<String>,
}
impl FtpTransport for FtpFake {
    fn root_kind(
        &mut self,
        _: &str,
        _: &AtomicBool,
    ) -> std::result::Result<MetadataKind, TransportError> {
        panic!("must not scan a root")
    }
    fn list(
        &mut self,
        path: &str,
        _: ListingCommand,
        _: &AtomicBool,
        visit: &mut dyn FnMut(&[u8]) -> bool,
    ) -> std::result::Result<(), TransportError> {
        self.calls.push(path.into());
        for line in &self.lines {
            if !visit(line.as_bytes()) {
                break;
            }
        }
        Ok(())
    }
}

#[test]
fn file_open_download_ftp_requires_typed_metadata_and_never_recurses() {
    let flag = AtomicBool::new(false);
    for (line, accepted) in [
        ("type=file;size=20; a.txt", true),
        ("type=file; a.txt", true),
        ("type=dir; a.txt", false),
        ("type=OS.unix=slink; a.txt", false),
        ("a.txt", false),
        ("type=file;size=20; other.txt", false),
    ] {
        let mut source = FtpMetadataSource::new(FtpFake {
            lines: vec![line.into()],
            calls: vec![],
        });
        let mut transfers = 0;
        let result = download_ftp(&mut source, "/root/a.txt", &flag, || {
            transfers += 1;
            Ok(())
        });
        assert_eq!(result.is_ok(), accepted, "{line}");
        assert_eq!(transfers, usize::from(accepted));
        assert_eq!(source.transport.calls, ["/root"]);
    }
}

#[cfg(windows)]
#[test]
fn file_open_download_curl_process_is_cancelled_and_reaped() {
    let dir = Temporary::new();
    let target = dir.0.join("started");
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[IO.File]::WriteAllText($env:SFM_TRANSFER_TEST_TARGET,'x'); Start-Sleep -Seconds 30",
    ]);
    command.env("SFM_TRANSFER_TEST_TARGET", &target);
    let flag = AtomicBool::new(false);
    let started = std::time::Instant::now();
    let result = run_transfer(
        command,
        &target,
        &flag,
        Duration::from_secs(10),
        &mut |bytes| {
            if bytes > 0 {
                flag.store(true, Ordering::Release);
            }
        },
    );
    assert!(result.is_err());
    assert!(target.exists());
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[test]
fn file_open_download_sftp_accepts_a_regular_file_without_size() {
    let dir = Temporary::new();
    let target = dir.0.join("file.txt");
    let stat = ssh2::FileStat {
        size: None,
        uid: None,
        gid: None,
        perm: Some(0o100644),
        atime: None,
        mtime: None,
    };
    let mut source = SftpFake {
        stat: stat.clone(),
        opened_stat: stat,
        opens: 0,
    };
    download_sftp(
        &mut source,
        "/root/file.txt",
        &target,
        &AtomicBool::new(false),
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(fs::read(target).unwrap(), vec![42; 150_000]);
}

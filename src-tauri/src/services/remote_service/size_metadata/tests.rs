use super::*;
use std::{collections::HashMap, sync::atomic::{AtomicBool, Ordering}};
use crate::{domain::models::{LocationKind, RemoteAuthKind, RemoteProfile}, services::directory_size::{
    metadata::{ListingFingerprint, MetadataKind}, scan::{scan_directory, ScanLimits, ScanOutcome},
}};

pub(super) fn profile() -> RemoteProfile {
    RemoteProfile { id: "test".into(), name: "Test".into(), protocol: LocationKind::Ftp,
        host: "example.invalid".into(), port: 21, username: "user".into(), root_path: "/root".into(),
        auth_kind: RemoteAuthKind::Password, private_key_path: None, passive_mode: true,
        ignore_host_key: false, connect_timeout_secs: 120, command_timeout_secs: 600,
        credential_target: None, password: None }
}

fn fact(command: ListingCommand, line: &str) -> RemoteFact {
    parse_ftp_line(command, line.as_bytes()).expect("recognized syntax").expect("entry")
}

#[test]
fn size_remote_mlsd_preserves_spaces_hidden_links_and_u64_precision() {
    let a = fact(ListingCommand::Mlsd, "type=file;size=9007199254740993;modify=20260910010203; file with spaces.txt");
    assert_eq!(a.name, "file with spaces.txt");
    assert_eq!(a.kind, MetadataKind::File(9_007_199_254_740_993));
    assert!(a.modified_at.is_some());
    assert_eq!(fact(ListingCommand::Mlsd, "type=dir; .hidden").kind, MetadataKind::Directory);
    assert_eq!(fact(ListingCommand::Mlsd, "type=OS.unix=slink:/target; link").kind, MetadataKind::Link);
    assert_eq!(fact(ListingCommand::Mlsd, "type=file;size=0;  leading space ").name, " leading space ");
    assert_eq!(parse_ftp_line(ListingCommand::Mlsd, b"type=cdir; .").unwrap(), None);
    assert_eq!(parse_ftp_line(ListingCommand::Mlsd, b"type=pdir; ..").unwrap(), None);
}

#[test]
fn size_remote_list_accepts_unix_and_dos_without_fabricating_unknown_sizes() {
    assert_eq!(fact(ListingCommand::ListAll, "-rw-r--r-- 1 user group 30 Sep 10 12:00 report 2026.txt").kind, MetadataKind::File(30));
    assert_eq!(fact(ListingCommand::ListAll, "drwxr-xr-x 2 user group 4096 Sep 10 2026 .hidden dir").name, ".hidden dir");
    assert_eq!(fact(ListingCommand::ListAll, "lrwxrwxrwx 1 user group 7 Sep 10 12:00 a link -> /target").name, "a link");
    assert_eq!(fact(ListingCommand::ListAll, "09-10-26  12:15PM       <DIR>          a folder").kind, MetadataKind::Directory);
    assert_eq!(fact(ListingCommand::ListAll, "09-10-2026  12:15PM                 10 a file.txt").kind, MetadataKind::File(10));
    assert_eq!(parse_ftp_line(ListingCommand::ListAll, b"total 42").unwrap(), None);
}

#[test]
fn size_remote_parser_rejects_malformed_encoding_traversal_and_unknown_types() {
    for line in ["type=file; bad", "type=file;size=-1; bad", "type=unknown; bad", "type=file;size=1; ../escape", "type=file;size=1; a\\b", "type=file;size=1; a\0b"] {
        assert!(parse_ftp_line(ListingCommand::Mlsd, line.as_bytes()).is_err(), "{line:?}");
    }
    assert!(parse_ftp_line(ListingCommand::Mlsd, b"type=file;size=1; \xff").is_err());
    assert!(parse_ftp_line(ListingCommand::ListAll, b"unrecognized server format").is_err());
}

#[derive(Default)]
struct FakeFtp {
    reject_mlsd: bool,
    root_kind: Option<Result<MetadataKind, TransportError>>,
    root_calls: Vec<String>,
    listings: HashMap<String, Vec<Vec<u8>>>,
    calls: Vec<(String, ListingCommand)>,
}
impl FtpTransport for FakeFtp {
    fn root_kind(&mut self, path: &str, _cancelled: &AtomicBool) -> Result<MetadataKind, TransportError> {
        self.root_calls.push(path.into());
        self.root_kind.clone().unwrap_or(Ok(MetadataKind::Directory))
    }
    fn list(&mut self, path: &str, command: ListingCommand, cancelled: &AtomicBool,
        visit: &mut dyn FnMut(&[u8]) -> bool) -> Result<(), TransportError> {
        self.calls.push((path.into(), command));
        if cancelled.load(Ordering::Relaxed) { return Err(TransportError::Cancelled); }
        if command == ListingCommand::Mlsd && self.reject_mlsd { return Err(TransportError::Unsupported); }
        for line in self.listings.get(path).into_iter().flatten() { if !visit(line) { break; } }
        Ok(())
    }
}
fn lines(value: &str) -> Vec<Vec<u8>> { value.lines().map(|line| line.as_bytes().to_vec()).collect() }

#[test]
fn size_remote_ftp_scan_lists_once_per_directory_not_per_file_and_has_matching_fingerprint() {
    let mut ftp = FakeFtp::default();
    ftp.listings.insert("/root".into(), lines("type=dir; folder\ntype=file;size=30; a\ntype=file;size=10; b"));
    ftp.listings.insert("/root/folder".into(), lines("type=file;size=60; .hidden"));
    let mut source = FtpMetadataSource::new(ftp);
    let result = scan_directory("/root", &mut source, &AtomicBool::new(false), ScanLimits::default(), |_| {});
    assert_eq!(result.outcome, ScanOutcome::Complete);
    assert_eq!(result.stats.known_bytes, 100);
    assert_eq!(source.transport.calls.len(), 2);
    assert_eq!(source.transport.root_calls, ["/root"]);
    let mut fingerprint = ListingFingerprint::default();
    fingerprint.add("folder", MetadataKind::Directory);
    fingerprint.add("a", MetadataKind::File(30));
    fingerprint.add("b", MetadataKind::File(10));
    assert_eq!(result.directories["/root"].fingerprint, fingerprint.finish());
}

#[test]
fn size_remote_ftp_fallback_requests_list_all_once_and_never_claims_hidden_completeness() {
    let mut ftp = FakeFtp { reject_mlsd: true, root_kind: Some(Err(TransportError::Unsupported)), ..FakeFtp::default() };
    ftp.listings.insert("/root".into(), lines("drwxr-xr-x 2 u g 4096 Sep 10 2026 .hidden\n-rw-r--r-- 1 u g 30 Sep 10 2026 visible"));
    ftp.listings.insert("/root/.hidden".into(), lines("-rw-r--r-- 1 u g 70 Sep 10 2026 hidden file"));
    let mut source = FtpMetadataSource::new(ftp);
    let result = scan_directory("/root", &mut source, &AtomicBool::new(false), ScanLimits::default(), |_| {});
    assert_eq!(result.outcome, ScanOutcome::Partial);
    assert_eq!(result.stats.known_bytes, 100);
    assert_eq!(source.transport.root_calls, ["/root"]);
    assert!(result.directories.values().all(|size| !size.complete && size.fingerprint.is_none()));
    assert_eq!(source.transport.calls, vec![("/root".into(), ListingCommand::Mlsd), ("/root".into(), ListingCommand::ListAll), ("/root/.hidden".into(), ListingCommand::ListAll)]);
}

#[test]
fn size_remote_ftp_root_rejects_explicit_links_unknowns_and_failures_before_listing() {
    for kind in [Ok(MetadataKind::Link), Ok(MetadataKind::File(5)), Ok(MetadataKind::Unknown),
        Err(TransportError::Failed("root permission denied".into())), Err(TransportError::Cancelled)] {
        let mut source = FtpMetadataSource::new(FakeFtp { root_kind: Some(kind), ..Default::default() });
        let result = scan_directory("/root", &mut source, &AtomicBool::new(false), ScanLimits::default(), |_| {});
        assert_eq!(result.outcome, ScanOutcome::Failed);
        assert!(source.transport.calls.is_empty());
        assert!(!result.directories["/root"].complete);
    }
}

#[test]
fn size_remote_ftp_server_transparent_directory_aliases_are_budgeted_not_claimed_link_free() {
    struct AliasSource { roots: usize, listings: usize }
    impl FtpTransport for AliasSource {
        fn root_kind(&mut self, _: &str, _: &AtomicBool) -> Result<MetadataKind, TransportError> {
            self.roots += 1; Ok(MetadataKind::Directory)
        }
        fn list(&mut self, _: &str, _: ListingCommand, _: &AtomicBool,
            visit: &mut dyn FnMut(&[u8]) -> bool) -> Result<(), TransportError> {
            self.listings += 1;
            // RFC 3659 permits a server to hide the underlying link behind dir.
            visit(b"type=dir; transparent-alias");
            Ok(())
        }
    }
    let mut source = FtpMetadataSource::new(AliasSource { roots: 0, listings: 0 });
    let result = scan_directory("/root", &mut source, &AtomicBool::new(false),
        ScanLimits { max_directories: 8, ..Default::default() }, |_| {});
    assert_eq!(source.transport.roots, 1);
    assert_eq!(source.transport.listings, 8);
    assert_eq!(result.outcome, ScanOutcome::Partial);
    assert_eq!(result.directories.len(), 8);
    assert_eq!(result.stats.skipped_links, 0, "the protocol did not identify a link");
    assert!(result.message.unwrap().contains("上限"));
}

#[test]
fn size_remote_sftp_raw_types_do_not_collapse_missing_sizes_or_specials_into_files() {
    let stat = |perm, size| ssh2::FileStat { perm, size, uid: None, gid: None, atime: None, mtime: None };
    assert_eq!(sftp_metadata_kind(&stat(Some(0o100644), Some(42))), MetadataKind::File(42));
    assert_eq!(sftp_metadata_kind(&stat(Some(0o040755), Some(4096))), MetadataKind::Directory);
    assert_eq!(sftp_metadata_kind(&stat(Some(0o120777), Some(20))), MetadataKind::Link);
    assert_eq!(sftp_metadata_kind(&stat(Some(0o010600), Some(0))), MetadataKind::Special);
    assert_eq!(sftp_metadata_kind(&stat(None, Some(10))), MetadataKind::Unknown);
    assert_eq!(sftp_metadata_kind(&stat(Some(0o100644), None)), MetadataKind::Unknown);
}

#[test]
fn size_remote_timeouts_are_clamped_on_scanner_copy_only() {
    let mut original = profile();
    let copy = scanner_profile(&original);
    assert_eq!((copy.connect_timeout_secs, copy.command_timeout_secs), (20, 20));
    assert_eq!((original.connect_timeout_secs, original.command_timeout_secs), (120, 600));
    original.connect_timeout_secs = 0;
    original.command_timeout_secs = 0;
    let copy = scanner_profile(&original);
    assert_eq!((copy.connect_timeout_secs, copy.command_timeout_secs), (1, 1));
}

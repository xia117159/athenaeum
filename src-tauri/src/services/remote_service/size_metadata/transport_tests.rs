use super::{*, ftp::metadata_command, process::{OutputLimits, stream_process}, sftp::{SftpRead, SftpMetadataSource}};
use crate::services::directory_size::{metadata::{ListingFingerprint, MetadataKind}, scan::{scan_directory, ScanLimits, ScanOutcome}};
use std::{process::Command, sync::atomic::{AtomicBool, Ordering}, time::Duration};

#[test]
fn size_remote_curl_metadata_requests_directory_mlsd_or_list_all_not_nlst() {
    let mut profile = tests::profile();
    profile.auth_kind = crate::domain::models::RemoteAuthKind::Anonymous;
    for (kind, verb) in [(ListingCommand::Mlsd, "MLSD"), (ListingCommand::ListAll, "LIST -a")] {
        let command = metadata_command(&profile, None, "/root/a folder", kind).unwrap();
        let args = command.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect::<Vec<_>>();
        assert_eq!(args[0], "--disable");
        assert!(args.windows(2).any(|pair| pair == ["--request", verb]));
        assert!(args.last().unwrap().ends_with("/root/a%20folder/"));
        assert!(!args.iter().any(|arg| arg == "--list-only"));
    }
}

#[cfg(windows)]
fn output_command(script: &str) -> Command {
    let mut command = Command::new("powershell.exe");
    command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]);
    command
}

#[cfg(windows)]
#[test]
fn size_remote_process_bounds_line_and_total_output_and_kills_on_cancel() {
    let cancelled = AtomicBool::new(false);
    let mut visits = 0;
    let line = stream_process(output_command("[Console]::Out.Write('x' * 20000)"), &cancelled,
        OutputLimits::default(), &mut |_| { visits += 1; true });
    assert!(matches!(line, Err(TransportError::OutputLimit(_))));
    assert_eq!(visits, 0);
    let total = stream_process(output_command("[Console]::Out.Write(('1234567890' + [char]10) * 1000)"), &cancelled,
        OutputLimits { bytes: 100, ..OutputLimits::default() }, &mut |_| true);
    assert!(matches!(total, Err(TransportError::OutputLimit(_))));
    let result = stream_process(output_command("[Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); Start-Sleep -Seconds 30"), &cancelled,
        OutputLimits { timeout: Duration::from_secs(5), ..OutputLimits::default() }, &mut |_| { cancelled.store(true, Ordering::Relaxed); true });
    assert!(matches!(result, Err(TransportError::Cancelled)));
}

struct FakeSftp { directory_reads: Vec<String>, session_count: usize }
impl SftpRead for FakeSftp {
    fn read(&mut self, path: &str, _cancelled: &AtomicBool,
        visit: &mut dyn FnMut(String, ssh2::FileStat) -> bool) -> Result<(), String> {
        self.directory_reads.push(path.into());
        let items = if path == "/root" { vec![("folder", 0o040755, None), ("a", 0o100644, Some(40)), ("link", 0o120777, Some(42))] }
            else { vec![(".hidden", 0o100644, Some(60))] };
        for (name, perm, size) in items {
            if !visit(name.into(), ssh2::FileStat { perm: Some(perm), size, uid: None, gid: None, atime: None, mtime: None }) { break; }
        }
        Ok(())
    }
}

#[test]
fn size_remote_sftp_reuses_one_transport_streams_each_directory_and_excludes_links() {
    let mut source = SftpMetadataSource::new(FakeSftp { session_count: 1, directory_reads: vec![] });
    let result = scan_directory("/root", &mut source, &AtomicBool::new(false), ScanLimits::default(), |_| {});
    assert_eq!(result.outcome, ScanOutcome::Complete);
    assert_eq!(result.stats.known_bytes, 100);
    assert_eq!(result.stats.skipped_links, 1);
    assert_eq!(source.transport.session_count, 1);
    assert_eq!(source.transport.directory_reads, vec!["/root", "/root/folder"]);
}

#[test]
fn size_remote_listing_wrapper_fingerprints_raw_types_before_projection_and_preserves_parent() {
    let profile = tests::profile();
    let stat = |perm, size| ssh2::FileStat { perm, size, uid: None, gid: None, atime: None, mtime: None };
    let listing = sftp_listing(&profile, "/root/sub", vec![
        ("file".into(), stat(Some(0o100644), Some(9_007_199_254_740_993))),
        ("link".into(), stat(Some(0o120777), Some(40))),
        ("pipe".into(), stat(Some(0o010644), Some(0))),
    ]);
    let mut stamp = ListingFingerprint::default();
    stamp.add("file", MetadataKind::File(9_007_199_254_740_993));
    stamp.add("link", MetadataKind::Link);
    stamp.add("pipe", MetadataKind::Special);
    assert_eq!(listing.size_fingerprint, stamp.finish());
    assert_eq!(listing.parent.as_deref(), Some("/root"));
    assert!(listing.can_go_up);
    assert_eq!(listing.entries.iter().find(|entry| entry.name == "link").unwrap().size, None);
    let unknown = sftp_listing(&profile, "/root", vec![("unknown".into(), stat(None, Some(40)))]);
    assert!(unknown.size_fingerprint.is_none());
    assert!(!unknown.can_go_up);
    let json = serde_json::to_value(&listing).unwrap();
    assert!(json["entries"].is_array());
    assert_eq!(json["sizeFingerprint"], listing.size_fingerprint.unwrap());
}

use std::path::PathBuf;
use crate::{domain::models::{DirectoryListing, LocationDescriptor, RemoteProfile, EntryViewModel, EntryKind, EntryDecoration, EntryAttributeAvailability},
    services::directory_size::{metadata::{ListingFingerprint, MetadataKind}, scan::MetadataSource}};
use super::{sftp_metadata_kind, RemoteFact, FtpMetadataSource, ftp::CurlMetadataTransport};
use super::super::{remote_parent_path, normalize_remote_path, listing::parse_sftp_entries, join_remote_path};

fn wrapper(profile: &RemoteProfile, path: &str, entries: Vec<EntryViewModel>, size_fingerprint: Option<String>) -> DirectoryListing {
    let parent = (normalize_remote_path(path) != normalize_remote_path(&profile.root_path)).then(|| remote_parent_path(path)).flatten();
    DirectoryListing { location: LocationDescriptor { kind: profile.protocol.clone(), path: path.into(), connection_id: Some(profile.id.clone()) },
        entries, can_go_up: parent.is_some(), parent, size_fingerprint }
}

pub(crate) fn sftp_listing(profile: &RemoteProfile, path: &str, entries: Vec<(PathBuf, ssh2::FileStat)>) -> DirectoryListing {
    let mut fingerprint = ListingFingerprint::default();
    for (path, stat) in &entries {
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("");
        if matches!(name, "." | "..") { continue; }
        fingerprint.add(name, sftp_metadata_kind(stat));
    }
    wrapper(profile, path, parse_sftp_entries(profile, path, entries), fingerprint.finish())
}

fn entry_from_fact(profile: &RemoteProfile, path: &str, fact: RemoteFact) -> EntryViewModel {
    let remote_path = join_remote_path(path, &fact.name);
    let is_directory = fact.kind == MetadataKind::Directory;
    let extension = (!is_directory).then(|| fact.name.rsplit_once('.').and_then(|(stem, ext)|
        (!stem.is_empty() && !ext.is_empty()).then(|| ext.to_string()))).flatten();
    EntryViewModel { path: remote_path.clone(), is_hidden: fact.name.starts_with('.'), name: fact.name, extension,
        kind: if is_directory { EntryKind::Directory } else { EntryKind::File },
        size: if let MetadataKind::File(bytes) = fact.kind { Some(bytes) } else { None },
        created_at: None, modified_at: fact.modified_at, accessed_at: None,
        is_system: false, is_protected_operating_system: false, is_read_only: false,
        is_symlink: fact.kind == MetadataKind::Link,
        location: LocationDescriptor { kind: profile.protocol.clone(), path: remote_path, connection_id: Some(profile.id.clone()) },
        decoration: EntryDecoration::default(), comment: None,
        attribute_availability: EntryAttributeAvailability { hidden: true, symlink: true, ..Default::default() } }
}

pub(crate) fn ftp_listing(profile: &RemoteProfile, password: Option<&str>, path: &str) -> anyhow::Result<DirectoryListing> {
    let mut source = FtpMetadataSource::new(CurlMetadataTransport { profile: profile.clone(), password: password.map(str::to_owned) });
    let mut entries = Vec::new();
    let mut fingerprint = ListingFingerprint::default();
    let result = source.read_facts(path, &std::sync::atomic::AtomicBool::new(false), &mut |fact| {
        fingerprint.add(&fact.name, fact.kind);
        if !fact.name.is_empty() { entries.push(entry_from_fact(profile, path, fact)); }
        true
    });
    let unavailable = match result {
        Ok(()) => false,
        Err(super::TransportError::Unsupported | super::TransportError::OutputLimit(_)) => true,
        Err(error) => return Err(anyhow::Error::msg(error.message())),
    };
    if unavailable || source.malformed {
        // Unrecognized legacy output must not silently hide files in ordinary browsing.
        let output = super::super::run_curl_list(profile, password, Some(path))?;
        if !output.status.success() { anyhow::bail!("FTP 目录名称列表读取失败"); }
        return Ok(wrapper(profile, path, super::super::parse_listing_entries(profile, Some(path), &output.stdout), None));
    }
    let fingerprint = if source.incomplete_reason().is_none() { fingerprint.finish() } else { None };
    Ok(wrapper(profile, path, entries, fingerprint))
}

pub(super) mod ftp;
mod parser;
mod sftp;
mod process;
mod listing;
mod ftp_root;
mod auth;
mod path;

pub(crate) use ftp::{FtpMetadataSource, ListingCommand, TransportError};
#[cfg(test)]
use ftp::FtpTransport;
pub(crate) use parser::{parse_ftp_line, RemoteFact};
pub(crate) use parser::{FtpEntryFact, FtpEntryKind};
pub(crate) use sftp::{scanner_profile, sftp_metadata_kind};
pub(crate) use listing::sftp_listing;
pub(crate) use listing::ftp_listing;

pub(crate) fn validated_path(profile: &crate::domain::models::RemoteProfile, path: &str) -> Result<String, String> {
    path::validated_path(profile, path)
}

pub(crate) fn scan_source(profile: &crate::domain::models::RemoteProfile, root: &str, cancelled: &std::sync::atomic::AtomicBool)
    -> Result<Box<dyn crate::services::directory_size::scan::MetadataSource>, String> {
    let profile = auth::snapshot_scanner_profile(profile, cancelled)?;
    match profile.protocol {
        crate::domain::models::LocationKind::Ftp => Ok(Box::new(FtpMetadataSource::new(ftp::CurlMetadataTransport {
            password: profile.password.clone(), profile
        }))),
        crate::domain::models::LocationKind::Sftp => Ok(Box::new(sftp::SftpMetadataSource::new(sftp::SftpSession::open(profile, root, cancelled)?))),
        _ => Err("目录统计目标不是 FTP/SFTP 目录".into()),
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod transport_tests;
#[cfg(test)]
mod ftp_root_tests;
#[cfg(test)]
mod ftp_root_wire_tests;
#[cfg(test)]
mod ftp_listing_wire_tests;

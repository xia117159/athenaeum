use std::sync::atomic::AtomicBool;
use crate::domain::models::RemoteProfile;

pub(super) fn snapshot_scanner_profile(profile: &RemoteProfile, cancelled: &AtomicBool) -> Result<RemoteProfile, String> {
    snapshot_with(profile, cancelled, |profile| super::super::resolve_secret(profile, profile.password.as_deref()))
}

pub(super) fn snapshot_with(profile: &RemoteProfile, cancelled: &AtomicBool,
    read: impl FnOnce(&RemoteProfile) -> Option<String>) -> Result<RemoteProfile, String> {
    let password = super::super::connection::setup_stage(Some(cancelled), || Ok(read(profile)))
        .map_err(|_| "目录统计已取消，认证信息未被使用".to_string())?;
    let mut snapshot = super::scanner_profile(profile);
    snapshot.password = password;
    // Never re-read a mutable credential target after DNS/handshake or between
    // FTP directories. Profile updates fence acquisition and cancel this job.
    snapshot.credential_target = None;
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, sync::atomic::Ordering};

    #[test]
    fn size_remote_scanner_snapshots_authentication_once_and_removes_late_credential_lookup() {
        let mut profile = super::super::tests::profile();
        profile.credential_target = Some("fake-target-never-accessed".into());
        let reads = Cell::new(0);
        let snapshot = snapshot_with(&profile, &AtomicBool::new(false), |_| {
            reads.set(reads.get() + 1); Some("captured-test-secret".into())
        }).unwrap();
        assert_eq!(snapshot.password.as_deref(), Some("captured-test-secret"));
        assert_eq!(snapshot.credential_target, None);
        assert_eq!(reads.get(), 1);
        assert!(profile.password.is_none(), "never change stored configuration");
        assert_eq!(profile.credential_target.as_deref(), Some("fake-target-never-accessed"));
    }

    #[test]
    fn size_remote_scanner_discards_credentials_if_invalidated_during_acquisition() {
        let cancelled = AtomicBool::new(false);
        let result = snapshot_with(&super::super::tests::profile(), &cancelled, |_| {
            cancelled.store(true, Ordering::Release); Some("updated-test-secret".into())
        });
        assert!(result.is_err());
        let reads = Cell::new(0);
        assert!(snapshot_with(&super::super::tests::profile(), &cancelled, |_| { reads.set(1); None }).is_err());
        assert_eq!(reads.get(), 0);
    }
}

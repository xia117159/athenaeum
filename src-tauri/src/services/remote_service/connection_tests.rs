use super::*;
use crate::domain::models::{LocationKind, RemoteAuthKind};
use std::sync::{Arc, Mutex, atomic::Ordering};

fn profile() -> RemoteProfile {
    RemoteProfile { id: "test".into(), name: "Test".into(), protocol: LocationKind::Sftp,
        host: "old.example.invalid".into(), port: 22, username: "test".into(), root_path: "/".into(),
        auth_kind: RemoteAuthKind::Password, private_key_path: None, passive_mode: true,
        ignore_host_key: false, connect_timeout_secs: 5, command_timeout_secs: 5,
        credential_target: Some("test-only-target".into()), password: None }
}

struct FakeConnect<'a> {
    cancelled: &'a AtomicBool,
    stop_after: Option<&'static str>,
    calls: Vec<&'static str>,
    credentials: Arc<Mutex<String>>,
    authentications: Vec<(String, String)>,
}
impl FakeConnect<'_> {
    fn stage(&mut self, stage: &'static str) {
        self.calls.push(stage);
        if self.stop_after == Some(stage) {
            *self.credentials.lock().unwrap() = "new-test-secret".into();
            self.cancelled.store(true, Ordering::Release);
        }
    }
}
impl SftpConnect for FakeConnect<'_> {
    type Address = ();
    type Socket = ();
    type Session = ();
    type Sftp = ();
    fn resolve(&mut self, _: &RemoteProfile) -> Result<()> { self.stage("resolve"); Ok(()) }
    fn connect(&mut self, _: &RemoteProfile, _: ()) -> Result<()> { self.stage("connect"); Ok(()) }
    fn handshake(&mut self, _: &RemoteProfile, _: ()) -> Result<()> { self.stage("handshake"); Ok(()) }
    fn verify(&mut self, _: &RemoteProfile, _: &()) -> Result<()> { self.stage("verify"); Ok(()) }
    fn authenticate(&mut self, profile: &RemoteProfile, password: Option<&str>, _: &()) -> Result<()> {
        self.stage("authenticate");
        let secret = password.map(str::to_owned).unwrap_or_else(|| self.credentials.lock().unwrap().clone());
        self.authentications.push((profile.host.clone(), secret));
        Ok(())
    }
    fn subsystem(&mut self, _: &()) -> Result<()> { self.stage("subsystem"); Ok(()) }
}
fn fake<'a>(cancelled: &'a AtomicBool, stop_after: Option<&'static str>) -> FakeConnect<'a> {
    FakeConnect { cancelled, stop_after, calls: vec![], credentials: Arc::new(Mutex::new("old-test-secret".into())), authentications: vec![] }
}

#[test]
fn size_remote_sftp_cancelled_old_host_handshake_cannot_authenticate_with_updated_credentials() {
    let cancelled = AtomicBool::new(false);
    let mut transport = fake(&cancelled, Some("handshake"));
    let result = establish_sftp(&mut transport, &profile(), None, Some(&cancelled));
    assert!(transport.authentications.is_empty(), "a cancelled handshake must not initiate authentication");
    assert!(result.is_err());
    assert_eq!(transport.calls, ["resolve", "connect", "handshake"]);
}

#[test]
fn size_remote_sftp_setup_checks_cancellation_before_and_after_every_blocking_stage() {
    let stages = ["resolve", "connect", "handshake", "verify", "authenticate", "subsystem"];
    for (index, stage) in stages.iter().enumerate() {
        let cancelled = AtomicBool::new(false);
        let mut transport = fake(&cancelled, Some(stage));
        assert!(establish_sftp(&mut transport, &profile(), None, Some(&cancelled)).is_err(), "{stage}");
        assert_eq!(transport.calls, stages[..=index], "no subsequent call after {stage}");
    }
    let cancelled = AtomicBool::new(true);
    let mut transport = fake(&cancelled, None);
    assert!(establish_sftp(&mut transport, &profile(), None, Some(&cancelled)).is_err());
    assert!(transport.calls.is_empty(), "closed owner/app must not start connection setup");
}

#[test]
fn size_remote_sftp_ordinary_connection_preserves_setup_order_without_scanner_cancellation() {
    let cancelled = AtomicBool::new(false);
    let mut transport = fake(&cancelled, None);
    establish_sftp(&mut transport, &profile(), Some("explicit-test-secret"), None).unwrap();
    assert_eq!(transport.calls, ["resolve", "connect", "handshake", "verify", "authenticate", "subsystem"]);
    assert_eq!(transport.authentications, [("old.example.invalid".into(), "explicit-test-secret".into())]);
}

#[test]
fn size_remote_sftp_cancel_during_root_metadata_prevents_subsequent_metadata_calls() {
    let cancelled = AtomicBool::new(false);
    let mut calls = 0;
    let result = (|| -> Result<()> {
        setup_stage(Some(&cancelled), || { calls += 1; cancelled.store(true, Ordering::Release); Ok(()) })?;
        setup_stage(Some(&cancelled), || { calls += 1; Ok(()) })
    })();
    assert!(result.is_err());
    assert_eq!(calls, 1);
}

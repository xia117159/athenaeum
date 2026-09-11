use std::{net::{SocketAddr, TcpStream, ToSocketAddrs}, sync::atomic::{AtomicBool, Ordering}, time::Duration};
use anyhow::{anyhow, bail, Context, Result};
use ssh2::{Session, Sftp};
use crate::domain::models::RemoteProfile;

/// The same setup path is used by real SSH and deterministic cancellation tests.
pub(super) trait SftpConnect {
    type Address;
    type Socket;
    type Session;
    type Sftp;
    fn resolve(&mut self, profile: &RemoteProfile) -> Result<Self::Address>;
    fn connect(&mut self, profile: &RemoteProfile, address: Self::Address) -> Result<Self::Socket>;
    fn handshake(&mut self, profile: &RemoteProfile, socket: Self::Socket) -> Result<Self::Session>;
    fn verify(&mut self, profile: &RemoteProfile, session: &Self::Session) -> Result<()>;
    fn authenticate(&mut self, profile: &RemoteProfile, password: Option<&str>, session: &Self::Session) -> Result<()>;
    fn subsystem(&mut self, session: &Self::Session) -> Result<Self::Sftp>;
}

pub(super) fn setup_stage<T>(cancelled: Option<&AtomicBool>, operation: impl FnOnce() -> Result<T>) -> Result<T> {
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) { bail!("目录统计已取消"); }
    let result = operation();
    // A blocking OS/network call may drain, but cannot authorize another stage.
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) { bail!("目录统计已取消"); }
    result
}

fn establish_ssh<T: SftpConnect>(transport: &mut T, profile: &RemoteProfile, cancelled: Option<&AtomicBool>) -> Result<T::Session> {
    let address = setup_stage(cancelled, || transport.resolve(profile))?;
    let socket = setup_stage(cancelled, || transport.connect(profile, address))?;
    setup_stage(cancelled, || transport.handshake(profile, socket))
}

pub(super) fn establish_sftp<T: SftpConnect>(transport: &mut T, profile: &RemoteProfile,
    password: Option<&str>, cancelled: Option<&AtomicBool>) -> Result<(T::Session, T::Sftp)> {
    let session = establish_ssh(transport, profile, cancelled)?;
    setup_stage(cancelled, || transport.verify(profile, &session))?;
    setup_stage(cancelled, || transport.authenticate(profile, password, &session))?;
    let sftp = setup_stage(cancelled, || transport.subsystem(&session))?;
    Ok((session, sftp))
}

struct NativeConnect;
impl SftpConnect for NativeConnect {
    type Address = SocketAddr;
    type Socket = TcpStream;
    type Session = Session;
    type Sftp = Sftp;
    fn resolve(&mut self, profile: &RemoteProfile) -> Result<SocketAddr> {
        (profile.host.as_str(), profile.port).to_socket_addrs()
            .with_context(|| format!("failed to resolve {}:{}", profile.host, profile.port))?
            .next().ok_or_else(|| anyhow!("failed to resolve {}:{}", profile.host, profile.port))
    }
    fn connect(&mut self, profile: &RemoteProfile, address: SocketAddr) -> Result<TcpStream> {
        let tcp = TcpStream::connect_timeout(&address, Duration::from_secs(profile.connect_timeout_secs))
            .with_context(|| format!("failed to connect to {}:{}", profile.host, profile.port))?;
        tcp.set_read_timeout(Some(Duration::from_secs(profile.command_timeout_secs))).context("failed to configure SFTP read timeout")?;
        tcp.set_write_timeout(Some(Duration::from_secs(profile.command_timeout_secs))).context("failed to configure SFTP write timeout")?;
        Ok(tcp)
    }
    fn handshake(&mut self, profile: &RemoteProfile, socket: TcpStream) -> Result<Session> {
        let mut session = Session::new().context("failed to create SSH session")?;
        session.set_tcp_stream(socket);
        session.set_timeout(profile.command_timeout_secs.saturating_mul(1000).min(u32::MAX as u64) as u32);
        session.handshake().context("failed to complete SSH handshake")?;
        Ok(session)
    }
    fn verify(&mut self, profile: &RemoteProfile, session: &Session) -> Result<()> { super::verify_sftp_host_key(session, profile) }
    fn authenticate(&mut self, profile: &RemoteProfile, password: Option<&str>, session: &Session) -> Result<()> {
        super::authenticate_sftp_session(session, profile, password)
    }
    fn subsystem(&mut self, session: &Session) -> Result<Sftp> { session.sftp().context("failed to open SFTP subsystem") }
}

pub(super) fn connect_ssh_session(profile: &RemoteProfile) -> Result<Session> { establish_ssh(&mut NativeConnect, profile, None) }
pub(super) fn connect_sftp(profile: &RemoteProfile, password: Option<&str>) -> Result<(Session, Sftp)> {
    establish_sftp(&mut NativeConnect, profile, password, None)
}
pub(super) fn connect_sftp_cancelled(profile: &RemoteProfile, cancelled: &AtomicBool) -> Result<(Session, Sftp)> {
    establish_sftp(&mut NativeConnect, profile, profile.password.as_deref(), Some(cancelled))
}

#[cfg(test)]
#[path = "connection_tests.rs"]
mod tests;

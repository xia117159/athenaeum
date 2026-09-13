use std::{fs, io::{BufRead, BufReader, Write}, net::TcpListener, path::PathBuf,
    sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, thread, time::{Duration, Instant}};
use super::{ftp_root::{read_root, root_command}, scanner_profile, tests::profile, TransportError};
use crate::{domain::models::{RemoteAuthKind, RemoteProfile}, services::directory_size::metadata::MetadataKind};

struct FtpServer {
    profile: RemoteProfile,
    commands: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl FtpServer {
    fn new(root_reply: &str, disconnect: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let commands = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let seen = commands.clone(); let shutdown = stop.clone(); let root_reply = root_reply.to_string();
        let worker = thread::spawn(move || {
            let started = Instant::now();
            while !shutdown.load(Ordering::Relaxed) && started.elapsed() < Duration::from_secs(10) {
                let (mut stream, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => { thread::sleep(Duration::from_millis(5)); continue; }
                    Err(_) => break,
                };
                stream.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
                stream.set_write_timeout(Some(Duration::from_secs(1))).unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let _ = stream.write_all(b"220 Test FTP ready\r\n");
                while !shutdown.load(Ordering::Relaxed) && started.elapsed() < Duration::from_secs(10) {
                    let mut line = String::new();
                    match reader.read_line(&mut line) {
                        Ok(0) => break,
                        Ok(_) => {},
                        Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => continue,
                        Err(_) => break,
                    }
                    let line = line.trim_end_matches(['\r', '\n']).to_string();
                    seen.lock().unwrap().push(line.clone());
                    if line.len() > 32768 || seen.lock().unwrap().len() > 64 { break; }
                    let reply = if line.starts_with("USER ") { "331 Password required\r\n" }
                        else if line.starts_with("PASS ") { "230 Logged in\r\n" }
                        else if line == "PWD" { "257 \"/login\"\r\n" }
                        else if line.starts_with("MLST ") { &root_reply }
                        else if line == "QUIT" { "221 Goodbye\r\n" }
                        else if line.starts_with("CWD ") { "250 Changed\r\n" }
                        else if line.starts_with("TYPE ") || line.starts_with("SITE ") { "200 Accepted\r\n" }
                        else { "500 Unexpected command\r\n" };
                    if stream.write_all(reply.as_bytes()).is_err() || line == "QUIT" || disconnect && line.starts_with("MLST ") { break; }
                }
            }
        });
        let mut profile = scanner_profile(&profile());
        profile.host = "127.0.0.1".into(); profile.port = port; profile.root_path = "/".into();
        profile.auth_kind = RemoteAuthKind::Anonymous; profile.command_timeout_secs = 3; profile.connect_timeout_secs = 3;
        Self { profile, commands, stop, worker: Some(worker) }
    }
    fn command(&self, path: &str) -> std::process::Command {
        let mut command = root_command(&self.profile, None, path).unwrap();
        command.env("NO_PROXY", "127.0.0.1");
        command
    }
    fn assert_preflight_only(&self, operand: &str) {
        let commands = self.commands.lock().unwrap();
        assert_eq!(commands.iter().filter(|line| line.starts_with("MLST ")).collect::<Vec<_>>(), [&format!("MLST {operand}")]);
        assert!(commands.iter().all(|line| line.starts_with("USER ") || line.starts_with("PASS ") || line == "PWD"
            || line == "QUIT" || line == &format!("MLST {operand}")), "unexpected preflight wire: {commands:?}");
    }
}
impl Drop for FtpServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() { worker.join().unwrap(); }
    }
}

struct CurlConfig(PathBuf);
impl CurlConfig {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("sfm-size-curl-config-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        for name in [".curlrc", "_curlrc"] {
            fs::write(path.join(name), "quote = \"SITE ROOT_PROBE_CONFIG_INJECTION\"\nurl = \"ftp://127.0.0.1:1/extra\"\n").unwrap();
        }
        Self(path)
    }
}
impl Drop for CurlConfig {
    fn drop(&mut self) {
        for name in [".curlrc", "_curlrc"] { fs::remove_file(self.0.join(name)).unwrap(); }
        fs::remove_dir(&self.0).unwrap();
    }
}

#[test]
fn size_remote_ftp_root_wire_is_one_raw_mlst_without_listing_data_or_curlrc_injection() {
    let config = CurlConfig::new();
    for (path, operand) in [("/root/a folder", "root/a folder"), ("/", ".")] {
        let server = FtpServer::new("250-Object facts\r\n type=dir; /login/root/a folder\r\n250 End\r\n", false);
        let mut command = server.command(path);
        command.env("CURL_HOME", &config.0);
        let result = read_root(command, &AtomicBool::new(false), Duration::from_secs(3));
        assert_eq!(result, Ok(MetadataKind::Directory));
        server.assert_preflight_only(operand);
    }
}

#[test]
fn size_remote_ftp_root_wire_distinguishes_unsupported_permission_and_truncation() {
    for (reply, disconnect, unsupported) in [
        ("500 MLST unsupported\r\n", false, true),
        ("502 MLST unsupported\r\n", false, true),
        ("550 Permission denied\r\n", false, false),
        ("500-Truncated unsupported\r\n", true, false),
        ("250-Object facts\r\n type=dir; /login/root\r\n", true, false),
    ] {
        let server = FtpServer::new(reply, disconnect);
        let result = read_root(server.command("/root"), &AtomicBool::new(false), Duration::from_secs(3));
        if unsupported { assert_eq!(result, Err(TransportError::Unsupported)); }
        else { assert!(matches!(result, Err(TransportError::Failed(_)))); }
        server.assert_preflight_only("root");
    }
}

#[test]
fn size_remote_ftp_root_wire_caps_control_output_and_honors_cancel() {
    let oversized = format!("250-Object facts\r\n{}250 End\r\n", " x=1; /padding\r\n".repeat(6000));
    let server = FtpServer::new(&oversized, false);
    let result = read_root(server.command("/root"), &AtomicBool::new(false), Duration::from_secs(3));
    match result { Err(TransportError::OutputLimit(message)) => assert!(message.contains("65536"), "{message}"), other => panic!("{other:?}") }
    let cancelled = AtomicBool::new(true);
    let server = FtpServer::new("250-Object facts\r\n type=dir; /root\r\n250 End\r\n", false);
    assert_eq!(read_root(server.command("/root"), &cancelled, Duration::from_secs(3)), Err(TransportError::Cancelled));
    assert!(server.commands.lock().unwrap().is_empty());
}

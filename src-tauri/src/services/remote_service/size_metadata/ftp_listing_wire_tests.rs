use std::{io::{BufRead, BufReader, Write}, net::{TcpListener, TcpStream}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}},
    thread, time::{Duration, Instant}};
use crate::{domain::models::{RemoteAuthKind, RemoteProfile}, services::directory_size::scan::{scan_directory, ScanLimits, ScanOutcome}};
use super::{ftp::CurlMetadataTransport, FtpMetadataSource};

#[derive(Clone, Copy, PartialEq)]
enum Mode { Metadata, Legacy, Denied, LoginDenied }
struct Server {
    profile: RemoteProfile,
    commands: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn new(mode: Mode) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let commands = Arc::new(Mutex::new(vec![])); let seen = commands.clone();
        let stop = Arc::new(AtomicBool::new(false)); let shutdown = stop.clone();
        let worker = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(30);
            while !shutdown.load(Ordering::Relaxed) && Instant::now() < deadline {
                match listener.accept() {
                    Ok((stream, _)) => serve(stream, mode, &seen, &shutdown, deadline),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(5)),
                    Err(_) => break,
                }
            }
        });
        let mut profile = super::scanner_profile(&super::tests::profile());
        profile.host = "127.0.0.1".into(); profile.port = port; profile.root_path = "/".into();
        profile.auth_kind = RemoteAuthKind::Anonymous; profile.command_timeout_secs = 3; profile.connect_timeout_secs = 3;
        Self { profile, commands, stop, worker: Some(worker) }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() { worker.join().unwrap(); }
    }
}
fn serve(mut stream: TcpStream, mode: Mode, commands: &Mutex<Vec<String>>, stop: &AtomicBool, deadline: Instant) {
    stream.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
    stream.set_write_timeout(Some(Duration::from_secs(1))).unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut passive = None; let mut cwd = String::from("/");
    let _ = stream.write_all(b"220 Test ready\r\n");
    while !stop.load(Ordering::Relaxed) && Instant::now() < deadline {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {},
            Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => continue,
            Err(_) => break,
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if line.len() > 32768 || commands.lock().unwrap().len() >= 256 { break; }
        commands.lock().unwrap().push(line.into());
        let reply = if line.starts_with("USER ") {
            if mode == Mode::LoginDenied { "530 Login denied\r\n".into() } else { "331 Password required\r\n".into() }
        } else if line.starts_with("PASS ") { "230 Logged in\r\n".into() }
        else if line == "PWD" { "257 \"/login\"\r\n".into() }
        else if line.starts_with("MLST ") { "250-Facts\r\n type=dir; /login/root\r\n250 End\r\n".into() }
        else if let Some(path) = line.strip_prefix("CWD ") {
            let next = if path.starts_with('/') { path.into() } else { format!("{}/{path}", cwd.trim_end_matches('/')) };
            if ["/", "/root", "/root/folder", "/root/folder "].contains(&next.as_str()) { cwd = next; "250 Changed\r\n".into() }
            else { "550 Missing directory\r\n".into() }
        } else if line == "EPSV" || line == "PASV" {
            let data = TcpListener::bind("127.0.0.1:0").unwrap(); data.set_nonblocking(true).unwrap();
            let port = data.local_addr().unwrap().port(); passive = Some(data);
            if line == "EPSV" { format!("229 Entering Extended Passive Mode (|||{port}|)\r\n") }
            else { format!("227 Entering Passive Mode (127,0,0,1,{},{})\r\n", port / 256, port % 256) }
        } else if matches!(line, "MLSD" | "LIST -a" | "NLST") {
            if mode == Mode::Denied { passive = None; "550 Permission denied\r\n".into() }
            else if mode == Mode::Legacy && line != "NLST" { passive = None; "500 Command unsupported\r\n".into() }
            else {
                let payload = if line == "NLST" { "folder/\r\nfile.txt\r\n" }
                    else if cwd == "/root/folder " { "type=file;size=90; payload\r\n" }
                    else if cwd == "/root/folder" { "type=file;size=10; payload\r\n" }
                    else { "type=dir; folder\r\ntype=dir; folder \r\n" };
                if stream.write_all(b"150 Opening data\r\n").is_err() { break; }
                let Some(data) = passive.take() else { break; };
                let until = Instant::now() + Duration::from_secs(2);
                loop {
                    match data.accept() {
                        Ok((mut channel, _)) => { let _ = channel.write_all(payload.as_bytes()); break; },
                        Err(_) if Instant::now() < until && !stop.load(Ordering::Relaxed) => thread::sleep(Duration::from_millis(5)),
                        Err(_) => break,
                    }
                }
                "226 Transfer complete\r\n".into()
            }
        } else if line.starts_with("TYPE ") { "200 Type accepted\r\n".into() }
        else if line == "QUIT" { "221 Bye\r\n".into() }
        else { "500 Unexpected command\r\n".into() };
        if stream.write_all(reply.as_bytes()).is_err() || line == "QUIT" { break; }
    }
}

#[test]
fn size_remote_ftp_legacy_wire_browsing_falls_back_to_nlst_without_exact_statistics() {
    let server = Server::new(Mode::Legacy);
    let listing = super::super::list_directory_snapshot(&server.profile, None, Some("/root")).unwrap();
    assert_eq!(listing.entries.iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>(), ["folder", "file.txt"]);
    assert!(listing.size_fingerprint.is_none());
    let mut source = FtpMetadataSource::new(CurlMetadataTransport { profile: server.profile.clone(), password: None });
    let scan = scan_directory("/root", &mut source, &AtomicBool::new(false), ScanLimits::default(), |_| {});
    assert_ne!(scan.outcome, ScanOutcome::Complete);
    assert_eq!(server.commands.lock().unwrap().iter().filter(|command| command.as_str() == "NLST").count(), 1,
        "only ordinary browsing may use name-only fallback");
}

#[test]
fn size_remote_ftp_listing_wire_errors_never_become_successful_empty_directories() {
    for mode in [Mode::Denied, Mode::LoginDenied] {
        let server = Server::new(mode);
        assert!(super::super::list_directory_snapshot(&server.profile, None, Some("/root")).is_err());
    }
    let server = Server::new(Mode::Metadata);
    assert!(super::super::list_directory_snapshot(&server.profile, None, Some("/missing")).is_err());
}

#[test]
fn size_remote_ftp_listing_wire_keeps_trailing_space_directories_distinct_through_curl() {
    let server = Server::new(Mode::Metadata);
    let mut source = FtpMetadataSource::new(CurlMetadataTransport { profile: server.profile.clone(), password: None });
    let scan = scan_directory("/root", &mut source, &AtomicBool::new(false), ScanLimits::default(), |_| {});
    assert_eq!(scan.outcome, ScanOutcome::Complete);
    assert_eq!(scan.stats.known_bytes, 100);
    assert_eq!(scan.directories["/root/folder"].bytes, 10);
    assert_eq!(scan.directories["/root/folder "].bytes, 90);
    let listing = super::super::list_directory_snapshot(&server.profile, None, Some("/root")).unwrap();
    assert_eq!(listing.size_fingerprint, scan.directories["/root"].fingerprint);
    assert!(server.commands.lock().unwrap().iter().any(|command| command == "CWD folder "));
}

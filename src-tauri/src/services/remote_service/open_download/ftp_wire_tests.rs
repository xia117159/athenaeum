use super::download_file;
use crate::domain::models::{LocationKind, RemoteAuthKind, RemoteProfile};
use std::{
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

struct Server {
    profile: RemoteProfile,
    commands: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn new(fact: &'static str, slow: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let commands = Arc::new(Mutex::new(Vec::new()));
        let seen = commands.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let shutdown = stop.clone();
        let worker = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(20);
            while !shutdown.load(Ordering::Acquire) && Instant::now() < deadline {
                match listener.accept() {
                    Ok((stream, _)) => serve(stream, fact, slow, &seen, &shutdown),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => break,
                }
            }
        });
        let profile = RemoteProfile {
            id: "download-test".into(),
            name: "Download".into(),
            protocol: LocationKind::Ftp,
            host: "127.0.0.1".into(),
            port,
            username: "anonymous".into(),
            root_path: "/root".into(),
            auth_kind: RemoteAuthKind::Anonymous,
            password: None,
            credential_target: None,
            private_key_path: None,
            passive_mode: true,
            ignore_host_key: false,
            connect_timeout_secs: 3,
            command_timeout_secs: 5,
        };
        Self {
            profile,
            commands,
            stop,
            worker: Some(worker),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.worker.take().unwrap().join().unwrap();
    }
}

fn serve(
    mut stream: TcpStream,
    fact: &str,
    slow: bool,
    commands: &Mutex<Vec<String>>,
    stop: &AtomicBool,
) {
    stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut passive = None;
    let _ = stream.write_all(b"220 Download fixture\r\n");
    while !stop.load(Ordering::Acquire) {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                continue
            }
            Err(_) => break,
        }
        let line = line.trim_end_matches(['\r', '\n']);
        commands.lock().unwrap().push(if line.starts_with("PASS ") {
            "PASS [fixture]".into()
        } else {
            line.into()
        });
        let reply = if line.starts_with("USER ") {
            "331 Password\r\n".into()
        } else if line.starts_with("PASS ") {
            "230 Logged in\r\n".into()
        } else if line == "PWD" {
            "257 \"/\"\r\n".into()
        } else if line.starts_with("CWD ") {
            "250 Changed\r\n".into()
        } else if line.starts_with("TYPE ") {
            "200 Type accepted\r\n".into()
        } else if line.starts_with("SIZE ") {
            if slow {
                "213 1048576\r\n".into()
            } else {
                "213 11\r\n".into()
            }
        } else if line == "EPSV" || line == "PASV" {
            let data = TcpListener::bind("127.0.0.1:0").unwrap();
            data.set_nonblocking(true).unwrap();
            let port = data.local_addr().unwrap().port();
            passive = Some(data);
            if line == "EPSV" {
                format!("229 Entering Extended Passive Mode (|||{port}|)\r\n")
            } else {
                format!(
                    "227 Entering Passive Mode (127,0,0,1,{},{})\r\n",
                    port / 256,
                    port % 256
                )
            }
        } else if line == "MLSD" || line.starts_with("RETR ") {
            let Some(data) = passive.take() else {
                break;
            };
            if stream.write_all(b"150 Opening data\r\n").is_err() {
                break;
            }
            let until = Instant::now() + Duration::from_secs(2);
            loop {
                match data.accept() {
                    Ok((mut channel, _)) => {
                        channel
                            .set_write_timeout(Some(Duration::from_secs(1)))
                            .unwrap();
                        if line == "MLSD" {
                            let _ = channel.write_all(format!("{fact} file.txt\r\n").as_bytes());
                        } else if slow {
                            for _ in 0..256 {
                                if stop.load(Ordering::Acquire)
                                    || channel.write_all(&[7; 4096]).is_err()
                                {
                                    break;
                                }
                                thread::sleep(Duration::from_millis(10));
                            }
                        } else {
                            let _ = channel.write_all(b"hello world");
                        }
                        break;
                    }
                    Err(_) if Instant::now() < until && !stop.load(Ordering::Acquire) => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => break,
                }
            }
            "226 Transfer complete\r\n".into()
        } else if line == "QUIT" {
            "221 Bye\r\n".into()
        } else {
            "500 Unsupported\r\n".into()
        };
        if stream.write_all(reply.as_bytes()).is_err() || line == "QUIT" {
            break;
        }
    }
}

#[test]
fn file_open_download_ftp_wire_checks_metadata_before_exactly_one_retr() {
    let dir = super::tests::Temporary::new();
    let target = dir.0.join("file.txt");
    for (fact, accepted) in [
        ("type=file;size=11;", true),
        ("type=file;", true),
        ("type=dir;", false),
        ("type=OS.unix=slink;", false),
        ("type=unknown;", false),
    ] {
        let server = Server::new(fact, false);
        let result = download_file(
            &server.profile,
            "/root/file.txt",
            &target,
            &AtomicBool::new(false),
            &mut |_| {},
        );
        assert_eq!(result.is_ok(), accepted, "{fact}: {result:?}");
        let commands = server.commands.lock().unwrap().clone();
        assert_eq!(
            commands
                .iter()
                .filter(|command| command.starts_with("RETR "))
                .count(),
            usize::from(accepted)
        );
        assert!(!commands.iter().any(|command| command == "NLST"));
        if accepted {
            assert_eq!(std::fs::read(&target).unwrap(), b"hello world");
            std::fs::remove_file(&target).unwrap();
        } else {
            assert!(!target.exists());
        }
    }
}

#[test]
fn file_open_download_ftp_wire_cancel_stops_before_receiving_the_whole_file() {
    let dir = super::tests::Temporary::new();
    let target = dir.0.join("file.txt");
    let server = Server::new("type=file;size=1048576;", true);
    let cancelled = AtomicBool::new(false);
    assert!(download_file(
        &server.profile,
        "/root/file.txt",
        &target,
        &cancelled,
        &mut |bytes| {
            if bytes > 0 {
                cancelled.store(true, Ordering::Release);
            }
        }
    )
    .is_err());
    assert!(std::fs::metadata(&target).unwrap().len() < 1048576);
}

use super::{ftp_root::{MlstReply, root_command}, tests::profile, TransportError};
use crate::{domain::models::RemoteAuthKind, services::directory_size::metadata::MetadataKind};

fn response(body: &str, exit: i32) -> Result<MetadataKind, TransportError> {
    let mut reply = MlstReply::default();
    for line in format!("220-Welcome\r\n257 fake banner text\r\n220 Ready\r\n331 Password\r\n230 Logged in\r\n257 \"/login\"\r\n{body}").lines() {
        reply.feed(line.as_bytes());
    }
    reply.finish(Some(exit))
}

#[test]
fn size_remote_ftp_root_reply_parses_complete_facts_with_link_precedence() {
    for facts in ["type=dir; /server/root", "TyPe=cdir;modify=20260911000000; /server/root"] {
        assert_eq!(response(&format!("250-Listing\r\n {facts}\r\n250 End\r\n221 Bye\r\n"), 0), Ok(MetadataKind::Directory));
    }
    for facts in ["type=dir;unix.slink=/target; /root", "type=cdir;unix.slink=/target; /root",
        "type=OS.unix=slink:/target; /root", "type=OS.unix=symlink; /root"] {
        assert_eq!(response(&format!("250-Listing\r\n {facts}\r\n250 End\r\n"), 0), Ok(MetadataKind::Link));
    }
}

#[test]
fn size_remote_ftp_root_reply_never_promotes_malformed_truncated_or_failed_responses() {
    for body in [
        "250-Listing\r\n type=dir; /root\r\n",
        "250 Listing\r\n", "250-Listing\r\n250 End\r\n",
        "250-Listing\r\n type=dir;type=file; /root\r\n250 End\r\n",
        "250-Listing\r\n type=dir; /root\r\n type=dir; /other\r\n250 End\r\n",
        "250-Listing\r\n type=unknown; /root\r\n250 End\r\n",
        "250-Listing\r\n type=dir; \r\n250 End\r\n",
        "250-Listing\r\n type=dir; /root\r\n550 Failed\r\n",
        "250-Listing\r\n type=dir; /root\r\n250 End\r\n550 Later failure\r\n",
    ] { assert!(matches!(response(body, 0), Err(TransportError::Failed(_))), "{body:?}"); }
    assert!(matches!(response("250-Listing\r\n type=dir; /root\r\n250 End\r\n", 56), Err(TransportError::Failed(_))));
    let mut reply = MlstReply::default(); reply.feed(b"257 \"/login\""); reply.feed(b"250-Listing");
    reply.feed(b" type=dir; /bad\xff"); reply.feed(b"250 End");
    assert!(matches!(reply.finish(Some(0)), Err(TransportError::Failed(_))));
}

#[test]
fn size_remote_ftp_root_unsupported_requires_a_complete_reply_owned_by_mlst() {
    for code in [500, 502, 504] {
        assert_eq!(response(&format!("{code} Unsupported\r\n"), 21), Err(TransportError::Unsupported));
        assert_eq!(response(&format!("{code}-Unsupported\r\n details\r\n{code} End\r\n"), 21), Err(TransportError::Unsupported));
        assert!(matches!(response(&format!("{code}-Truncated\r\n"), 21), Err(TransportError::Failed(_))));
        assert!(matches!(response(&format!("{code} Unsupported\r\n"), 56), Err(TransportError::Failed(_))));
    }
    assert!(matches!(response("550 Permission denied\r\n", 21), Err(TransportError::Failed(_))));
    for lines in [["500 Authentication failure"].as_slice(), ["220 Ready", "230 Logged in", "500 PWD failure"].as_slice()] {
        let mut reply = MlstReply::default();
        for line in lines { reply.feed(line.as_bytes()); }
        assert!(matches!(reply.finish(Some(21)), Err(TransportError::Failed(_))));
    }
}

#[test]
fn size_remote_ftp_root_command_is_login_relative_bounded_headers_only_and_curlrc_isolated() {
    let mut profile = profile(); profile.auth_kind = RemoteAuthKind::Anonymous; profile.root_path = "/".into();
    for (path, operand) in [("/root/a folder", "root/a folder"), ("/", ".")] {
        let command = root_command(&profile, None, path).unwrap();
        let args: Vec<_> = command.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
        assert_eq!(args[0], "--disable");
        assert!(args.contains(&"--head".into()));
        assert!(args.windows(2).any(|pair| pair == ["--dump-header", "-"]));
        assert!(args.windows(2).any(|pair| pair == ["--quote", &format!("MLST {operand}")]));
        assert_eq!(args.last().unwrap(), "ftp://example.invalid:21/");
        assert!(!args.contains(&"--request".into()));
    }
    assert!(root_command(&profile, None, "/root/\r\nDELE name").is_err());
    profile.root_path = "/root".into();
    assert!(root_command(&profile, None, "/outside").is_err());
}

use crate::services::directory_size::metadata::MetadataKind;
use super::ListingCommand;
use super::super::validate_remote_entry_name;
use chrono::{NaiveDate, NaiveDateTime, NaiveTime};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RemoteFact {
    pub name: String,
    pub kind: MetadataKind,
    pub modified_at: Option<chrono::DateTime<chrono::Utc>>,
}

pub(crate) fn parse_ftp_line(command: ListingCommand, line: &[u8]) -> Result<Option<RemoteFact>, ()> {
    let line = std::str::from_utf8(line).map_err(|_| ())?.trim_end_matches('\r');
    if line.is_empty() { return Ok(None); }
    if line.chars().any(|ch| ch.is_control()) { return Err(()); }
    let parsed = match command {
        ListingCommand::Mlsd => parse_mlsd(line)?,
        ListingCommand::ListAll => parse_list(line)?,
    };
    if let Some(fact) = &parsed { validate_remote_entry_name(&fact.name).map_err(|_| ())?; }
    Ok(parsed)
}

fn bytes(value: &str) -> Result<u64, ()> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) { return Err(()); }
    value.parse().map_err(|_| ())
}

fn parse_mlsd(line: &str) -> Result<Option<RemoteFact>, ()> {
    let (facts, name) = line.split_once(' ').ok_or(())?;
    if !facts.ends_with(';') { return Err(()); }
    let mut entry_type = None;
    let mut size = None;
    let mut modified_at = None;
    let mut link = false;
    for fact in facts.split(';').filter(|fact| !fact.is_empty()) {
        let (key, value) = fact.split_once('=').ok_or(())?;
        match key.to_ascii_lowercase().as_str() {
            "type" => { if entry_type.replace(value.to_ascii_lowercase()).is_some() { return Err(()); } }
            "size" => { if size.replace(bytes(value)?).is_some() { return Err(()); } }
            "modify" => modified_at = NaiveDateTime::parse_from_str(value, "%Y%m%d%H%M%S%.f").ok().map(|date| date.and_utc()),
            "unix.slink" => link = true,
            _ => {}
        }
    }
    let entry_type = entry_type.ok_or(())?;
    if matches!(entry_type.as_str(), "cdir" | "pdir") { return Ok(None); }
    let kind = if link || entry_type.starts_with("os.unix=slink") || entry_type.starts_with("os.unix=symlink") {
        MetadataKind::Link
    } else {
        match entry_type.as_str() {
            "file" => MetadataKind::File(size.ok_or(())?),
            "dir" => MetadataKind::Directory,
            _ => return Err(()),
        }
    };
    Ok(Some(RemoteFact { name: name.into(), kind, modified_at }))
}

fn take_field<'a>(rest: &mut &'a str) -> Result<&'a str, ()> {
    *rest = rest.trim_start_matches(' ');
    let end = rest.find(' ').ok_or(())?;
    let field = &rest[..end];
    *rest = rest[end..].trim_start_matches(' ');
    if field.is_empty() { Err(()) } else { Ok(field) }
}

fn parse_list(line: &str) -> Result<Option<RemoteFact>, ()> {
    if line.strip_prefix("total ").is_some_and(|value| value.trim().parse::<u64>().is_ok()) { return Ok(None); }
    let mut rest = line.trim_start_matches(' ');
    let first = take_field(&mut rest)?;
    if first.len() >= 10 && matches!(first.as_bytes()[0], b'-' | b'd' | b'l' | b'b' | b'c' | b'p' | b's') {
        let _links = bytes(take_field(&mut rest)?)?;
        let _owner = take_field(&mut rest)?;
        let _group = take_field(&mut rest)?;
        let size = bytes(take_field(&mut rest)?)?;
        let _month = take_field(&mut rest)?;
        let _day = take_field(&mut rest)?;
        let _time = take_field(&mut rest)?;
        let kind = match first.as_bytes()[0] {
            b'-' => MetadataKind::File(size), b'd' => MetadataKind::Directory,
            b'l' => MetadataKind::Link, _ => MetadataKind::Special,
        };
        let name = if kind == MetadataKind::Link { rest.split_once(" -> ").ok_or(())?.0 } else { rest };
        if matches!(name, "." | "..") { return Ok(None); }
        return Ok(Some(RemoteFact { name: name.into(), kind, modified_at: None }));
    }
    let date = NaiveDate::parse_from_str(first, "%m-%d-%y").or_else(|_| NaiveDate::parse_from_str(first, "%m-%d-%Y")).map_err(|_| ())?;
    let time = NaiveTime::parse_from_str(&take_field(&mut rest)?.to_ascii_uppercase(), "%I:%M%p").map_err(|_| ())?;
    let size = take_field(&mut rest)?;
    let kind = if size.eq_ignore_ascii_case("<DIR>") { MetadataKind::Directory } else { MetadataKind::File(bytes(size)?) };
    if matches!(rest, "." | "..") { return Ok(None); }
    Ok(Some(RemoteFact { name: rest.into(), kind, modified_at: Some(date.and_time(time).and_utc()) }))
}

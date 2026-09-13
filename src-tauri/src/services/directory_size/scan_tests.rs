use super::*;
use crate::services::directory_size::metadata::MetadataKind;
use std::{collections::HashMap, sync::atomic::Ordering, time::Instant};

#[derive(Default)]
struct FakeSource {
    entries: HashMap<String, Vec<MetadataEntry>>,
    reads: Vec<String>,
    fail: Option<String>,
    cancel_after: Option<usize>,
    emitted: usize,
}
impl MetadataSource for FakeSource {
    fn read_directory(&mut self, path: &str, cancelled: &AtomicBool, visit: &mut dyn FnMut(MetadataEntry) -> bool) -> Result<(), String> {
        self.reads.push(path.to_owned());
        if self.fail.as_deref() == Some(path) { return Err("access denied".into()); }
        for entry in self.entries.get(path).into_iter().flatten() {
            self.emitted += 1;
            if self.cancel_after == Some(self.emitted) { cancelled.store(true, Ordering::Relaxed); }
            if !visit(entry.clone()) { break; }
        }
        Ok(())
    }
}
fn file(name: &str, size: u64) -> MetadataEntry {
    MetadataEntry { name: name.into(), kind: MetadataKind::File(size), directory_path: None }
}
fn folder(name: &str, path: &str) -> MetadataEntry {
    MetadataEntry { name: name.into(), kind: MetadataKind::Directory, directory_path: Some(path.into()) }
}
fn run(source: &mut dyn MetadataSource) -> ScanResult {
    scan_directory("/root", source, &AtomicBool::new(false), ScanLimits::default(), |_| {})
}

#[test]
fn size_scan_aggregates_once_bottom_up_including_hidden_files() {
    let mut source = FakeSource::default();
    source.entries.insert("/root".into(), vec![folder("folder", "/root/folder"), file("a", 30), file("b", 10)]);
    source.entries.insert("/root/folder".into(), vec![file(".hidden", 40), folder("deep", "/root/folder/deep")]);
    source.entries.insert("/root/folder/deep".into(), vec![file("c", 20)]);
    let result = run(&mut source);
    assert_eq!(result.stats.known_bytes, 100);
    assert_eq!(result.directories["/root"].bytes, 100);
    assert_eq!(result.directories["/root/folder"].bytes, 60);
    assert_eq!(result.directories["/root/folder/deep"].bytes, 20);
    assert_eq!(result.outcome, ScanOutcome::Complete);
    assert_eq!(source.reads.len(), 3);
    assert_eq!(result.stats.files, 4);
    assert!(result.directories.values().all(|value| value.complete && value.fingerprint.is_some()));
}

#[test]
fn size_scan_zero_links_special_unknown_and_partial_are_not_conflated() {
    let mut source = FakeSource::default();
    source.entries.insert("/root".into(), vec![folder("empty", "/root/empty"), folder("denied", "/root/denied"),
        file("zero", 0), MetadataEntry { name: "link".into(), kind: MetadataKind::Link, directory_path: Some("/outside".into()) },
        MetadataEntry { name: "pipe".into(), kind: MetadataKind::Special, directory_path: None }, file("good", 10)]);
    source.fail = Some("/root/denied".into());
    let result = run(&mut source);
    assert_eq!(result.outcome, ScanOutcome::Partial);
    assert_eq!(result.directories["/root"].bytes, 10);
    assert!(!result.directories["/root"].complete);
    assert!(result.directories["/root/empty"].complete);
    assert_eq!(result.directories["/root/empty"].bytes, 0);
    assert!(!result.directories["/root/denied"].complete);
    assert!(result.directories["/root/denied"].fingerprint.is_none(), "a failed enumeration is not an empty listing");
    assert_eq!(result.stats.skipped_links, 1);
    assert_eq!(result.stats.skipped_special, 1);
    assert!(!source.reads.iter().any(|path| path == "/outside"));
    source.fail = None;
    source.entries.get_mut("/root").unwrap().push(MetadataEntry { name: "?".into(), kind: MetadataKind::Unknown, directory_path: None });
    let result = run(&mut source);
    assert_eq!(result.outcome, ScanOutcome::Partial);
    assert!(result.directories["/root"].fingerprint.is_none());
}

#[test]
fn size_scan_limits_overflow_and_cancellation_preserve_explicit_incompleteness() {
    let mut source = FakeSource::default();
    source.entries.insert("/root".into(), vec![file("a", 5), folder("child", "/root/child")]);
    let limited = scan_directory("/root", &mut source, &AtomicBool::new(false), ScanLimits { max_directories: 1, ..ScanLimits::default() }, |_| {});
    assert_eq!(limited.outcome, ScanOutcome::Partial);
    assert_eq!(limited.directories["/root"].bytes, 5);
    assert!(!limited.directories["/root"].complete);
    source.cancel_after = Some(source.emitted + 2);
    let cancelled = run(&mut source);
    assert_eq!(cancelled.outcome, ScanOutcome::Cancelled);
    assert!(!cancelled.directories["/root"].complete);
    source.cancel_after = None;
    source.entries.insert("/root".into(), vec![file("max", u64::MAX), file("overflow", 1)]);
    let overflow = run(&mut source);
    assert_eq!(overflow.outcome, ScanOutcome::Partial);
    assert_eq!(overflow.directories["/root"].bytes, u64::MAX);
    assert!(!overflow.directories["/root"].complete);
    let expired = scan_directory("/root", &mut source, &AtomicBool::new(false), ScanLimits { max_elapsed: Duration::ZERO, ..ScanLimits::default() }, |_| {});
    assert_eq!(expired.outcome, ScanOutcome::Partial);
}

struct GeneratedSource { directories: usize, files: usize, reads: usize, emitted: usize }
impl MetadataSource for GeneratedSource {
    fn read_directory(&mut self, path: &str, _cancelled: &AtomicBool, visit: &mut dyn FnMut(MetadataEntry) -> bool) -> Result<(), String> {
        self.reads += 1;
        let index = if path == "/root" { 0 } else { path.trim_start_matches("/node-").parse::<usize>().unwrap() };
        if index + 1 < self.directories { if !visit(folder("child", &format!("/node-{}", index + 1))) { return Ok(()); } }
        for index in 0..self.files {
            self.emitted += 1;
            if !visit(file(&format!("file-{index}"), 1)) { break; }
        }
        Ok(())
    }
}

#[test]
fn size_scan_streams_a_million_files_without_retaining_file_records() {
    let mut source = GeneratedSource { directories: 1, files: 1_000_000, reads: 0, emitted: 0 };
    let started = Instant::now();
    let result = run(&mut source);
    assert_eq!(result.outcome, ScanOutcome::Complete);
    assert_eq!(result.stats.files, 1_000_000);
    assert_eq!(result.stats.known_bytes, 1_000_000);
    assert_eq!(result.directories.len(), 1);
    assert!(result.accounted_bytes < 4096);
    assert_eq!(source.reads, 1);
    eprintln!("million-file stream: {:?}, {} accounted bytes, {} retained directory", started.elapsed(), result.accounted_bytes, result.directories.len());
}

#[test]
fn size_scan_deep_chain_is_iterative_and_path_bytes_are_budgeted() {
    let mut source = GeneratedSource { directories: 40_000, files: 1, reads: 0, emitted: 0 };
    let result = run(&mut source);
    assert_eq!(result.outcome, ScanOutcome::Complete);
    assert_eq!(result.stats.known_bytes, 40_000);
    assert_eq!(source.reads, 40_000);
    let mut source = FakeSource::default();
    source.entries.insert("/root".into(), vec![folder("long", &format!("/root/{}", "a".repeat(2048)))]);
    let limited = scan_directory("/root", &mut source, &AtomicBool::new(false), ScanLimits { max_accounted_bytes: 2048, ..ScanLimits::default() }, |_| {});
    assert_eq!(limited.outcome, ScanOutcome::Partial);
    assert!(limited.accounted_bytes <= 2048);
    assert_eq!(source.reads.len(), 1);
}

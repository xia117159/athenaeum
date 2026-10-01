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
fn configured_size_budgets_match_user_limits() {
    assert_eq!(ScanLimits::default().max_accounted_bytes, 128 * 1024 * 1024);
    assert_eq!(super::super::core::ServiceLimits::default().cache_bytes, 256 * 1024 * 1024);
}

struct WideLocalSource { children: usize }
impl WideLocalSource {
    fn entries(&self, path: &str) -> Box<dyn Iterator<Item = MetadataEntry>> {
        if path == "/root" {
            Box::new((0..self.children).map(|index| folder(&format!("child{index}"), &format!("/root/child{index}"))))
        } else { Box::new(std::iter::once(file("payload", 7))) }
    }
}
impl MetadataSource for WideLocalSource {
    fn open_directory(&mut self, path: &str, _: &AtomicBool) -> Option<Result<DirectoryCursor, String>> {
        Some(Ok(DirectoryCursor { entries: self.entries(path), created_at: Some(chrono::DateTime::UNIX_EPOCH) }))
    }
    fn read_directory(&mut self, path: &str, _: &AtomicBool, visit: &mut dyn FnMut(MetadataEntry) -> bool) -> Result<(), String> {
        for entry in self.entries(path) { if !visit(entry) { break; } }
        Ok(())
    }
}

#[test]
fn local_wide_tree_finishes_past_100k_with_tiny_detail_budget() {
    let mut source = WideLocalSource { children: 100_005 };
    let result = scan_directory("/root", &mut source, &AtomicBool::new(false),
        ScanLimits { max_accounted_bytes: 4096, ..ScanLimits::default() }, |_| {});
    assert_eq!(result.outcome, ScanOutcome::Complete);
    assert_eq!(result.stats.directories, 100_006);
    assert_eq!(result.directories["/root"].bytes, 100_005 * 7);
    assert!(result.directories.len() < 10);
    assert!(result.accounted_bytes <= 4096);
}

#[test]
fn local_count_and_elapsed_limits_only_bound_details_not_traversal() {
    let mut source = WideLocalSource { children: 20 };
    let result = scan_directory("/root", &mut source, &AtomicBool::new(false),
        ScanLimits { max_directories: 1, max_elapsed: Duration::ZERO, ..ScanLimits::default() }, |_| {});
    assert_eq!(result.outcome, ScanOutcome::Complete);
    assert_eq!(result.directories.len(), 1);
    assert_eq!(result.directories["/root"].bytes, 140);
    assert_eq!(result.stats.directories, 21);
}

struct StreamingSource(FakeSource);
impl MetadataSource for StreamingSource {
    fn read_directory(&mut self, _: &str, _: &AtomicBool, _: &mut dyn FnMut(MetadataEntry) -> bool) -> Result<(), String> { unreachable!() }
    fn open_directory(&mut self, path: &str, _: &AtomicBool) -> Option<Result<DirectoryCursor, String>> {
        self.0.reads.push(path.into());
        if self.0.fail.as_deref() == Some(path) { return Some(Err("denied".into())); }
        Some(Ok(DirectoryCursor { entries: Box::new(self.0.entries.get(path).cloned().unwrap_or_default().into_iter()),
            created_at: Some(chrono::DateTime::UNIX_EPOCH) }))
    }
}

#[test]
fn local_detail_eviction_prefers_root_children_and_preserves_error_link_overflow_semantics() {
    let mut source = StreamingSource(FakeSource::default());
    source.0.entries.insert("/root".into(), vec![folder("a", "/root/a"), folder("b", "/root/b")]);
    source.0.entries.insert("/root/a".into(), vec![folder("deep", "/root/a/deep"), file("direct", 4)]);
    source.0.entries.insert("/root/a/deep".into(), vec![file("deep", 6)]);
    source.0.entries.insert("/root/b".into(), vec![file("b", 20)]);
    let result = scan_directory("/root", &mut source, &AtomicBool::new(false),
        ScanLimits { max_directories: 3, ..ScanLimits::default() }, |_| {});
    assert_eq!(result.outcome, ScanOutcome::Complete);
    assert_eq!(result.directories["/root/a"].bytes, 10);
    assert_eq!(result.directories["/root/b"].bytes, 20);
    assert_eq!(result.directories["/root"].bytes, 30);
    assert!(!result.directories.contains_key("/root/a/deep"));
    source.0.fail = Some("/root/a/deep".into());
    source.0.entries.get_mut("/root/b").unwrap().push(MetadataEntry { name: "link".into(), kind: MetadataKind::Link, directory_path: Some("/root".into()) });
    let result = run(&mut source);
    assert_eq!(result.outcome, ScanOutcome::Partial);
    assert_eq!(result.stats.known_bytes, 24);
    assert!(result.directories["/root/b"].complete);
    assert_eq!(result.stats.skipped_links, 1);
    source.0.entries.insert("/root".into(), vec![file("max", u64::MAX), file("overflow", 1)]);
    assert_eq!(run(&mut source).outcome, ScanOutcome::Partial);
    let cancelled = scan_directory("/root", &mut source, &AtomicBool::new(true), ScanLimits::default(), |_| {});
    assert_eq!(cancelled.outcome, ScanOutcome::Cancelled);
}

struct DeepStreamingSource;
impl MetadataSource for DeepStreamingSource {
    fn read_directory(&mut self, _: &str, _: &AtomicBool, _: &mut dyn FnMut(MetadataEntry) -> bool) -> Result<(), String> { unreachable!() }
    fn open_directory(&mut self, path: &str, _: &AtomicBool) -> Option<Result<DirectoryCursor, String>> {
        Some(Ok(DirectoryCursor { entries: Box::new(vec![file("p", 1), folder("d", &format!("{path}/d"))].into_iter()), created_at: None }))
    }
}
#[test]
fn local_active_depth_is_bounded_without_recursive_stack_and_reports_partial() {
    let result = run(&mut DeepStreamingSource);
    assert_eq!(result.outcome, ScanOutcome::Partial);
    assert_eq!(result.stats.directories, 1024);
    assert!(result.accounted_bytes <= ScanLimits::default().max_accounted_bytes);
    assert!(result.message.unwrap().contains("安全上限"));
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
    assert_eq!(result.directories["/root"].stats, result.stats);
    assert_eq!(result.directories["/root/folder"].stats, ScanStats { known_bytes: 60, files: 2, directories: 2, ..Default::default() });
    assert_eq!(result.directories["/root/folder/deep"].stats, ScanStats { known_bytes: 20, files: 1, directories: 1, ..Default::default() });
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

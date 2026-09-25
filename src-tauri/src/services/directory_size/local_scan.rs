//! Local iterative DFS. Retained details and traversal completeness are independent.
use std::{collections::{BTreeMap, HashMap}, sync::{Arc, atomic::{AtomicBool, Ordering}}, time::Instant};
use super::{metadata::{ListingFingerprint, MetadataKind}, scan::*};

const MAX_OPEN_DIRECTORIES: usize = 1024;
struct Frame { path: Arc<str>, cursor: DirectoryCursor, size: DirectorySize, fingerprint: ListingFingerprint }
impl Frame {
    fn new(path: &str, cursor: Result<DirectoryCursor, String>, message: &mut Option<String>) -> Self {
        let (cursor, complete) = match cursor {
            Ok(cursor) => (cursor, true),
            Err(error) => {
                message.get_or_insert(error);
                (DirectoryCursor { entries: Box::new(std::iter::empty()), created_at: None }, false)
            }
        };
        let size = DirectorySize { bytes: 0, complete, fingerprint: None, created_at: cursor.created_at,
            stats: ScanStats { directories: 1, errors: u64::from(!complete), ..Default::default() } };
        Self { path: Arc::from(path), cursor, size, fingerprint: ListingFingerprint::default() }
    }
    fn cost(&self) -> usize { NODE_ACCOUNT_BYTES + self.path.len() }
}

#[derive(Default)]
struct Details {
    values: HashMap<Arc<str>, DirectorySize>,
    order: BTreeMap<(usize, u64), Arc<str>>,
    bytes: usize, next: u64,
}
impl Details {
    fn evict(&mut self) {
        if let Some((_, path)) = self.order.pop_last() {
            self.bytes -= NODE_ACCOUNT_BYTES + path.len(); self.values.remove(&path);
        }
    }
    fn trim(&mut self, budget: usize) { while self.bytes > budget { self.evict(); } }
    fn insert(&mut self, depth: usize, frame: Frame, budget: usize, count: usize) {
        let cost = frame.cost();
        if cost > budget || count == 0 { return; }
        while self.bytes + cost > budget || self.values.len() >= count {
            if self.order.last_key_value().is_some_and(|((old_depth, _), _)| *old_depth < depth) { return; }
            self.evict();
        }
        self.next += 1; self.bytes += cost;
        self.order.insert((depth, self.next), frame.path.clone());
        self.values.insert(frame.path, frame.size);
    }
}

fn add(total: &mut u64, bytes: u64, complete: &mut bool) {
    if let Some(value) = total.checked_add(bytes) { *total = value; }
    else { *total = u64::MAX; *complete = false; }
}
fn merge(parent: &mut DirectorySize, child: &DirectorySize) {
    parent.complete &= child.complete;
    add(&mut parent.bytes, child.bytes, &mut parent.complete);
    parent.stats.files = parent.stats.files.saturating_add(child.stats.files);
    parent.stats.directories = parent.stats.directories.saturating_add(child.stats.directories);
    parent.stats.skipped_links = parent.stats.skipped_links.saturating_add(child.stats.skipped_links);
    parent.stats.skipped_special = parent.stats.skipped_special.saturating_add(child.stats.skipped_special);
    parent.stats.errors = parent.stats.errors.saturating_add(child.stats.errors);
    parent.stats.known_bytes = parent.bytes;
}

pub(super) fn scan(root: &str, source: &mut dyn MetadataSource, cursor: Result<DirectoryCursor, String>,
    cancelled: &AtomicBool, limits: ScanLimits, mut progress: impl FnMut(&ScanStats)) -> ScanResult {
    let root_failed = cursor.is_err();
    let mut message = None;
    let frame = Frame::new(root, cursor, &mut message);
    let mut working = frame.cost();
    if working > limits.max_accounted_bytes {
        return ScanResult { directories: HashMap::new(), stats: ScanStats::default(), outcome: ScanOutcome::Partial,
            accounted_bytes: 0, message: Some("目录统计活动路径超过内存预算".into()) };
    }
    let mut stats = frame.size.stats.clone();
    let mut frames = vec![frame];
    let mut details = Details::default();
    let mut last_progress = Instant::now();
    let mut total_complete = false;
    while !frames.is_empty() {
        if cancelled.load(Ordering::Relaxed) {
            for frame in &mut frames { frame.size.complete = false; }
        }
        let entry = if cancelled.load(Ordering::Relaxed) { None } else { frames.last_mut().unwrap().cursor.entries.next() };
        if let Some(entry) = entry {
            let frame = frames.last_mut().unwrap();
            frame.fingerprint.add(&entry.name, entry.kind);
            match entry.kind {
                MetadataKind::File(bytes) => {
                    let was_complete = frame.size.complete;
                    add(&mut frame.size.bytes, bytes, &mut frame.size.complete);
                    if was_complete && !frame.size.complete {
                        frame.size.stats.errors += 1; stats.errors += 1;
                        message.get_or_insert_with(|| "目录大小超出可表示范围".into());
                    }
                    frame.size.stats.files += 1; frame.size.stats.known_bytes = frame.size.bytes;
                    stats.files += 1; stats.known_bytes = stats.known_bytes.saturating_add(bytes);
                }
                MetadataKind::Directory => {
                    if let Some(path) = entry.directory_path {
                        let cost = NODE_ACCOUNT_BYTES + path.len();
                        if frames.len() < MAX_OPEN_DIRECTORIES && working.saturating_add(cost) <= limits.max_accounted_bytes {
                            working += cost; details.trim(limits.max_accounted_bytes - working);
                            let cursor = source.open_directory(&path, cancelled).unwrap_or_else(|| Err("本地目录游标不可用".into()));
                            let child = Frame::new(&path, cursor, &mut message);
                            stats.directories += 1; stats.errors += child.size.stats.errors;
                            frames.push(child);
                        } else {
                            let frame = frames.last_mut().unwrap(); frame.size.complete = false;
                            frame.size.stats.errors += 1; stats.errors += 1;
                            message.get_or_insert_with(|| "目录统计活动深度或路径内存达到安全上限".into());
                        }
                    } else { frame.size.complete = false; frame.size.stats.errors += 1; stats.errors += 1; }
                }
                MetadataKind::Link => { frame.size.stats.skipped_links += 1; stats.skipped_links += 1; }
                MetadataKind::Special => { frame.size.stats.skipped_special += 1; stats.skipped_special += 1; }
                MetadataKind::Unknown => {
                    frame.size.complete = false; frame.size.stats.errors += 1; stats.errors += 1;
                    message.get_or_insert_with(|| "部分条目的类型或大小不可用".into());
                }
            }
        } else {
            let mut frame = frames.pop().unwrap();
            working -= frame.cost();
            frame.size.fingerprint = if frame.size.complete { std::mem::take(&mut frame.fingerprint).finish() } else { None };
            frame.size.stats.known_bytes = frame.size.bytes;
            if let Some(parent) = frames.last_mut() { merge(&mut parent.size, &frame.size); }
            else { total_complete = frame.size.complete; stats = frame.size.stats.clone(); }
            if !cancelled.load(Ordering::Relaxed) { source.directory_completed(&frame.path, &frame.size); }
            details.insert(frames.len(), frame, limits.max_accounted_bytes - working, limits.max_directories.max(1));
        }
        if last_progress.elapsed() >= limits.progress_interval { progress(&stats); last_progress = Instant::now(); }
    }
    let outcome = if cancelled.load(Ordering::Relaxed) { ScanOutcome::Cancelled }
        else if root_failed { ScanOutcome::Failed } else if total_complete { ScanOutcome::Complete } else { ScanOutcome::Partial };
    ScanResult { directories: details.values, stats, outcome, accounted_bytes: details.bytes, message }
}

use std::{collections::{HashMap, HashSet}, sync::{atomic::{AtomicBool, Ordering}, Arc}, time::{Duration, Instant}};
use super::metadata::{ListingFingerprint, MetadataEntry, MetadataKind};

pub(crate) trait MetadataSource {
    fn read_directory(&mut self, path: &str, cancelled: &AtomicBool, visit: &mut dyn FnMut(MetadataEntry) -> bool) -> Result<(), String>;
    fn incomplete_reason(&self) -> Option<&str> { None }
    /// Local cursors permit bounded DFS; remote protocols keep their callback API.
    fn open_directory(&mut self, _path: &str, _cancelled: &AtomicBool) -> Option<Result<DirectoryCursor, String>> { None }
    /// Publish a provisional subtree before the bounded detail map may discard it.
    fn directory_completed(&mut self, _path: &str, _size: &DirectorySize) {}
}

pub(crate) struct DirectoryCursor {
    pub entries: Box<dyn Iterator<Item = MetadataEntry>>,
    pub created_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ScanLimits {
    pub max_directories: usize,
    pub max_accounted_bytes: usize,
    pub max_elapsed: Duration,
    pub progress_interval: Duration,
}
impl Default for ScanLimits {
    fn default() -> Self {
        Self { max_directories: 100_000, max_accounted_bytes: 128 * 1024 * 1024,
            max_elapsed: Duration::from_secs(15 * 60), progress_interval: Duration::from_millis(200) }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct ScanStats {
    pub files: u64,
    pub directories: u64,
    pub known_bytes: u64,
    pub skipped_links: u64,
    pub skipped_special: u64,
    pub errors: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ScanOutcome { Complete, Partial, Failed, Cancelled }

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct DirectorySize {
    pub bytes: u64,
    pub complete: bool,
    pub fingerprint: Option<String>,
    pub stats: ScanStats,
    pub created_at: Option<chrono::DateTime<chrono::Utc>>,
}

impl DirectorySize {
    pub fn visited(&self) -> bool { self.stats.directories != 0 }
    fn unvisited() -> Self { Self { bytes: 0, complete: false, fingerprint: None, stats: ScanStats::default(), created_at: None } }
}

#[derive(Debug)]
pub(crate) struct ScanResult {
    pub directories: HashMap<Arc<str>, DirectorySize>,
    pub stats: ScanStats,
    pub outcome: ScanOutcome,
    pub accounted_bytes: usize,
    pub message: Option<String>,
}

// Conservative allowance for vector growth, hash buckets, Arc/string headers,
// fingerprints and the final map conversion peak. No file record is retained.
pub(super) const NODE_ACCOUNT_BYTES: usize = 640;

struct Node {
    path: Arc<str>,
    parent: Option<usize>,
    size: DirectorySize,
}

pub(crate) fn scan_directory(
    root: &str, source: &mut dyn MetadataSource, cancelled: &AtomicBool,
    limits: ScanLimits, mut progress: impl FnMut(&ScanStats),
) -> ScanResult {
    if let Some(cursor) = source.open_directory(root, cancelled) {
        return super::local_scan::scan(root, source, cursor, cancelled, limits, progress);
    }
    let started = Instant::now();
    let mut last_progress = started;
    let mut stats = ScanStats::default();
    let mut message = None;
    let mut halted = false;
    let mut nodes: Vec<Node> = Vec::new();
    let mut seen: HashSet<Arc<str>> = HashSet::new();
    let mut accounted_bytes = NODE_ACCOUNT_BYTES.saturating_add(root.len());
    if limits.max_directories == 0 || accounted_bytes > limits.max_accounted_bytes {
        return ScanResult { directories: HashMap::new(), stats, outcome: ScanOutcome::Partial,
            accounted_bytes: 0, message: Some("目录统计内存上限".into()) };
    }
    let root: Arc<str> = root.into();
    seen.insert(root.clone());
    nodes.push(Node { path: root, parent: None, size: DirectorySize::unvisited() });
    let mut index = 0;
    let mut root_failed = false;
    while index < nodes.len() && !halted {
        if cancelled.load(Ordering::Relaxed) { break; }
        if started.elapsed() >= limits.max_elapsed {
            message.get_or_insert_with(|| "目录统计已达到时间上限".into());
            break;
        }
        let path = nodes[index].path.clone();
        let mut bytes = 0_u64;
        let mut complete = true;
        let mut fingerprint = ListingFingerprint::default();
        let before = stats.clone();
        stats.directories += 1;
        let result = source.read_directory(&path, cancelled, &mut |entry| {
            if cancelled.load(Ordering::Relaxed) || started.elapsed() >= limits.max_elapsed {
                complete = false;
                halted = true;
                if !cancelled.load(Ordering::Relaxed) { message.get_or_insert_with(|| "目录统计已达到时间上限".into()); }
                return false;
            }
            fingerprint.add(&entry.name, entry.kind);
            match entry.kind {
                MetadataKind::File(size) => {
                    stats.files += 1;
                    match bytes.checked_add(size) {
                        Some(next) => bytes = next,
                        None => { bytes = u64::MAX; complete = false; stats.errors += 1; message.get_or_insert_with(|| "目录大小超出可表示范围".into()); }
                    }
                    stats.known_bytes = stats.known_bytes.saturating_add(size);
                }
                MetadataKind::Directory => {
                    if let Some(child) = entry.directory_path {
                        let cost = NODE_ACCOUNT_BYTES.saturating_add(child.len());
                        if seen.contains(child.as_str()) {
                            complete = false;
                            stats.errors += 1;
                            message.get_or_insert_with(|| "目录元数据包含重复或循环路径".into());
                        } else if nodes.len() >= limits.max_directories || cost > limits.max_accounted_bytes.saturating_sub(accounted_bytes) {
                            complete = false;
                            halted = true;
                            message.get_or_insert_with(|| "目录统计已达到目录数量或内存上限".into());
                        } else {
                            accounted_bytes += cost;
                            let path: Arc<str> = child.into();
                            seen.insert(path.clone());
                            nodes.push(Node { path, parent: Some(index), size: DirectorySize::unvisited() });
                        }
                    } else { complete = false; stats.errors += 1; }
                }
                MetadataKind::Link => stats.skipped_links += 1,
                MetadataKind::Special => stats.skipped_special += 1,
                MetadataKind::Unknown => { complete = false; stats.errors += 1; message.get_or_insert_with(|| "部分条目的类型或大小不可用".into()); }
            }
            if last_progress.elapsed() >= limits.progress_interval {
                progress(&stats);
                last_progress = Instant::now();
            }
            !halted
        });
        if let Err(error) = result {
            root_failed |= index == 0;
            complete = false;
            stats.errors += 1;
            message.get_or_insert_with(|| error.chars().take(256).collect());
        }
        if let Some(reason) = source.incomplete_reason() {
            complete = false;
            message.get_or_insert_with(|| reason.chars().take(256).collect());
        }
        if cancelled.load(Ordering::Relaxed) { complete = false; halted = true; }
        nodes[index].size = DirectorySize { bytes, complete, fingerprint: if complete { fingerprint.finish() } else { None }, created_at: None,
            stats: ScanStats { files: stats.files - before.files, directories: 1, known_bytes: bytes,
                skipped_links: stats.skipped_links - before.skipped_links, skipped_special: stats.skipped_special - before.skipped_special,
                errors: stats.errors - before.errors } };
        index += 1;
    }
    // Parents always precede children. Every subtree is merged exactly once,
    // regardless of depth; incomplete/unvisited children propagate upwards.
    for index in (1..nodes.len()).rev() {
        let parent = nodes[index].parent.expect("non-root parent");
        let child_bytes = nodes[index].size.bytes;
        let child = nodes[index].size.stats.clone();
        let parent_stats = &mut nodes[parent].size.stats;
        parent_stats.files = parent_stats.files.saturating_add(child.files);
        parent_stats.directories = parent_stats.directories.saturating_add(child.directories);
        parent_stats.skipped_links = parent_stats.skipped_links.saturating_add(child.skipped_links);
        parent_stats.skipped_special = parent_stats.skipped_special.saturating_add(child.skipped_special);
        parent_stats.errors = parent_stats.errors.saturating_add(child.errors);
        nodes[parent].size.complete &= nodes[index].size.complete;
        match nodes[parent].size.bytes.checked_add(child_bytes) {
            Some(bytes) => nodes[parent].size.bytes = bytes,
            None => {
                nodes[parent].size.bytes = u64::MAX;
                nodes[parent].size.complete = false;
                stats.errors += 1;
                nodes[parent].size.stats.errors += 1;
                message.get_or_insert_with(|| "目录大小超出可表示范围".into());
            }
        }
        nodes[parent].size.stats.known_bytes = nodes[parent].size.bytes;
    }
    let outcome = if cancelled.load(Ordering::Relaxed) { ScanOutcome::Cancelled }
        else if root_failed { ScanOutcome::Failed }
        else if nodes[0].size.complete { ScanOutcome::Complete }
        else { ScanOutcome::Partial };
    if outcome == ScanOutcome::Cancelled { nodes[0].size.complete = false; }
    drop(seen);
    let directories = nodes.into_iter().map(|node| (node.path, node.size)).collect();
    ScanResult { directories, stats, outcome, accounted_bytes, message }
}

#[cfg(test)]
#[path = "scan_tests.rs"]
mod tests;

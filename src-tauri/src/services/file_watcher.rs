use std::{
    collections::{BTreeSet, HashSet},
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
#[cfg(any(not(windows), test))]
use std::{collections::HashMap, fs, time::SystemTime};

use tauri::{AppHandle, Emitter};

use crate::domain::models::{WorkspaceFsChangedEvent, WorkspaceWatchRootsRequest};

#[cfg(not(windows))]
const WATCH_POLL_INTERVAL: Duration = Duration::from_millis(750);
#[cfg(windows)]
const NATIVE_WATCH_RELOAD_INTERVAL: Duration = Duration::from_millis(250);
#[cfg(windows)]
const NATIVE_WATCH_CHUNK_WAIT_MS: u32 = 50;
const MAX_WATCH_ROOTS: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WatchKind {
    Directory,
    Navigation,
}

#[cfg(any(not(windows), test))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct DirectorySignature {
    entries: Vec<EntrySignature>,
}

#[cfg(any(not(windows), test))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct EntrySignature {
    name: String,
    is_dir: bool,
    len: u64,
    modified_millis: Option<u128>,
}

#[derive(Debug, Default)]
struct WatchState {
    directory_roots: BTreeSet<String>,
    navigation_parent_roots: BTreeSet<String>,
    #[cfg(any(not(windows), test))]
    signatures: HashMap<String, Option<DirectorySignature>>,
}

#[derive(Debug)]
pub struct FileWatchService {
    state: Arc<Mutex<WatchState>>,
    started: AtomicBool,
    sequence: Arc<AtomicU64>,
}

impl Default for FileWatchService {
    fn default() -> Self {
        Self {
            state: Arc::new(Mutex::new(WatchState::default())),
            started: AtomicBool::new(false),
            sequence: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl FileWatchService {
    pub fn update_roots(&self, app: AppHandle, request: WorkspaceWatchRootsRequest) {
        eprintln!(
            "[FileWatcher] update_roots called: directory_paths={:?}, navigation_parent_paths={:?}",
            request.directory_paths, request.navigation_parent_paths
        );

        let directory_roots = normalize_roots(request.directory_paths);
        let navigation_parent_roots = normalize_roots(request.navigation_parent_paths);

        eprintln!(
            "[FileWatcher] normalized: directory_roots={:?}, navigation_parent_roots={:?}",
            directory_roots, navigation_parent_roots
        );

        #[cfg(windows)]
        let has_roots = {
            let mut state = self.state.lock().expect("file watch state lock poisoned");
            state.directory_roots = directory_roots;
            state.navigation_parent_roots = navigation_parent_roots;
            !active_roots(&state).is_empty()
        };

        #[cfg(not(windows))]
        let roots_to_prime = {
            let mut state = self.state.lock().expect("file watch state lock poisoned");
            replace_roots(&mut state, directory_roots, navigation_parent_roots)
        };
        #[cfg(not(windows))]
        let primed_signatures = scan_directory_signatures(roots_to_prime);
        #[cfg(not(windows))]
        let has_roots = {
            let mut state = self.state.lock().expect("file watch state lock poisoned");
            insert_primed_signatures(&mut state, primed_signatures);
            !active_roots(&state).is_empty()
        };

        eprintln!("[FileWatcher] has_roots={}, will_start={}", has_roots, !self.started.load(Ordering::SeqCst));

        if has_roots {
            self.ensure_started(app);
        }
    }

    fn ensure_started(&self, app: AppHandle) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }

        let state = self.state.clone();
        let sequence = self.sequence.clone();
        thread::spawn(move || run_watch_loop(app, state, sequence));
    }
}

#[cfg(windows)]
fn run_watch_loop(app: AppHandle, state: Arc<Mutex<WatchState>>, sequence: Arc<AtomicU64>) {
    eprintln!("[FileWatcher] Watch loop started on Windows");
    let mut watches = Vec::<NativeDirectoryWatch>::new();
    let mut watched_roots = BTreeSet::<String>::new();

    loop {
        let active_roots = {
            let guard = state.lock().expect("file watch state lock poisoned");
            active_roots(&guard).into_iter().collect::<BTreeSet<_>>()
        };

        if active_roots != watched_roots {
            eprintln!("[FileWatcher] Roots changed: old={:?}, new={:?}", watched_roots, active_roots);
            watches = create_native_directory_watches(&active_roots);
            eprintln!("[FileWatcher] Created {} native watch handles", watches.len());
            watched_roots = active_roots;
        }

        if watches.is_empty() {
            thread::sleep(NATIVE_WATCH_RELOAD_INTERVAL);
            continue;
        }

        let changed_roots = wait_for_native_directory_changes(&mut watches);
        if changed_roots.is_empty() {
            continue;
        }

        eprintln!("[FileWatcher] Detected changes in roots: {:?}", changed_roots);

        let event = {
            let guard = state.lock().expect("file watch state lock poisoned");
            event_for_changed_roots(&guard, changed_roots, &sequence)
        };
        if let Some(ref evt) = event {
            eprintln!("[FileWatcher] Emitting event: sequence={}, directory_roots={:?}, navigation_parent_roots={:?}",
                      evt.sequence, evt.directory_roots, evt.navigation_parent_roots);
            emit_workspace_fs_changed(&app, evt.clone());
        } else {
            eprintln!("[FileWatcher] No event generated for changed roots");
        }
    }
}

#[cfg(not(windows))]
fn run_watch_loop(app: AppHandle, state: Arc<Mutex<WatchState>>, sequence: Arc<AtomicU64>) {
    loop {
        thread::sleep(WATCH_POLL_INTERVAL);
        let event = poll_changed_roots(&state, &sequence);
        if let Some(event) = event {
            emit_workspace_fs_changed(&app, event);
        }
    }
}

fn emit_workspace_fs_changed(app: &AppHandle, event: WorkspaceFsChangedEvent) {
    eprintln!("[FileWatcher] Attempting to emit workspace_fs_changed event");
    match app.emit("workspace_fs_changed", event) {
        Ok(_) => eprintln!("[FileWatcher] Event emitted successfully"),
        Err(error) => eprintln!("[FileWatcher] Failed to emit workspace_fs_changed: {error}"),
    }
}

fn normalize_roots(paths: Vec<String>) -> BTreeSet<String> {
    paths
        .into_iter()
        .filter_map(|path| normalize_local_directory_root(&path))
        .take(MAX_WATCH_ROOTS)
        .collect()
}

fn normalize_local_directory_root(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.contains("://") {
        return None;
    }
    let normalized = normalize_windows_display_path(trimmed).replace('/', "\\");
    let normalized = Path::new(&normalized)
        .canonicalize()
        .ok()
        .map(|path| normalize_windows_display_path(&path.to_string_lossy()).replace('/', "\\"))
        .unwrap_or(normalized);
    let without_trailing_separator = normalized.trim_end_matches('\\');
    if without_trailing_separator.len() == 2 && without_trailing_separator.as_bytes()[1] == b':' {
        return Some(format!("{without_trailing_separator}\\").to_lowercase());
    }
    if without_trailing_separator.is_empty() {
        return None;
    }
    Some(without_trailing_separator.to_lowercase())
}

fn normalize_windows_display_path(path: &str) -> String {
    let normalized = path.replace('/', "\\");
    if let Some(rest) = normalized.strip_prefix("\\\\?\\UNC\\") {
        return format!("\\\\{rest}");
    }
    if let Some(rest) = normalized.strip_prefix("\\\\?\\") {
        return rest.to_string();
    }
    if let Some(rest) = normalized.strip_prefix("\\\\.\\") {
        return rest.to_string();
    }
    normalized
}

#[cfg(any(not(windows), test))]
fn retain_active_signatures(state: &mut WatchState) {
    let active = active_roots(state);
    state.signatures.retain(|root, _| active.contains(root));
}

#[cfg(any(not(windows), test))]
fn replace_roots(
    state: &mut WatchState,
    directory_roots: BTreeSet<String>,
    navigation_parent_roots: BTreeSet<String>,
) -> Vec<String> {
    state.directory_roots = directory_roots;
    state.navigation_parent_roots = navigation_parent_roots;
    retain_active_signatures(state);
    active_roots(state)
        .into_iter()
        .filter(|root| !state.signatures.contains_key(root))
        .collect()
}

#[cfg(test)]
fn replace_roots_and_prime_signatures(
    state: &mut WatchState,
    directory_roots: BTreeSet<String>,
    navigation_parent_roots: BTreeSet<String>,
) {
    let roots_to_prime = replace_roots(state, directory_roots, navigation_parent_roots);
    let primed_signatures = scan_directory_signatures(roots_to_prime);
    insert_primed_signatures(state, primed_signatures);
}

#[cfg(any(not(windows), test))]
fn scan_directory_signatures(roots: Vec<String>) -> Vec<(String, Option<DirectorySignature>)> {
    roots
        .into_iter()
        .map(|root| {
            let signature = directory_signature(Path::new(&root));
            (root, signature)
        })
        .collect()
}

#[cfg(any(not(windows), test))]
fn insert_primed_signatures(
    state: &mut WatchState,
    signatures: Vec<(String, Option<DirectorySignature>)>,
) {
    let active = active_roots(state);
    for (root, signature) in signatures {
        if active.contains(&root) && !state.signatures.contains_key(&root) {
            state.signatures.insert(root, signature);
        }
    }
}

fn active_roots(state: &WatchState) -> HashSet<String> {
    state
        .directory_roots
        .iter()
        .chain(state.navigation_parent_roots.iter())
        .cloned()
        .collect()
}

#[cfg(any(not(windows), test))]
fn poll_changed_roots(
    state: &Arc<Mutex<WatchState>>,
    sequence: &Arc<AtomicU64>,
) -> Option<WorkspaceFsChangedEvent> {
    let active = {
        let mut guard = state.lock().expect("file watch state lock poisoned");
        let active = active_roots(&guard);
        if active.is_empty() {
            guard.signatures.clear();
            return None;
        }
        active
    };

    let scanned_roots = scan_directory_signatures(active.into_iter().collect());

    let mut guard = state.lock().expect("file watch state lock poisoned");
    let active = active_roots(&guard);
    let mut changed_roots = BTreeSet::new();
    for (root, next_signature) in scanned_roots {
        if !active.contains(&root) {
            continue;
        }
        match guard.signatures.get(&root) {
            None => {
                guard.signatures.insert(root, next_signature);
            }
            Some(previous) if *previous != next_signature => {
                guard.signatures.insert(root.clone(), next_signature);
                changed_roots.insert(root);
            }
            Some(_) => {}
        }
    }

    if changed_roots.is_empty() {
        return None;
    }

    event_for_changed_roots(&guard, changed_roots, sequence)
}

fn event_for_changed_roots(
    state: &WatchState,
    changed_roots: BTreeSet<String>,
    sequence: &Arc<AtomicU64>,
) -> Option<WorkspaceFsChangedEvent> {
    let changed_roots = changed_roots
        .into_iter()
        .filter(|root| root_has_kind(state, root, WatchKind::Directory) || root_has_kind(state, root, WatchKind::Navigation))
        .collect::<BTreeSet<_>>();
    if changed_roots.is_empty() {
        return None;
    }

    let directory_roots = changed_roots
        .iter()
        .filter(|root| root_has_kind(state, root, WatchKind::Directory))
        .cloned()
        .collect::<Vec<_>>();
    let navigation_parent_roots = changed_roots
        .iter()
        .filter(|root| root_has_kind(state, root, WatchKind::Navigation))
        .cloned()
        .collect::<Vec<_>>();
    let roots = changed_roots.into_iter().collect::<Vec<_>>();
    let next_sequence = sequence.fetch_add(1, Ordering::SeqCst) + 1;

    Some(WorkspaceFsChangedEvent {
        roots,
        directory_roots,
        navigation_parent_roots,
        sequence: next_sequence,
    })
}

fn root_has_kind(state: &WatchState, root: &str, kind: WatchKind) -> bool {
    match kind {
        WatchKind::Directory => state.directory_roots.contains(root),
        WatchKind::Navigation => state.navigation_parent_roots.contains(root),
    }
}

#[cfg(any(not(windows), test))]
fn directory_signature(path: &Path) -> Option<DirectorySignature> {
    let entries = fs::read_dir(path).ok()?;
    let mut signatures = Vec::new();
    for entry in entries.flatten() {
        let metadata = entry.metadata().ok();
        signatures.push(EntrySignature {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_dir: metadata.as_ref().map(|value| value.is_dir()).unwrap_or(false),
            len: metadata.as_ref().map(|value| value.len()).unwrap_or(0),
            modified_millis: metadata
                .and_then(|value| value.modified().ok())
                .and_then(system_time_millis),
        });
    }
    signatures.sort_by(|left, right| left.name.cmp(&right.name));
    Some(DirectorySignature { entries: signatures })
}

#[cfg(any(not(windows), test))]
fn system_time_millis(value: SystemTime) -> Option<u128> {
    value
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis())
}

#[cfg(windows)]
#[derive(Debug)]
struct NativeDirectoryWatch {
    root: String,
    handle: windows::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl Drop for NativeDirectoryWatch {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Storage::FileSystem::FindCloseChangeNotification(self.handle);
        }
    }
}

#[cfg(windows)]
fn create_native_directory_watches(roots: &BTreeSet<String>) -> Vec<NativeDirectoryWatch> {
    eprintln!("[FileWatcher] create_native_directory_watches: attempting to create {} watches", roots.len());
    let watches: Vec<NativeDirectoryWatch> = roots
        .iter()
        .filter_map(|root| {
            eprintln!("[FileWatcher] Attempting to create watch for: {}", root);
            match create_native_directory_watch(root) {
                Some(watch) => {
                    eprintln!("[FileWatcher] ✓ Successfully created watch for: {}", root);
                    Some(watch)
                }
                None => {
                    eprintln!("[FileWatcher] ✗ Failed to create watch for: {}", root);
                    None
                }
            }
        })
        .collect();
    eprintln!("[FileWatcher] Created {} out of {} requested watches", watches.len(), roots.len());
    watches
}

#[cfg(windows)]
fn create_native_directory_watch(root: &str) -> Option<NativeDirectoryWatch> {
    use windows::Win32::Storage::FileSystem::{
        FindFirstChangeNotificationW, FILE_NOTIFY_CHANGE_CREATION, FILE_NOTIFY_CHANGE_DIR_NAME,
        FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE,
    };
    use windows_core::HSTRING;

    eprintln!("[FileWatcher] create_native_directory_watch: root={}", root);

    let filter = FILE_NOTIFY_CHANGE_FILE_NAME
        | FILE_NOTIFY_CHANGE_DIR_NAME
        | FILE_NOTIFY_CHANGE_SIZE
        | FILE_NOTIFY_CHANGE_LAST_WRITE
        | FILE_NOTIFY_CHANGE_CREATION;

    let path = HSTRING::from(root);
    eprintln!("[FileWatcher] Calling FindFirstChangeNotificationW with path: {:?}, bWatchSubtree: false", root);

    let handle_result = unsafe { FindFirstChangeNotificationW(&path, false, filter) };

    match handle_result {
        Ok(handle) => {
            eprintln!("[FileWatcher] FindFirstChangeNotificationW succeeded for: {}", root);
            Some(NativeDirectoryWatch {
                root: root.to_string(),
                handle,
            })
        }
        Err(err) => {
            eprintln!("[FileWatcher] FindFirstChangeNotificationW FAILED for: {} - Error: {:?}", root, err);
            None
        }
    }
}

#[cfg(windows)]
fn wait_for_native_directory_changes(watches: &mut [NativeDirectoryWatch]) -> BTreeSet<String> {
    use windows::Win32::Foundation::{WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows::Win32::Storage::FileSystem::FindNextChangeNotification;
    use windows::Win32::System::Threading::WaitForMultipleObjects;

    let mut changed_roots = BTreeSet::new();
    for chunk in watches.chunks_mut(64) {
        let handles = chunk.iter().map(|watch| watch.handle).collect::<Vec<_>>();
        let result = unsafe { WaitForMultipleObjects(&handles, false, NATIVE_WATCH_CHUNK_WAIT_MS) };
        if result == WAIT_TIMEOUT || result == WAIT_FAILED {
            continue;
        }

        let index = result.0.saturating_sub(WAIT_OBJECT_0.0) as usize;
        if index >= chunk.len() {
            continue;
        }

        changed_roots.insert(chunk[index].root.clone());
        unsafe {
            let _ = FindNextChangeNotification(chunk[index].handle);
        }
    }
    changed_roots
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_roots_dedupes_local_paths_and_skips_remote_urls() {
        let roots = normalize_roots(vec![
            " C:/Users/Admin/Documents/ ".to_string(),
            "C:\\Users\\Admin\\Documents".to_string(),
            "sftp://deploy@edge/releases".to_string(),
            "".to_string(),
        ]);

        assert_eq!(roots.len(), 1);
        assert!(roots.contains("c:\\users\\admin\\documents"));
    }

    #[test]
    fn normalize_roots_preserves_windows_drive_roots() {
        let roots = normalize_roots(vec!["C:\\".to_string(), "D:/".to_string()]);

        assert!(roots.contains("c:\\"));
        assert!(roots.contains("d:\\"));
        assert!(!roots.contains("C:"));
    }

    #[test]
    fn normalize_roots_uses_stable_windows_identity_for_verbatim_and_case_variants() {
        let roots = normalize_roots(vec![
            "\\\\?\\C:\\Users\\Admin\\Documents\\".to_string(),
            "c:/users/admin/documents".to_string(),
            "\\\\.\\C:\\Users\\Admin\\Documents".to_string(),
        ]);

        assert_eq!(roots.len(), 1);
        assert!(roots.contains("c:\\users\\admin\\documents"));
    }

    #[test]
    fn registered_roots_are_primed_before_the_first_change_poll() {
        let temp = std::env::temp_dir().join(format!("sfm-watch-prime-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp).expect("create temp watch dir");
        let watched_file = temp.join("a.txt");
        fs::write(&watched_file, b"a").expect("write initial file");

        let mut watch_state = WatchState::default();
        replace_roots_and_prime_signatures(
            &mut watch_state,
            BTreeSet::from([temp.to_string_lossy().into_owned()]),
            BTreeSet::new(),
        );
        fs::remove_file(&watched_file).expect("remove watched file");

        let state = Arc::new(Mutex::new(watch_state));
        let sequence = Arc::new(AtomicU64::new(0));
        let event = poll_changed_roots(&state, &sequence).expect("change event");

        assert_eq!(event.directory_roots, vec![temp.to_string_lossy().into_owned()]);

        let _ = fs::remove_dir_all(temp);
    }

    #[cfg(windows)]
    #[test]
    fn native_directory_watch_reports_direct_child_changes() {
        let temp = std::env::temp_dir().join(format!("sfm-native-watch-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp).expect("create temp watch dir");
        let root = normalize_local_directory_root(&temp.to_string_lossy()).expect("normalize temp root");
        let mut watches = create_native_directory_watches(&BTreeSet::from([root.clone()]));
        assert_eq!(watches.len(), 1);

        fs::write(temp.join("created.txt"), b"created").expect("write watched file");

        let mut changed_roots = BTreeSet::new();
        for _ in 0..20 {
            changed_roots.extend(wait_for_native_directory_changes(&mut watches));
            if changed_roots.contains(&root) {
                break;
            }
        }

        assert!(changed_roots.contains(&root));

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn first_poll_primes_signatures_and_second_poll_reports_changes() {
        let temp = std::env::temp_dir().join(format!("sfm-watch-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp).expect("create temp watch dir");
        fs::write(temp.join("a.txt"), b"a").expect("write initial file");

        let state = Arc::new(Mutex::new(WatchState {
            directory_roots: BTreeSet::from([temp.to_string_lossy().into_owned()]),
            navigation_parent_roots: BTreeSet::new(),
            signatures: HashMap::new(),
        }));
        let sequence = Arc::new(AtomicU64::new(0));

        assert!(poll_changed_roots(&state, &sequence).is_none());
        fs::write(temp.join("b.txt"), b"b").expect("write changed file");
        let event = poll_changed_roots(&state, &sequence).expect("change event");

        assert_eq!(event.sequence, 1);
        assert_eq!(event.directory_roots, vec![temp.to_string_lossy().into_owned()]);
        assert_eq!(event.navigation_parent_roots, Vec::<String>::new());

        let _ = fs::remove_dir_all(temp);
    }
}

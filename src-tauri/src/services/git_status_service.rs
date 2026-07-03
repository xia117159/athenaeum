use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

use anyhow::Result;
use gix::bstr::ByteSlice;

use crate::domain::models::{GitDirectoryStatus, GitFileStatus};

// ---------------------------------------------------------------------------
// Shared helpers (used by both gix and subprocess paths)
// ---------------------------------------------------------------------------

/// Creates a `git` Command with the `CREATE_NO_WINDOW` flag on Windows to
/// prevent console window flashes when spawning git subprocesses from a
/// GUI application. Used only by the subprocess fallback path.
fn git_command() -> Command {
    let mut cmd = Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn status_priority(status: GitFileStatus) -> u8 {
    match status {
        GitFileStatus::Conflict => 6,
        GitFileStatus::Deleted => 5,
        GitFileStatus::Modified => 4,
        GitFileStatus::Added => 3,
        GitFileStatus::Renamed => 2,
        GitFileStatus::Untracked => 1,
        GitFileStatus::Clean => 0,
    }
}

fn normalize_path_separator(path: &str) -> String {
    if cfg!(windows) {
        path.replace('/', "\\")
    } else {
        path.to_string()
    }
}

/// Compares two paths for equality, case-insensitively on Windows.
fn paths_equal(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

/// Checks if `prefix` is a parent directory of `path`, case-insensitively on Windows.
fn path_starts_with(path: &Path, prefix: &Path) -> bool {
    if cfg!(windows) {
        let path_str = path.to_string_lossy().to_lowercase();
        let prefix_str = prefix.to_string_lossy().to_lowercase();
        if !path_str.starts_with(&prefix_str) {
            return false;
        }
        path_str.as_bytes().get(prefix_str.len()) == Some(&b'\\')
    } else {
        path.starts_with(prefix)
    }
}

fn normalize_path_key(path: &str) -> String {
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.to_string()
    }
}

fn strip_verbatim_prefix(path: &Path) -> std::path::PathBuf {
    let s = path.to_string_lossy();
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        std::path::PathBuf::from(stripped)
    } else {
        path.to_path_buf()
    }
}

fn insert_or_update_status(
    result: &mut HashMap<String, GitFileStatus>,
    key: String,
    status: GitFileStatus,
) {
    result
        .entry(key)
        .and_modify(|existing| {
            if status_priority(status) > status_priority(*existing) {
                *existing = status;
            }
        })
        .or_insert(status);
}

/// Adds a status entry for a file path, applying query_dir matching.
/// If the file is a direct child of query_dir, it's added directly.
/// If it's in a subdirectory of query_dir, the top-level subdirectory is
/// added with the status instead (directory aggregation).
fn add_status_for_path(
    result: &mut HashMap<String, GitFileStatus>,
    abs_path: &Path,
    query_dir: &Path,
    status: GitFileStatus,
) {
    if let Some(parent) = abs_path.parent() {
        if paths_equal(parent, query_dir) {
            let abs_key = normalize_path_key(&abs_path.to_string_lossy());
            insert_or_update_status(result, abs_key, status);
        } else if path_starts_with(abs_path, query_dir) {
            let abs_lower = abs_path.to_string_lossy().to_lowercase();
            let query_lower = query_dir.to_string_lossy().to_lowercase();
            if let Some(rest) = abs_lower.strip_prefix(&format!("{}\\", query_lower)) {
                if let Some(first_component) = rest.split('\\').next() {
                    let child_dir = query_dir.join(first_component);
                    let child_key = normalize_path_key(&child_dir.to_string_lossy());
                    insert_or_update_status(result, child_key, status);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// gix-based implementation (primary path — no subprocess, no console window)
// ---------------------------------------------------------------------------

/// Maps a gix `EntryStatus` to our `GitFileStatus`.
fn map_gix_entry_status(
    status: &gix::status::plumbing::index_as_worktree::EntryStatus<(), gix::submodule::Status>,
) -> Option<GitFileStatus> {
    use gix::status::plumbing::index_as_worktree::{Change, EntryStatus};
    match status {
        EntryStatus::Conflict { .. } => Some(GitFileStatus::Conflict),
        EntryStatus::Change(Change::Removed) => Some(GitFileStatus::Deleted),
        EntryStatus::Change(Change::Modification { .. }) => Some(GitFileStatus::Modified),
        EntryStatus::Change(Change::Type { .. }) => Some(GitFileStatus::Modified),
        EntryStatus::Change(Change::SubmoduleModification(_)) => None,
        EntryStatus::IntentToAdd => Some(GitFileStatus::Added),
        EntryStatus::NeedsUpdate(_) => None,
    }
}

/// Gets git status using the `gix` library (pure Rust, no subprocess).
/// Returns `None` if the directory is not inside a git repo or if an
/// unrecoverable error occurs (caller should fall back to subprocess).
fn get_git_status_via_gix(directory: &Path) -> Option<GitDirectoryStatus> {
    let repo = gix::discover(directory).ok()?;

    // If discover found a repo but it has no workdir, it's a bare repo — skip.
    let workdir = repo.workdir()?.to_path_buf();

    let canonical_dir = strip_verbatim_prefix(
        &std::fs::canonicalize(directory).unwrap_or_else(|_| directory.to_path_buf()),
    );

    let mut result = HashMap::new();

    // Get file statuses using gix status API
    let platform = repo.status(gix::progress::Discard).ok()?;
    let iter = platform
        .into_iter(Vec::<gix::bstr::BString>::new())
        .ok()?;

    for item in iter.flatten() {
        match &item {
            gix::status::Item::IndexWorktree(iw_item) => {
                use gix::status::index_worktree::Item as IwItem;
                match iw_item {
                    IwItem::Modification { rela_path, status, .. } => {
                        if let Some(git_status) = map_gix_entry_status(status) {
                            if git_status == GitFileStatus::Untracked {
                                continue;
                            }
                            let path = normalize_path_separator(&rela_path.to_str_lossy());
                            let abs_path = workdir.join(&path);
                            add_status_for_path(&mut result, &abs_path, &canonical_dir, git_status);
                        }
                    }
                    IwItem::DirectoryContents { .. } => {
                        // Untracked/ignored files — skip (no badge for untracked)
                    }
                    IwItem::Rewrite { dirwalk_entry, copy, .. } => {
                        let status = if *copy { GitFileStatus::Added } else { GitFileStatus::Renamed };
                        let path = normalize_path_separator(&dirwalk_entry.rela_path.to_str_lossy());
                        let abs_path = workdir.join(&path);
                        add_status_for_path(&mut result, &abs_path, &canonical_dir, status);
                    }
                }
            }
            gix::status::Item::TreeIndex(change) => {
                use gix::diff::index::ChangeRef;
                let (location, status) = match change {
                    ChangeRef::Addition { location, .. } => {
                        (location.as_ref(), GitFileStatus::Added)
                    }
                    ChangeRef::Deletion { location, .. } => {
                        (location.as_ref(), GitFileStatus::Deleted)
                    }
                    ChangeRef::Modification { location, .. } => {
                        (location.as_ref(), GitFileStatus::Modified)
                    }
                    ChangeRef::Rewrite { source_location, copy, .. } => {
                        if *copy {
                            (source_location.as_ref(), GitFileStatus::Added)
                        } else {
                            (source_location.as_ref(), GitFileStatus::Renamed)
                        }
                    }
                };
                let path = normalize_path_separator(&location.to_str_lossy());
                let abs_path = workdir.join(&path);
                add_status_for_path(&mut result, &abs_path, &canonical_dir, status);
            }
        }
    }

    // Add clean entries: iterate the git index for tracked files in the
    // query directory. Files not already in the status map get Clean status.
    // Clean has the lowest priority so it never overrides existing entries.
    if let Ok(index) = repo.index_or_empty() {
        let backing = index.path_backing();
        for entry in index.entries() {
            let path = entry.path_in(backing);
            let path_str = normalize_path_separator(&path.to_str_lossy());
            let abs_path = workdir.join(&path_str);
            add_status_for_path(&mut result, &abs_path, &canonical_dir, GitFileStatus::Clean);
        }
    }

    Some(GitDirectoryStatus { statuses: result, is_git_repo: true })
}

// ---------------------------------------------------------------------------
// Subprocess fallback (with CREATE_NO_WINDOW on Windows)
// ---------------------------------------------------------------------------

fn parse_status_code(x: u8, y: u8) -> Option<GitFileStatus> {
    match (x, y) {
        (b'U', _) | (_, b'U') | (b'A', b'A') | (b'D', b'D') => Some(GitFileStatus::Conflict),
        (b'D', _) | (_, b'D') => Some(GitFileStatus::Deleted),
        (b'M', _) | (_, b'M') | (b'T', _) | (_, b'T') => Some(GitFileStatus::Modified),
        (b'A', _) => Some(GitFileStatus::Added),
        (b'R', _) => Some(GitFileStatus::Renamed),
        (b'?', b'?') => Some(GitFileStatus::Untracked),
        _ => None,
    }
}

fn highest_priority_status(raw: &[u8]) -> Option<GitFileStatus> {
    let mut highest: Option<GitFileStatus> = None;
    for chunk in raw.split(|&b| b == 0) {
        if chunk.len() < 4 {
            continue;
        }
        if let Some(status) = parse_status_code(chunk[0], chunk[1]) {
            if status == GitFileStatus::Untracked {
                continue;
            }
            if highest.is_none_or(|h| status_priority(status) > status_priority(h)) {
                highest = Some(status);
            }
        }
    }
    highest
}

pub fn parse_porcelain_output(
    raw: &[u8],
    repo_root: &Path,
    query_dir: &Path,
) -> HashMap<String, GitFileStatus> {
    let mut result: HashMap<String, GitFileStatus> = HashMap::new();

    if raw.is_empty() {
        return result;
    }

    let entries: Vec<&[u8]> = raw.split(|&b| b == 0).collect();
    let mut i = 0;

    while i < entries.len() {
        let entry = entries[i];
        if entry.len() < 4 {
            i += 1;
            continue;
        }

        let x = entry[0];
        let y = entry[1];
        let rel_path_str = String::from_utf8_lossy(&entry[3..]);
        let rel_path = normalize_path_separator(&rel_path_str);

        let status = match parse_status_code(x, y) {
            Some(s) => s,
            None => {
                i += 1;
                continue;
            }
        };

        if status == GitFileStatus::Untracked {
            i += 1;
            continue;
        }

        // Rename entries have an extra NUL-delimited old-path field to skip.
        if x == b'R' || x == b'C' {
            i += 1;
        }

        let abs_path = repo_root.join(&rel_path);
        add_status_for_path(&mut result, &abs_path, query_dir, status);

        i += 1;
    }

    result
}

fn add_clean_tracked_entries(
    result: &mut HashMap<String, GitFileStatus>,
    repo_root: &Path,
    query_dir: &Path,
) {
    let rel_path = if paths_equal(repo_root, query_dir) {
        String::new()
    } else {
        let q = query_dir.to_string_lossy().to_lowercase();
        let r = repo_root.to_string_lossy().to_lowercase();
        let rest = if let Some(rest) = q.strip_prefix(&format!("{}\\", r)) {
            rest
        } else if let Some(rest) = q.strip_prefix(&format!("{}/", r)) {
            rest
        } else {
            return;
        };
        rest.replace('\\', "/")
    };

    let mut cmd = git_command();
    cmd.args(["ls-tree", "HEAD", "--name-only", "-z"]);
    if !rel_path.is_empty() {
        cmd.arg(&format!("{}/", rel_path));
    }
    cmd.current_dir(repo_root);

    let output = match cmd.output() {
        Ok(o) if o.status.success() => o.stdout,
        _ => return,
    };

    if output.is_empty() {
        return;
    }

    for name_bytes in output.split(|&b| b == 0) {
        if name_bytes.is_empty() {
            continue;
        }
        let name_str = String::from_utf8_lossy(name_bytes);
        let name = normalize_path_separator(&name_str);
        let abs_path = repo_root.join(&name);
        let abs_key = normalize_path_key(&abs_path.to_string_lossy());
        result.entry(abs_key).or_insert(GitFileStatus::Clean);
    }
}

fn check_subdirectory_git_repos(
    result: &mut HashMap<String, GitFileStatus>,
    directory: &Path,
) -> bool {
    let entries = match std::fs::read_dir(directory) {
        Ok(e) => e,
        Err(_) => return false,
    };

    let mut found_any = false;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if !path.join(".git").exists() {
            continue;
        }

        found_any = true;

        let status = match git_command()
            .args(["status", "--porcelain", "-z"])
            .current_dir(&path)
            .output()
        {
            Ok(o) if o.status.success() => highest_priority_status(&o.stdout),
            _ => continue,
        };

        let key = normalize_path_key(&path.to_string_lossy());
        if let Some(s) = status {
            insert_or_update_status(result, key, s);
        } else {
            result.entry(key).or_insert(GitFileStatus::Clean);
        }
    }

    found_any
}

fn get_git_status_via_subprocess(directory: &Path) -> Result<GitDirectoryStatus> {
    let repo_root = match git_command()
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(directory)
        .output()
    {
        Ok(output) if output.status.success() => {
            let root_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let root = Path::new(&root_str).to_path_buf();
            if cfg!(windows) {
                std::path::PathBuf::from(normalize_path_separator(&root.to_string_lossy()))
            } else {
                root
            }
        }
        _ => {
            let mut statuses = HashMap::new();
            let found_git = check_subdirectory_git_repos(&mut statuses, directory);
            return Ok(GitDirectoryStatus { statuses, is_git_repo: found_git });
        }
    };

    let output = match git_command()
        .args(["status", "--porcelain", "-z"])
        .current_dir(directory)
        .output()
    {
        Ok(output) if output.status.success() => output.stdout,
        _ => {
            return Ok(GitDirectoryStatus { statuses: HashMap::new(), is_git_repo: false });
        }
    };

    let canonical_dir =
        strip_verbatim_prefix(&std::fs::canonicalize(directory).unwrap_or_else(|_| directory.to_path_buf()));

    let mut statuses = parse_porcelain_output(&output, &repo_root, &canonical_dir);
    add_clean_tracked_entries(&mut statuses, &repo_root, &canonical_dir);

    Ok(GitDirectoryStatus { statuses, is_git_repo: true })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

pub fn get_git_status_for_directory(directory: &Path) -> Result<GitDirectoryStatus> {
    // Primary path: use gix library (no subprocess, no console window, fast)
    if let Some(result) = get_git_status_via_gix(directory) {
        return Ok(result);
    }

    // Fallback: subprocess with CREATE_NO_WINDOW
    get_git_status_via_subprocess(directory)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn repo_root() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from("C:\\repo")
        } else {
            PathBuf::from("/repo")
        }
    }

    fn query_dir() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from("C:\\repo\\src")
        } else {
            PathBuf::from("/repo/src")
        }
    }

    fn make_porcelain(entries: &[&str]) -> Vec<u8> {
        entries.join("\0").into_bytes()
    }

    fn lookup_status<'a>(
        result: &'a HashMap<String, GitFileStatus>,
        path: &Path,
    ) -> Option<&'a GitFileStatus> {
        let key = if cfg!(windows) {
            path.to_string_lossy().to_lowercase()
        } else {
            path.to_string_lossy().to_string()
        };
        result.get(&key)
    }

    #[test]
    fn parse_modified_file() {
        let raw = make_porcelain(&[" M src/main.rs"]);
        let result = parse_porcelain_output(&raw, &repo_root(), &query_dir());
        let expected_path = query_dir().join("main.rs");
        assert_eq!(lookup_status(&result, &expected_path), Some(&GitFileStatus::Modified));
    }

    #[test]
    fn parse_staged_modified_file() {
        let raw = make_porcelain(&["M  src/lib.rs"]);
        let result = parse_porcelain_output(&raw, &repo_root(), &query_dir());
        let expected_path = query_dir().join("lib.rs");
        assert_eq!(lookup_status(&result, &expected_path), Some(&GitFileStatus::Modified));
    }

    #[test]
    fn parse_untracked_file() {
        let raw = make_porcelain(&["?? src/new_file.txt"]);
        let result = parse_porcelain_output(&raw, &repo_root(), &query_dir());
        assert!(result.is_empty());
    }

    #[test]
    fn parse_added_file() {
        let raw = make_porcelain(&["A  src/added.rs"]);
        let result = parse_porcelain_output(&raw, &repo_root(), &query_dir());
        let expected_path = query_dir().join("added.rs");
        assert_eq!(lookup_status(&result, &expected_path), Some(&GitFileStatus::Added));
    }

    #[test]
    fn parse_deleted_file() {
        let raw = make_porcelain(&[" D src/removed.rs"]);
        let result = parse_porcelain_output(&raw, &repo_root(), &query_dir());
        let expected_path = query_dir().join("removed.rs");
        assert_eq!(lookup_status(&result, &expected_path), Some(&GitFileStatus::Deleted));
    }

    #[test]
    fn parse_conflict_file() {
        let raw = make_porcelain(&["UU src/conflict.rs"]);
        let result = parse_porcelain_output(&raw, &repo_root(), &query_dir());
        let expected_path = query_dir().join("conflict.rs");
        assert_eq!(lookup_status(&result, &expected_path), Some(&GitFileStatus::Conflict));
    }

    #[test]
    fn parse_renamed_file_skips_old_name() {
        let raw = make_porcelain(&["R  src/new_name.rs", "src/old_name.rs"]);
        let result = parse_porcelain_output(&raw, &repo_root(), &query_dir());
        let expected_path = query_dir().join("new_name.rs");
        assert_eq!(lookup_status(&result, &expected_path), Some(&GitFileStatus::Renamed));
        let old_path = query_dir().join("old_name.rs");
        assert_eq!(lookup_status(&result, &old_path), None);
    }

    #[test]
    fn directory_aggregation_picks_highest_priority() {
        let raw = make_porcelain(&["?? src/sub/file1.txt", " M src/sub/file2.txt"]);
        let result = parse_porcelain_output(&raw, &repo_root(), &query_dir());
        let sub_dir = query_dir().join("sub");
        assert_eq!(lookup_status(&result, &sub_dir), Some(&GitFileStatus::Modified));
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn directory_aggregation_conflict_wins() {
        let raw = make_porcelain(&[" M src/sub/a.rs", "UU src/sub/b.rs", "?? src/sub/c.rs"]);
        let result = parse_porcelain_output(&raw, &repo_root(), &query_dir());
        let sub_dir = query_dir().join("sub");
        assert_eq!(lookup_status(&result, &sub_dir), Some(&GitFileStatus::Conflict));
    }

    #[test]
    fn empty_output_returns_empty_map() {
        let result = parse_porcelain_output(&[], &repo_root(), &query_dir());
        assert!(result.is_empty());
    }

    #[test]
    fn files_outside_query_dir_are_excluded() {
        let raw = make_porcelain(&[" M README.md"]);
        let result = parse_porcelain_output(&raw, &repo_root(), &query_dir());
        assert!(result.is_empty());
    }

    #[test]
    fn mixed_direct_and_nested_entries() {
        let raw = make_porcelain(&[" M src/direct.rs", "?? src/sub/nested.txt", "A  src/sub/deep/file.rs"]);
        let result = parse_porcelain_output(&raw, &repo_root(), &query_dir());
        let direct_path = query_dir().join("direct.rs");
        let sub_dir = query_dir().join("sub");
        assert_eq!(lookup_status(&result, &direct_path), Some(&GitFileStatus::Modified));
        assert_eq!(lookup_status(&result, &sub_dir), Some(&GitFileStatus::Added));
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn multiple_statuses_on_same_file_picks_highest() {
        let raw = make_porcelain(&["?? src/file.rs", " M src/file.rs"]);
        let result = parse_porcelain_output(&raw, &repo_root(), &query_dir());
        let file_path = query_dir().join("file.rs");
        assert_eq!(lookup_status(&result, &file_path), Some(&GitFileStatus::Modified));
    }

    #[test]
    fn strip_verbatim_prefix_removes_windows_extended_path() {
        let verbatim = Path::new(r"\\?\C:\repo\src");
        let stripped = strip_verbatim_prefix(verbatim);
        assert_eq!(stripped, PathBuf::from(r"C:\repo\src"));
    }

    #[test]
    fn strip_verbatim_prefix_preserves_normal_path() {
        let normal = Path::new(r"C:\repo\src");
        let stripped = strip_verbatim_prefix(normal);
        assert_eq!(stripped, PathBuf::from(r"C:\repo\src"));
    }

    #[cfg(windows)]
    #[test]
    fn verbatim_query_dir_matches_normal_repo_root_paths() {
        let raw = make_porcelain(&[" M src/main.rs"]);
        let verbatim_dir = PathBuf::from(r"\\?\C:\repo\src");
        let stripped = strip_verbatim_prefix(&verbatim_dir);
        let result = parse_porcelain_output(&raw, &repo_root(), &stripped);
        let file_path = PathBuf::from(r"C:\repo\src\main.rs");
        assert_eq!(lookup_status(&result, &file_path), Some(&GitFileStatus::Modified));
    }

    #[cfg(windows)]
    #[test]
    fn case_insensitive_query_dir_matches_repo_root_with_different_case() {
        let raw = make_porcelain(&[" M src/main.rs"]);
        let upper_repo_root = PathBuf::from(r"C:\Repo");
        let lower_query_dir = PathBuf::from(r"C:\repo\src");
        let result = parse_porcelain_output(&raw, &upper_repo_root, &lower_query_dir);
        let file_path = PathBuf::from(r"C:\Repo\src\main.rs");
        assert_eq!(lookup_status(&result, &file_path), Some(&GitFileStatus::Modified));
    }

    #[cfg(windows)]
    #[test]
    fn case_insensitive_directory_aggregation_matches_different_case() {
        let raw = make_porcelain(&["?? src/sub/new.txt"]);
        let upper_repo_root = PathBuf::from(r"C:\Repo");
        let lower_query_dir = PathBuf::from(r"C:\repo\src");
        let result = parse_porcelain_output(&raw, &upper_repo_root, &lower_query_dir);
        assert!(result.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn case_insensitive_direct_file_match_with_different_case() {
        let raw = make_porcelain(&[" M src/main.rs"]);
        let lower_repo_root = PathBuf::from(r"C:\repo");
        let upper_query_dir = PathBuf::from(r"C:\REPO\src");
        let result = parse_porcelain_output(&raw, &lower_repo_root, &upper_query_dir);
        let file_path = PathBuf::from(r"C:\REPO\src\main.rs");
        assert_eq!(lookup_status(&result, &file_path), Some(&GitFileStatus::Modified));
    }

    #[test]
    fn add_status_for_path_direct_child() {
        let mut result = HashMap::new();
        let abs_path = query_dir().join("main.rs");
        add_status_for_path(&mut result, &abs_path, &query_dir(), GitFileStatus::Modified);
        assert_eq!(lookup_status(&result, &abs_path), Some(&GitFileStatus::Modified));
    }

    #[test]
    fn add_status_for_path_nested_child_aggregates_to_directory() {
        let mut result = HashMap::new();
        let abs_path = query_dir().join("sub").join("deep").join("file.rs");
        add_status_for_path(&mut result, &abs_path, &query_dir(), GitFileStatus::Added);
        let sub_dir = query_dir().join("sub");
        assert_eq!(lookup_status(&result, &sub_dir), Some(&GitFileStatus::Added));
    }

    #[test]
    fn add_status_for_path_outside_query_dir_is_excluded() {
        let mut result = HashMap::new();
        let abs_path = repo_root().join("README.md");
        add_status_for_path(&mut result, &abs_path, &query_dir(), GitFileStatus::Modified);
        assert!(result.is_empty());
    }

    #[test]
    fn clean_status_does_not_override_higher_priority() {
        let mut result = HashMap::new();
        let abs_path = query_dir().join("main.rs");
        add_status_for_path(&mut result, &abs_path, &query_dir(), GitFileStatus::Modified);
        add_status_for_path(&mut result, &abs_path, &query_dir(), GitFileStatus::Clean);
        assert_eq!(lookup_status(&result, &abs_path), Some(&GitFileStatus::Modified));
    }

    // --- Integration tests against the real project repository ---

    /// Returns the path to the project root (the directory containing Cargo.toml).
    fn project_root() -> PathBuf {
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
            .unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_string());
        PathBuf::from(manifest_dir)
    }

    #[test]
    fn gix_path_returns_some_for_project_root() {
        let root = project_root();
        let result = get_git_status_via_gix(&root);
        assert!(result.is_some(), "gix path should find the project repo");
        let status = result.unwrap();
        assert!(status.is_git_repo, "should be a git repo");
        // The project has tracked files, so there should be at least some entries
        assert!(
            !status.statuses.is_empty(),
            "status map should not be empty for a repo with tracked files"
        );
    }

    #[test]
    fn gix_path_returns_some_for_subdirectory() {
        let subdir = project_root().join("src").join("services");
        let result = get_git_status_via_gix(&subdir);
        assert!(result.is_some(), "gix path should find the repo from a subdirectory");
        let status = result.unwrap();
        assert!(status.is_git_repo, "should be a git repo");
        // The services directory has tracked files (git_status_service.rs, etc.)
        assert!(
            !status.statuses.is_empty(),
            "status map should contain entries for tracked files in the subdirectory"
        );
    }

    #[test]
    fn get_git_status_for_directory_works_on_project_root() {
        let root = project_root();
        let result = get_git_status_for_directory(&root).unwrap();
        assert!(result.is_git_repo, "project root should be a git repo");
        assert!(
            !result.statuses.is_empty(),
            "should have status entries for tracked files"
        );
    }
}

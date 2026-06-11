use std::{
  fs,
  io::Read,
  path::{Path, PathBuf},
  sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver},
    Arc, Mutex
  },
  thread
};

use anyhow::Result;
use encoding_rs::{UTF_16BE, UTF_16LE, UTF_8};
use regex::{Regex, RegexBuilder};
use walkdir::WalkDir;

use crate::domain::models::{ExtensionFilterMode, SearchContentMode, SearchFinished, SearchProgress, SearchQuery, SearchResult};

const DEFAULT_MAX_FILE_SIZE_BYTES: u64 = 1024 * 1024;
const PROGRESS_INTERVAL: usize = 100;
const RESULT_DRAIN_INTERVAL: usize = 64;
const MAX_SEARCH_WORKERS: usize = 8;

enum TextMatcher {
  Normal {
    pattern: String,
    normalized_pattern: String,
    case_sensitive: bool
  },
  Regex(Regex)
}

struct ContentSearchJob {
  path: PathBuf,
  name: String,
  parent: String,
  search_id: String,
  matched_on: Vec<String>
}

struct ContentSearchWorkers {
  sender: mpsc::Sender<ContentSearchJob>,
  result_receiver: Receiver<SearchResult>,
  handles: Vec<thread::JoinHandle<()>>
}

impl TextMatcher {
  fn new(pattern: &str, mode: SearchContentMode, case_sensitive: bool) -> Result<Self> {
    match mode {
      SearchContentMode::Normal => Ok(Self::Normal {
        pattern: pattern.to_string(),
        normalized_pattern: if case_sensitive {
          pattern.to_string()
        } else {
          pattern.to_lowercase()
        },
        case_sensitive
      }),
      SearchContentMode::Wildcard => {
        let regex_pattern = wildcard_to_regex(pattern);
        Ok(Self::Regex(
          RegexBuilder::new(&regex_pattern)
            .case_insensitive(!case_sensitive)
            .build()?
        ))
      }
      SearchContentMode::Regex => Ok(Self::Regex(
        RegexBuilder::new(pattern)
          .case_insensitive(!case_sensitive)
          .build()?
      ))
    }
  }

  fn is_match(&self, content: &str) -> bool {
    self.find(content).is_some()
  }

  fn excerpt(&self, content: &str) -> Option<String> {
    self.find(content).map(|(start, end)| {
      let excerpt_start = floor_char_boundary(content, start.saturating_sub(32));
      let excerpt_end = ceil_char_boundary(content, (end + 64).min(content.len()));
      content[excerpt_start..excerpt_end].replace(['\r', '\n'], " ")
    })
  }

  fn find(&self, content: &str) -> Option<(usize, usize)> {
    match self {
      Self::Normal {
        pattern,
        normalized_pattern,
        case_sensitive
      } => {
        if pattern.is_empty() {
          return Some((0, 0));
        }

        if *case_sensitive {
          content
            .find(pattern)
            .map(|start| (start, start + pattern.len()))
        } else {
          let normalized_content = content.to_lowercase();
          normalized_content
            .find(normalized_pattern)
            .map(|start| (start, start + normalized_pattern.len()))
        }
      }
      Self::Regex(regex) => regex.find(content).map(|match_result| (match_result.start(), match_result.end()))
    }
  }
}

fn wildcard_to_regex(pattern: &str) -> String {
  let mut regex = String::new();
  for character in pattern.chars() {
    match character {
      '*' => regex.push_str(".*"),
      '?' => regex.push('.'),
      _ => regex.push_str(&regex::escape(&character.to_string()))
    }
  }
  regex
}

fn search_worker_count() -> usize {
  thread::available_parallelism()
    .map(|count| count.get())
    .unwrap_or(4)
    .clamp(1, MAX_SEARCH_WORKERS)
}

fn process_content_job(
  job: ContentSearchJob,
  matcher: &TextMatcher,
  max_file_size_bytes: u64
) -> Option<SearchResult> {
  let mut matched_on = job.matched_on;
  let mut excerpt = None;

  if let Ok(metadata) = fs::metadata(&job.path) {
    if metadata.len() <= max_file_size_bytes {
      let mut buffer = Vec::new();
      if fs::File::open(&job.path)
        .and_then(|mut file| file.read_to_end(&mut buffer))
        .is_ok()
      {
        if let Some(text) = decode_text(&buffer) {
          if matcher.is_match(&text) {
            matched_on.push("content".to_string());
            excerpt = matcher.excerpt(&text);
          }
        }
      }
    }
  }

  if matched_on.is_empty() {
    return None;
  }

  Some(SearchResult {
    search_id: job.search_id,
    path: job.path.to_string_lossy().into_owned(),
    name: job.name,
    parent: job.parent,
    is_directory: false,
    matched_on,
    excerpt
  })
}

fn drain_content_results<F>(
  receiver: &Receiver<SearchResult>,
  matched_entries: &mut usize,
  on_result: &mut F
) -> Result<()>
where
  F: FnMut(SearchResult) -> Result<()>
{
  while let Ok(result) = receiver.try_recv() {
    *matched_entries += 1;
    on_result(result)?;
  }

  Ok(())
}

fn spawn_content_workers(
  matcher: Arc<TextMatcher>,
  max_file_size_bytes: u64,
  cancelled: Arc<AtomicBool>
) -> ContentSearchWorkers {
  let (job_sender, job_receiver) = mpsc::channel::<ContentSearchJob>();
  let (result_sender, result_receiver) = mpsc::channel::<SearchResult>();
  let shared_job_receiver = Arc::new(Mutex::new(job_receiver));
  let worker_count = search_worker_count();
  let mut handles = Vec::with_capacity(worker_count);

  for _ in 0..worker_count {
    let job_receiver = shared_job_receiver.clone();
    let result_sender = result_sender.clone();
    let matcher = matcher.clone();
    let cancelled = cancelled.clone();

    handles.push(thread::spawn(move || {
      loop {
        if cancelled.load(Ordering::SeqCst) {
          break;
        }

        let job = match job_receiver.lock().expect("content search queue poisoned").recv() {
          Ok(job) => job,
          Err(_) => break
        };

        if cancelled.load(Ordering::SeqCst) {
          break;
        }

        if let Some(result) = process_content_job(job, &matcher, max_file_size_bytes) {
          if result_sender.send(result).is_err() {
            break;
          }
        }
      }
    }));
  }

  ContentSearchWorkers {
    sender: job_sender,
    result_receiver,
    handles
  }
}

fn is_allowed_extension(path: &Path, extensions: &[String], mode: &ExtensionFilterMode) -> bool {
  if extensions.is_empty() {
    return true;
  }

  let extension = path
    .extension()
    .and_then(|value| value.to_str())
    .unwrap_or_default()
    .to_lowercase();
  let matched = extensions
    .iter()
    .any(|candidate| candidate.trim_start_matches('.').eq_ignore_ascii_case(&extension));

  match mode {
    ExtensionFilterMode::Include => matched,
    ExtensionFilterMode::Exclude => !matched
  }
}

fn is_hidden(path: &Path) -> bool {
  if path
    .file_name()
    .and_then(|value| value.to_str())
    .map(|name| name.starts_with('.'))
    .unwrap_or(false)
  {
    return true;
  }

  #[cfg(windows)]
  {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    fs::symlink_metadata(path)
      .map(|metadata| metadata.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0)
      .unwrap_or(false)
  }

  #[cfg(not(windows))]
  {
    false
  }
}

fn decode_text(bytes: &[u8]) -> Option<String> {
  if bytes.starts_with(&[0xFF, 0xFE]) {
    let (decoded, _, _) = UTF_16LE.decode(&bytes[2..]);
    return Some(decoded.into_owned());
  }
  if bytes.starts_with(&[0xFE, 0xFF]) {
    let (decoded, _, _) = UTF_16BE.decode(&bytes[2..]);
    return Some(decoded.into_owned());
  }
  if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
    let (decoded, _, _) = UTF_8.decode(&bytes[3..]);
    return Some(decoded.into_owned());
  }

  let (decoded, _, had_errors) = UTF_8.decode(bytes);
  if had_errors && bytes.iter().filter(|byte| **byte == 0).count() > bytes.len() / 4 {
    return None;
  }
  Some(decoded.into_owned())
}

fn floor_char_boundary(content: &str, mut index: usize) -> usize {
  while index > 0 && !content.is_char_boundary(index) {
    index -= 1;
  }
  index
}

fn ceil_char_boundary(content: &str, mut index: usize) -> usize {
  while index < content.len() && !content.is_char_boundary(index) {
    index += 1;
  }
  index
}

pub fn run_search<F, P>(
  query: SearchQuery,
  cancelled: Arc<AtomicBool>,
  mut on_result: F,
  mut on_progress: P
) -> Result<SearchFinished>
where
  F: FnMut(SearchResult) -> Result<()>,
  P: FnMut(SearchProgress) -> Result<()>
{
  let search_id = query.search_id.clone().unwrap_or_default();
  let mut scanned_entries = 0usize;
  let mut matched_entries = 0usize;
  let content_matcher = query
    .content_pattern
    .as_deref()
    .filter(|pattern| !pattern.is_empty())
    .map(|pattern| TextMatcher::new(pattern, query.content_mode.clone(), query.case_sensitive))
    .transpose()?;
  let name_matcher = query
    .name_pattern
    .as_deref()
    .filter(|pattern| !pattern.is_empty())
    .map(|pattern| TextMatcher::new(pattern, query.name_mode.clone(), query.case_sensitive))
    .transpose()?;
  let max_file_size_bytes = query
    .max_file_size_bytes
    .unwrap_or(DEFAULT_MAX_FILE_SIZE_BYTES);
  let content_workers = content_matcher.map(|matcher| {
    spawn_content_workers(Arc::new(matcher), max_file_size_bytes, cancelled.clone())
  });

  for root in &query.roots {
    if cancelled.load(Ordering::SeqCst) {
      break;
    }

    let walker = if query.recursive {
      WalkDir::new(root)
    } else {
      WalkDir::new(root).max_depth(1)
    };

    for entry in walker.into_iter().filter_map(|entry| entry.ok()) {
      if cancelled.load(Ordering::SeqCst) {
        break;
      }

      let path = entry.path();
      scanned_entries += 1;
      if let Some(workers) = &content_workers {
        if scanned_entries % RESULT_DRAIN_INTERVAL == 0 {
          drain_content_results(&workers.result_receiver, &mut matched_entries, &mut on_result)?;
        }
      }
      if scanned_entries % PROGRESS_INTERVAL == 0 {
        if let Some(workers) = &content_workers {
          drain_content_results(&workers.result_receiver, &mut matched_entries, &mut on_result)?;
        }
        on_progress(SearchProgress {
          search_id: search_id.clone(),
          scanned_entries,
          matched_entries
        })?;
      }

      if !query.include_hidden && is_hidden(path) {
        continue;
      }

      let name = path.file_name().and_then(|value| value.to_str()).unwrap_or_default();
      let mut matched_on = Vec::new();

      if let Some(matcher) = &name_matcher {
        if matcher.is_match(name) {
          matched_on.push("name".to_string());
        }
      }

      if path.is_dir() {
        if !query.include_folders || matched_on.is_empty() || content_workers.is_some() {
          continue;
        }

        matched_entries += 1;
        on_result(SearchResult {
          search_id: search_id.clone(),
          path: path.to_string_lossy().into_owned(),
          name: name.to_string(),
          parent: path
            .parent()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default(),
          is_directory: true,
          matched_on,
          excerpt: None
        })?;
        continue;
      }

      if !is_allowed_extension(path, &query.extensions, &query.extension_filter_mode) {
        continue;
      }

      if let Some(workers) = &content_workers {
        if path.is_file() {
          let _ = workers.sender.send(ContentSearchJob {
            path: path.to_path_buf(),
            name: name.to_string(),
            parent: path
              .parent()
              .map(|value| value.to_string_lossy().into_owned())
              .unwrap_or_default(),
            search_id: search_id.clone(),
            matched_on
          });
          continue;
        }

        if matched_on.is_empty() {
          continue;
        }

        matched_entries += 1;
        on_result(SearchResult {
          search_id: search_id.clone(),
          path: path.to_string_lossy().into_owned(),
          name: name.to_string(),
          parent: path
            .parent()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default(),
          is_directory: path.is_dir(),
          matched_on,
          excerpt: None
        })?;
        continue;
      }

      if matched_on.is_empty() {
        continue;
      }
      matched_entries += 1;
      on_result(SearchResult {
        search_id: search_id.clone(),
        path: path.to_string_lossy().into_owned(),
        name: name.to_string(),
        parent: path
          .parent()
          .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default(),
        is_directory: path.is_dir(),
        matched_on,
        excerpt: None
      })?;
    }
  }

  if let Some(workers) = content_workers {
    drop(workers.sender);
    for handle in workers.handles {
      let _ = handle.join();
    }
    while let Ok(result) = workers.result_receiver.recv() {
      matched_entries += 1;
      on_result(result)?;
    }
  }

  Ok(SearchFinished {
    search_id,
    cancelled: cancelled.load(Ordering::SeqCst),
    scanned_entries,
    matched_entries
  })
}

#[cfg(test)]
mod tests {
  use std::{
    fs,
    sync::{
      atomic::{AtomicBool, Ordering},
      Arc
    },
    time::{SystemTime, UNIX_EPOCH}
  };

  use super::run_search;
  use crate::domain::models::{ExtensionFilterMode, SearchContentMode, SearchQuery};

  fn unique_temp_path(label: &str) -> std::path::PathBuf {
    let unique = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .expect("time went backwards")
      .as_nanos();
    std::env::temp_dir().join(format!("simplefilemanager-search-{label}-{unique}"))
  }

  #[test]
  fn finds_matches_by_name_and_content() {
    let root = unique_temp_path("match");
    fs::create_dir_all(&root).expect("create search root");
    fs::write(root.join("notes.txt"), "important phrase").expect("write search file");

    let query = SearchQuery {
      search_id: Some("search-1".into()),
      roots: vec![root.to_string_lossy().into_owned()],
      name_pattern: Some("notes".into()),
      content_pattern: Some("phrase".into()),
      name_mode: SearchContentMode::Normal,
      content_mode: SearchContentMode::Normal,
      extensions: vec!["txt".into()],
      extension_filter_mode: ExtensionFilterMode::Include,
      include_folders: false,
      recursive: true,
      include_hidden: true,
      case_sensitive: false,
      max_file_size_bytes: Some(1024)
    };

    let mut results = Vec::new();
    let mut progress_events = Vec::new();
    let finished = run_search(
      query,
      Arc::new(AtomicBool::new(false)),
      |result| {
        results.push(result);
        Ok(())
      },
      |progress| {
        progress_events.push(progress);
        Ok(())
      }
    )
    .expect("run search");

    assert!(!finished.cancelled);
    assert_eq!(finished.matched_entries, 1);
    assert_eq!(results.len(), 1);
    assert!(results[0].matched_on.iter().any(|item| item == "name"));
    assert!(results[0].matched_on.iter().any(|item| item == "content"));
    assert!(progress_events.len() <= 1);

    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn cancellation_stops_search() {
    let root = unique_temp_path("cancel");
    fs::create_dir_all(&root).expect("create search root");
    for index in 0..10 {
      fs::write(root.join(format!("file-{index}.txt")), "payload").expect("write file");
    }

    let cancelled = Arc::new(AtomicBool::new(false));
    let query = SearchQuery {
      search_id: Some("search-2".into()),
      roots: vec![root.to_string_lossy().into_owned()],
      name_pattern: Some("file".into()),
      content_pattern: None,
      name_mode: SearchContentMode::Normal,
      content_mode: SearchContentMode::Normal,
      extensions: vec!["txt".into()],
      extension_filter_mode: ExtensionFilterMode::Include,
      include_folders: false,
      recursive: true,
      include_hidden: true,
      case_sensitive: false,
      max_file_size_bytes: Some(1024)
    };

    let finished = run_search(
      query,
      cancelled.clone(),
      |result| {
        let _ = result;
        cancelled.store(true, Ordering::SeqCst);
        Ok(())
      },
      |_| Ok(())
    )
    .expect("run search");

    assert!(finished.cancelled);
    assert!(finished.matched_entries >= 1);

    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn name_search_modes_extension_filters_and_folder_inclusion_are_applied() {
    let root = unique_temp_path("name-filters");
    fs::create_dir_all(root.join("release-candidate")).expect("create release folder");
    fs::write(root.join("release-notes.txt"), "notes").expect("write txt file");
    fs::write(root.join("release-manifest.json"), "{}").expect("write json file");
    fs::write(root.join("skip.md"), "release").expect("write md file");

    let base_query = SearchQuery {
      search_id: Some("search-name-filters".into()),
      roots: vec![root.to_string_lossy().into_owned()],
      name_pattern: Some("release*".into()),
      content_pattern: None,
      name_mode: SearchContentMode::Wildcard,
      content_mode: SearchContentMode::Normal,
      extensions: vec!["txt".into()],
      extension_filter_mode: ExtensionFilterMode::Include,
      include_folders: false,
      recursive: true,
      include_hidden: true,
      case_sensitive: false,
      max_file_size_bytes: Some(1024)
    };

    let mut included_results = Vec::new();
    let included_finished = run_search(
      base_query.clone(),
      Arc::new(AtomicBool::new(false)),
      |result| {
        included_results.push(result);
        Ok(())
      },
      |_| Ok(())
    )
    .expect("run include-filtered name search");

    assert_eq!(included_finished.matched_entries, 1);
    assert_eq!(included_results[0].name, "release-notes.txt");
    assert!(!included_results.iter().any(|result| result.is_directory));

    let mut exclude_query = base_query.clone();
    exclude_query.extensions = vec!["json".into()];
    exclude_query.extension_filter_mode = ExtensionFilterMode::Exclude;
    exclude_query.include_folders = true;

    let mut excluded_results = Vec::new();
    let excluded_finished = run_search(
      exclude_query,
      Arc::new(AtomicBool::new(false)),
      |result| {
        excluded_results.push(result);
        Ok(())
      },
      |_| Ok(())
    )
    .expect("run exclude-filtered name search");

    assert_eq!(excluded_finished.matched_entries, 2);
    assert!(excluded_results.iter().any(|result| result.name == "release-notes.txt" && !result.is_directory));
    assert!(excluded_results.iter().any(|result| result.name == "release-candidate" && result.is_directory));
    assert!(!excluded_results.iter().any(|result| result.name == "release-manifest.json"));

    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn search_respects_recursive_flag() {
    let root = unique_temp_path("recursive");
    fs::create_dir_all(root.join("nested")).expect("create nested search folder");
    fs::write(root.join("root.txt"), "needle").expect("write root file");
    fs::write(root.join("nested").join("nested.txt"), "needle").expect("write nested file");

    let base_query = SearchQuery {
      search_id: Some("search-recursive".into()),
      roots: vec![root.to_string_lossy().into_owned()],
      name_pattern: None,
      content_pattern: Some("needle".into()),
      name_mode: SearchContentMode::Normal,
      content_mode: SearchContentMode::Normal,
      extensions: vec!["txt".into()],
      extension_filter_mode: ExtensionFilterMode::Include,
      include_folders: false,
      recursive: false,
      include_hidden: true,
      case_sensitive: false,
      max_file_size_bytes: Some(1024)
    };

    let mut non_recursive_results = Vec::new();
    let non_recursive_finished = run_search(
      base_query.clone(),
      Arc::new(AtomicBool::new(false)),
      |result| {
        non_recursive_results.push(result);
        Ok(())
      },
      |_| Ok(())
    )
    .expect("run non-recursive search");

    let mut recursive_query = base_query;
    recursive_query.recursive = true;
    let mut recursive_results = Vec::new();
    let recursive_finished = run_search(
      recursive_query,
      Arc::new(AtomicBool::new(false)),
      |result| {
        recursive_results.push(result);
        Ok(())
      },
      |_| Ok(())
    )
    .expect("run recursive search");

    assert_eq!(non_recursive_finished.matched_entries, 1);
    assert!(non_recursive_results.iter().any(|result| result.name == "root.txt"));
    assert!(!non_recursive_results.iter().any(|result| result.name == "nested.txt"));
    assert_eq!(recursive_finished.matched_entries, 2);
    assert!(recursive_results.iter().any(|result| result.name == "root.txt"));
    assert!(recursive_results.iter().any(|result| result.name == "nested.txt"));

    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn content_search_supports_wildcard_mode() {
    let root = unique_temp_path("wildcard");
    fs::create_dir_all(&root).expect("create search root");
    fs::write(root.join("trace.txt"), "error code 42 done").expect("write search file");
    fs::write(root.join("skip.txt"), "error done").expect("write non matching search file");

    let query = SearchQuery {
      search_id: Some("search-wildcard".into()),
      roots: vec![root.to_string_lossy().into_owned()],
      name_pattern: None,
      content_pattern: Some("error*42?done".into()),
      name_mode: SearchContentMode::Normal,
      content_mode: SearchContentMode::Wildcard,
      extensions: vec!["txt".into()],
      extension_filter_mode: ExtensionFilterMode::Include,
      include_folders: false,
      recursive: true,
      include_hidden: true,
      case_sensitive: false,
      max_file_size_bytes: Some(1024)
    };

    let mut results = Vec::new();
    let finished = run_search(
      query,
      Arc::new(AtomicBool::new(false)),
      |result| {
        results.push(result);
        Ok(())
      },
      |_| Ok(())
    )
    .expect("run wildcard search");

    assert_eq!(finished.matched_entries, 1);
    assert_eq!(results[0].name, "trace.txt");
    assert!(results[0].excerpt.as_deref().unwrap_or_default().contains("error code 42 done"));

    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn content_search_supports_regex_mode() {
    let root = unique_temp_path("regex");
    fs::create_dir_all(&root).expect("create search root");
    fs::write(root.join("log.txt"), "request error 503 completed").expect("write search file");
    fs::write(root.join("skip.txt"), "request error completed").expect("write non matching search file");

    let query = SearchQuery {
      search_id: Some("search-regex".into()),
      roots: vec![root.to_string_lossy().into_owned()],
      name_pattern: None,
      content_pattern: Some(r"error\s+\d{3}".into()),
      name_mode: SearchContentMode::Normal,
      content_mode: SearchContentMode::Regex,
      extensions: vec!["txt".into()],
      extension_filter_mode: ExtensionFilterMode::Include,
      include_folders: false,
      recursive: true,
      include_hidden: true,
      case_sensitive: false,
      max_file_size_bytes: Some(1024)
    };

    let mut results = Vec::new();
    let finished = run_search(
      query,
      Arc::new(AtomicBool::new(false)),
      |result| {
        results.push(result);
        Ok(())
      },
      |_| Ok(())
    )
    .expect("run regex search");

    assert_eq!(finished.matched_entries, 1);
    assert_eq!(results[0].name, "log.txt");
    assert!(results[0].excerpt.as_deref().unwrap_or_default().contains("error 503"));

    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn content_search_respects_case_sensitive_flag() {
    let root = unique_temp_path("case");
    fs::create_dir_all(&root).expect("create search root");
    fs::write(root.join("case.txt"), "Atlas Release").expect("write search file");

    let case_sensitive_query = SearchQuery {
      search_id: Some("search-case-sensitive".into()),
      roots: vec![root.to_string_lossy().into_owned()],
      name_pattern: None,
      content_pattern: Some("atlas".into()),
      name_mode: SearchContentMode::Normal,
      content_mode: SearchContentMode::Normal,
      extensions: vec!["txt".into()],
      extension_filter_mode: ExtensionFilterMode::Include,
      include_folders: false,
      recursive: true,
      include_hidden: true,
      case_sensitive: true,
      max_file_size_bytes: Some(1024)
    };

    let mut sensitive_results = Vec::new();
    let sensitive_finished = run_search(
      case_sensitive_query,
      Arc::new(AtomicBool::new(false)),
      |result| {
        sensitive_results.push(result);
        Ok(())
      },
      |_| Ok(())
    )
    .expect("run case-sensitive search");

    let case_insensitive_query = SearchQuery {
      search_id: Some("search-case-insensitive".into()),
      roots: vec![root.to_string_lossy().into_owned()],
      name_pattern: None,
      content_pattern: Some("atlas".into()),
      name_mode: SearchContentMode::Normal,
      content_mode: SearchContentMode::Normal,
      extensions: vec!["txt".into()],
      extension_filter_mode: ExtensionFilterMode::Include,
      include_folders: false,
      recursive: true,
      include_hidden: true,
      case_sensitive: false,
      max_file_size_bytes: Some(1024)
    };

    let mut insensitive_results = Vec::new();
    let insensitive_finished = run_search(
      case_insensitive_query,
      Arc::new(AtomicBool::new(false)),
      |result| {
        insensitive_results.push(result);
        Ok(())
      },
      |_| Ok(())
    )
    .expect("run case-insensitive search");

    assert_eq!(sensitive_finished.matched_entries, 0);
    assert!(sensitive_results.is_empty());
    assert_eq!(insensitive_finished.matched_entries, 1);
    assert_eq!(insensitive_results[0].name, "case.txt");

    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn invalid_regex_returns_an_error_before_scanning_files() {
    let root = unique_temp_path("invalid-regex");
    fs::create_dir_all(&root).expect("create search root");
    fs::write(root.join("log.txt"), "error 503").expect("write search file");

    let query = SearchQuery {
      search_id: Some("search-invalid-regex".into()),
      roots: vec![root.to_string_lossy().into_owned()],
      name_pattern: None,
      content_pattern: Some("error(".into()),
      name_mode: SearchContentMode::Normal,
      content_mode: SearchContentMode::Regex,
      extensions: vec!["txt".into()],
      extension_filter_mode: ExtensionFilterMode::Include,
      include_folders: false,
      recursive: true,
      include_hidden: true,
      case_sensitive: false,
      max_file_size_bytes: Some(1024)
    };

    let result = run_search(
      query,
      Arc::new(AtomicBool::new(false)),
      |_| Ok(()),
      |_| Ok(())
    );

    assert!(result.is_err());

    let _ = fs::remove_dir_all(root);
  }
}

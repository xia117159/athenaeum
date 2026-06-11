use std::{
  fs,
  path::{Path, PathBuf}
};

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};

use crate::domain::models::{
  ColorRule, ColorRuleMode, ColorRuleTarget, DirectoryListing, DriveInfo, EntryDecoration, EntryKind, EntryViewModel,
  LocationDescriptor, TreeNode
};

fn metadata_modified_at(metadata: &fs::Metadata) -> Option<DateTime<Utc>> {
  metadata.modified().ok().map(DateTime::<Utc>::from)
}

fn is_hidden(path: &Path, metadata: Option<&fs::Metadata>) -> bool {
  if path
    .file_name()
    .and_then(|name| name.to_str())
    .map(|name| name.starts_with('.'))
    .unwrap_or(false)
  {
    return true;
  }

  #[cfg(windows)]
  {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    metadata
      .map(|value| value.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0)
      .unwrap_or(false)
  }

  #[cfg(not(windows))]
  {
    let _ = metadata;
    false
  }
}

fn is_symlink(metadata: &fs::Metadata) -> bool {
  metadata.file_type().is_symlink()
}

fn apply_color_rules(path: &Path, metadata: &fs::Metadata, rules: &[ColorRule]) -> Option<String> {
  let is_dir = metadata.is_dir();
  let hidden = is_hidden(path, Some(metadata));
  let read_only = metadata.permissions().readonly();
  let name = path.file_name().and_then(|value| value.to_str()).unwrap_or_default().to_lowercase();
  let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_lowercase();
  let full_path = path.to_string_lossy().to_lowercase();

  let mut ordered_rules = rules.iter().collect::<Vec<_>>();
  ordered_rules.sort_by_key(|rule| rule.priority);

  for rule in ordered_rules {
    let target_matches = matches!(rule.target, ColorRuleTarget::Any)
      || (matches!(rule.target, ColorRuleTarget::Directory) && is_dir)
      || (matches!(rule.target, ColorRuleTarget::File) && !is_dir);

    if !target_matches {
      continue;
    }

    let matched = match rule.mode {
      ColorRuleMode::Extension => rule
        .pattern
        .as_ref()
        .map(|pattern| extension == pattern.trim_start_matches('.').to_lowercase())
        .unwrap_or(false),
      ColorRuleMode::NameContains => rule
        .pattern
        .as_ref()
        .map(|pattern| name.contains(&pattern.to_lowercase()))
        .unwrap_or(false),
      ColorRuleMode::PathContains => rule
        .pattern
        .as_ref()
        .map(|pattern| full_path.contains(&pattern.to_lowercase()))
        .unwrap_or(false),
      ColorRuleMode::Hidden => hidden,
      ColorRuleMode::ReadOnly => read_only
    };

    if matched {
      return Some(rule.color_hex.clone());
    }
  }

  None
}

fn entry_from_path(path: PathBuf, color_rules: &[ColorRule], tag_names: Vec<String>) -> Result<EntryViewModel> {
  let metadata = fs::symlink_metadata(&path).with_context(|| format!("failed to get metadata for {}", path.display()))?;
  let is_dir = metadata.is_dir();
  let hidden = is_hidden(&path, Some(&metadata));
  let read_only = metadata.permissions().readonly();

  Ok(EntryViewModel {
    path: path.to_string_lossy().into_owned(),
    name: path
      .file_name()
      .and_then(|value| value.to_str())
      .unwrap_or_default()
      .to_string(),
    extension: path.extension().and_then(|value| value.to_str()).map(|value| value.to_string()),
    kind: if is_dir { EntryKind::Directory } else { EntryKind::File },
    size: (!is_dir).then_some(metadata.len()),
    modified_at: metadata_modified_at(&metadata),
    is_hidden: hidden,
    is_read_only: read_only,
    is_symlink: is_symlink(&metadata),
    location: LocationDescriptor::local(path.to_string_lossy().into_owned()),
    decoration: EntryDecoration {
      color_hex: apply_color_rules(&path, &metadata, color_rules),
      tags: tag_names
    }
  })
}

fn drive_infos_from_mask(mask: u32) -> Vec<DriveInfo> {
  (0..26)
    .filter_map(|index| {
      if mask & (1 << index) == 0 {
        return None;
      }

      let letter = (b'A' + index as u8) as char;
      let drive = format!("{letter}:\\");
      Some(DriveInfo {
        path: drive.clone(),
        label: drive
      })
    })
    .collect()
}

fn readable_drive_infos<F>(drives: Vec<DriveInfo>, can_read: F) -> Vec<DriveInfo>
where
  F: Fn(&Path) -> bool
{
  drives
    .into_iter()
    .filter(|drive| can_read(Path::new(&drive.path)))
    .collect()
}

pub fn list_drives() -> Vec<DriveInfo> {
  #[cfg(windows)]
  {
    let mask = unsafe { windows::Win32::Storage::FileSystem::GetLogicalDrives() };
    let drives = readable_drive_infos(drive_infos_from_mask(mask), |path| fs::read_dir(path).is_ok());
    if drives.is_empty() {
      return vec![DriveInfo {
        path: "C:\\".into(),
        label: "C:\\".into()
      }];
    }
    drives
  }

  #[cfg(not(windows))]
  {
    vec![DriveInfo {
      path: "/".into(),
      label: "/".into()
    }]
  }
}

pub fn list_directory<F>(path: &Path, color_rules: &[ColorRule], tags_for_path: F) -> Result<DirectoryListing>
where
  F: Fn(&str) -> Vec<String>
{
  let canonical = if path.exists() {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
  } else {
    path.to_path_buf()
  };

  let mut entries = Vec::new();
  for entry in fs::read_dir(&canonical).with_context(|| format!("failed to read directory {}", canonical.display()))? {
    let entry = entry.context("failed to read directory entry")?;
    let entry_path = entry.path();
    let tags = tags_for_path(&entry_path.to_string_lossy());
    entries.push(entry_from_path(entry_path, color_rules, tags)?);
  }

  entries.sort_by(|left, right| match (&left.kind, &right.kind) {
    (EntryKind::Directory, EntryKind::File) => std::cmp::Ordering::Less,
    (EntryKind::File, EntryKind::Directory) => std::cmp::Ordering::Greater,
    _ => left.name.to_lowercase().cmp(&right.name.to_lowercase())
  });

  Ok(DirectoryListing {
    location: LocationDescriptor::local(canonical.to_string_lossy().into_owned()),
    entries,
    parent: canonical.parent().map(|parent| parent.to_string_lossy().into_owned()),
    can_go_up: canonical.parent().is_some()
  })
}

pub fn get_tree_children(path: &Path) -> Result<Vec<TreeNode>> {
  let canonical = if path.exists() {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
  } else {
    path.to_path_buf()
  };

  let mut children = Vec::new();
  for entry in fs::read_dir(&canonical).with_context(|| format!("failed to read tree for {}", canonical.display()))? {
    let entry = entry.context("failed to read tree entry")?;
    let child_path = entry.path();
    let metadata = fs::symlink_metadata(&child_path)
      .with_context(|| format!("failed to get tree metadata for {}", child_path.display()))?;
    if !metadata.is_dir() {
      continue;
    }

    let has_children = fs::read_dir(&child_path)
      .ok()
      .map(|iter| {
        iter.flatten().any(|item| {
          fs::symlink_metadata(item.path())
            .map(|metadata| metadata.is_dir())
            .unwrap_or(false)
        })
      })
      .unwrap_or(false);

    children.push(TreeNode {
      path: child_path.to_string_lossy().into_owned(),
      name: child_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string(),
      has_children
    });
  }

  children.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
  Ok(children)
}

pub fn available_conflict_path(destination: &Path) -> PathBuf {
  if !destination.exists() {
    return destination.to_path_buf();
  }

  let parent = destination.parent().unwrap_or_else(|| Path::new(""));
  let stem = destination
    .file_stem()
    .and_then(|value| value.to_str())
    .or_else(|| destination.file_name().and_then(|value| value.to_str()))
    .unwrap_or("item");
  let extension = destination.extension().and_then(|value| value.to_str());

  for index in 1.. {
    let file_name = match extension {
      Some(extension) if !extension.is_empty() => format!("{stem} ({index}).{extension}"),
      _ => format!("{stem} ({index})")
    };
    let candidate = parent.join(file_name);
    if !candidate.exists() {
      return candidate;
    }
  }

  unreachable!("conflict index iteration is unbounded")
}

pub fn copy_recursively(source: &Path, destination: &Path) -> Result<PathBuf> {
  let metadata = fs::symlink_metadata(source).with_context(|| format!("failed to stat {}", source.display()))?;
  let destination = available_conflict_path(destination);

  if metadata.is_dir() && !metadata.file_type().is_symlink() {
    fs::create_dir_all(&destination).with_context(|| format!("failed to create directory {}", destination.display()))?;
    for entry in fs::read_dir(source).with_context(|| format!("failed to read {}", source.display()))? {
      let entry = entry.context("failed to read recursive directory entry")?;
      let child_source = entry.path();
      let child_destination = destination.join(entry.file_name());
      copy_recursively(&child_source, &child_destination)?;
    }
  } else {
    if let Some(parent) = destination.parent() {
      fs::create_dir_all(parent).with_context(|| format!("failed to create {}", parent.display()))?;
    }
    fs::copy(source, &destination).with_context(|| {
      format!(
        "failed to copy {} to {}",
        source.display(),
        destination.display()
      )
    })?;
  }
  Ok(destination)
}

pub fn move_entry(source: &Path, destination: &Path) -> Result<PathBuf> {
  let destination = available_conflict_path(destination);

  match fs::rename(source, &destination) {
    Ok(_) => Ok(destination),
    Err(_) => {
      let copied = copy_recursively(source, &destination)?;
      remove_path(source)?;
      Ok(copied)
    }
  }
}

pub fn delete_entry(path: &Path) -> Result<()> {
  delete_entry_recycle(path)
}

#[cfg(windows)]
pub fn delete_entry_recycle(path: &Path) -> Result<()> {
  use std::os::windows::ffi::OsStrExt;

  use windows::Win32::UI::Shell::{
    SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE, SHFILEOPSTRUCTW
  };

  if !path.exists() {
    bail!("path does not exist: {}", path.display());
  }

  let mut from = path.as_os_str().encode_wide().collect::<Vec<u16>>();
  from.push(0);
  from.push(0);

  let mut operation = SHFILEOPSTRUCTW {
    hwnd: Default::default(),
    wFunc: FO_DELETE,
    pFrom: windows::core::PCWSTR(from.as_ptr()),
    pTo: windows::core::PCWSTR::null(),
    fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT).0 as u16,
    fAnyOperationsAborted: Default::default(),
    hNameMappings: std::ptr::null_mut(),
    lpszProgressTitle: windows::core::PCWSTR::null()
  };

  let result = unsafe { SHFileOperationW(&mut operation) };
  if result != 0 {
    bail!("failed to move {} to recycle bin: shell error {}", path.display(), result);
  }
  if operation.fAnyOperationsAborted.as_bool() {
    bail!("delete operation was cancelled for {}", path.display());
  }

  Ok(())
}

#[cfg(not(windows))]
pub fn delete_entry_recycle(path: &Path) -> Result<()> {
  remove_path(path)
}

pub fn rename_entry(source: &Path, new_name: &str) -> Result<PathBuf> {
  validate_entry_name(new_name)?;
  let parent = source.parent().context("cannot rename root path")?;
  let destination = parent.join(new_name);
  if destination.exists() {
    bail!("destination already exists: {}", destination.display());
  }

  fs::rename(source, &destination).with_context(|| {
    format!(
      "failed to rename {} to {}",
      source.display(),
      destination.display()
    )
  })?;
  Ok(destination)
}

pub fn create_directory(parent: &Path, name: &str) -> Result<PathBuf> {
  validate_entry_name(name)?;
  let directory = parent.join(name);
  if directory.exists() {
    bail!("directory already exists: {}", directory.display());
  }
  fs::create_dir(&directory).with_context(|| format!("failed to create directory {}", directory.display()))?;
  Ok(directory)
}

pub fn create_file(parent: &Path, name: &str) -> Result<PathBuf> {
  validate_entry_name(name)?;
  let file = parent.join(name);
  if file.exists() {
    bail!("file already exists: {}", file.display());
  }
  fs::OpenOptions::new()
    .write(true)
    .create_new(true)
    .open(&file)
    .with_context(|| format!("failed to create file {}", file.display()))?;
  Ok(file)
}

fn validate_entry_name(name: &str) -> Result<()> {
  let candidate = name.trim();
  if candidate.is_empty() {
    bail!("entry name cannot be empty");
  }
  if candidate.contains('/') || candidate.contains('\\') || Path::new(candidate).components().count() != 1 {
    bail!("entry name must not include path separators");
  }
  if candidate == "." || candidate == ".." {
    bail!("entry name must not be . or ..");
  }
  Ok(())
}

fn remove_path(path: &Path) -> Result<()> {
  let metadata = fs::symlink_metadata(path).with_context(|| format!("failed to stat {}", path.display()))?;
  if metadata.is_dir() && !metadata.file_type().is_symlink() {
    fs::remove_dir_all(path).with_context(|| format!("failed to delete directory {}", path.display()))?;
  } else {
    fs::remove_file(path).with_context(|| format!("failed to delete file {}", path.display()))?;
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH}
  };

  use super::{
    apply_color_rules, available_conflict_path, copy_recursively, create_file, drive_infos_from_mask, list_directory,
    move_entry, readable_drive_infos, rename_entry
  };
  use crate::domain::models::{ColorRule, ColorRuleMode, ColorRuleTarget, DriveInfo, EntryKind};

  fn unique_temp_path(label: &str) -> std::path::PathBuf {
    let unique = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .expect("time went backwards")
      .as_nanos();
    std::env::temp_dir().join(format!("simplefilemanager-{label}-{unique}"))
  }

  #[test]
  fn applies_extension_rule() {
    let rule = ColorRule {
      id: "rule-1".into(),
      name: "Rust".into(),
      target: ColorRuleTarget::File,
      mode: ColorRuleMode::Extension,
      pattern: Some("rs".into()),
      color_hex: "#ff6600".into(),
      priority: 1
    };

    let path = std::path::Path::new("main.rs");
    let metadata = fs::metadata(path).unwrap_or_else(|_| {
      let temp = unique_temp_path("color-rule.rs");
      fs::write(&temp, "fn main() {}").expect("write temp file");
      let metadata = fs::metadata(&temp).expect("read temp metadata");
      let _ = fs::remove_file(temp);
      metadata
    });
    let color = apply_color_rules(path, &metadata, &[rule]);

    assert_eq!(color.as_deref(), Some("#ff6600"));
  }

  #[test]
  fn list_directory_sorts_directories_first_and_applies_tags() {
    let root = unique_temp_path("listing");
    let workspace = root.join("workspace");
    fs::create_dir_all(workspace.join("folder")).expect("create folder");
    fs::write(workspace.join("main.rs"), "fn main() {}").expect("write file");

    let listing = list_directory(&workspace, &[], |path| {
      if path.ends_with("main.rs") {
        vec!["Pinned".into()]
      } else {
        Vec::new()
      }
    })
    .expect("list directory");

    assert_eq!(listing.entries.len(), 2);
    assert_eq!(listing.entries[0].kind, EntryKind::Directory);
    assert_eq!(listing.entries[1].decoration.tags, vec!["Pinned".to_string()]);

    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn copy_move_and_rename_cycle_preserves_file() {
    let root = unique_temp_path("ops");
    let source = root.join("source");
    let target = root.join("target");
    fs::create_dir_all(&source).expect("create source");
    fs::create_dir_all(&target).expect("create target");
    fs::write(source.join("file.txt"), "hello").expect("write file");

    copy_recursively(&source.join("file.txt"), &target.join("file.txt")).expect("copy file");
    let renamed = rename_entry(&target.join("file.txt"), "renamed.txt").expect("rename file");
    move_entry(&renamed, &source.join("renamed.txt")).expect("move file");

    assert!(source.join("renamed.txt").exists());

    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn create_file_creates_empty_files_and_rejects_unsafe_names() {
    let root = unique_temp_path("create-file");
    fs::create_dir_all(&root).expect("create root");

    let created = create_file(&root, "notes.txt").expect("create file");

    assert_eq!(created, root.join("notes.txt"));
    assert!(created.exists());
    assert_eq!(fs::metadata(&created).expect("read metadata").len(), 0);
    assert!(create_file(&root, "notes.txt").is_err());
    assert!(create_file(&root, "..").is_err());
    assert!(create_file(&root, "nested\\name.txt").is_err());

    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn drive_infos_from_mask_includes_every_logical_drive_bit() {
    let mask = (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5) | (1 << 6);
    let drives = drive_infos_from_mask(mask);

    assert_eq!(
      drives.iter().map(|drive| drive.path.as_str()).collect::<Vec<_>>(),
      vec!["C:\\", "D:\\", "E:\\", "F:\\", "G:\\"]
    );
  }

  #[test]
  fn readable_drive_infos_filters_unreadable_roots() {
    let drives = vec![
      DriveInfo {
        path: "C:\\".into(),
        label: "C:\\".into()
      },
      DriveInfo {
        path: "G:\\".into(),
        label: "G:\\".into()
      },
      DriveInfo {
        path: "Z:\\".into(),
        label: "Z:\\".into()
      }
    ];

    let readable = readable_drive_infos(drives, |path| path.to_string_lossy() != "G:\\");

    assert_eq!(
      readable.iter().map(|drive| drive.path.as_str()).collect::<Vec<_>>(),
      vec!["C:\\", "Z:\\"]
    );
  }

  #[test]
  fn copy_and_move_preserve_existing_destination_with_numbered_conflicts() {
    let root = unique_temp_path("conflict");
    let source = root.join("source");
    let target = root.join("target");
    fs::create_dir_all(&source).expect("create source");
    fs::create_dir_all(&target).expect("create target");
    fs::write(source.join("file.txt"), "incoming").expect("write source file");
    fs::write(target.join("file.txt"), "existing").expect("write existing target file");

    let copied = copy_recursively(&source.join("file.txt"), &target.join("file.txt")).expect("copy file");

    assert_eq!(copied.file_name().and_then(|value| value.to_str()), Some("file (1).txt"));
    assert_eq!(fs::read_to_string(target.join("file.txt")).expect("read existing target"), "existing");
    assert_eq!(fs::read_to_string(target.join("file (1).txt")).expect("read copied file"), "incoming");

    fs::write(source.join("move.txt"), "moved").expect("write move source");
    fs::write(target.join("move.txt"), "existing move").expect("write existing move target");

    let moved = move_entry(&source.join("move.txt"), &target.join("move.txt")).expect("move file");

    assert_eq!(moved.file_name().and_then(|value| value.to_str()), Some("move (1).txt"));
    assert_eq!(fs::read_to_string(target.join("move.txt")).expect("read existing move target"), "existing move");
    assert_eq!(fs::read_to_string(target.join("move (1).txt")).expect("read moved file"), "moved");
    assert!(!source.join("move.txt").exists());

    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn available_conflict_path_handles_extensionless_names() {
    let root = unique_temp_path("extensionless-conflict");
    fs::create_dir_all(&root).expect("create root");
    fs::write(root.join("README"), "existing").expect("write existing extensionless file");

    let candidate = available_conflict_path(&root.join("README"));

    assert_eq!(candidate.file_name().and_then(|value| value.to_str()), Some("README (1)"));

    let _ = fs::remove_dir_all(root);
  }
}

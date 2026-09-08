use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};

use crate::domain::models::{
    ColorRule, DirectoryListing, DirectorySizeAvailability, DirectorySizeState, DriveInfo,
    EntryAttributeAvailability, EntryDecoration, EntryKind, EntryViewModel, ItemProperties,
    ItemPropertiesRequest, ItemPropertiesTarget, ItemPropertyField, ItemPropertyFieldAvailability,
    ItemPropertyFieldState, LocationDescriptor, TreeNode,
};
use crate::services::color_filter::{
    compile_rules, AttributeFacts, ColorStyle, CompiledColorRules, EntryFacts,
};

const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
const FILE_ATTRIBUTE_ARCHIVE: u32 = 0x20;

fn metadata_modified_at(metadata: &fs::Metadata) -> Option<DateTime<Utc>> {
    metadata.modified().ok().map(DateTime::<Utc>::from)
}

fn metadata_created_at(metadata: &fs::Metadata) -> Option<DateTime<Utc>> {
    metadata.created().ok().map(DateTime::<Utc>::from)
}

fn metadata_accessed_at(metadata: &fs::Metadata) -> Option<DateTime<Utc>> {
    metadata.accessed().ok().map(DateTime::<Utc>::from)
}

fn has_windows_file_attribute(metadata: Option<&fs::Metadata>, attribute: u32) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata
            .map(|value| value.file_attributes() & attribute != 0)
            .unwrap_or(false)
    }

    #[cfg(not(windows))]
    {
        let _ = (metadata, attribute);
        false
    }
}

fn is_hidden(path: &Path, metadata: Option<&fs::Metadata>) -> bool {
    #[cfg(windows)]
    {
        let _ = path;
        has_windows_hidden_attribute(metadata)
    }

    #[cfg(not(windows))]
    {
        let _ = metadata;
        path.file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.starts_with('.'))
            .unwrap_or(false)
    }
}

fn has_windows_hidden_attribute(metadata: Option<&fs::Metadata>) -> bool {
    has_windows_file_attribute(metadata, FILE_ATTRIBUTE_HIDDEN)
}

fn is_system(metadata: Option<&fs::Metadata>) -> bool {
    has_windows_file_attribute(metadata, FILE_ATTRIBUTE_SYSTEM)
}

fn is_protected_operating_system(metadata: Option<&fs::Metadata>) -> bool {
    has_windows_hidden_attribute(metadata) && is_system(metadata)
}

fn is_symlink(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn extension_with_dot(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .map(|value| format!(".{value}"))
}

fn unavailable(
    field: ItemPropertyField,
    state: ItemPropertyFieldAvailability,
    message: impl Into<String>,
) -> ItemPropertyFieldState {
    ItemPropertyFieldState {
        field,
        state,
        message: Some(message.into()),
    }
}

fn apply_color_rules(
    path: &Path,
    metadata: &fs::Metadata,
    rules: &CompiledColorRules,
) -> Option<ColorStyle> {
    let is_dir = metadata.is_dir();
    let platform_specific = if cfg!(windows) {
        (
            Some(is_system(Some(metadata))),
            Some(is_protected_operating_system(Some(metadata))),
            Some(has_windows_file_attribute(
                Some(metadata),
                FILE_ATTRIBUTE_ARCHIVE,
            )),
        )
    } else {
        (None, None, None)
    };
    rules.style_for(&EntryFacts {
        name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .into(),
        path: path.to_string_lossy().into_owned(),
        extension: (!is_dir).then(|| extension_with_dot(path).unwrap_or_default()),
        kind: if is_dir {
            EntryKind::Directory
        } else {
            EntryKind::File
        },
        size: (!is_dir).then_some(metadata.len()),
        created_at: metadata_created_at(metadata),
        modified_at: metadata_modified_at(metadata),
        accessed_at: metadata_accessed_at(metadata),
        attributes: AttributeFacts {
            hidden: Some(is_hidden(path, Some(metadata))),
            system: platform_specific.0,
            protected_system: platform_specific.1,
            read_only: Some(metadata.permissions().readonly()),
            symlink: Some(is_symlink(metadata)),
            archive: platform_specific.2,
        },
    })
}

fn entry_from_path(
    path: PathBuf,
    color_rules: &CompiledColorRules,
    tag_names: Vec<String>,
    comment: Option<String>,
) -> Result<EntryViewModel> {
    let metadata = fs::symlink_metadata(&path)
        .with_context(|| format!("failed to get metadata for {}", path.display()))?;
    let is_dir = metadata.is_dir();
    let hidden = is_hidden(&path, Some(&metadata));
    let system = is_system(Some(&metadata));
    let read_only = metadata.permissions().readonly();
    let color_style = apply_color_rules(&path, &metadata, color_rules);
    let (foreground_color_hex, background_color_hex) = color_style
        .map(|style| (style.foreground_color_hex, style.background_color_hex))
        .unwrap_or((None, None));

    Ok(EntryViewModel {
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string(),
        extension: path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_string()),
        kind: if is_dir {
            EntryKind::Directory
        } else {
            EntryKind::File
        },
        size: (!is_dir).then_some(metadata.len()),
        created_at: metadata_created_at(&metadata),
        modified_at: metadata_modified_at(&metadata),
        accessed_at: metadata_accessed_at(&metadata),
        is_hidden: hidden,
        is_system: system,
        is_protected_operating_system: is_protected_operating_system(Some(&metadata)),
        is_read_only: read_only,
        is_symlink: is_symlink(&metadata),
        location: LocationDescriptor::local(path.to_string_lossy().into_owned()),
        decoration: EntryDecoration {
            foreground_color_hex,
            background_color_hex,
            tags: tag_names,
        },
        comment,
        attribute_availability: EntryAttributeAvailability {
            hidden: true,
            system: cfg!(windows),
            protected_system: cfg!(windows),
            read_only: true,
            symlink: true,
            archive: cfg!(windows),
        },
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
                label: drive,
            })
        })
        .collect()
}

fn readable_drive_infos<F>(drives: Vec<DriveInfo>, can_read: F) -> Vec<DriveInfo>
where
    F: Fn(&Path) -> bool,
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
        let drives = readable_drive_infos(drive_infos_from_mask(mask), |path| {
            fs::read_dir(path).is_ok()
        });
        if drives.is_empty() {
            return vec![DriveInfo {
                path: "C:\\".into(),
                label: "C:\\".into(),
            }];
        }
        drives
    }

    #[cfg(not(windows))]
    {
        vec![DriveInfo {
            path: "/".into(),
            label: "/".into(),
        }]
    }
}

pub fn list_directory<F>(
    path: &Path,
    color_rules: &[ColorRule],
    metadata_for_path: F,
) -> Result<DirectoryListing>
where
    F: Fn(&str) -> (Vec<String>, Option<String>),
{
    let compiled_color_rules = compile_rules(color_rules, Utc::now());
    let canonical = if path.exists() {
        path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
    } else {
        path.to_path_buf()
    };

    let mut entries = Vec::new();
    for entry in fs::read_dir(&canonical)
        .with_context(|| format!("failed to read directory {}", canonical.display()))?
    {
        let entry = entry.context("failed to read directory entry")?;
        let entry_path = entry.path();
        let (tags, comment) = metadata_for_path(&entry_path.to_string_lossy());
        entries.push(entry_from_path(
            entry_path,
            &compiled_color_rules,
            tags,
            comment,
        )?);
    }

    entries.sort_by(|left, right| match (&left.kind, &right.kind) {
        (EntryKind::Directory, EntryKind::File) => std::cmp::Ordering::Less,
        (EntryKind::File, EntryKind::Directory) => std::cmp::Ordering::Greater,
        _ => left.name.to_lowercase().cmp(&right.name.to_lowercase()),
    });

    Ok(DirectoryListing {
        location: LocationDescriptor::local(canonical.to_string_lossy().into_owned()),
        entries,
        parent: canonical
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned()),
        can_go_up: canonical.parent().is_some(),
    })
}

pub fn get_item_properties(request: &ItemPropertiesRequest, path: &Path) -> Result<ItemProperties> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("failed to get metadata for {}", path.display()))?;
    let actual_path = if path.exists() {
        path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
    } else {
        path.to_path_buf()
    };
    let is_dir = metadata.is_dir();
    let created_at = metadata_created_at(&metadata);
    let modified_at = metadata_modified_at(&metadata);
    let accessed_at = metadata_accessed_at(&metadata);
    let mut field_states = Vec::new();

    if created_at.is_none() {
        field_states.push(unavailable(
            ItemPropertyField::CreatedAt,
            ItemPropertyFieldAvailability::ReadFailed,
            "Created date is not available",
        ));
    }
    if modified_at.is_none() {
        field_states.push(unavailable(
            ItemPropertyField::ModifiedAt,
            ItemPropertyFieldAvailability::ReadFailed,
            "Modified date is not available",
        ));
    }
    if accessed_at.is_none() {
        field_states.push(unavailable(
            ItemPropertyField::AccessedAt,
            ItemPropertyFieldAvailability::ReadFailed,
            "Accessed date is not available",
        ));
    }

    field_states.push(unavailable(
        ItemPropertyField::AllocatedBytes,
        ItemPropertyFieldAvailability::NotAvailable,
        "Allocated size is not available on this platform",
    ));

    let directory_size_state = if is_dir {
        DirectorySizeState {
            state: DirectorySizeAvailability::NotComputed,
            size_bytes: None,
            message: Some(if request.include_directory_size {
                "Directory size has not been computed".into()
            } else {
                "Directory size is not computed".into()
            }),
        }
    } else {
        DirectorySizeState {
            state: DirectorySizeAvailability::NotApplicable,
            size_bytes: None,
            message: None,
        }
    };

    if is_dir {
        field_states.push(unavailable(
            ItemPropertyField::DirectorySize,
            ItemPropertyFieldAvailability::NotComputed,
            "Directory size is not computed",
        ));
    }

    Ok(ItemProperties {
        request_id: request.request_id.clone(),
        target: ItemPropertiesTarget::Local {
            path: path.to_string_lossy().into_owned(),
        },
        display_path: path.to_string_lossy().into_owned(),
        actual_path: actual_path.to_string_lossy().into_owned(),
        parent_path: actual_path
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned()),
        name: actual_path
            .file_name()
            .and_then(|value| value.to_str())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| actual_path.to_string_lossy().into_owned()),
        extension: (!is_dir)
            .then(|| extension_with_dot(&actual_path))
            .flatten(),
        kind: if is_dir {
            EntryKind::Directory
        } else {
            EntryKind::File
        },
        size_bytes: (!is_dir).then_some(metadata.len()),
        allocated_bytes: None,
        created_at,
        modified_at,
        accessed_at,
        is_hidden: is_hidden(&actual_path, Some(&metadata)),
        is_read_only: metadata.permissions().readonly(),
        is_symlink: is_symlink(&metadata),
        directory_size_state,
        field_states,
        error_message: None,
    })
}

pub fn get_tree_children(path: &Path) -> Result<Vec<TreeNode>> {
    let canonical = if path.exists() {
        path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
    } else {
        path.to_path_buf()
    };

    let mut children = Vec::new();
    for entry in fs::read_dir(&canonical)
        .with_context(|| format!("failed to read tree for {}", canonical.display()))?
    {
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
            has_children,
            is_hidden: is_hidden(&child_path, Some(&metadata)),
            is_system: is_system(Some(&metadata)),
            is_protected_operating_system: is_protected_operating_system(Some(&metadata)),
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
            _ => format!("{stem} ({index})"),
        };
        let candidate = parent.join(file_name);
        if !candidate.exists() {
            return candidate;
        }
    }

    unreachable!("conflict index iteration is unbounded")
}

pub fn copy_recursively(source: &Path, destination: &Path) -> Result<PathBuf> {
    let metadata = fs::symlink_metadata(source)
        .with_context(|| format!("failed to stat {}", source.display()))?;
    let destination = available_conflict_path(destination);

    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::create_dir_all(&destination)
            .with_context(|| format!("failed to create directory {}", destination.display()))?;
        for entry in
            fs::read_dir(source).with_context(|| format!("failed to read {}", source.display()))?
        {
            let entry = entry.context("failed to read recursive directory entry")?;
            let child_source = entry.path();
            let child_destination = destination.join(entry.file_name());
            copy_recursively(&child_source, &child_destination)?;
        }
    } else {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
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
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE,
        SHFILEOPSTRUCTW,
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
        lpszProgressTitle: windows::core::PCWSTR::null(),
    };

    let result = unsafe { SHFileOperationW(&mut operation) };
    if result != 0 {
        bail!(
            "failed to move {} to recycle bin: shell error {}",
            path.display(),
            result
        );
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
    fs::create_dir(&directory)
        .with_context(|| format!("failed to create directory {}", directory.display()))?;
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
    if candidate.contains('/')
        || candidate.contains('\\')
        || Path::new(candidate).components().count() != 1
    {
        bail!("entry name must not include path separators");
    }
    if candidate == "." || candidate == ".." {
        bail!("entry name must not be . or ..");
    }
    Ok(())
}

fn remove_path(path: &Path) -> Result<()> {
    let metadata =
        fs::symlink_metadata(path).with_context(|| format!("failed to stat {}", path.display()))?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(path)
            .with_context(|| format!("failed to delete directory {}", path.display()))?;
    } else {
        fs::remove_file(path)
            .with_context(|| format!("failed to delete file {}", path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{
        apply_color_rules, available_conflict_path, copy_recursively, create_file,
        drive_infos_from_mask, get_item_properties, get_tree_children, is_hidden,
        is_protected_operating_system, is_system, list_directory, move_entry, readable_drive_infos,
        rename_entry, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_SYSTEM,
    };
    use crate::domain::color_filter::ColorRuleTarget;
    use crate::domain::models::{
        ColorRule, DirectorySizeAvailability, DriveInfo, EntryKind, ItemPropertiesRequest,
        ItemPropertiesTarget, ItemPropertyField, ItemPropertyFieldAvailability,
    };
    use crate::services::color_filter::compile_rules;
    use chrono::Utc;

    fn unique_temp_path(label: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time went backwards")
            .as_nanos();
        std::env::temp_dir().join(format!("athenaeum-{label}-{unique}"))
    }

    #[cfg(windows)]
    fn set_windows_file_attributes(path: &std::path::Path, attributes: u32) {
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            core::PCWSTR,
            Win32::Storage::FileSystem::{SetFileAttributesW, FILE_FLAGS_AND_ATTRIBUTES},
        };

        let wide_path = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        unsafe {
            SetFileAttributesW(
                PCWSTR(wide_path.as_ptr()),
                FILE_FLAGS_AND_ATTRIBUTES(attributes),
            )
            .expect("set Windows file attributes");
        }
    }

    #[test]
    fn applies_extension_rule() {
        let rule = ColorRule {
            schema_version: 2,
            id: "rule-1".into(),
            name: "Rust".into(),
            enabled: true,
            target: ColorRuleTarget::File,
            expression: "Extension == \".rs\"".into(),
            case_sensitive: false,
            foreground_color_hex: Some("#ff6600".into()),
            background_color_hex: None,
            priority: 1,
            migration_diagnostic: None,
            migration_source: None,
        };

        let path = std::path::Path::new("main.rs");
        let metadata = fs::metadata(path).unwrap_or_else(|_| {
            let temp = unique_temp_path("color-rule.rs");
            fs::write(&temp, "fn main() {}").expect("write temp file");
            let metadata = fs::metadata(&temp).expect("read temp metadata");
            let _ = fs::remove_file(temp);
            metadata
        });
        let compiled = compile_rules(&[rule], Utc::now());
        let color = apply_color_rules(path, &metadata, &compiled);

        assert_eq!(
            color
                .and_then(|style| style.foreground_color_hex)
                .as_deref(),
            Some("#ff6600")
        );
    }

    #[test]
    fn list_directory_sorts_directories_first_and_applies_tags() {
        let root = unique_temp_path("listing");
        let workspace = root.join("workspace");
        fs::create_dir_all(workspace.join("folder")).expect("create folder");
        fs::write(workspace.join("main.rs"), "fn main() {}").expect("write file");

        let listing = list_directory(&workspace, &[], |path| {
            if path.ends_with("main.rs") {
                (vec!["Pinned".into()], Some("Reviewed".into()))
            } else {
                (Vec::new(), None)
            }
        })
        .expect("list directory");

        assert_eq!(listing.entries.len(), 2);
        assert_eq!(listing.entries[0].kind, EntryKind::Directory);
        assert!(!listing.entries[0].is_system);
        assert!(!listing.entries[0].is_protected_operating_system);
        assert_eq!(
            listing.entries[1].decoration.tags,
            vec!["Pinned".to_string()]
        );
        assert_eq!(listing.entries[1].comment, Some("Reviewed".to_string()));
        assert!(!listing.entries[1].is_system);
        assert!(!listing.entries[1].is_protected_operating_system);

        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn protected_operating_system_requires_windows_hidden_and_system_attributes() {
        const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
        let root = unique_temp_path("protected-attributes");
        fs::create_dir_all(&root).expect("create root");
        let file = root.join(".config");
        fs::write(&file, "system only").expect("write file");

        set_windows_file_attributes(&file, FILE_ATTRIBUTE_SYSTEM);
        let metadata = fs::symlink_metadata(&file).expect("read system metadata");
        assert!(!is_hidden(&file, Some(&metadata)));
        assert!(is_system(Some(&metadata)));
        assert!(!is_protected_operating_system(Some(&metadata)));

        set_windows_file_attributes(&file, FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM);
        let metadata = fs::symlink_metadata(&file).expect("read protected metadata");
        assert!(is_protected_operating_system(Some(&metadata)));

        set_windows_file_attributes(&file, FILE_ATTRIBUTE_NORMAL);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn windows_dot_prefixed_directory_is_visible_without_hidden_attribute() {
        let root = unique_temp_path("dot-directory");
        let dot_directory = root.join(".temp");
        fs::create_dir_all(&dot_directory).expect("create dot directory");

        let listing = list_directory(&root, &[], |_| (Vec::new(), None)).expect("list directory");
        let entry = listing
            .entries
            .iter()
            .find(|entry| entry.name == ".temp")
            .expect("dot directory entry");

        assert!(!entry.is_hidden);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn get_tree_children_marks_regular_directories_as_not_system_or_protected() {
        let root = unique_temp_path("tree-visibility");
        fs::create_dir_all(root.join("child")).expect("create child directory");

        let children = get_tree_children(&root).expect("read tree children");

        assert_eq!(children.len(), 1);
        assert_eq!(children[0].name, "child");
        assert!(!children[0].is_hidden);
        assert!(!children[0].is_system);
        assert!(!children[0].is_protected_operating_system);

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
    fn get_item_properties_returns_local_file_metadata() {
        let root = unique_temp_path("item-properties-file");
        fs::create_dir_all(&root).expect("create root");
        let file = root.join("notes.txt");
        fs::write(&file, "hello").expect("write file");
        let request = ItemPropertiesRequest {
            request_id: "properties-1".into(),
            target: ItemPropertiesTarget::Local {
                path: file.to_string_lossy().into_owned(),
            },
            include_directory_size: false,
        };

        let properties = get_item_properties(&request, &file).expect("read properties");

        assert_eq!(properties.request_id, "properties-1");
        assert_eq!(properties.kind, EntryKind::File);
        assert_eq!(properties.name, "notes.txt");
        assert_eq!(properties.extension.as_deref(), Some(".txt"));
        assert_eq!(properties.size_bytes, Some(5));
        assert_eq!(
            properties.directory_size_state.state,
            DirectorySizeAvailability::NotApplicable
        );
        assert!(properties
            .field_states
            .iter()
            .any(|state| state.field == ItemPropertyField::AllocatedBytes
                && state.state == ItemPropertyFieldAvailability::NotAvailable));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn get_item_properties_keeps_directory_size_uncomputed() {
        let root = unique_temp_path("item-properties-directory");
        fs::create_dir_all(root.join("child")).expect("create child directory");
        let request = ItemPropertiesRequest {
            request_id: "properties-2".into(),
            target: ItemPropertiesTarget::Local {
                path: root.to_string_lossy().into_owned(),
            },
            include_directory_size: false,
        };

        let properties = get_item_properties(&request, &root).expect("read properties");

        assert_eq!(properties.kind, EntryKind::Directory);
        assert_eq!(properties.size_bytes, None);
        assert_eq!(
            properties.directory_size_state.state,
            DirectorySizeAvailability::NotComputed
        );
        assert_eq!(properties.directory_size_state.size_bytes, None);
        assert!(properties
            .field_states
            .iter()
            .any(|state| state.field == ItemPropertyField::DirectorySize
                && state.state == ItemPropertyFieldAvailability::NotComputed));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn drive_infos_from_mask_includes_every_logical_drive_bit() {
        let mask = (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5) | (1 << 6);
        let drives = drive_infos_from_mask(mask);

        assert_eq!(
            drives
                .iter()
                .map(|drive| drive.path.as_str())
                .collect::<Vec<_>>(),
            vec!["C:\\", "D:\\", "E:\\", "F:\\", "G:\\"]
        );
    }

    #[test]
    fn readable_drive_infos_filters_unreadable_roots() {
        let drives = vec![
            DriveInfo {
                path: "C:\\".into(),
                label: "C:\\".into(),
            },
            DriveInfo {
                path: "G:\\".into(),
                label: "G:\\".into(),
            },
            DriveInfo {
                path: "Z:\\".into(),
                label: "Z:\\".into(),
            },
        ];

        let readable = readable_drive_infos(drives, |path| path.to_string_lossy() != "G:\\");

        assert_eq!(
            readable
                .iter()
                .map(|drive| drive.path.as_str())
                .collect::<Vec<_>>(),
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

        let copied = copy_recursively(&source.join("file.txt"), &target.join("file.txt"))
            .expect("copy file");

        assert_eq!(
            copied.file_name().and_then(|value| value.to_str()),
            Some("file (1).txt")
        );
        assert_eq!(
            fs::read_to_string(target.join("file.txt")).expect("read existing target"),
            "existing"
        );
        assert_eq!(
            fs::read_to_string(target.join("file (1).txt")).expect("read copied file"),
            "incoming"
        );

        fs::write(source.join("move.txt"), "moved").expect("write move source");
        fs::write(target.join("move.txt"), "existing move").expect("write existing move target");

        let moved =
            move_entry(&source.join("move.txt"), &target.join("move.txt")).expect("move file");

        assert_eq!(
            moved.file_name().and_then(|value| value.to_str()),
            Some("move (1).txt")
        );
        assert_eq!(
            fs::read_to_string(target.join("move.txt")).expect("read existing move target"),
            "existing move"
        );
        assert_eq!(
            fs::read_to_string(target.join("move (1).txt")).expect("read moved file"),
            "moved"
        );
        assert!(!source.join("move.txt").exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn available_conflict_path_handles_extensionless_names() {
        let root = unique_temp_path("extensionless-conflict");
        fs::create_dir_all(&root).expect("create root");
        fs::write(root.join("README"), "existing").expect("write existing extensionless file");

        let candidate = available_conflict_path(&root.join("README"));

        assert_eq!(
            candidate.file_name().and_then(|value| value.to_str()),
            Some("README (1)")
        );

        let _ = fs::remove_dir_all(root);
    }
}

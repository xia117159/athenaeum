use std::{fs, path::Path, sync::atomic::{AtomicBool, Ordering}};
use super::{metadata::{MetadataEntry, MetadataKind}, scan::MetadataSource};

pub(crate) fn local_metadata_kind(metadata: &fs::Metadata) -> MetadataKind {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Directory reparse points include junctions, not just symbolic links.
        if metadata.is_dir() && metadata.file_attributes() & 0x400 != 0 { return MetadataKind::Link; }
    }
    if metadata.file_type().is_symlink() { MetadataKind::Link }
    else if metadata.is_dir() { MetadataKind::Directory }
    else if metadata.is_file() { MetadataKind::File(metadata.len()) }
    else { MetadataKind::Special }
}

pub(crate) struct LocalMetadataSource;
impl MetadataSource for LocalMetadataSource {
    fn read_directory(&mut self, path: &str, cancelled: &AtomicBool, visit: &mut dyn FnMut(MetadataEntry) -> bool) -> Result<(), String> {
        if cancelled.load(Ordering::Relaxed) { return Ok(()); }
        let path = Path::new(path);
        let metadata = fs::symlink_metadata(path).map_err(|_| "无法读取目录元数据".to_owned())?;
        if local_metadata_kind(&metadata) != MetadataKind::Directory { return Err("大小统计不跟随链接，目标必须是普通目录".into()); }
        let entries = fs::read_dir(path).map_err(|_| "无法读取目录（权限不足或目录已移除）".to_owned())?;
        for entry in entries {
            if cancelled.load(Ordering::Relaxed) { break; }
            let fact = match entry {
                Ok(entry) => {
                    let name = entry.file_name().to_str().map(str::to_owned);
                    // DirEntry::metadata does not follow links. On Windows it reuses
                    // enumeration metadata, avoiding another stat for each file.
                    let mut kind = entry.metadata().map(|value| local_metadata_kind(&value)).unwrap_or(MetadataKind::Unknown);
                    let directory_path = if kind == MetadataKind::Directory { entry.path().to_str().map(str::to_owned) } else { None };
                    if name.is_none() || (kind == MetadataKind::Directory && directory_path.is_none()) { kind = MetadataKind::Unknown; }
                    MetadataEntry { name: name.unwrap_or_default(), kind, directory_path }
                }
                Err(_) => MetadataEntry { name: String::new(), kind: MetadataKind::Unknown, directory_path: None },
            };
            if !visit(fact) { break; }
        }
        Ok(())
    }
}

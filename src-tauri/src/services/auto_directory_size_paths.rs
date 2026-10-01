use super::settings_store::SettingsStore;
pub fn normalize(input: &str) -> Option<String> {
    let mut path = input.trim().replace('/', "\\");
    if path.get(..8).is_some_and(|prefix| prefix.eq_ignore_ascii_case("\\\\?\\UNC\\")) { path = format!("\\\\{}", &path[8..]); }
    else if let Some(rest) = path.strip_prefix("\\\\?\\") { path = rest.into(); }
    if path.starts_with("\\\\.\\") { return None; }
    let drive = path.as_bytes().get(1) == Some(&b':') && path.as_bytes().get(2) == Some(&b'\\') && path.as_bytes()[0].is_ascii_alphabetic();
    let unc = path.starts_with("\\\\");
    if !drive && !unc { return None; }
    let rest = if drive { &path[3..] } else { &path[2..] };
    let parts: Vec<_> = rest.split('\\').filter(|part| !part.is_empty()).collect();
    if unc && parts.len() < 2 { return None; }
    if parts.iter().any(|part| matches!(*part, "." | "..") || part.chars().any(|ch| ch.is_control() || "<>\"|?*:".contains(ch))) { return None; }
    let normalized = if drive { format!("{}:\\{}", path[..1].to_ascii_uppercase(), parts.join("\\")) }
        else { format!("\\\\{}", parts.join("\\")) };
    // The limit applies to the saved form, after `\\?\` prefixes and separators are removed.
    (normalized.encode_utf16().count() <= 32_767).then_some(normalized)
}
// Root confirmation lives in the frontend (E4); this copy only proves parity with the shared vectors.
#[cfg(test)]
pub fn is_volume_root(path: &str) -> bool {
    path.len() == 3 && path.as_bytes()[1..] == *b":\\" || path.starts_with("\\\\") && path[2..].split('\\').count() == 2
}
pub fn clean(paths: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    paths.into_iter().filter_map(|path| normalize(&path)).filter(|path| seen.insert(path.to_lowercase())).take(256).collect()
}
/// Caller holds the settings write lock across staging, persistence and publication.
pub fn update(settings: &mut SettingsStore, path: &str, add: bool) -> anyhow::Result<Vec<String>> {
    let path = normalize(path).ok_or_else(|| anyhow::anyhow!("请输入有效的本地或网络文件夹绝对路径"))?;
    let mut staged = settings.clone(); staged.auto_directory_size_paths = clean(staged.auto_directory_size_paths);
    let key = path.to_lowercase();
    if add {
        if !staged.auto_directory_size_paths.iter().any(|saved| saved.to_lowercase() == key) {
            anyhow::ensure!(staged.auto_directory_size_paths.len() < 256, "自动计算目录最多支持 256 项");
            staged.auto_directory_size_paths.push(path);
        }
    } else { staged.auto_directory_size_paths.retain(|saved| saved.to_lowercase() != key); }
    staged.persist_atomically()?;
    *settings = staged;
    Ok(settings.auto_directory_size_paths.clone())
}

#[cfg(test)]
#[path = "auto_directory_size_paths_tests.rs"]
mod tests;

use crate::domain::{directory_sizes::DirectorySizeTarget, models::RemoteProfile};

#[derive(Clone)]
pub(super) struct ScanTarget { pub key: String, pub path: String, pub profile: Option<RemoteProfile> }

pub(super) fn normalize_local_path(path: &str) -> Result<String, String> {
    if path.is_empty() || path.len() > 32768 || path.chars().any(char::is_control) || path.contains("://") {
        return Err("目录统计需要有效的绝对本地路径".into());
    }
    #[cfg(not(windows))]
    if path.starts_with('/') {
        if path.split('/').any(|part| matches!(part, "." | "..")) { return Err("目录路径不能包含点段".into()); }
        return Ok(if path == "/" { path.into() } else { path.trim_end_matches('/').into() });
    }
    let mut normalized = path.replace('/', "\\");
    if normalized.get(..8).is_some_and(|prefix| prefix.eq_ignore_ascii_case("\\\\?\\unc\\")) { normalized = format!("\\\\{}", &normalized[8..]); }
    else if let Some(rest) = normalized.strip_prefix("\\\\?\\") { normalized = rest.into(); }
    if normalized.starts_with("\\\\.\\") || normalized.split('\\').any(|part| matches!(part, "." | "..")) {
        return Err("目录统计不接受设备路径或点段".into());
    }
    let drive = normalized.as_bytes().get(1) == Some(&b':') && normalized.as_bytes().get(2) == Some(&b'\\')
        && normalized.as_bytes()[0].is_ascii_alphabetic();
    let unc = normalized.starts_with("\\\\") && normalized[2..].split('\\').filter(|part| !part.is_empty()).count() >= 2;
    if !drive && !unc { return Err("目录统计需要绝对本地路径".into()); }
    normalized = normalized.trim_end_matches('\\').into();
    if normalized.len() == 2 { normalized.push('\\'); }
    // Only a drive designator is intrinsically case-insensitive. Components can
    // be case-sensitive, and Unicode case folding is not Windows equivalence.
    // Use verbatim I/O paths so even trailing dots/spaces keep their identity.
    if drive {
        normalized.replace_range(..1, &normalized[..1].to_ascii_lowercase());
        Ok(format!("\\\\?\\{normalized}"))
    } else { Ok(format!("\\\\?\\UNC\\{}", &normalized[2..])) }
}
pub(super) fn normalize_target(target: &DirectorySizeTarget, profile: Option<RemoteProfile>, revision: u64) -> Result<ScanTarget, String> {
    match target {
        DirectorySizeTarget::Local { path } => {
            let path = normalize_local_path(path)?;
            Ok(ScanTarget { key: format!("local:{path}"), path, profile: None })
        }
        DirectorySizeTarget::Remote { profile_id, path } => {
            let profile = profile.filter(|profile| &profile.id == profile_id).ok_or_else(|| "远程连接已不存在或发生变化".to_string())?;
            let path = crate::services::remote_service::size_metadata::validated_path(&profile, path)?;
            Ok(ScanTarget { key: format!("remote:{}:{}:{revision}:{path}", profile_id.len(), profile_id), path, profile: Some(profile) })
        }
    }
}
pub(super) fn lookup_path(target: &ScanTarget, path: &str) -> Result<String, String> {
    let (path, separator) = match &target.profile {
        Some(profile) => (crate::services::remote_service::size_metadata::validated_path(profile, path)?, '/'),
        None => (normalize_local_path(path)?, if cfg!(windows) || !path.starts_with('/') { '\\' } else { '/' }),
    };
    let prefix = format!("{}{separator}", target.path.trim_end_matches(separator));
    if path != target.path && !path.starts_with(&prefix) { return Err("查询目录超出本次统计根路径".into()); }
    Ok(path)
}

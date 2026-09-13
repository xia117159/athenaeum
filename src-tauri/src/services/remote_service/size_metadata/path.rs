use crate::domain::models::RemoteProfile;

fn normalize(path: &str) -> Result<String, String> {
    if path.len() > 32768 || !path.starts_with('/') { return Err("远程统计需要有效的绝对目录路径".into()); }
    super::super::validate_remote_path(path).map_err(|_| "远程统计路径包含无效路径段".to_string())?;
    let parts = path.replace('\\', "/").split('/').filter(|part| !part.is_empty()).map(str::to_owned).collect::<Vec<_>>();
    Ok(format!("/{}", parts.join("/")))
}

pub(super) fn validated_path(profile: &RemoteProfile, path: &str) -> Result<String, String> {
    super::super::validate_profile(profile).map_err(|_| "远程连接配置不可用".to_string())?;
    let path = normalize(path)?;
    let root = normalize(&profile.root_path)?;
    if root != "/" && path != root && !path.starts_with(&format!("{root}/")) {
        return Err("远程统计目录超出连接根路径".into());
    }
    Ok(path)
}

/// Parsed server names are not user input: never trim their whitespace before
/// encoding. Keep curl's existing login-relative directory URL semantics.
pub(super) fn metadata_url(profile: &RemoteProfile, path: &str) -> Result<String, String> {
    let path = validated_path(profile, path)?;
    let suffix = path.trim_start_matches('/').split('/').filter(|part| !part.is_empty())
        .map(super::super::remote_path::percent_encode_path_segment).collect::<Vec<_>>().join("/");
    Ok(format!("ftp://{}:{}/{}{}", profile.host, profile.port, suffix, if suffix.is_empty() { "" } else { "/" }))
}

use super::arguments::parse_arguments;
use crate::domain::models::FileAssociationRule;
use anyhow::{bail, Result};
use std::collections::HashSet;

pub fn parse_extensions(patterns: &str) -> Result<Vec<String>> {
    let mut seen = HashSet::new();
    let mut extensions = Vec::new();
    for token in patterns
        .split(';')
        .map(str::trim)
        .filter(|token| !token.is_empty())
    {
        let extension = token
            .strip_prefix("*.")
            .or_else(|| token.strip_prefix('.'))
            .unwrap_or(token);
        if extension.is_empty()
            || extension
                .chars()
                .any(|ch| ch.is_whitespace() || ch.is_control() || "*?/\\:<>|\"".contains(ch))
            || extension.split('.').any(str::is_empty)
        {
            bail!("后缀格式无效：{token}，请使用 *.md、.md 或 md");
        }
        let extension = extension.to_lowercase();
        if seen.insert(extension.clone()) {
            extensions.push(extension);
        }
    }
    Ok(extensions)
}

pub fn matches(rule: &FileAssociationRule, path: &str) -> bool {
    if rule.executable_path.trim().is_empty() || validate_rule(rule).is_err() {
        return false;
    }
    let name = path.rsplit(['/', '\\']).next().unwrap_or("").to_lowercase();
    parse_extensions(&rule.patterns)
        .unwrap_or_default()
        .iter()
        .any(|extension| name.ends_with(&format!(".{extension}")))
}

pub fn executable_path(path: &str) -> &str {
    let path = path.trim();
    path.strip_prefix('"')
        .and_then(|path| path.strip_suffix('"'))
        .unwrap_or(path)
}

pub fn validate_rule(rule: &FileAssociationRule) -> Result<()> {
    parse_extensions(&rule.patterns)?;
    if executable_path(&rule.executable_path)
        .chars()
        .any(|ch| ch.is_control() || "<>|?*\"".contains(ch))
    {
        bail!("程序路径含有无效字符");
    }
    parse_arguments(&rule.arguments_template)?;
    Ok(())
}

pub fn normalize_rules(rules: Vec<FileAssociationRule>) -> Result<Vec<FileAssociationRule>> {
    let mut ids = HashSet::new();
    rules
        .into_iter()
        .enumerate()
        .map(|(index, mut rule)| {
            if rule.id.trim().is_empty() || !ids.insert(rule.id.clone()) {
                bail!("第 {} 条关联标识重复或为空", index + 1);
            }
            rule.patterns = rule
                .patterns
                .split(';')
                .map(str::trim)
                .filter(|token| !token.is_empty())
                .collect::<Vec<_>>()
                .join(";");
            rule.executable_path = executable_path(&rule.executable_path).to_string();
            validate_rule(&rule)
                .map_err(|error| anyhow::anyhow!("第 {} 条关联：{error}", index + 1))?;
            Ok(rule)
        })
        .collect()
}

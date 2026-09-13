use super::native::{self, EntrySnapshot};
use crate::domain::{
    batch_rename::{BatchRenameRow, BatchRenameRowStatus},
    rename_expression::Diagnostic,
};
use std::{collections::HashMap, path::PathBuf};

#[derive(Debug, Clone)]
pub struct PlannedEntry {
    pub snapshot: EntrySnapshot,
    pub target_name: String,
    pub final_path: PathBuf,
}
#[derive(Debug, Clone)]
pub struct RenamePlan {
    pub items: Vec<PlannedEntry>,
}

pub fn validate_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() || matches!(name, "." | "..") {
        return Err("新名称不能为空或为 .、..".into());
    }
    if name.ends_with(['.', ' ']) {
        return Err("Windows 名称不能以点或空格结尾".into());
    }
    if name
        .chars()
        .any(|ch| ch < '\u{20}' || r#"<>:"/\|?*"#.contains(ch))
    {
        return Err(r#"名称不能包含控制字符或 < > : " / \ | ? *"#.into());
    }
    if name.encode_utf16().count() > 255 {
        return Err("名称超过 Windows 的 255 个 UTF-16 字符限制".into());
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim_end()
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    }) {
        return Err("此名称由 Windows 设备保留".into());
    }
    Ok(())
}
pub fn initial_rows(sources: &[EntrySnapshot]) -> Vec<BatchRenameRow> {
    sources
        .iter()
        .enumerate()
        .map(|(index, source)| {
            let path = source.path.to_string_lossy().into_owned();
            let name = native::name_of(&source.path).unwrap_or_default().to_owned();
            BatchRenameRow {
                id: index.to_string(),
                source_path: path.clone(),
                parent_path: source.path.parent().unwrap().to_string_lossy().into_owned(),
                old_name: name.clone(),
                new_name: Some(name),
                target_path: Some(path),
                is_directory: source.is_directory,
                status: BatchRenameRowStatus::Unchanged,
                diagnostic: None,
            }
        })
        .collect()
}
fn mark_error(row: &mut BatchRenameRow, message: impl Into<String>) {
    row.status = BatchRenameRowStatus::Error;
    if row.diagnostic.is_none() {
        row.diagnostic = Some(Diagnostic {
            message: message.into(),
            start: 0,
            end: 0,
        });
    }
}

#[cfg(test)]
pub fn plan_names(
    sources: &[EntrySnapshot],
    names: Vec<Result<String, Diagnostic>>,
) -> (Vec<BatchRenameRow>, Option<RenamePlan>) {
    plan_names_cancelable(sources, names, &|| false)
}
pub fn plan_names_cancelable(
    sources: &[EntrySnapshot],
    names: Vec<Result<String, Diagnostic>>,
    cancelled: &dyn Fn() -> bool,
) -> (Vec<BatchRenameRow>, Option<RenamePlan>) {
    let mut rows = initial_rows(sources);
    if names.len() != sources.len() {
        for row in &mut rows {
            mark_error(row, "预览项目数与选择不一致");
        }
        return (rows, None);
    }
    let mut groups: HashMap<&native::FileIdentity, Vec<usize>> = HashMap::new();
    for (index, name) in names.into_iter().enumerate() {
        if cancelled() {
            return (rows, None);
        }
        let row = &mut rows[index];
        row.target_path = None;
        match name {
            Ok(name) => {
                row.status = if name == row.old_name {
                    BatchRenameRowStatus::Unchanged
                } else {
                    BatchRenameRowStatus::Changed
                };
                if let Err(error) = validate_name(&name) {
                    mark_error(row, error);
                }
                row.new_name = Some(name);
            }
            Err(error) => {
                row.new_name = None;
                row.status = BatchRenameRowStatus::Error;
                row.diagnostic = Some(error);
            }
        }
        if let Err(error) = native::validate_snapshot(&sources[index], true) {
            mark_error(row, error.to_string());
        }
        groups
            .entry(&sources[index].parent_identity)
            .or_default()
            .push(index);
    }
    for indices in groups.values() {
        if cancelled() {
            return (rows, None);
        }
        let mut originals = indices.clone();
        originals.sort_by(|a, b| native::compare_names(&rows[*a].old_name, &rows[*b].old_name));
        for pair in originals.windows(2) {
            if native::same_name(&rows[pair[0]].old_name, &rows[pair[1]].old_name) {
                mark_error(&mut rows[pair[0]], "重复选择了同一个目录项");
                mark_error(&mut rows[pair[1]], "重复选择了同一个目录项");
            }
        }
        let mut targets = indices
            .iter()
            .copied()
            .filter(|index| rows[*index].new_name.is_some())
            .collect::<Vec<_>>();
        targets.sort_by(|a, b| {
            native::compare_names(
                rows[*a].new_name.as_deref().unwrap(),
                rows[*b].new_name.as_deref().unwrap(),
            )
        });
        for pair in targets.windows(2) {
            if native::same_name(
                rows[pair[0]].new_name.as_deref().unwrap(),
                rows[pair[1]].new_name.as_deref().unwrap(),
            ) {
                mark_error(&mut rows[pair[0]], "多个项目使用了相同的目标名称");
                mark_error(&mut rows[pair[1]], "多个项目使用了相同的目标名称");
            }
        }
        for index in indices {
            if cancelled() {
                return (rows, None);
            }
            if rows[*index].status == BatchRenameRowStatus::Error {
                continue;
            }
            let new_name = rows[*index].new_name.as_deref().unwrap();
            let target = sources[*index].path.parent().unwrap().join(new_name);
            match std::fs::symlink_metadata(&target) {
                Ok(_) => {
                    let occupying = originals
                        .binary_search_by(|other| {
                            native::compare_names(&rows[*other].old_name, new_name)
                        })
                        .ok()
                        .map(|position| originals[position]);
                    let vacated = occupying.is_some_and(|other| {
                        other == *index
                            || (rows[other].status == BatchRenameRowStatus::Changed
                                && rows[other].new_name.as_ref() != Some(&rows[other].old_name))
                    });
                    if !vacated {
                        mark_error(&mut rows[*index], "目标名称已被其他项目占用");
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => mark_error(&mut rows[*index], format!("无法检查目标：{error}")),
            }
        }
    }
    let mut order = (0..sources.len()).collect::<Vec<_>>();
    order.sort_by_key(|index| sources[*index].path.components().count());
    let mut directories: HashMap<PathBuf, PathBuf> = HashMap::new();
    for index in order {
        if rows[index].status == BatchRenameRowStatus::Error {
            continue;
        }
        let source = &sources[index];
        let parent = source.path.parent().unwrap();
        let projected_parent = parent
            .ancestors()
            .find_map(|ancestor| {
                directories
                    .get(ancestor)
                    .map(|target| native::rewrite_descendant(parent, ancestor, target))
            })
            .unwrap_or_else(|| parent.to_path_buf());
        let target = projected_parent.join(rows[index].new_name.as_deref().unwrap());
        if target.to_string_lossy().encode_utf16().count() > 32760 {
            mark_error(&mut rows[index], "目标路径超过 Windows 长路径限制");
            continue;
        }
        if source.is_directory {
            directories.insert(source.path.clone(), target.clone());
        }
        rows[index].target_path = Some(target.to_string_lossy().into_owned());
    }
    let has_error = rows
        .iter()
        .any(|row| row.status == BatchRenameRowStatus::Error);
    let changed = rows
        .iter()
        .any(|row| row.status == BatchRenameRowStatus::Changed);
    let plan = (!has_error && changed).then(|| RenamePlan {
        items: sources
            .iter()
            .zip(&rows)
            .map(|(source, row)| PlannedEntry {
                snapshot: source.clone(),
                target_name: row.new_name.clone().unwrap(),
                final_path: PathBuf::from(row.target_path.as_ref().unwrap()),
            })
            .collect(),
    });
    (rows, plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_names_reject_devices_invalid_characters_and_utf16_overflow() {
        for name in [
            "",
            ".",
            "..",
            "con.txt",
            "COM¹.log",
            "aux ",
            "NUL",
            "x/y",
            "x\\y",
            "a.",
            "a ",
            "a?",
            "a:b",
            "x\u{0001}",
        ] {
            assert!(validate_name(name).is_err(), "{name:?}");
        }
        assert!(validate_name(&"😀".repeat(128)).is_err());
        assert!(validate_name("New-正常.txt").is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn planning_supports_cycles_and_projects_descendants_without_mutating_files() {
        let root = std::env::temp_dir().join(format!("athenaeum-plan-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("A")).unwrap();
        std::fs::write(root.join("a.txt"), "a").unwrap();
        std::fs::write(root.join("b.txt"), "b").unwrap();
        std::fs::write(root.join("A/Test.txt"), "child").unwrap();
        let sources = ["a.txt", "b.txt", "A", "A/Test.txt"]
            .iter()
            .map(|path| native::snapshot(&root.join(path)).unwrap())
            .collect::<Vec<_>>();
        let (rows, plan) = plan_names(
            &sources,
            ["b.txt", "a.txt", "Renamed", "New.txt"]
                .iter()
                .map(|name| Ok((*name).to_owned()))
                .collect(),
        );
        assert!(plan.is_some(), "{rows:?}");
        assert_eq!(
            rows[3].target_path.as_deref(),
            Some(root.join("Renamed").join("New.txt").to_str().unwrap())
        );
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "a");
        assert!(root.join("A/Test.txt").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn conflicts_unchanged_occupants_and_replaced_sources_disable_the_whole_plan() {
        let root = std::env::temp_dir().join(format!("athenaeum-plan-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        for name in ["a.txt", "b.txt", "external.txt"] {
            std::fs::write(root.join(name), name).unwrap();
        }
        let sources = ["a.txt", "b.txt"]
            .iter()
            .map(|path| native::snapshot(&root.join(path)).unwrap())
            .collect::<Vec<_>>();
        for names in [
            ["same.txt", "SAME.TXT"],
            ["b.txt", "b.txt"],
            ["external.txt", "new.txt"],
        ] {
            let (rows, plan) = plan_names(
                &sources,
                names.iter().map(|name| Ok((*name).into())).collect(),
            );
            assert!(plan.is_none());
            assert!(
                rows.iter()
                    .any(|row| row.status == BatchRenameRowStatus::Error),
                "{names:?}"
            );
        }
        let (rows, plan) = plan_names(&sources, vec![Ok("a.txt".into()), Ok("b.txt".into())]);
        assert!(plan.is_none());
        assert!(rows
            .iter()
            .all(|row| row.status == BatchRenameRowStatus::Unchanged));
        std::fs::rename(root.join("a.txt"), root.join("old.txt")).unwrap();
        std::fs::write(root.join("a.txt"), "replacement").unwrap();
        let (rows, plan) = plan_names(
            &sources,
            vec![Ok("new-a.txt".into()), Ok("new-b.txt".into())],
        );
        assert!(plan.is_none());
        assert_eq!(rows[0].status, BatchRenameRowStatus::Error);
        std::fs::remove_dir_all(root).unwrap();
    }
}

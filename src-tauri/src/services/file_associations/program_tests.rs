use super::programs::{program_command, ProgramInfoCache};
use std::{fs, path::PathBuf};

#[test]
fn file_associations_program_cache_refreshes_existence_and_unicode_fallback() {
    let root = std::env::temp_dir().join(format!("sfm-program-info-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let path = root.join("中文 编辑器.exe");
    let path_text = path.to_string_lossy().to_string();
    let cache = ProgramInfoCache::default();
    let info = cache.inspect(&[path_text.clone()]);
    assert_eq!(info.len(), 1);
    assert!(!info[0].exists);
    assert_eq!(info[0].display_name, "中文 编辑器.exe");
    fs::write(&path, "no version resource").unwrap();
    assert!(cache.inspect(&[path_text.clone()])[0].exists);
    fs::remove_file(&path).unwrap();
    assert!(!cache.inspect(&[path_text])[0].exists);
    fs::remove_dir(root).unwrap();
}

#[test]
fn file_associations_argv_child_probe() {
    if let Some(output) = std::env::var_os("SFM_ASSOCIATION_ARGV_PROBE") {
        let args: Vec<String> = std::env::args().skip(5).collect();
        fs::write(output, serde_json::to_vec(&args).unwrap()).unwrap();
    }
}

#[cfg(windows)]
#[test]
fn file_associations_native_launch_preserves_actual_argv_and_rejects_batch_files() {
    let root = std::env::temp_dir().join(format!("sfm-launch-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let result_path = root.join("argv.json");
    let supplied = vec![
        r"C:\中文 目录\file.txt".to_string(),
        String::new(),
        r#"a"b\"#.to_string(),
        "--file=C:\\space dir\\file.md".into(),
    ];
    let mut args = vec![
        "--exact".into(),
        "services::file_associations::program_tests::file_associations_argv_child_probe".into(),
        "--nocapture".into(),
        "--".into(),
    ];
    args.extend(supplied.clone());
    let exe = std::env::current_exe().unwrap();
    let mut command = program_command(exe.to_str().unwrap(), &args).unwrap();
    command.env("SFM_ASSOCIATION_ARGV_PROBE", &result_path);
    assert!(command.status().unwrap().success());
    let captured: Vec<String> = serde_json::from_slice(&fs::read(&result_path).unwrap()).unwrap();
    assert_eq!(captured, supplied);
    let batch = root.join("unsafe.BaT");
    fs::write(&batch, "@echo off").unwrap();
    assert!(program_command(batch.to_str().unwrap(), &[])
        .unwrap_err()
        .to_string()
        .contains("批处理"));
    assert!(
        program_command(&format!("{}.", batch.display()), &[]).is_err(),
        "Win32 terminal-dot aliases cannot bypass the batch restriction"
    );
    assert!(program_command(&format!("{} ", batch.display()), &[]).is_err());
    assert!(program_command(root.join("missing.exe").to_str().unwrap(), &[]).is_err());
    assert!(program_command("relative.exe", &[]).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[test]
fn file_associations_native_version_resource_is_readable_without_a_shell() {
    let path = PathBuf::from(std::env::var_os("WINDIR").unwrap())
        .join("System32")
        .join("kernel32.dll");
    let description =
        super::programs::file_description(&path).expect("system DLL has a version description");
    assert!(!description.trim().is_empty());
    assert!(!description.contains('\u{fffd}'));
}

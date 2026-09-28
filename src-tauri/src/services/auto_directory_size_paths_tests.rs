use super::*;

#[test]
fn auto_size_paths_shared_normalization_vectors() {
    let fixtures: Vec<serde_json::Value> = serde_json::from_str(include_str!("../../tests/fixtures/auto_directory_size_paths.json")).unwrap();
    for fixture in fixtures {
        let normalized = normalize(fixture["input"].as_str().unwrap());
        assert_eq!(normalized.as_deref(), fixture["normalized"].as_str(), "{}", fixture["input"]);
        assert_eq!(normalized.as_deref().is_some_and(is_volume_root), fixture["volumeRoot"].as_bool().unwrap());
    }
    assert!(normalize(&format!("C:\\{}", "😀".repeat(16383))).is_none());
}

#[test]
fn auto_size_paths_length_limit_applies_to_the_normalized_path() {
    let longest = format!("C:\\{}", "a".repeat(32_764));
    assert_eq!(normalize(&longest).as_deref(), Some(longest.as_str()));
    assert_eq!(normalize(&format!("\\\\?\\{longest}")).as_deref(), Some(longest.as_str()));
    assert_eq!(normalize(&format!("{longest}\\\\\\")).as_deref(), Some(longest.as_str()));
    assert!(normalize(&format!("{longest}a")).is_none());
}

#[test]
fn auto_size_paths_defaults_load_cleaning_and_limit() {
    assert!(SettingsStore::default().auto_directory_size_paths.is_empty());
    assert_eq!(clean(vec![" c:/A/ ".into(), "C:\\a".into(), "relative".into()]), ["C:\\A"]);
    assert_eq!(clean((0..300).map(|n| format!("C:\\{n}")).collect()).len(), 256);
}

#[test]
fn auto_size_paths_locked_updates_merge_and_persist_without_overwriting_other_settings() {
    let directory = std::env::temp_dir().join(format!("sfm-auto-size-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap(); let file = directory.join("settings.json");
    let mut store = SettingsStore::load_from(file.clone()).unwrap(); store.template_root = "templates".into();
    assert_eq!(update(&mut store, "c:/A", true).unwrap(), ["C:\\A"]);
    assert_eq!(update(&mut store, "C:\\B", true).unwrap(), ["C:\\A", "C:\\B"]);
    assert_eq!(update(&mut store, "c:/a/", true).unwrap(), ["C:\\A", "C:\\B"]);
    assert_eq!(update(&mut store, "c:/a/", false).unwrap(), ["C:\\B"]);
    let reloaded = SettingsStore::load_from(file.clone()).unwrap();
    assert_eq!(reloaded.auto_directory_size_paths, ["C:\\B"]); assert_eq!(reloaded.template_root, "templates");
    assert!(update(&mut store, "relative", true).is_err());
    store.auto_directory_size_paths = (0..256).map(|n| format!("C:\\{n}")).collect();
    assert!(update(&mut store, "C:\\extra", true).is_err());
    std::fs::remove_dir_all(directory).unwrap();
}

use super::commit_model_metadata;
use crate::domain::models::FileAssociationRule;
use crate::services::{metadata_store::MetadataStore, settings_store::SettingsStore};
use serde_json::{json, Value};

#[test]
fn file_associations_persisted_legacy_shape_survives_round_trip_and_snapshot() {
    let rules = json!([{"id":"saved-id","patterns":"*.md;.json;txt",
        "executablePath":r"D:\Program Files\中文编辑器.exe","argumentsTemplate":"--new-window {file}"},
        {"id":"empty","patterns":"","executablePath":"","argumentsTemplate":""}]);
    let store: MetadataStore = serde_json::from_value(json!({"fileAssociations":rules})).unwrap();
    let restored = serde_json::to_value(&store).unwrap();
    assert_eq!(restored["fileAssociations"], rules);
    let settings = SettingsStore::default();
    let snapshot = store.to_settings_snapshot(
        settings.layout,
        settings.detail_columns,
        settings.navigation_columns,
        settings.details_row_height,
        settings.size_bar_mode,
        settings.folder_expansion_enabled,
        settings.tooltip_hover_delay_ms,
        settings.metadata_retention_hours,
        settings.file_visibility,
        settings.context_menu,
        settings.theme,
    );
    assert_eq!(
        serde_json::to_value(snapshot).unwrap()["fileAssociations"],
        rules
    );
    let older: MetadataStore = serde_json::from_value(json!({})).unwrap();
    let older: Value = serde_json::to_value(older).unwrap();
    assert_eq!(older["fileAssociations"], json!([]));
}

#[test]
fn file_associations_commit_only_after_successful_disk_write() {
    let root =
        std::env::temp_dir().join(format!("sfm-association-settings-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let mut store = MetadataStore::default();
    store.attach_path(root.join("metadata.json"));
    let rules = vec![FileAssociationRule {
        id: "stable".into(),
        patterns: " .md ; txt; ".into(),
        executable_path: r" C:\Missing Editor\editor.exe ".into(),
        arguments_template: "--new-window {file}".into(),
    }];
    commit_model_metadata(&mut store, Vec::new(), Some(rules)).unwrap();
    assert_eq!(store.file_associations[0].patterns, ".md;txt");
    let reloaded = MetadataStore::load_from(root.join("metadata.json")).unwrap();
    assert_eq!(reloaded.file_associations, store.file_associations);
    commit_model_metadata(&mut store, Vec::new(), None).unwrap();
    assert_eq!(
        store.file_associations[0].id, "stable",
        "older model updates preserve rules"
    );
    let before = serde_json::to_value(&store).unwrap();
    std::fs::write(root.join("blocked"), "not a directory").unwrap();
    store.attach_path(root.join("blocked").join("metadata.json"));
    assert!(commit_model_metadata(&mut store, Vec::new(), Some(Vec::new())).is_err());
    assert_eq!(serde_json::to_value(&store).unwrap(), before);
    std::fs::remove_dir_all(root).unwrap();
}

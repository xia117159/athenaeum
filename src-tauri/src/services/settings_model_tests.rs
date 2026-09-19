use super::*;
use crate::domain::models::FileAssociationRule;
use std::fs;

#[test]
fn folder_row_click_defaults_and_settings_round_trip() {
    let root = std::env::temp_dir().join(format!("sfm-row-click-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let mut metadata = MetadataStore::default();
    metadata.attach_path(root.join("metadata.json"));
    let path = root.join("settings.json");
    let mut settings = SettingsStore::load_from(path.clone()).unwrap();
    let mut legacy = serde_json::to_value(&settings).unwrap();
    legacy.as_object_mut().unwrap().remove("folderExpansionOnRowClick");
    let defaulted: SettingsStore = serde_json::from_value(legacy).unwrap();
    assert_eq!(serde_json::to_value(defaulted).unwrap()["folderExpansionOnRowClick"], false);
    let mut request = serde_json::to_value(update(&settings, None)).unwrap();
    request.as_object_mut().unwrap().remove("folderExpansionOnRowClick");
    let defaulted: SettingsModelUpdate = serde_json::from_value(request).unwrap();
    assert_eq!(serde_json::to_value(defaulted).unwrap()["folderExpansionOnRowClick"], false);
    for master in [false, true] {
        for enabled in [true, false] {
            let mut request = serde_json::to_value(update(&settings, None)).unwrap();
            request["folderExpansionEnabled"] = serde_json::json!(master);
            request["folderExpansionOnRowClick"] = serde_json::json!(enabled);
            commit_model(&mut metadata, &mut settings, serde_json::from_value(request).unwrap()).unwrap();
            let reloaded = SettingsStore::load_from(path.clone()).unwrap();
            assert_eq!(serde_json::to_value(reloaded).unwrap()["folderExpansionOnRowClick"], enabled);
        }
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn tree_auto_follow_defaults_and_settings_round_trip() {
    let root = std::env::temp_dir().join(format!("sfm-tree-follow-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let mut metadata = MetadataStore::default();
    metadata.attach_path(root.join("metadata.json"));
    let path = root.join("settings.json");
    let mut settings = SettingsStore::load_from(path.clone()).unwrap();
    let mut legacy = serde_json::to_value(&settings).unwrap();
    legacy.as_object_mut().unwrap().remove("treeAutoFollowEnabled");
    let defaulted: SettingsStore = serde_json::from_value(legacy).unwrap();
    assert_eq!(serde_json::to_value(defaulted).unwrap()["treeAutoFollowEnabled"], false);
    let mut request = serde_json::to_value(update(&settings, None)).unwrap();
    request.as_object_mut().unwrap().remove("treeAutoFollowEnabled");
    let defaulted: SettingsModelUpdate = serde_json::from_value(request).unwrap();
    assert_eq!(serde_json::to_value(defaulted).unwrap()["treeAutoFollowEnabled"], false);
    for enabled in [true, false] {
        let mut request = serde_json::to_value(update(&settings, None)).unwrap();
        request["treeAutoFollowEnabled"] = serde_json::json!(enabled);
        commit_model(&mut metadata, &mut settings, serde_json::from_value(request).unwrap()).unwrap();
        let reloaded = SettingsStore::load_from(path.clone()).unwrap();
        assert_eq!(serde_json::to_value(reloaded).unwrap()["treeAutoFollowEnabled"], enabled);
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn template_root_settings_round_trip() {
    let root = std::env::temp_dir().join(format!("sfm-template-settings-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let mut metadata = MetadataStore::default();
    metadata.attach_path(root.join("metadata.json"));
    let mut settings = SettingsStore::load_from(root.join("settings.json")).unwrap();
    let mut value = serde_json::to_value(update(&settings, None)).unwrap();
    value["templateRoot"] = serde_json::json!(r" C:\模板文件 ");
    commit_model(&mut metadata, &mut settings, serde_json::from_value(value).unwrap()).unwrap();
    let persisted = SettingsStore::load_from(root.join("settings.json")).unwrap();
    assert_eq!(serde_json::to_value(persisted).unwrap()["templateRoot"], r"C:\模板文件");
    fs::remove_dir_all(root).unwrap();
}

fn update(
    settings: &SettingsStore,
    rules: Option<Vec<FileAssociationRule>>,
) -> SettingsModelUpdate {
    SettingsModelUpdate {
        template_root: settings.template_root.clone(),
        file_associations: rules,
        shortcuts: vec![],
        columns: settings.detail_columns.clone(),
        navigation_columns: settings.navigation_columns.clone(),
        details_row_height: 30,
        size_bar_mode: settings.size_bar_mode.clone(),
        tree_auto_follow_enabled: settings.tree_auto_follow_enabled,
        folder_expansion_enabled: true,
        folder_expansion_on_row_click: settings.folder_expansion_on_row_click,
        notifications_enabled: true,
        tooltip_hover_delay_ms: settings.tooltip_hover_delay_ms,
        metadata_retention_hours: settings.metadata_retention_hours,
        file_visibility: settings.file_visibility.clone(),
        context_menu: settings.context_menu.clone(),
        theme: settings.theme.clone(),
    }
}

#[test]
fn file_associations_settings_transaction_round_trip_and_rollback_preserve_both_stores() {
    let root = std::env::temp_dir().join(format!("sfm-settings-model-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let metadata_path = root.join("metadata.json");
    let settings_path = root.join("layout.toml");
    let mut metadata = MetadataStore::default();
    metadata.attach_path(metadata_path.clone());
    metadata.persist().unwrap();
    let mut settings = SettingsStore::default();
    settings.attach_path(settings_path.clone());
    settings.persist().unwrap();
    let rules = vec![FileAssociationRule {
        id: "one".into(),
        patterns: " .md ; txt ".into(),
        executable_path: r" C:\Editor\edit.exe ".into(),
        arguments_template: "--new {file}".into(),
    }];
    let before_settings = fs::read(&settings_path).unwrap();
    let before_metadata = fs::read(&metadata_path).unwrap();
    let memory_settings = serde_json::to_value(&settings).unwrap();
    let memory_metadata = serde_json::to_value(&metadata).unwrap();
    fs::write(root.join("blocked"), "file instead of directory").unwrap();
    metadata.attach_path(root.join("blocked/metadata.json"));
    let request = update(&settings, Some(rules.clone()));
    assert!(commit_model(&mut metadata, &mut settings, request).is_err());
    assert_eq!(
        fs::read(&settings_path).unwrap(),
        before_settings,
        "successful first write must be rolled back"
    );
    assert_eq!(fs::read(&metadata_path).unwrap(), before_metadata);
    assert_eq!(serde_json::to_value(&settings).unwrap(), memory_settings);
    assert_eq!(serde_json::to_value(&metadata).unwrap(), memory_metadata);

    metadata.attach_path(metadata_path.clone());
    settings.attach_path(root.join("blocked/layout.toml"));
    let request = update(&settings, Some(rules.clone()));
    assert!(commit_model(&mut metadata, &mut settings, request).is_err());
    assert_eq!(
        fs::read(&metadata_path).unwrap(),
        before_metadata,
        "failure of the first write cannot publish metadata"
    );
    assert_eq!(serde_json::to_value(&metadata).unwrap(), memory_metadata);
    settings.attach_path(settings_path.clone());
    let request = update(&settings, Some(rules));
    commit_model(&mut metadata, &mut settings, request).unwrap();
    assert_eq!(
        MetadataStore::load_from(metadata_path.clone())
            .unwrap()
            .file_associations,
        metadata.file_associations
    );
    assert_eq!(metadata.file_associations[0].patterns, ".md;txt");
    assert_eq!(
        SettingsStore::load_from(settings_path.clone())
            .unwrap()
            .details_row_height,
        30
    );
    let request = update(&settings, None);
    commit_model(&mut metadata, &mut settings, request).unwrap();
    assert_eq!(
        metadata.file_associations[0].id, "one",
        "older clients preserve current association rules"
    );

    let before = fs::read(&metadata_path).unwrap();
    let mut invalid = metadata.file_associations.clone();
    invalid[0].arguments_template = "\"unclosed".into();
    let request = update(&settings, Some(invalid));
    assert!(commit_model(&mut metadata, &mut settings, request).is_err());
    assert_eq!(
        fs::read(&metadata_path).unwrap(),
        before,
        "validation happens before any persistence"
    );
    fs::remove_dir_all(root).unwrap();
}

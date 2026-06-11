use std::{
  fs,
  path::{Path, PathBuf}
};

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};

use crate::domain::models::{
  Bookmark, ColorRule, EntryTag, HotlistEntry, NavigationItem, NavigationItemUpsertRequest,
  NavigationTargetStatus, RemoteProfile, SettingsSnapshot, ShortcutBinding, TagDefinition, UiLayout, UiTheme
};
use crate::services::windows_shell;

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataStore {
  pub bookmarks: Vec<Bookmark>,
  pub hotlist: Vec<HotlistEntry>,
  #[serde(default)]
  pub navigation_items: Vec<NavigationItem>,
  pub tag_definitions: Vec<TagDefinition>,
  pub entry_tags: Vec<EntryTag>,
  pub color_rules: Vec<ColorRule>,
  pub shortcuts: Vec<ShortcutBinding>,
  pub remote_profiles: Vec<RemoteProfile>,
  #[serde(skip)]
  file_path: Option<PathBuf>
}

impl MetadataStore {
  pub fn load_default() -> Self {
    Self::default()
  }

  pub fn load_from(file_path: PathBuf) -> Result<Self> {
    if !file_path.exists() {
      return Ok(Self {
        file_path: Some(file_path),
        ..Self::default()
      });
    }

    let content = fs::read_to_string(&file_path).context("failed to read metadata store")?;
    let mut store: Self = serde_json::from_str(&content).context("failed to parse metadata store")?;
    store.file_path = Some(file_path);
    Ok(store)
  }

  pub fn attach_path(&mut self, file_path: PathBuf) {
    self.file_path = Some(file_path);
  }

  pub fn persist(&self) -> Result<()> {
    let file_path = self.file_path.as_ref().context("metadata store path not initialized")?;
    if let Some(parent) = file_path.parent() {
      fs::create_dir_all(parent).context("failed to create metadata directory")?;
    }

    let temp_path = file_path.with_extension("json.tmp");
    let content = serde_json::to_vec_pretty(self).context("failed to serialize metadata store")?;
    fs::write(&temp_path, content).context("failed to write metadata store temp file")?;
    if file_path.exists() {
      fs::remove_file(file_path).context("failed to replace metadata store file")?;
    }
    fs::rename(&temp_path, file_path).context("failed to commit metadata store file")?;
    Ok(())
  }

  pub fn to_settings_snapshot(&self, layout: UiLayout, details_row_height: u16, theme: UiTheme) -> SettingsSnapshot {
    SettingsSnapshot {
      bookmarks: self.bookmarks.clone(),
      hotlist: self.hotlist.clone(),
      navigation_items: self.navigation_items.clone(),
      tag_definitions: self.tag_definitions.clone(),
      entry_tags: self.entry_tags.clone(),
      color_rules: self.color_rules.clone(),
      shortcuts: self.shortcuts.clone(),
      details_row_height,
      theme,
      layout,
      remote_profiles: self
        .remote_profiles
        .iter()
        .cloned()
        .map(redact_remote_profile)
        .collect()
    }
  }

  pub fn upsert_bookmark(&mut self, bookmark: Bookmark) {
    upsert_by_id(&mut self.bookmarks, bookmark, |item| &item.id);
    self.bookmarks.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
  }

  pub fn delete_bookmark(&mut self, id: &str) {
    self.bookmarks.retain(|item| item.id != id);
  }

  pub fn upsert_hotlist(&mut self, entry: HotlistEntry) {
    upsert_by_id(&mut self.hotlist, entry, |item| &item.id);
    self.hotlist.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
  }

  pub fn delete_hotlist(&mut self, id: &str) {
    self.hotlist.retain(|item| item.id != id);
  }

  pub fn upsert_navigation_item(
    &mut self,
    request: NavigationItemUpsertRequest,
    now: impl Fn() -> DateTime<Utc>,
    create_id: impl Fn() -> String
  ) -> Result<NavigationItem> {
    let path = request.path.trim().to_string();
    let description = request.description.trim().to_string();
    let target = windows_shell::resolve_navigation_target(&path)?;
    if matches!(
      target.target_status,
      NavigationTargetStatus::InvalidPath | NavigationTargetStatus::UnsupportedRemote
    ) {
      bail!(target.message.unwrap_or_else(|| "navigation item path is invalid".into()));
    }
    let display_name = request
      .display_name
      .as_deref()
      .unwrap_or_default()
      .trim()
      .to_string();
    let display_name = if display_name.is_empty() {
      target.display_name.clone()
    } else {
      display_name
    };
    let timestamp = now();
    let requested_id = request.id.as_deref().map(str::trim).filter(|id| !id.is_empty());
    let existing_index = if let Some(id) = requested_id {
      let index = self.navigation_items.iter().position(|item| item.id == id);
      if index.is_none() {
        bail!("navigation item id was not found");
      }
      index
    } else {
      let path_key = navigation_path_key(target.normalized_path.as_deref().unwrap_or(&path));
      self
        .navigation_items
        .iter()
        .position(|item| navigation_path_key(&item.path) == path_key)
    };

    let (id, created_at, sort_order, last_opened_at) = if let Some(index) = existing_index {
      let existing = &self.navigation_items[index];
      (
        existing.id.clone(),
        existing.created_at,
        existing.sort_order,
        existing.last_opened_at
      )
    } else {
      (
        create_id(),
        timestamp,
        self.navigation_items.iter().map(|item| item.sort_order).max().unwrap_or(0) + 1,
        None
      )
    };

    let item = NavigationItem {
      id,
      display_name,
      description,
      path: target.normalized_path.clone().unwrap_or(path),
      target_kind: target.target_kind,
      target_status: target.target_status,
      status_message: target.message,
      sort_order,
      created_at,
      updated_at: timestamp,
      last_opened_at
    };

    if let Some(index) = existing_index {
      self.navigation_items[index] = item.clone();
    } else {
      self.navigation_items.push(item.clone());
    }
    self.sort_navigation_items();
    Ok(item)
  }

  pub fn mark_navigation_item_opened(
    &mut self,
    id: &str,
    now: impl Fn() -> DateTime<Utc>
  ) -> Option<NavigationItem> {
    let timestamp = now();
    let item = self.navigation_items.iter_mut().find(|item| item.id == id)?;
    item.last_opened_at = Some(timestamp);
    item.updated_at = timestamp;
    Some(item.clone())
  }

  pub fn delete_navigation_item(&mut self, id: &str) -> bool {
    let before = self.navigation_items.len();
    self.navigation_items.retain(|item| item.id != id);
    before != self.navigation_items.len()
  }

  pub fn reorder_navigation_items(&mut self, ids: Vec<String>) {
    let mut next_order = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for id in ids {
      if !seen.insert(id.clone()) {
        continue;
      }
      if self.navigation_items.iter().any(|item| item.id == id) {
        next_order.push(id);
      }
    }

    let existing_by_sort = {
      let mut items = self.navigation_items.clone();
      items.sort_by(|left, right| left.sort_order.cmp(&right.sort_order).then(left.display_name.cmp(&right.display_name)));
      items
    };
    for item in existing_by_sort {
      if seen.insert(item.id.clone()) {
        next_order.push(item.id);
      }
    }

    for item in &mut self.navigation_items {
      if let Some(index) = next_order.iter().position(|id| id == &item.id) {
        item.sort_order = index as u32 + 1;
      }
    }
    self.sort_navigation_items();
  }

  fn sort_navigation_items(&mut self) {
    self
      .navigation_items
      .sort_by(|left, right| left.sort_order.cmp(&right.sort_order).then(left.display_name.cmp(&right.display_name)));
  }

  pub fn upsert_color_rule(&mut self, rule: ColorRule) {
    upsert_by_id(&mut self.color_rules, rule, |item| &item.id);
    self.color_rules.sort_by(|left, right| left.priority.cmp(&right.priority).then(left.name.cmp(&right.name)));
  }

  pub fn set_color_rules(&mut self, rules: Vec<ColorRule>) {
    self.color_rules = rules;
    self.color_rules.sort_by(|left, right| left.priority.cmp(&right.priority).then(left.name.cmp(&right.name)));
  }

  pub fn delete_color_rule(&mut self, id: &str) {
    self.color_rules.retain(|item| item.id != id);
  }

  pub fn upsert_tag_definition(&mut self, definition: TagDefinition) {
    upsert_by_id(&mut self.tag_definitions, definition, |item| &item.id);
    self.tag_definitions.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
  }

  pub fn delete_tag_definition(&mut self, id: &str) {
    self.tag_definitions.retain(|item| item.id != id);
    for entry in &mut self.entry_tags {
      entry.tag_ids.retain(|tag_id| tag_id != id);
    }
    self.entry_tags.retain(|entry| !entry.tag_ids.is_empty());
  }

  pub fn set_shortcuts(&mut self, shortcuts: Vec<ShortcutBinding>) {
    self.shortcuts = shortcuts;
    self.shortcuts.sort_by(|left, right| left.action.to_lowercase().cmp(&right.action.to_lowercase()));
  }

  pub fn upsert_remote_profile(&mut self, profile: RemoteProfile) {
    upsert_by_id(&mut self.remote_profiles, profile, |item| &item.id);
    self.remote_profiles.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
  }

  pub fn delete_remote_profile(&mut self, id: &str) -> Option<RemoteProfile> {
    let index = self.remote_profiles.iter().position(|item| item.id == id)?;
    Some(self.remote_profiles.remove(index))
  }

  pub fn tags_for_path(&self, path: &str) -> Vec<String> {
    let normalized_path = normalize_path(Path::new(path));
    let Some(entry) = self
      .entry_tags
      .iter()
      .find(|entry| normalize_path(Path::new(&entry.path)) == normalized_path) else {
      return Vec::new();
    };

    entry
      .tag_ids
      .iter()
      .filter_map(|tag_id| self.tag_definitions.iter().find(|definition| definition.id == *tag_id))
      .map(|definition| definition.name.clone())
      .collect()
  }
}

fn redact_remote_profile(mut profile: RemoteProfile) -> RemoteProfile {
  profile.credential_target = None;
  profile
}

fn upsert_by_id<T>(items: &mut Vec<T>, value: T, id_of: impl Fn(&T) -> &str) {
  let id = id_of(&value).to_string();
  if let Some(existing) = items.iter_mut().find(|item| id_of(item) == id) {
    *existing = value;
  } else {
    items.push(value);
  }
}

fn normalize_path(path: &Path) -> String {
  let rendered = path.to_string_lossy();
  if cfg!(windows) {
    rendered.to_lowercase()
  } else {
    rendered.into_owned()
  }
}

fn navigation_path_key(path: &str) -> String {
  let mut value = path.trim().replace('/', "\\");
  while value.len() > 3 && value.ends_with('\\') {
    value.pop();
  }
  if cfg!(windows) {
    value.to_lowercase()
  } else {
    value
  }
}

#[cfg(test)]
mod tests {
  use std::{env, fs, path::PathBuf};

  use super::MetadataStore;
  use crate::domain::models::{
    Bookmark, EntryTag, LocationKind, NavigationItemUpsertRequest, NavigationTargetKind,
    NavigationTargetStatus, RemoteAuthKind, RemoteProfile, TagDefinition, UiLayout, UiTheme
  };

  struct TestDir {
    path: PathBuf
  }

  impl TestDir {
    fn new(name: &str) -> Self {
      let path = env::temp_dir().join(format!("simplefilemanager-metadata-{name}-{}", uuid::Uuid::new_v4()));
      fs::create_dir_all(&path).expect("failed to create temp directory");
      Self { path }
    }
  }

  impl Drop for TestDir {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.path);
    }
  }

  #[test]
  fn upsert_bookmark_replaces_existing_item() {
    let mut store = MetadataStore::default();
    store.upsert_bookmark(Bookmark {
      id: "bookmarks-1".into(),
      name: "Docs".into(),
      path: "C:\\Docs".into()
    });
    store.upsert_bookmark(Bookmark {
      id: "bookmarks-1".into(),
      name: "Root".into(),
      path: "C:\\".into()
    });

    assert_eq!(store.bookmarks.len(), 1);
    assert_eq!(store.bookmarks[0].name, "Root");
  }

  #[test]
  fn persist_round_trip_preserves_state() {
    let temp = TestDir::new("roundtrip");
    let file_path = temp.path.join("metadata.json");
    let mut store = MetadataStore::load_default();
    store.attach_path(file_path.clone());
    store.upsert_bookmark(Bookmark {
      id: "bookmark-1".into(),
      name: "Docs".into(),
      path: temp.path.to_string_lossy().into_owned()
    });
    store.persist().expect("failed to persist metadata");

    let reloaded = MetadataStore::load_from(file_path).expect("failed to reload metadata");
    let snapshot = reloaded.to_settings_snapshot(UiLayout::fallback(), 36, UiTheme::default());
    assert_eq!(snapshot.bookmarks.len(), 1);
    assert_eq!(snapshot.bookmarks[0].name, "Docs");
  }

  #[test]
  fn old_metadata_without_navigation_items_loads_with_empty_navigation_collection() {
    let temp = TestDir::new("legacy-navigation");
    let file_path = temp.path.join("metadata.json");
    fs::write(
      &file_path,
      r#"{
        "bookmarks": [],
        "hotlist": [],
        "tagDefinitions": [],
        "entryTags": [],
        "colorRules": [],
        "shortcuts": [],
        "remoteProfiles": []
      }"#
    )
    .expect("failed to seed legacy metadata");

    let reloaded = MetadataStore::load_from(file_path).expect("failed to load legacy metadata");
    let snapshot = reloaded.to_settings_snapshot(UiLayout::fallback(), 36, UiTheme::default());

    assert!(reloaded.navigation_items.is_empty());
    assert!(snapshot.navigation_items.is_empty());
  }

  #[test]
  fn upsert_navigation_item_creates_and_updates_backend_owned_fields() {
    let mut store = MetadataStore::default();
    let created = store
      .upsert_navigation_item(
        NavigationItemUpsertRequest {
          id: None,
          display_name: None,
          description: "  Project docs  ".into(),
          path: "  C:\\Docs  ".into()
        },
        || {
          use chrono::TimeZone;
          chrono::Utc.with_ymd_and_hms(2026, 6, 8, 9, 0, 0).unwrap()
        },
        || "nav-fixed".into()
      )
      .expect("navigation item should be created");

    assert_eq!(created.id, "nav-fixed");
    assert_eq!(created.display_name, "Docs");
    assert_eq!(created.description, "Project docs");
    assert_eq!(created.path, "C:\\Docs");
    assert_eq!(created.sort_order, 1);
    assert_eq!(created.target_kind, NavigationTargetKind::Missing);
    assert_eq!(created.target_status, NavigationTargetStatus::Missing);

    let updated = store
      .upsert_navigation_item(
        NavigationItemUpsertRequest {
          id: Some("nav-fixed".into()),
          display_name: Some("  Docs Root  ".into()),
          description: "Updated".into(),
          path: "C:\\Docs".into()
        },
        || {
          use chrono::TimeZone;
          chrono::Utc.with_ymd_and_hms(2026, 6, 8, 10, 0, 0).unwrap()
        },
        || "unused".into()
      )
      .expect("navigation item should be updated");

    assert_eq!(store.navigation_items.len(), 1);
    assert_eq!(updated.display_name, "Docs Root");
    assert_eq!(updated.created_at, created.created_at);
    assert!(updated.updated_at > created.updated_at);
  }

  #[test]
  fn upsert_navigation_item_rejects_client_owned_unknown_ids_invalid_paths_and_remote_targets() {
    let mut store = MetadataStore::default();

    let unknown_id_result = store.upsert_navigation_item(
      NavigationItemUpsertRequest {
        id: Some("client-owned-id".into()),
        display_name: Some("Client".into()),
        description: String::new(),
        path: "C:\\Client".into()
      },
      chrono::Utc::now,
      || "server-owned-id".into()
    );
    assert!(unknown_id_result.is_err());
    assert!(store.navigation_items.is_empty());

    let invalid_path_result = store.upsert_navigation_item(
      NavigationItemUpsertRequest {
        id: None,
        display_name: Some("Relative".into()),
        description: String::new(),
        path: "relative\\target".into()
      },
      chrono::Utc::now,
      || "nav-invalid".into()
    );
    assert!(invalid_path_result.is_err());
    assert!(store.navigation_items.is_empty());

    let remote_path_result = store.upsert_navigation_item(
      NavigationItemUpsertRequest {
        id: None,
        display_name: Some("Remote".into()),
        description: String::new(),
        path: "sftp://deploy@example/root".into()
      },
      chrono::Utc::now,
      || "nav-remote".into()
    );
    assert!(remote_path_result.is_err());
    assert!(store.navigation_items.is_empty());
  }

  #[test]
  fn mark_navigation_item_opened_updates_last_opened_timestamp() {
    let mut store = MetadataStore::default();
    let created = store
      .upsert_navigation_item(
        NavigationItemUpsertRequest {
          id: None,
          display_name: Some("A".into()),
          description: String::new(),
          path: "C:\\A".into()
        },
        || {
          use chrono::TimeZone;
          chrono::Utc.with_ymd_and_hms(2026, 6, 8, 9, 0, 0).unwrap()
        },
        || "nav-a".into()
      )
      .expect("navigation item should be created");

    let opened_at = {
      use chrono::TimeZone;
      chrono::Utc.with_ymd_and_hms(2026, 6, 8, 12, 30, 0).unwrap()
    };
    let updated = store
      .mark_navigation_item_opened("nav-a", || opened_at)
      .expect("navigation item should be marked opened");

    assert_eq!(updated.id, created.id);
    assert_eq!(updated.last_opened_at, Some(opened_at));
    assert_eq!(store.navigation_items[0].last_opened_at, Some(opened_at));
    assert!(store.mark_navigation_item_opened("missing", chrono::Utc::now).is_none());
  }

  #[test]
  fn reorder_navigation_items_ignores_duplicates_and_appends_missing_items() {
    let mut store = MetadataStore::default();
    for (index, id) in ["nav-a", "nav-b", "nav-c"].iter().enumerate() {
      store
        .upsert_navigation_item(
          NavigationItemUpsertRequest {
            id: None,
            display_name: Some((*id).into()),
            description: String::new(),
            path: format!("C:\\Item{}", index)
          },
          chrono::Utc::now,
          || (*id).into()
        )
        .expect("navigation item should be created");
    }

    store.reorder_navigation_items(vec!["nav-c".into(), "nav-c".into(), "missing".into(), "nav-a".into()]);

    assert_eq!(
      store
        .navigation_items
        .iter()
        .map(|item| (item.id.as_str(), item.sort_order))
        .collect::<Vec<_>>(),
      vec![("nav-c", 1), ("nav-a", 2), ("nav-b", 3)]
    );
  }

  #[test]
  fn delete_navigation_item_removes_only_metadata() {
    let mut store = MetadataStore::default();
    store
      .upsert_navigation_item(
        NavigationItemUpsertRequest {
          id: None,
          display_name: Some("A".into()),
          description: String::new(),
          path: "C:\\A".into()
        },
        chrono::Utc::now,
        || "nav-a".into()
      )
      .expect("navigation item should be created");

    assert!(store.delete_navigation_item("nav-a"));
    assert!(store.navigation_items.is_empty());
    assert!(!store.delete_navigation_item("missing"));
  }

  #[test]
  fn tags_for_path_returns_tag_names() {
    let path = "C:\\Data\\notes.txt".to_string();
    let store = MetadataStore {
      tag_definitions: vec![TagDefinition {
        id: "tag-1".into(),
        name: "Pinned".into(),
        color_hex: "#00ff99".into()
      }],
      entry_tags: vec![EntryTag {
        path: path.clone(),
        tag_ids: vec!["tag-1".into()]
      }],
      ..MetadataStore::default()
    };

    assert_eq!(store.tags_for_path(&path), vec!["Pinned".to_string()]);
  }

  #[test]
  fn settings_snapshot_redacts_remote_profile_credential_targets() {
    let store = MetadataStore {
      remote_profiles: vec![RemoteProfile {
        id: "remote-1".into(),
        name: "Edge".into(),
        protocol: LocationKind::Sftp,
        host: "edge-01.internal".into(),
        port: 22,
        username: "deploy".into(),
        root_path: "/releases".into(),
        auth_kind: RemoteAuthKind::Password,
        private_key_path: None,
        passive_mode: true,
        ignore_host_key: false,
        connect_timeout_secs: 10,
        command_timeout_secs: 20,
        credential_target: Some("SimpleFileManager.Remote.remote-1".into())
      }],
      ..MetadataStore::default()
    };

    assert_eq!(
      store.remote_profiles[0].credential_target.as_deref(),
      Some("SimpleFileManager.Remote.remote-1")
    );

    let snapshot = store.to_settings_snapshot(UiLayout::fallback(), 36, UiTheme::default());
    assert_eq!(snapshot.remote_profiles.len(), 1);
    assert_eq!(snapshot.remote_profiles[0].credential_target, None);
  }

  #[test]
  fn delete_remote_profile_removes_matching_item() {
    let mut store = MetadataStore {
      remote_profiles: vec![
        RemoteProfile {
          id: "remote-1".into(),
          name: "Edge".into(),
          protocol: LocationKind::Sftp,
          host: "edge-01.internal".into(),
          port: 22,
          username: "deploy".into(),
          root_path: "/releases".into(),
          auth_kind: RemoteAuthKind::Password,
          private_key_path: None,
          passive_mode: true,
          ignore_host_key: false,
          connect_timeout_secs: 10,
          command_timeout_secs: 20,
          credential_target: Some("SimpleFileManager.Remote.remote-1".into())
        },
        RemoteProfile {
          id: "remote-2".into(),
          name: "Anonymous FTP".into(),
          protocol: LocationKind::Ftp,
          host: "ftp.example.com".into(),
          port: 21,
          username: "anonymous".into(),
          root_path: "/".into(),
          auth_kind: RemoteAuthKind::Anonymous,
          private_key_path: None,
          passive_mode: true,
          ignore_host_key: false,
          connect_timeout_secs: 10,
          command_timeout_secs: 20,
          credential_target: None
        }
      ],
      ..MetadataStore::default()
    };

    store.delete_remote_profile("remote-1");

    assert_eq!(store.remote_profiles.len(), 1);
    assert_eq!(store.remote_profiles[0].id, "remote-2");
  }
}

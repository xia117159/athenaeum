use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};

use crate::{
    domain::models::RemoteProfile,
    services::metadata_store::MetadataStore,
};

use super::remote_service::windows_credentials::{delete_secret, read_secret, write_secret};

pub const LEGACY_IDENTIFIER: &str = "com.openai.simplefilemanager";
pub const LEGACY_DATA_LEAF: &str = "SimpleFileManager";
pub const LEGACY_CREDENTIAL_PREFIX: &str = "SimpleFileManager.Remote.";
pub const NEW_CREDENTIAL_PREFIX: &str = "Athenaeum.Remote.";

pub fn legacy_app_data_dir(base: &Path) -> PathBuf {
    base.join(LEGACY_IDENTIFIER).join(LEGACY_DATA_LEAF)
}

pub fn migrate_legacy_data_dir(old_dir: &Path, new_dir: &Path) -> Result<()> {
    if !old_dir.exists() {
        return Ok(());
    }
    if new_dir.exists() {
        return Ok(());
    }
    if let Some(parent) = new_dir.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create parent for {}", new_dir.display()))?;
    }
    fs::rename(old_dir, new_dir).with_context(|| {
        format!(
            "failed to migrate {} -> {}",
            old_dir.display(),
            new_dir.display()
        )
    })
}

pub fn plan_credential_migration(profile: &RemoteProfile) -> Option<(String, String)> {
    let old_target = profile.credential_target.as_deref()?;
    let id_part = old_target.strip_prefix(LEGACY_CREDENTIAL_PREFIX)?;
    let new_target = format!("{}{}", NEW_CREDENTIAL_PREFIX, id_part);
    Some((old_target.to_string(), new_target))
}

pub fn migrate_legacy_credentials(metadata: &mut MetadataStore) -> Result<bool> {
    let mut changed = false;
    for profile in &mut metadata.remote_profiles {
        let Some((old_target, new_target)) = plan_credential_migration(profile) else {
            continue;
        };
        if read_secret(&new_target).is_none() {
            if let Some(secret) = read_secret(&old_target) {
                write_secret(&new_target, &secret)?;
                let _ = delete_secret(&old_target);
            }
        }
        profile.credential_target = Some(new_target);
        changed = true;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::models::{LocationKind, RemoteAuthKind};
    use std::env;

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(name: &str) -> Self {
            let path = env::temp_dir().join(format!(
                "athenaeum-migration-{name}-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir_all(&path).expect("failed to create temp directory");
            Self { path }
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn fresh_sibling(label: &str) -> PathBuf {
        env::temp_dir().join(format!("athenaeum-migration-{label}-{}", uuid::Uuid::new_v4()))
    }

    fn legacy_profile(id: &str, target: Option<&str>) -> RemoteProfile {
        RemoteProfile {
            id: id.into(),
            name: format!("Profile {id}"),
            protocol: LocationKind::Sftp,
            host: "192.168.1.3".into(),
            port: 6666,
            username: "cheng".into(),
            root_path: "/".into(),
            auth_kind: RemoteAuthKind::Password,
            private_key_path: None,
            passive_mode: true,
            ignore_host_key: false,
            connect_timeout_secs: 10,
            command_timeout_secs: 20,
            credential_target: target.map(str::to_string),
            password: None,
        }
    }

    #[test]
    fn legacy_app_data_dir_joins_identifier_and_leaf() {
        let path = legacy_app_data_dir(Path::new("C:\\Users\\demo\\AppData\\Local"));
        assert!(path.ends_with("com.openai.simplefilemanager\\SimpleFileManager"));
    }

    #[test]
    fn migrate_legacy_data_dir_renames_old_to_new_when_new_absent() {
        let old_root = TestDir::new("old-root");
        let new_root = fresh_sibling("new-root");
        fs::write(old_root.path.join("metadata.json"), "{}").unwrap();
        fs::write(old_root.path.join("layout.toml"), "[x]").unwrap();
        fs::create_dir_all(old_root.path.join("operation-trash/task-1")).unwrap();
        fs::write(
            old_root.path.join("operation-trash/task-1/file.bin"),
            b"data",
        )
        .unwrap();

        migrate_legacy_data_dir(&old_root.path, &new_root).expect("migration should succeed");

        assert!(!old_root.path.exists());
        assert!(new_root.exists());
        assert_eq!(fs::read_to_string(new_root.join("metadata.json")).unwrap(), "{}");
        assert!(new_root.join("operation-trash/task-1/file.bin").exists());
        let _ = fs::remove_dir_all(&new_root);
    }

    #[test]
    fn migrate_legacy_data_dir_noop_when_old_absent() {
        let new_root = fresh_sibling("new-absent");
        migrate_legacy_data_dir(Path::new("/does/not/exist/athenaeum"), &new_root)
            .expect("missing old dir is a no-op");
        assert!(!new_root.exists());
        let _ = fs::remove_dir_all(&new_root);
    }

    #[test]
    fn migrate_legacy_data_dir_skips_when_new_already_exists() {
        let old_root = TestDir::new("old-skip");
        let new_root = TestDir::new("new-skip");
        fs::write(old_root.path.join("metadata.json"), "OLD").unwrap();
        fs::write(new_root.path.join("metadata.json"), "NEW").unwrap();

        migrate_legacy_data_dir(&old_root.path, &new_root.path)
            .expect("existing new dir should not fail");

        assert!(old_root.path.exists());
        assert_eq!(fs::read_to_string(new_root.path.join("metadata.json")).unwrap(), "NEW");
    }

    #[test]
    fn migrate_legacy_data_dir_preserves_deep_subtree() {
        let old_root = TestDir::new("old-subtree");
        let new_root = fresh_sibling("new-subtree");
        fs::create_dir_all(old_root.path.join("operation-trash/task-1/nested")).unwrap();
        fs::write(
            old_root.path.join("operation-trash/task-1/nested/file.bin"),
            b"deep",
        )
        .unwrap();

        migrate_legacy_data_dir(&old_root.path, &new_root).expect("migration should succeed");

        assert!(new_root.join("operation-trash/task-1/nested/file.bin").exists());
        let _ = fs::remove_dir_all(&new_root);
    }

    #[test]
    fn plan_credential_migration_returns_old_new_for_legacy_target() {
        let profile = legacy_profile("abc-123", Some("SimpleFileManager.Remote.abc-123"));
        assert_eq!(
            plan_credential_migration(&profile),
            Some((
                "SimpleFileManager.Remote.abc-123".into(),
                "Athenaeum.Remote.abc-123".into()
            ))
        );
    }

    #[test]
    fn plan_credential_migration_returns_none_for_already_migrated() {
        let profile = legacy_profile("abc-123", Some("Athenaeum.Remote.abc-123"));
        assert!(plan_credential_migration(&profile).is_none());
    }

    #[test]
    fn plan_credential_migration_returns_none_when_target_absent() {
        let profile = legacy_profile("abc-123", None);
        assert!(plan_credential_migration(&profile).is_none());
    }

    #[test]
    fn plan_credential_migration_returns_none_for_unrelated_target() {
        let profile = legacy_profile("abc-123", Some("OtherApp.Remote.abc-123"));
        assert!(plan_credential_migration(&profile).is_none());
    }

    #[test]
    fn migrate_legacy_credentials_updates_target_strings() {
        let mut store = MetadataStore::default();
        store.remote_profiles = vec![
            legacy_profile("uuid-a", Some("SimpleFileManager.Remote.uuid-a")),
            legacy_profile("uuid-b", Some("Athenaeum.Remote.uuid-b")),
        ];

        let changed = migrate_legacy_credentials(&mut store).expect("migration should succeed");

        assert!(changed);
        assert_eq!(
            store.remote_profiles[0].credential_target.as_deref(),
            Some("Athenaeum.Remote.uuid-a")
        );
        assert_eq!(
            store.remote_profiles[1].credential_target.as_deref(),
            Some("Athenaeum.Remote.uuid-b")
        );
    }

    #[test]
    fn migrate_legacy_credentials_noop_when_already_migrated() {
        let mut store = MetadataStore::default();
        store.remote_profiles = vec![legacy_profile("uuid-a", Some("Athenaeum.Remote.uuid-a"))];

        let changed = migrate_legacy_credentials(&mut store).expect("migration should succeed");

        assert!(!changed);
    }

    #[test]
    fn migrate_legacy_credentials_noop_when_no_remote_profiles() {
        let mut store = MetadataStore::default();
        let changed = migrate_legacy_credentials(&mut store).expect("migration should succeed");
        assert!(!changed);
    }
}

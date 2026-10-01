pub mod atomic_file;
pub mod templates;
pub(crate) mod file_identity;
pub mod batch_rename;
pub mod color_filter;
pub mod drive_service;
pub mod directory_size;
pub mod desktop_shutdown;
#[cfg(test)]
mod desktop_shutdown_tests;
pub mod file_watcher;
#[cfg(windows)]
pub(crate) mod watch_registry;
pub mod file_associations;
pub mod file_opening;
pub mod fs_service;
pub mod git_status_service;
pub mod icon_service;
pub mod metadata_store;
pub mod migration;
mod native_menu_contract;
pub mod operation_service;
pub mod remote_service;
pub mod search_service;
pub mod settings_store;
pub mod auto_directory_size_paths;
pub mod settings_model;
pub mod webview_recovery;
pub mod windows_shell;
#[cfg(windows)]
pub(crate) mod windows_sta;

use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, RwLock,
    },
};

use anyhow::{Context, Result};
use tauri::{path::BaseDirectory, AppHandle, Manager};

use self::{
    file_watcher::FileWatchService, metadata_store::MetadataStore,
    operation_service::OperationStore, settings_store::SettingsStore,
};
use crate::domain::models::SystemIconBitmap;

pub struct IconBitmapCache {
    entries: HashMap<String, SystemIconBitmap>,
    order: VecDeque<String>,
    png_entries: HashMap<String, Vec<u8>>,
    png_order: VecDeque<String>,
}

impl Default for IconBitmapCache {
    fn default() -> Self { Self { entries: HashMap::new(), order: VecDeque::new(), png_entries: HashMap::new(), png_order: VecDeque::new() } }
}

impl IconBitmapCache {
    const CAPACITY: usize = 512;

    pub fn get(&mut self, key: &str) -> Option<SystemIconBitmap> {
        let value = self.entries.get(key).cloned()?;
        self.order.retain(|item| item != key);
        self.order.push_back(key.to_string());
        Some(value)
    }

    pub fn insert(&mut self, key: String, value: SystemIconBitmap) {
        self.entries.insert(key.clone(), value);
        self.order.retain(|item| item != &key);
        self.order.push_back(key);
        while self.order.len() > Self::CAPACITY {
            if let Some(oldest) = self.order.pop_front() { self.entries.remove(&oldest); }
        }
    }

    pub fn get_png(&mut self, key: &str) -> Option<Vec<u8>> {
        let value = self.png_entries.get(key).cloned()?;
        self.png_order.retain(|item| item != key);
        self.png_order.push_back(key.to_string());
        Some(value)
    }

    pub fn insert_png(&mut self, key: String, value: Vec<u8>) {
        self.png_entries.insert(key.clone(), value);
        self.png_order.retain(|item| item != &key);
        self.png_order.push_back(key);
        while self.png_order.len() > Self::CAPACITY {
            if let Some(oldest) = self.png_order.pop_front() { self.png_entries.remove(&oldest); }
        }
    }
}

pub struct AppState {
    pub shutdown: desktop_shutdown::Shutdown,
    pub metadata: RwLock<MetadataStore>,
    pub settings: RwLock<SettingsStore>,
    pub app_data_dir: RwLock<Option<PathBuf>>,
    pub search_cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub system_icon_cache: Mutex<IconBitmapCache>,
    pub operations: Mutex<OperationStore>,
    pub file_watcher: FileWatchService,
    pub directory_sizes: directory_size::DirectorySizeService,
    pub file_open_jobs: file_opening::registry::FileOpenJobs,
    pub association_programs: file_associations::programs::ProgramInfoCache,
    pub batch_rename: batch_rename::sessions::BatchRenameSessions,
}

impl AppState {
    pub fn new(metadata: MetadataStore, settings: SettingsStore) -> Self {
        Self {
            shutdown: desktop_shutdown::Shutdown::default(),
            metadata: RwLock::new(metadata),
            settings: RwLock::new(settings),
            app_data_dir: RwLock::new(None),
            search_cancellations: Mutex::new(HashMap::new()),
            system_icon_cache: Mutex::new(IconBitmapCache::default()),
            operations: Mutex::new(OperationStore::default()),
            file_watcher: FileWatchService::default(),
            directory_sizes: directory_size::DirectorySizeService::default(),
            file_open_jobs: file_opening::registry::FileOpenJobs::default(),
            association_programs: file_associations::programs::ProgramInfoCache::default(),
            batch_rename: batch_rename::sessions::BatchRenameSessions::default(),
        }
    }

    pub fn initialize_paths(&self, app: &AppHandle) -> Result<()> {
        let data_dir = app
            .path()
            .resolve("Athenaeum", BaseDirectory::AppLocalData)
            .context("failed to resolve app local data directory")?;

        if let Some(local_base) = dirs::data_local_dir() {
            let legacy_dir = migration::legacy_app_data_dir(&local_base);
            if let Err(error) = migration::migrate_legacy_data_dir(&legacy_dir, &data_dir) {
                eprintln!("warning: legacy data dir migration failed: {error:#}");
            }
        }

        std::fs::create_dir_all(&data_dir).context("failed to create app data directory")?;
        let metadata_path = data_dir.join("metadata.json");
        let settings_path = data_dir.join("layout.toml");
        let operation_journal_path = data_dir.join("operation-journal.json");
        self.directory_sizes.initialize_storage(data_dir.join("directory-size-cache-v2"));

        let mut metadata = MetadataStore::load_from(metadata_path.clone())?;
        for diagnostic in metadata.color_filter_recovery_diagnostics() {
            eprintln!("warning: {diagnostic}");
        }
        metadata.attach_path(metadata_path);
        let credentials_migrated = migration::migrate_legacy_credentials(&mut metadata)?;
        if metadata.color_rules_migration_dirty() {
            if let Err(error) = commit_color_rule_startup_migration(&mut metadata) {
                if credentials_migrated {
                    return Err(error.context("failed to persist metadata migrations"));
                }
                eprintln!("warning: color rule migration could not be persisted and will be retried: {error:#}");
            }
        } else if credentials_migrated {
            metadata.persist()?;
        }
        *self.metadata.write().expect("metadata lock poisoned") = metadata;

        let mut settings = SettingsStore::load_from(settings_path.clone())?;
        settings.attach_path(settings_path);
        *self.settings.write().expect("settings lock poisoned") = settings;

        let operations = OperationStore::load_from(operation_journal_path)?;
        *self
            .operations
            .lock()
            .expect("operation store lock poisoned") = operations;

        *self
            .app_data_dir
            .write()
            .expect("app data dir lock poisoned") = Some(data_dir);
        Ok(())
    }
    pub fn set_search_flag(&self, id: &str, cancelled: bool) {
        if let Some(flag) = self
            .search_cancellations
            .lock()
            .expect("search lock poisoned")
            .get(id)
        {
            flag.store(cancelled, Ordering::SeqCst);
        }
    }
}

pub(crate) fn commit_color_rule_startup_migration(metadata: &mut MetadataStore) -> Result<bool> {
    if !metadata.color_rules_migration_dirty() {
        return Ok(false);
    }
    let mut staged = metadata.clone();
    if let Err(error) = staged.persist() {
        metadata.push_color_filter_recovery_diagnostic(format!(
            "Color rule migration could not be persisted and will be retried: {error:#}"
        ));
        return Err(error);
    }
    *metadata = staged;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::IconBitmapCache;
    use crate::domain::models::SystemIconBitmap;

    #[test]
    fn icon_bitmap_cache_evicts_oldest_entries_and_refreshes_lru_order() {
        let mut cache = IconBitmapCache::default();
        let bitmap = || SystemIconBitmap { width: 16, height: 16, rgba_base64: String::new() };
        for index in 0..=IconBitmapCache::CAPACITY {
            cache.insert(index.to_string(), bitmap());
        }
        assert!(cache.get("0").is_none());
        assert!(cache.get("1").is_some());
        cache.insert("new".into(), bitmap());
        assert!(cache.get("1").is_some());
        assert!(cache.get("2").is_none());
    }

    #[test]
    fn icon_png_cache_evicts_oldest_entries_and_refreshes_lru_order() {
        let mut cache = IconBitmapCache::default();
        for index in 0..=IconBitmapCache::CAPACITY {
            cache.insert_png(index.to_string(), vec![index as u8]);
        }
        assert!(cache.get_png("0").is_none());
        assert!(cache.get_png("1").is_some());
        cache.insert_png("new".into(), vec![1]);
        assert!(cache.get_png("1").is_some());
        assert!(cache.get_png("2").is_none());
    }
}

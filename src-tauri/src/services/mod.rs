pub mod fs_service;
pub mod icon_service;
pub mod metadata_store;
pub mod operation_service;
pub mod remote_service;
pub mod search_service;
pub mod settings_store;
pub mod windows_shell;

use std::{
  collections::HashMap,
  path::PathBuf,
  sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, RwLock
  }
};

use anyhow::{Context, Result};
use tauri::{path::BaseDirectory, AppHandle, Manager};

use self::{metadata_store::MetadataStore, operation_service::OperationStore, settings_store::SettingsStore};
use crate::domain::models::SystemIconBitmap;

pub struct AppState {
  pub metadata: RwLock<MetadataStore>,
  pub settings: RwLock<SettingsStore>,
  pub app_data_dir: RwLock<Option<PathBuf>>,
  pub search_cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
  pub system_icon_cache: Mutex<HashMap<String, SystemIconBitmap>>,
  pub operations: Mutex<OperationStore>
}

impl AppState {
  pub fn new(metadata: MetadataStore, settings: SettingsStore) -> Self {
    Self {
      metadata: RwLock::new(metadata),
      settings: RwLock::new(settings),
      app_data_dir: RwLock::new(None),
      search_cancellations: Mutex::new(HashMap::new()),
      system_icon_cache: Mutex::new(HashMap::new()),
      operations: Mutex::new(OperationStore::default())
    }
  }

  pub fn initialize_paths(&self, app: &AppHandle) -> Result<()> {
    let data_dir = app
      .path()
      .resolve("SimpleFileManager", BaseDirectory::AppLocalData)
      .context("failed to resolve app local data directory")?;
    std::fs::create_dir_all(&data_dir).context("failed to create app data directory")?;
    let metadata_path = data_dir.join("metadata.json");
    let settings_path = data_dir.join("layout.toml");
    let operation_journal_path = data_dir.join("operation-journal.json");

    let mut metadata = MetadataStore::load_from(metadata_path.clone())?;
    metadata.attach_path(metadata_path);
    *self.metadata.write().expect("metadata lock poisoned") = metadata;

    let mut settings = SettingsStore::load_from(settings_path.clone())?;
    settings.attach_path(settings_path);
    *self.settings.write().expect("settings lock poisoned") = settings;

    let operations = OperationStore::load_from(operation_journal_path)?;
    *self.operations.lock().expect("operation store lock poisoned") = operations;

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

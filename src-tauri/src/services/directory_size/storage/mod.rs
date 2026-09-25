mod quota;
mod database;
mod worker;
mod stream;
pub(super) mod startup;
mod migration;
mod maintenance;
mod maintenance_namespaces;
mod operations;
#[cfg(test)]
mod startup_tests;
#[cfg(test)]
mod migration_tests;
#[cfg(test)]
mod maintenance_tests;
#[cfg(test)]
mod operations_tests;
#[cfg(test)]
mod process_tests;
#[cfg(test)]
mod performance_tests;
pub(super) use stream::ScanStream;
pub(super) use database::{ScanHeader, StoredDirectory, StoredHit};
pub(super) use worker::Store;
pub(super) use operations::{Operation, RenamePath};
pub(super) fn legacy_path(directory: &std::path::Path) -> Option<std::path::PathBuf> {
    let path = directory.parent()?.join("directory-size-history.ndjson");
    migration::recognized(&path).then_some(path)
}
#[cfg(test)]
mod worker_tests;
#[cfg(test)]
mod quota_tests;
#[cfg(test)]
mod database_tests;

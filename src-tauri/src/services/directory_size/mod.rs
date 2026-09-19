pub(crate) mod metadata;
pub(crate) mod scan;
pub(crate) mod local;
pub(crate) mod watch;
mod core;
mod target;
mod runtime;
mod rename_proof;
mod rename_runtime;
mod rename_handoff;
pub(crate) use rename_runtime::RenameSession;
pub use runtime::{DirectorySizeService, EventSink};

#[cfg(test)]
mod core_tests;
#[cfg(test)]
mod runtime_tests;

#[cfg(test)]
mod local_tests;

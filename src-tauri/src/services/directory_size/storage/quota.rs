//! SQLite file quotas are checked before the underlying OS VFS can grow a file.
use std::{ffi::CString, ops::{Deref, DerefMut}, path::{Path, PathBuf}, sync::Arc};
use rusqlite::{ffi, Connection, OpenFlags};
#[path = "quota_vfs.rs"]
mod vfs;
#[path = "quota_io.rs"]
mod io;

#[derive(Clone, Copy)]
pub(super) struct Limits { pub database: u64, pub wal: u64, pub shm: u64, pub journal: u64 }
impl Default for Limits {
    fn default() -> Self { Self { database: 208 << 20, wal: 24 << 20, shm: 1 << 20, journal: 1 << 20 } }
}
pub(super) struct Quota { path: PathBuf, limits: Limits, inner: Arc<Registration> }
struct Context {
    base: *mut ffi::sqlite3_vfs, paths: [(String, u64); 3], shm: u64, readonly: bool,
    #[cfg(test)] fault_after: std::sync::atomic::AtomicIsize,
}
struct Registration { vfs: Box<ffi::sqlite3_vfs>, _context: Box<Context>, name: CString }
// Registration and Context are immutable after sqlite3_vfs_register. SQLite
// synchronizes its VFS registry; individual connections remain thread confined.
unsafe impl Send for Registration {}
unsafe impl Sync for Registration {}
impl Drop for Registration { fn drop(&mut self) { unsafe { ffi::sqlite3_vfs_unregister(&mut *self.vfs); } } }
pub(super) struct QuotaConnection { connection: Connection, _shm_guard: Option<std::fs::File>, _registration: Arc<Registration> }
impl Deref for QuotaConnection { type Target = Connection; fn deref(&self) -> &Connection { &self.connection } }
impl DerefMut for QuotaConnection { fn deref_mut(&mut self) -> &mut Connection { &mut self.connection } }
impl Quota {
    pub fn register(path: &Path, limits: Limits) -> anyhow::Result<Self> {
        Self::register_mode(path, limits, false)
    }
    fn register_mode(path: &Path, limits: Limits, readonly: bool) -> anyhow::Result<Self> {
        let name = CString::new(format!("athenaeum-quota-{}", uuid::Uuid::new_v4()))?;
        let key = super::super::target::normalize_local_path(path.to_str().ok_or_else(|| anyhow::anyhow!("invalid cache path"))?)
            .map_err(anyhow::Error::msg)?;
        for (suffix, limit) in [("", limits.database), ("-wal", limits.wal), ("-shm", limits.shm), ("-journal", limits.journal)] {
            match std::fs::symlink_metadata(format!("{}{suffix}", path.display())) {
                Ok(metadata) => anyhow::ensure!(metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() <= limit, "invalid or oversized cache file"),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                Err(error) => return Err(error.into()),
            }
        }
        unsafe {
            anyhow::ensure!(ffi::sqlite3_initialize() == ffi::SQLITE_OK, "SQLite initialization failed");
            let base = ffi::sqlite3_vfs_find(std::ptr::null());
            anyhow::ensure!(!base.is_null() && (*base).iVersion >= 2, "SQLite system VFS unavailable");
            let mut context = Box::new(Context { base, paths: [(key.clone(), limits.database),
                (format!("{key}-wal"), limits.wal), (format!("{key}-journal"), limits.journal)], shm: limits.shm, readonly,
                #[cfg(test)] fault_after: std::sync::atomic::AtomicIsize::new(-1),
            });
            let mut vfs = Box::new(vfs::build(base, &mut *context, name.as_ptr()));
            anyhow::ensure!(ffi::sqlite3_vfs_register(&mut *vfs, 0) == ffi::SQLITE_OK, "quota VFS registration failed");
            Ok(Self { path: path.into(), limits, inner: Arc::new(Registration { vfs, _context: context, name }) })
        }
    }
    pub fn open(&self, writable: bool) -> rusqlite::Result<QuotaConnection> {
        let shm_guard = if writable { None } else {
            let mut options = std::fs::OpenOptions::new(); options.read(true);
            #[cfg(windows)] {
                use std::os::windows::fs::OpenOptionsExt;
                // Pin the existing name while the system VFS maps it. Without
                // this handle, Windows OPEN_ALWAYS could recreate a removed SHM.
                options.share_mode(1 | 2);
            }
            let guard = options.open(format!("{}-shm", self.path.display())).map_err(|_| unavailable_shm())?;
            if guard.metadata().map_err(|_| unavailable_shm())?.len() < 32 << 10 { return Err(unavailable_shm()); }
            Some(guard)
        };
        let flags = if writable { OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE } else { OpenFlags::SQLITE_OPEN_READ_ONLY };
        let readonly = if writable { None } else {
            Some(Self::register_mode(&self.path, self.limits, true).map_err(|_| unavailable_shm())?)
        };
        let registration = readonly.as_ref().map_or(&self.inner, |quota| &quota.inner);
        // URI parsing belongs to SQLite, before xFullPathname/xOpen. SQLite owns
        // the decoded filename and its NUL-separated parameters until xClose.
        // Passing a temporary URI string directly to the system VFS is invalid.
        let path = if writable { self.path.clone() } else {
            let mut uri = String::from("file:");
            for byte in self.path.to_string_lossy().bytes() {
                if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b':' | b'.' | b'_' | b'-') { uri.push(byte as char); }
                else { uri.push_str(&format!("%{byte:02X}")); }
            }
            uri.push_str("?mode=ro&readonly_shm=1"); PathBuf::from(uri)
        };
        let connection = Connection::open_with_flags_and_vfs(path, flags | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI,
            registration.name.to_str().expect("generated ASCII VFS name"))?;
        if writable {
            // Readers require existing sidecars. Windows retries deleting their
            // pinned SHM name under SQLite's global mutex, stalling other DBs.
            // Retain these already quota-bounded fixed files on normal close.
            let mut persist: std::os::raw::c_int = 1;
            let result = unsafe { ffi::sqlite3_file_control(connection.handle(), c"main".as_ptr(),
                ffi::SQLITE_FCNTL_PERSIST_WAL, (&mut persist as *mut std::os::raw::c_int).cast()) };
            if result != ffi::SQLITE_OK { return Err(rusqlite::Error::SqliteFailure(ffi::Error::new(result), None)); }
        }
        Ok(QuotaConnection { connection, _shm_guard: shm_guard, _registration: registration.clone() })
    }
    #[cfg(test)]
    pub fn fail_after_writes(&self, count: isize) {
        self.inner._context.fault_after.store(count, std::sync::atomic::Ordering::SeqCst);
    }
}
fn unavailable_shm() -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(ffi::Error::new(ffi::SQLITE_IOERR_SHMMAP), Some("cache shared memory is not ready for read-only access".into()))
}

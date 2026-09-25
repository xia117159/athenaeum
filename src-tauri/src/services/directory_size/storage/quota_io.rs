use super::ffi;
use std::{os::raw::{c_int, c_void}, ptr};
use super::super::super::artifacts::{Creation, Removal};

#[repr(C)]
pub(super) struct File {
    pub methods: *const ffi::sqlite3_io_methods, pub real: *mut ffi::sqlite3_file,
    pub limit: u64, pub shm: u64, pub writable: bool,
    pub path: *mut std::path::PathBuf, pub main: bool,
    #[cfg(test)] pub fault_after: *const std::sync::atomic::AtomicIsize,
}
unsafe fn file(raw: *mut ffi::sqlite3_file) -> &'static mut File { &mut *raw.cast() }
unsafe fn methods(file: &File) -> &ffi::sqlite3_io_methods { &*(*file.real).pMethods }
fn fits(offset: i64, bytes: c_int, limit: u64) -> bool {
    offset >= 0 && bytes >= 0 && (offset as u64).checked_add(bytes as u64).is_some_and(|end| end <= limit)
}
unsafe extern "C" fn close(raw: *mut ffi::sqlite3_file) -> c_int {
    let file = file(raw);
    let receipt = (file.main && file.writable).then(|| Removal::begin(&shm_path(file)));
    let result = (methods(file).xClose.unwrap())(file.real);
    if result == ffi::SQLITE_OK { if let Some(receipt) = receipt { receipt.finish(); } }
    drop(Box::from_raw(file.path)); file.path = ptr::null_mut();
    ffi::sqlite3_free(file.real.cast()); file.methods = ptr::null(); result
}
unsafe fn shm_path(file: &File) -> std::path::PathBuf { std::path::PathBuf::from(format!("{}-shm", (*file.path).display())) }
unsafe extern "C" fn read(raw: *mut ffi::sqlite3_file, out: *mut c_void, amount: c_int, offset: i64) -> c_int {
    let f = file(raw); (methods(f).xRead.unwrap())(f.real, out, amount, offset)
}
unsafe extern "C" fn write(raw: *mut ffi::sqlite3_file, data: *const c_void, amount: c_int, offset: i64) -> c_int {
    let f = file(raw);
    if !f.writable { return ffi::SQLITE_READONLY; }
    if !fits(offset, amount, f.limit) { return ffi::SQLITE_FULL; }
    #[cfg(test)] {
        use std::sync::atomic::Ordering;
        let fault = &*f.fault_after;
        if fault.load(Ordering::SeqCst) >= 0 && fault.fetch_sub(1, Ordering::SeqCst) == 0 {
            // A real partial OS write followed by failure, not a mock SQL error.
            if amount > 1 { (methods(f).xWrite.unwrap())(f.real, data, amount / 2, offset); }
            return ffi::SQLITE_IOERR_WRITE;
        }
    }
    (methods(f).xWrite.unwrap())(f.real, data, amount, offset)
}
unsafe extern "C" fn truncate(raw: *mut ffi::sqlite3_file, size: i64) -> c_int {
    let f = file(raw); if !f.writable { return ffi::SQLITE_READONLY; }
    if !fits(size, 0, f.limit) { return ffi::SQLITE_FULL; }
    (methods(f).xTruncate.unwrap())(f.real, size)
}
unsafe extern "C" fn sync(raw: *mut ffi::sqlite3_file, flags: c_int) -> c_int { let f = file(raw); (methods(f).xSync.unwrap())(f.real, flags) }
unsafe extern "C" fn size(raw: *mut ffi::sqlite3_file, out: *mut i64) -> c_int { let f = file(raw); (methods(f).xFileSize.unwrap())(f.real, out) }
unsafe extern "C" fn lock(raw: *mut ffi::sqlite3_file, flags: c_int) -> c_int { let f = file(raw); (methods(f).xLock.unwrap())(f.real, flags) }
unsafe extern "C" fn unlock(raw: *mut ffi::sqlite3_file, flags: c_int) -> c_int { let f = file(raw); (methods(f).xUnlock.unwrap())(f.real, flags) }
unsafe extern "C" fn reserved(raw: *mut ffi::sqlite3_file, out: *mut c_int) -> c_int { let f = file(raw); (methods(f).xCheckReservedLock.unwrap())(f.real, out) }
unsafe extern "C" fn control(raw: *mut ffi::sqlite3_file, operation: c_int, arg: *mut c_void) -> c_int {
    let f = file(raw);
    if operation == ffi::SQLITE_FCNTL_SIZE_HINT && !fits(*arg.cast::<i64>(), 0, f.limit) { return ffi::SQLITE_FULL; }
    if operation == ffi::SQLITE_FCNTL_CHUNK_SIZE {
        // OS allocation rounding must not grow past a previously checked end.
        let mut disabled: c_int = 0;
        return (methods(f).xFileControl.unwrap())(f.real, operation, (&mut disabled as *mut c_int).cast());
    }
    (methods(f).xFileControl.unwrap())(f.real, operation, arg)
}
unsafe extern "C" fn sector(raw: *mut ffi::sqlite3_file) -> c_int { let f = file(raw); (methods(f).xSectorSize.unwrap())(f.real) }
unsafe extern "C" fn characteristics(raw: *mut ffi::sqlite3_file) -> c_int { let f = file(raw); (methods(f).xDeviceCharacteristics.unwrap())(f.real) }
unsafe extern "C" fn shm_map(raw: *mut ffi::sqlite3_file, page: c_int, bytes: c_int, extend: c_int, out: *mut *mut c_void) -> c_int {
    let f = file(raw);
    *out = ptr::null_mut();
    if page < 0 || bytes <= 0 || ((page as u64) + 1).saturating_mul(bytes as u64) > f.shm { return ffi::SQLITE_IOERR_SHMSIZE; }
    // Plain SQLITE_READONLY means a valid read-only mapping to SQLite and is
    // converted to OK by walIndexPage. Returning it with NULL lets recovery
    // dereference NULL. Use an actual map failure when growth is prohibited.
    if extend != 0 && !f.writable { return ffi::SQLITE_IOERR_SHMMAP; }
    let receipt = (extend != 0 && f.main).then(|| Creation::begin(&shm_path(f)));
    let result = methods(f).xShmMap.map_or(ffi::SQLITE_IOERR_SHMMAP, |call| call(f.real, page, bytes, extend, out));
    if result == ffi::SQLITE_OK { if let Some(receipt) = receipt { receipt.finish(); } }
    if !f.writable {
        // The Windows VFS can reuse a writable process-wide SHM node. Mark this
        // connection read-only even when that shared node has a writable map.
        if result == ffi::SQLITE_READONLY_CANTINIT { *out = ptr::null_mut(); return ffi::SQLITE_IOERR_SHMMAP; }
        if matches!(result, ffi::SQLITE_OK | ffi::SQLITE_READONLY) {
            return if (*out).is_null() { ffi::SQLITE_IOERR_SHMMAP } else { ffi::SQLITE_READONLY };
        }
    }
    result
}
unsafe extern "C" fn shm_lock(raw: *mut ffi::sqlite3_file, offset: c_int, n: c_int, flags: c_int) -> c_int {
    let f = file(raw); methods(f).xShmLock.map_or(ffi::SQLITE_IOERR_SHMLOCK, |call| call(f.real, offset, n, flags))
}
unsafe extern "C" fn barrier(raw: *mut ffi::sqlite3_file) { let f = file(raw); if let Some(call) = methods(f).xShmBarrier { call(f.real); } }
unsafe extern "C" fn shm_unmap(raw: *mut ffi::sqlite3_file, delete: c_int) -> c_int {
    let f = file(raw);
    let receipt = (delete != 0 && f.writable && f.main).then(|| Removal::begin(&shm_path(f)));
    let result = methods(f).xShmUnmap.map_or(ffi::SQLITE_OK, |call| call(f.real, if f.writable { delete } else { 0 }));
    if result == ffi::SQLITE_OK { if let Some(receipt) = receipt { receipt.finish(); } } result
}
// Do not allow mmap to bypass the accounted page cache or the guarded write path.
unsafe extern "C" fn fetch(_: *mut ffi::sqlite3_file, _: i64, _: c_int, out: *mut *mut c_void) -> c_int { *out = ptr::null_mut(); ffi::SQLITE_OK }
unsafe extern "C" fn unfetch(_: *mut ffi::sqlite3_file, _: i64, _: *mut c_void) -> c_int { ffi::SQLITE_OK }
pub(super) static METHODS: ffi::sqlite3_io_methods = ffi::sqlite3_io_methods { iVersion: 3,
    xClose: Some(close), xRead: Some(read), xWrite: Some(write), xTruncate: Some(truncate), xSync: Some(sync),
    xFileSize: Some(size), xLock: Some(lock), xUnlock: Some(unlock), xCheckReservedLock: Some(reserved),
    xFileControl: Some(control), xSectorSize: Some(sector), xDeviceCharacteristics: Some(characteristics),
    xShmMap: Some(shm_map), xShmLock: Some(shm_lock), xShmBarrier: Some(barrier), xShmUnmap: Some(shm_unmap),
    xFetch: Some(fetch), xUnfetch: Some(unfetch) };

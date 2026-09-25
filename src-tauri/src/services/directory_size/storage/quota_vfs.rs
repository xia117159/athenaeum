use super::{ffi, io, Context};
use std::{ffi::CStr, os::raw::{c_char, c_int, c_void}, ptr};
use super::super::super::artifacts::{Creation, Removal};

unsafe fn context(vfs: *mut ffi::sqlite3_vfs) -> &'static Context { &*((*vfs).pAppData.cast()) }
unsafe fn known(ctx: &Context, name: *const c_char) -> Option<(usize, u64)> {
    if name.is_null() { return None; }
    let name = CStr::from_ptr(name).to_str().ok()?;
    // SQLite already decoded URI parameters before calling xOpen. A literal
    // '%' or the '?' in a verbatim Windows path must remain part of its name.
    let path = super::super::super::target::normalize_local_path(name).ok()?;
    ctx.paths.iter().enumerate().find(|(_, (key, _))| key == &path).map(|(index, (_, limit))| (index, *limit))
}

unsafe extern "C" fn open(vfs: *mut ffi::sqlite3_vfs, name: *const c_char, file: *mut ffi::sqlite3_file, flags: c_int, out: *mut c_int) -> c_int {
    (*file).pMethods = ptr::null();
    let ctx = context(vfs);
    let Some((kind, limit)) = known(ctx, name) else { return ffi::SQLITE_CANTOPEN; };
    let expected = [ffi::SQLITE_OPEN_MAIN_DB, ffi::SQLITE_OPEN_WAL, ffi::SQLITE_OPEN_MAIN_JOURNAL][kind];
    if flags & expected == 0 { return ffi::SQLITE_CANTOPEN; }
    let real = ffi::sqlite3_malloc((*ctx.base).szOsFile).cast::<ffi::sqlite3_file>();
    if real.is_null() { return ffi::SQLITE_NOMEM; }
    ptr::write_bytes(real.cast::<u8>(), 0, (*ctx.base).szOsFile as usize);
    let path = std::path::PathBuf::from(&ctx.paths[kind].0);
    let creation = (!ctx.readonly && flags & ffi::SQLITE_OPEN_CREATE != 0).then(|| Creation::begin(&path));
    // A read-only connection may ask to open WAL with write/create flags.
    // Apply ownership to every file, not only the main database handle.
    let flags = if ctx.readonly {
        (flags & !(ffi::SQLITE_OPEN_READWRITE | ffi::SQLITE_OPEN_CREATE | ffi::SQLITE_OPEN_DELETEONCLOSE)) | ffi::SQLITE_OPEN_READONLY
    } else { flags };
    let result = ((*ctx.base).xOpen.unwrap())(ctx.base, name, real, flags, out);
    if result != ffi::SQLITE_OK {
        if !(*real).pMethods.is_null() { ((*(*real).pMethods).xClose.unwrap())(real); }
        ffi::sqlite3_free(real.cast()); return result;
    }
    if let Some(creation) = creation { creation.finish(); }
    ptr::write(file.cast::<io::File>(), io::File { methods: &io::METHODS, real, limit, shm: ctx.shm,
        writable: flags & ffi::SQLITE_OPEN_READWRITE != 0,
        path: Box::into_raw(Box::new(path)), main: kind == 0,
        #[cfg(test)] fault_after: &ctx.fault_after,
    });
    ffi::SQLITE_OK
}
unsafe extern "C" fn delete(vfs: *mut ffi::sqlite3_vfs, name: *const c_char, sync: c_int) -> c_int {
    let ctx = context(vfs);
    if ctx.readonly { return ffi::SQLITE_READONLY; }
    let Some((kind, _)) = known(ctx, name) else { return ffi::SQLITE_IOERR_DELETE; };
    let receipt = Removal::begin(std::path::Path::new(&ctx.paths[kind].0));
    let result = ((*ctx.base).xDelete.unwrap())(ctx.base, name, sync);
    if result == ffi::SQLITE_OK { receipt.finish(); } result
}
unsafe extern "C" fn access(vfs: *mut ffi::sqlite3_vfs, name: *const c_char, flags: c_int, out: *mut c_int) -> c_int {
    let ctx = context(vfs);
    if known(ctx, name).is_none() { *out = 0; return ffi::SQLITE_OK; }
    ((*ctx.base).xAccess.unwrap())(ctx.base, name, flags, out)
}
unsafe extern "C" fn full_path(vfs: *mut ffi::sqlite3_vfs, name: *const c_char, size: c_int, out: *mut c_char) -> c_int {
    let base = context(vfs).base; ((*base).xFullPathname.unwrap())(base, name, size, out)
}
unsafe extern "C" fn randomness(vfs: *mut ffi::sqlite3_vfs, size: c_int, out: *mut c_char) -> c_int {
    let base = context(vfs).base; ((*base).xRandomness.unwrap())(base, size, out)
}
unsafe extern "C" fn sleep(vfs: *mut ffi::sqlite3_vfs, micros: c_int) -> c_int {
    let base = context(vfs).base; ((*base).xSleep.unwrap())(base, micros)
}
unsafe extern "C" fn time(vfs: *mut ffi::sqlite3_vfs, out: *mut f64) -> c_int {
    let base = context(vfs).base; ((*base).xCurrentTime.unwrap())(base, out)
}
unsafe extern "C" fn time64(vfs: *mut ffi::sqlite3_vfs, out: *mut i64) -> c_int {
    let base = context(vfs).base; ((*base).xCurrentTimeInt64.unwrap())(base, out)
}
unsafe extern "C" fn error(vfs: *mut ffi::sqlite3_vfs, size: c_int, out: *mut c_char) -> c_int {
    let base = context(vfs).base; (*base).xGetLastError.map_or(0, |f| f(base, size, out))
}

pub(super) unsafe fn build(base: *mut ffi::sqlite3_vfs, context: *mut Context, name: *const c_char) -> ffi::sqlite3_vfs {
    ffi::sqlite3_vfs { iVersion: 2, szOsFile: std::mem::size_of::<io::File>() as c_int, mxPathname: (*base).mxPathname,
        pNext: ptr::null_mut(), zName: name, pAppData: context.cast::<c_void>(), xOpen: Some(open), xDelete: Some(delete),
        xAccess: Some(access), xFullPathname: Some(full_path), xDlOpen: None, xDlError: None, xDlSym: None, xDlClose: None,
        xRandomness: Some(randomness), xSleep: Some(sleep), xCurrentTime: Some(time), xGetLastError: Some(error),
        xCurrentTimeInt64: Some(time64), xSetSystemCall: None, xGetSystemCall: None, xNextSystemCall: None }
}

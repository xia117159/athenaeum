use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

use anyhow::{anyhow, Context, Result};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AtomicWriteFault {
    AfterTempCreate,
    AfterWrite,
    AfterFlush,
    AfterFileSync,
    BeforeCommit,
    ParentDirectorySync,
}

#[cfg(windows)]
fn replace_file(temp_path: &Path, destination: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH},
    };
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let replacement = temp_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    unsafe {
        ReplaceFileW(
            PCWSTR(destination.as_ptr()),
            PCWSTR(replacement.as_ptr()),
            PCWSTR::null(),
            REPLACEFILE_WRITE_THROUGH,
            None,
            None,
        )
    }
    .context("failed to atomically replace file")
}

#[cfg(not(windows))]
fn replace_file(temp_path: &Path, destination: &Path) -> Result<()> {
    fs::rename(temp_path, destination).context("failed to atomically replace file")
}

#[cfg(not(windows))]
fn sync_parent_directory(destination: &Path) -> Result<()> {
    let Some(parent) = destination.parent() else {
        return Ok(());
    };
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .context("failed to sync persistence parent directory")
}

#[cfg(windows)]
fn sync_parent_directory(_destination: &Path) -> Result<()> {
    Ok(())
}

fn inject_fault(fault: Option<AtomicWriteFault>, stage: AtomicWriteFault) -> Result<()> {
    if fault == Some(stage) {
        return Err(anyhow!("injected atomic persistence failure at {stage:?}"));
    }
    Ok(())
}

fn write_atomically_impl(
    destination: &Path,
    bytes: &[u8],
    fault: Option<AtomicWriteFault>,
) -> Result<()> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).context("failed to create persistence directory")?;
    }
    let temp_path = destination.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .context("failed to create persistence temp file")?;
        inject_fault(fault, AtomicWriteFault::AfterTempCreate)?;
        file.write_all(bytes)
            .context("failed to write persistence temp file")?;
        inject_fault(fault, AtomicWriteFault::AfterWrite)?;
        file.flush()
            .context("failed to flush persistence temp file")?;
        inject_fault(fault, AtomicWriteFault::AfterFlush)?;
        file.sync_all()
            .context("failed to sync persistence temp file")?;
        inject_fault(fault, AtomicWriteFault::AfterFileSync)?;
        drop(file);
        inject_fault(fault, AtomicWriteFault::BeforeCommit)?;
        if destination.exists() {
            replace_file(&temp_path, destination)
        } else {
            fs::rename(&temp_path, destination).context("failed to install persistence file")
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
        return result;
    }

    if let Err(error) = inject_fault(fault, AtomicWriteFault::ParentDirectorySync)
        .and_then(|_| sync_parent_directory(destination))
    {
        eprintln!("warning: persistence committed but parent directory sync failed: {error}");
    }
    Ok(())
}

pub fn write_atomically(destination: &Path, bytes: &[u8]) -> Result<()> {
    write_atomically_impl(destination, bytes, None)
}

#[cfg(test)]
fn write_atomically_with_fault(
    destination: &Path,
    bytes: &[u8],
    fault: Option<AtomicWriteFault>,
) -> Result<()> {
    write_atomically_impl(destination, bytes, fault)
}

#[cfg(test)]
mod tests {
    use super::{write_atomically_with_fault, AtomicWriteFault};
    use std::{fs, path::PathBuf};

    fn temp_directory(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("athenaeum-atomic-{name}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn pre_commit_failures_preserve_destination_and_remove_temp_files() {
        for fault in [
            AtomicWriteFault::AfterTempCreate,
            AtomicWriteFault::AfterWrite,
            AtomicWriteFault::AfterFlush,
            AtomicWriteFault::AfterFileSync,
            AtomicWriteFault::BeforeCommit,
        ] {
            let directory = temp_directory("pre-commit");
            fs::create_dir_all(&directory).expect("create temp directory");
            let destination = directory.join("metadata.json");
            fs::write(&destination, b"old").expect("write destination");

            assert!(write_atomically_with_fault(&destination, b"new", Some(fault)).is_err());
            assert_eq!(fs::read(&destination).expect("read destination"), b"old");
            assert_eq!(fs::read_dir(&directory).expect("read directory").count(), 1);

            fs::remove_dir_all(directory).expect("remove temp directory");
        }
    }

    #[test]
    fn successful_commit_replaces_existing_destination() {
        let directory = temp_directory("replace");
        fs::create_dir_all(&directory).expect("create temp directory");
        let destination = directory.join("metadata.json");
        fs::write(&destination, b"old").expect("write destination");

        write_atomically_with_fault(&destination, b"new", None).expect("replace destination");
        assert_eq!(fs::read(&destination).expect("read destination"), b"new");
        assert_eq!(fs::read_dir(&directory).expect("read directory").count(), 1);

        fs::remove_dir_all(directory).expect("remove temp directory");
    }

    #[test]
    fn post_commit_parent_sync_failure_keeps_committed_result() {
        let directory = temp_directory("post-commit");
        let destination = directory.join("metadata.json");

        write_atomically_with_fault(
            &destination,
            b"committed",
            Some(AtomicWriteFault::ParentDirectorySync),
        )
        .expect("post-commit sync warning must not report rollback");
        assert_eq!(
            fs::read(&destination).expect("read destination"),
            b"committed"
        );

        fs::remove_dir_all(directory).expect("remove temp directory");
    }
}

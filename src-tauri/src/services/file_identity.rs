//! Shared on-disk identity contract. Callers choose their own handle access/share policy.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIdentity {
    pub version: u32,
    pub volume: u64,
    pub id: [u8; 16],
    pub id_bits: u8,
    pub created: i64,
    pub kind: u32,
    pub stable: bool,
}

impl FileIdentity {
    pub fn is_directory(&self) -> bool {
        self.kind & 0x10 != 0
    }
}

#[cfg(windows)]
pub(crate) fn read(handle: windows::Win32::Foundation::HANDLE) -> anyhow::Result<FileIdentity> {
    use anyhow::Context;
    use windows::Win32::Storage::FileSystem::*;
    let mut basic = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(handle, &mut basic) }.context("无法读取文件身份")?;
    let mut filesystem = [0u16; 64];
    unsafe { GetVolumeInformationByHandleW(handle, None, None, None, None, Some(&mut filesystem)) }
        .context("无法读取卷能力，尚未改动文件")?;
    let end = filesystem
        .iter()
        .position(|ch| *ch == 0)
        .unwrap_or(filesystem.len());
    let filesystem = String::from_utf16_lossy(&filesystem[..end]).to_ascii_uppercase();
    let mut info = FILE_ID_INFO::default();
    let full = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileIdInfo,
            (&mut info as *mut FILE_ID_INFO).cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    }
    .ok()
    .filter(|_| info.FileId.Identifier != [0; 16])
    .map(|_| (info.VolumeSerialNumber, info.FileId.Identifier));
    let index = (basic.nFileIndexHigh as u64) << 32 | basic.nFileIndexLow as u64;
    let (volume, id, id_bits) = select_id(&filesystem, full, basic.dwVolumeSerialNumber, index)?;
    Ok(FileIdentity {
        version: 1,
        volume,
        id,
        id_bits,
        created: ((basic.ftCreationTime.dwHighDateTime as u64) << 32
            | basic.ftCreationTime.dwLowDateTime as u64) as i64,
        kind: basic.dwFileAttributes
            & (FILE_ATTRIBUTE_DIRECTORY.0 | FILE_ATTRIBUTE_REPARSE_POINT.0),
        stable: matches!(filesystem.as_str(), "NTFS" | "REFS"),
    })
}

#[cfg(any(windows, test))]
fn select_id(
    filesystem: &str,
    full: Option<(u64, [u8; 16])>,
    volume: u32,
    index: u64,
) -> anyhow::Result<(u64, [u8; 16], u8)> {
    if let Some((volume, id)) = full.filter(|(_, id)| *id != [0; 16]) {
        return Ok((volume, id, 128));
    }
    if !matches!(filesystem, "NTFS" | "FAT" | "FAT32" | "EXFAT") || index == 0 {
        anyhow::bail!("卷 {filesystem} 无法提供可靠文件身份，尚未改动文件");
    }
    let mut id = [0; 16];
    id[..8].copy_from_slice(&index.to_le_bytes());
    Ok((volume as u64, id, 64))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_id_never_truncates_and_legacy_fallback_excludes_refs() {
        let full = [0x92; 16];
        assert_eq!(
            select_id("REFS", Some((u64::MAX, full)), 3, 4).unwrap(),
            (u64::MAX, full, 128)
        );
        for filesystem in ["REFS", "unknown"] {
            assert!(select_id(filesystem, None, 1, 4).is_err());
            assert!(select_id(filesystem, Some((1, [0; 16])), 1, 4).is_err());
        }
        for filesystem in ["NTFS", "FAT", "FAT32", "EXFAT"] {
            assert_eq!(select_id(filesystem, None, 1, 4).unwrap().2, 64);
            assert!(select_id(filesystem, None, 1, 0).is_err());
        }
    }
}

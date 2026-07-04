use crate::domain::models::DriveRoot;

/// Drive type constants from the Windows API (Win32::Storage::FileSystem).
const DRIVE_UNKNOWN: u32 = 0;
const DRIVE_NO_ROOT_DIR: u32 = 1;
const DRIVE_REMOVABLE: u32 = 2;
const DRIVE_FIXED: u32 = 3;
const DRIVE_REMOTE: u32 = 4;
const DRIVE_CDROM: u32 = 5;
const DRIVE_RAMDISK: u32 = 6;

/// Lists all drive roots on the system with their type, total bytes, and available bytes.
///
/// On Windows, uses `GetLogicalDrives`, `GetDriveTypeW`, `GetDiskFreeSpaceExW`,
/// and `GetVolumeInformationW` to enumerate drives and gather metadata.
/// On non-Windows, returns an empty list.
pub fn list_drive_roots() -> Vec<DriveRoot> {
    #[cfg(windows)]
    {
        list_drive_roots_windows()
    }

    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[cfg(windows)]
fn list_drive_roots_windows() -> Vec<DriveRoot> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives,
    };

    let mask = unsafe { GetLogicalDrives() };

    let mut roots = Vec::new();

    for index in 0..26u32 {
        if mask & (1 << index) == 0 {
            continue;
        }

        let letter = (b'A' + index as u8) as char;
        let drive_path = format!("{letter}:\\");
        let wide_path: Vec<u16> = drive_path.encode_utf16().chain(std::iter::once(0)).collect();
        let pcwstr = PCWSTR(wide_path.as_ptr());

        let drive_type = unsafe { GetDriveTypeW(pcwstr) };

        let drive_type_str = match drive_type {
            DRIVE_FIXED => "local",
            DRIVE_REMOVABLE => "removable",
            DRIVE_REMOTE => "network",
            DRIVE_CDROM => "cdrom",
            DRIVE_RAMDISK => "ramdisk",
            DRIVE_UNKNOWN | DRIVE_NO_ROOT_DIR => "unknown",
            _ => "unknown",
        }
        .to_string();

        let (total_bytes, available_bytes) = {
            let mut free_to_caller: u64 = 0;
            let mut total: u64 = 0;
            let mut _total_free: u64 = 0;
            let result = unsafe {
                GetDiskFreeSpaceExW(
                    pcwstr,
                    Some(&mut free_to_caller as *mut _),
                    Some(&mut total as *mut _),
                    Some(&mut _total_free as *mut _),
                )
            };
            if result.is_ok() {
                (Some(total), Some(free_to_caller))
            } else {
                (None, None)
            }
        };

        let volume_label = get_volume_label(&wide_path);
        let drive_letter = &drive_path[..2]; // "C:"
        let label = match volume_label {
            Some(name) => format!("{name} ({drive_letter})"),
            None => drive_path.clone(),
        };

        roots.push(DriveRoot {
            path: drive_path,
            label,
            drive_type: drive_type_str,
            total_bytes,
            available_bytes,
        });
    }

    roots
}

#[cfg(windows)]
fn get_volume_label(wide_path: &[u16]) -> Option<String> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetVolumeInformationW;

    let mut volume_name_buffer = [0u16; 261];
    let result = unsafe {
        GetVolumeInformationW(
            PCWSTR(wide_path.as_ptr()),
            Some(&mut volume_name_buffer),
            None,
            None,
            None,
            None,
        )
    };

    if result.is_err() {
        return None;
    }

    let len = volume_name_buffer
        .iter()
        .position(|&c| c == 0)
        .unwrap_or(volume_name_buffer.len());
    if len == 0 {
        return None;
    }

    String::from_utf16(&volume_name_buffer[..len]).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_drive_roots_returns_struct_with_expected_fields() {
        let roots = list_drive_roots();
        for root in &roots {
            assert!(!root.path.is_empty());
            assert!(!root.label.is_empty());
            assert!(
                ["local", "removable", "network", "cdrom", "ramdisk", "unknown"]
                    .contains(&root.drive_type.as_str()),
                "unexpected drive type: {}",
                root.drive_type
            );
            if root.total_bytes.is_some() {
                assert!(root.available_bytes.is_some());
            }
        }
    }

    #[test]
    fn list_drive_roots_paths_are_drive_roots() {
        let roots = list_drive_roots();
        for root in &roots {
            #[cfg(windows)]
            {
                assert!(
                    root.path.len() == 3
                        && root.path.as_bytes()[1] == b':'
                        && root.path.as_bytes()[2] == b'\\',
                    "expected drive root path, got: {}",
                    root.path
                );
            }
        }
    }
}

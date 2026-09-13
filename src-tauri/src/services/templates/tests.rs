use super::*;
use crate::domain::models::TemplateEntryKind;
use std::{fs, path::PathBuf};

pub(super) struct TestDir(pub PathBuf);
impl TestDir {
    pub fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("athenaeum-templates-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    pub fn text(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn template_native_same_parent_rename_keeps_guards_and_never_overwrites() {
    use std::os::windows::fs::OpenOptionsExt;
    for directory in [false, true] {
        let root = TestDir::new();
        let original = root.0.join("original");
        if directory {
            fs::create_dir(&original).unwrap();
            fs::write(original.join("content.txt"), "retained").unwrap();
        } else {
            fs::write(&original, "retained").unwrap();
        }
        let parent = native::DirectoryGuard::open(&root.0).unwrap();
        let item = native::EntryHandle::open(&original, true).unwrap();
        let parent_writer = || {
            fs::OpenOptions::new()
                .access_mode(0x40000000)
                .share_mode(7)
                .custom_flags(0x02000000)
                .open(&root.0)
        };
        assert!(
            parent_writer().is_err(),
            "the parent remains protected against reparse writers"
        );
        item.rename_to(&parent, "recovered").unwrap();
        assert!(!original.exists());
        assert!(parent_writer().is_err());
        let recovered = root.0.join("recovered");
        let content = if directory {
            recovered.join("content.txt")
        } else {
            recovered.clone()
        };
        assert_eq!(fs::read(content).unwrap(), b"retained");
        fs::write(root.0.join("occupied"), "foreign").unwrap();
        assert!(item.rename_to(&parent, "occupied").is_err());
        assert_eq!(fs::read(root.0.join("occupied")).unwrap(), b"foreign");
        assert!(recovered.exists());
        let other = TestDir::new();
        let other_parent = native::DirectoryGuard::open(&other.0).unwrap();
        assert!(item.rename_to(&other_parent, "misdirected").is_err());
        assert!(!other.0.join("misdirected").exists());
        assert!(!root.0.join("misdirected").exists());
    }
}

#[test]
fn template_identity_journal_keeps_the_entire_windows_file_id() {
    let root = TestDir::new();
    let handle = native::EntryHandle::open(&root.0, false).unwrap();
    let original = serde_json::to_value(&handle.identity).unwrap();
    assert_eq!(
        original["idBits"], 128,
        "NTFS full FileIdInfo must be retained"
    );
    let mut changed = original.clone();
    let id = changed["id"].as_array_mut().unwrap();
    id[15] = serde_json::Value::from(id[15].as_u64().unwrap() ^ 1);
    let changed: owned::Identity = serde_json::from_value(changed).unwrap();
    assert_ne!(
        handle.identity, changed,
        "the high 64 bits are part of object identity"
    );
    assert!(!owned::same_identity(&handle.identity, &changed));
    let roundtrip: owned::Identity = serde_json::from_value(original).unwrap();
    assert_eq!(handle.identity, roundtrip);
}

#[test]
fn template_catalog_accepts_a_real_windows_short_root_alias() {
    use std::os::windows::ffi::OsStrExt;
    use windows::{core::PCWSTR, Win32::Storage::FileSystem::GetShortPathNameW};
    let root = TestDir::new();
    fs::write(root.0.join("sample.txt"), "template").unwrap();
    let wide = root
        .0
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut output = vec![0u16; 32768];
    let len = unsafe { GetShortPathNameW(PCWSTR(wide.as_ptr()), Some(&mut output)) } as usize;
    assert!(len > 0 && len < output.len());
    let alias = String::from_utf16(&output[..len]).unwrap();
    // Volumes may disable 8.3 generation; still exercise the API's actual result.
    let listing = list(&alias, &alias, "").unwrap();
    assert_eq!(listing.entries.len(), 1);
    assert!(same_path(Path::new(&listing.root_path), &root.0));
    assert!(list(&root.text(), &TestDir::new().text(), "").is_err());
}

#[test]
fn template_catalog_is_one_level_sorted_and_preserves_relative_paths() {
    let root = TestDir::new();
    fs::create_dir_all(root.0.join("Word/报告")).unwrap();
    fs::write(root.0.join("Word/新文件.docx"), "content").unwrap();
    fs::write(root.0.join("new_cpp.cpp"), "int main(){}").unwrap();
    let top = list(&root.text(), "", "").unwrap();
    assert_eq!(
        top.entries
            .iter()
            .map(|e| e.name.as_str())
            .collect::<Vec<_>>(),
        ["Word", "new_cpp.cpp"]
    );
    assert_eq!(top.entries[0].kind, TemplateEntryKind::Directory);
    let word = list(&root.text(), &top.root_path, "Word").unwrap();
    assert_eq!(word.entries[1].relative_path, "Word/新文件.docx");
    assert_eq!(word.entries[1].kind, TemplateEntryKind::File);
    assert!(list(&root.text(), r"C:\different", "").is_err());
}

#[test]
fn template_catalog_rejects_traversal_and_links() {
    let root = TestDir::new();
    for relative in [
        "..",
        "../outside",
        r"C:\Windows",
        r"\Windows",
        "a//b",
        "a/./b",
        "file:stream",
    ] {
        assert!(list(&root.text(), "", relative).is_err(), "{relative}");
    }
    let link = root.0.join("escape");
    let external = TestDir::new();
    let output = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&link)
        .arg(&external.0)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "junction fixture: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(list(&root.text(), "", "escape").is_err());
    // Removing a junction is nonrecursive and never touches its target.
    fs::remove_dir(&link).unwrap();
}

use std::path::PathBuf;

use super::{artifact::InspectedPathIdentity, EntryType, FileIdentity};

fn identity(entry_type: EntryType, id: u64) -> FileIdentity {
    FileIdentity {
        entry_type,
        #[cfg(windows)]
        volume_serial_number: 1,
        #[cfg(windows)]
        file_index: id,
        #[cfg(unix)]
        device: 1,
        #[cfg(unix)]
        inode: id,
        #[cfg(not(any(windows, unix)))]
        length: id,
    }
}

#[test]
fn identity_overlap_keeps_distinct_case_sensitive_siblings_separate() {
    let root = identity(EntryType::Directory, 1);
    let left = InspectedPathIdentity::for_test(
        vec![root, identity(EntryType::File, 2)],
        PathBuf::from("Payload.bin"),
    );
    let distinct = InspectedPathIdentity::for_test(
        vec![root, identity(EntryType::File, 3)],
        PathBuf::from("payload.bin"),
    );
    let same = InspectedPathIdentity::for_test(
        vec![root, identity(EntryType::File, 2)],
        PathBuf::from("Payload.bin"),
    );

    assert!(!left.overlaps(&distinct));
    assert!(left.overlaps(&same));
}

#[test]
fn identity_vector_overlap_requires_one_chain_to_be_an_identity_prefix() {
    let root = identity(EntryType::Directory, 1);
    let parent = identity(EntryType::Directory, 2);
    let child = identity(EntryType::File, 3);
    let sibling = identity(EntryType::File, 4);
    let ancestor = InspectedPathIdentity::for_test(vec![root, parent], "parent".into());
    let descendant =
        InspectedPathIdentity::for_test(vec![root, parent, child], "parent/child".into());
    let distinct_sibling =
        InspectedPathIdentity::for_test(vec![root, parent, sibling], "parent/sibling".into());
    let same_object_different_entry =
        InspectedPathIdentity::for_test(vec![root, parent, child], "parent/other".into());
    let same_leaf_different_parent = InspectedPathIdentity::for_test(
        vec![root, identity(EntryType::Directory, 5), child],
        "other/child".into(),
    );

    assert!(ancestor.overlaps(&descendant));
    assert!(descendant.overlaps(&ancestor));
    assert!(!descendant.overlaps(&distinct_sibling));
    assert!(!descendant.overlaps(&same_object_different_entry));
    assert!(!descendant.overlaps(&same_leaf_different_parent));
}

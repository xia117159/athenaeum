/// Raw types are retained before a listing projects special/unknown entries to UI files.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MetadataKind {
    File(u64),
    Directory,
    Link,
    Special,
    Unknown,
}

#[derive(Debug, Clone)]
pub(crate) struct MetadataEntry {
    pub name: String,
    pub kind: MetadataKind,
    pub directory_path: Option<String>,
}

#[derive(Default)]
pub(crate) struct ListingFingerprint {
    sum: [u8; 32],
    count: u64,
    invalid: bool,
}

impl ListingFingerprint {
    pub fn add(&mut self, name: &str, kind: MetadataKind) {
        use sha2::{Digest, Sha256};
        if name.is_empty() || kind == MetadataKind::Unknown {
            self.invalid = true;
            return;
        }
        let Some(count) = self.count.checked_add(1) else { self.invalid = true; return; };
        self.count = count;
        let mut hash = Sha256::new();
        hash.update(b"athenaeum-size-facts-v1\0");
        hash.update((name.len() as u64).to_le_bytes());
        hash.update(name.as_bytes());
        let (tag, bytes) = match kind {
            MetadataKind::File(bytes) => (1, bytes),
            MetadataKind::Directory => (2, 0),
            MetadataKind::Link => (3, 0),
            MetadataKind::Special => (4, 0),
            MetadataKind::Unknown => unreachable!(),
        };
        hash.update([tag]);
        hash.update(bytes.to_le_bytes());
        let digest = hash.finalize();
        // Addition mod 2^256 is order independent without XOR's duplicate-pair cancellation.
        let mut carry = 0_u16;
        for (sum, byte) in self.sum.iter_mut().zip(digest) {
            let next = u16::from(*sum) + u16::from(byte) + carry;
            *sum = next as u8;
            carry = next >> 8;
        }
    }

    pub fn finish(self) -> Option<String> {
        if self.invalid { return None; }
        use std::fmt::Write;
        let mut value = format!("v1:{}:", self.count);
        for byte in self.sum { let _ = write!(value, "{byte:02x}"); }
        Some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fingerprint(entries: &[(&str, MetadataKind)]) -> Option<String> {
        let mut value = ListingFingerprint::default();
        for (name, kind) in entries { value.add(name, *kind); }
        value.finish()
    }

    #[test]
    fn size_fingerprint_is_order_independent_but_preserves_multiplicity_and_raw_bytes() {
        let a = (".hidden", MetadataKind::File(9_007_199_254_740_993));
        let b = ("folder", MetadataKind::Directory);
        let first = fingerprint(&[a, b]);
        assert!(first.is_some(), "complete raw metadata must have a fingerprint");
        assert_eq!(first, fingerprint(&[b, a]));
        assert_ne!(first, fingerprint(&[a, a, b]));
        assert_ne!(fingerprint(&[]), fingerprint(&[a, a]));
        assert_ne!(first, fingerprint(&[(a.0, MetadataKind::File(9_007_199_254_740_992)), b]));
        assert_ne!(first, fingerprint(&[(a.0, MetadataKind::Link), b]));
    }

    #[test]
    fn size_fingerprint_rejects_unknown_metadata_and_delimits_names() {
        assert_eq!(fingerprint(&[("unknown", MetadataKind::Unknown)]), None);
        assert_eq!(fingerprint(&[("", MetadataKind::File(0))]), None);
        assert_ne!(fingerprint(&[("ab", MetadataKind::File(12))]), fingerprint(&[("ab1", MetadataKind::File(2))]));
        assert!(fingerprint(&[("link", MetadataKind::Link), ("pipe", MetadataKind::Special)]).is_some());
    }
}

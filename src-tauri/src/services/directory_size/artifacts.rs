//! Fixed cache membership, sampled independently from recursive directory scans.
use std::{collections::HashSet, path::Path, sync::{Arc, LazyLock, Mutex, Weak}};
use super::{metadata::MetadataKind, target::normalize_local_path, watch::RootIdentity};

const FILES: [&str; 7] = ["sizes.sqlite3", "sizes.sqlite3-wal", "sizes.sqlite3-shm", "sizes.sqlite3-journal", "startup.json", "startup.next", "writer.lock"];
static REGISTRIES: LazyLock<Mutex<Vec<Weak<Registry>>>> = LazyLock::new(|| Mutex::new(vec![]));

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(super) struct Contribution { pub bytes: u64, pub files: u64 }
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(super) struct Capture { pub policy: String, pub contribution: Contribution }
#[derive(Clone, Debug, PartialEq, Eq)]
struct Fact { path: String, bytes: u64, file: bool, trusted: bool, parent_valid: bool, pending: bool }
#[derive(Clone, Debug, PartialEq, Eq)]
struct ParentFact { path: String, stable: bool }
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct Snapshot { pub revision: u64, pub policy: String, facts: Vec<Fact>, parents: Vec<ParentFact> }
impl Snapshot {
    pub fn pending(&self, scope: &str) -> bool { self.facts.iter().any(|fact| fact.pending && Path::new(&fact.path).starts_with(scope)) }
    pub fn contribution(&self, scope: &str) -> Contribution {
        let mut value = Contribution::default();
        for fact in self.facts.iter().filter(|fact| fact.file && fact.parent_valid && Path::new(&fact.path).starts_with(scope)) {
            value.bytes = value.bytes.saturating_add(fact.bytes); value.files += 1;
        }
        value
    }
    pub fn suppress(&self, root: &str, relative: &str) -> bool {
        if relative.is_empty() || Path::new(relative).is_absolute() { return false; }
        let path = Path::new(root).join(relative);
        self.facts.iter().any(|fact| Path::new(&fact.path) == path && fact.trusted && fact.parent_valid)
    }
    pub fn overlaps(&self, scope: &str) -> bool { self.facts.iter().any(|fact| Path::new(&fact.path).starts_with(scope)) }
    pub fn suppress_parent_modified(&self, root: &str, relative: &str) -> bool {
        if relative.is_empty() || Path::new(relative).is_absolute() { return false; }
        let path = Path::new(root).join(relative);
        self.parents.iter().any(|parent| parent.stable && Path::new(&parent.path) == path)
    }
    pub fn capture(&self, scope: &str) -> Option<Capture> {
        self.overlaps(scope).then(|| Capture { policy: self.policy.clone(), contribution: self.contribution(scope) })
    }
    pub fn untrusted_changes(&self, previous: &Self) -> Vec<String> {
        self.facts.iter().filter(|fact| (!fact.trusted || !fact.parent_valid) && previous.facts.iter().any(|old| old.path == fact.path && old != *fact))
            .map(|fact| fact.path.clone()).collect()
    }
}
struct Member { path: String, expected: Option<RootIdentity>, owned_absent: bool, operation: usize }
struct State { members: Vec<Member>, snapshot: Arc<Snapshot>, epoch: u64 }
pub(super) struct Registry { parents: Vec<(String, (RootIdentity, u64))>, state: Mutex<State> }

fn parent_fact(path: &Path) -> Result<(RootIdentity, u64), String> {
    #[cfg(windows)] {
        let proof = path.to_str().and_then(super::rename_proof::read_proof).filter(|proof| proof.directory).ok_or("cache parent identity unavailable")?;
        Ok((proof.identity, u64::from(proof.attributes)))
    }
    #[cfg(not(windows))] {
        let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        Ok((super::watch::read_root_identity(path)?, u64::from(metadata.permissions().readonly())))
    }
}

fn registries() -> Vec<Arc<Registry>> {
    let mut list = REGISTRIES.lock().unwrap(); list.retain(|registry| registry.strong_count() != 0);
    list.iter().filter_map(Weak::upgrade).collect()
}
pub(super) fn file_fact(path: &str) -> Option<(RootIdentity, u64)> {
    #[cfg(windows)] {
        let proof = super::rename_proof::read_proof(path)?;
        return (!proof.directory).then_some((proof.identity, proof.bytes));
    }
    #[cfg(not(windows))]
    let metadata = std::fs::symlink_metadata(path).ok()?;
    #[cfg(not(windows))]
    if !matches!(super::local::local_metadata_kind(&metadata), MetadataKind::File(_)) { return None; }
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        let created = metadata.created().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
        Some((RootIdentity([metadata.dev(), metadata.ino(), created.as_secs(), u64::from(created.subsec_nanos())]), metadata.len()))
    }
    #[cfg(not(any(windows, unix)))] { None }
}
impl Registry {
    pub fn register(directory: &Path) -> anyhow::Result<Arc<Self>> {
        std::fs::create_dir_all(directory)?;
        let parent = normalize_local_path(directory.to_str().ok_or_else(|| anyhow::anyhow!("invalid cache directory"))?).map_err(anyhow::Error::msg)?;
        let identity = parent_fact(Path::new(&parent)).map_err(anyhow::Error::msg)?;
        let parents = vec![(parent.clone(), identity)];
        let paths = FILES.iter().map(|name| Path::new(&parent).join(name)).collect::<Vec<_>>();
        let members: Vec<_> = paths.into_iter().map(|path| {
            let path = path.to_string_lossy().into_owned();
            Member { expected: file_fact(&path).map(|(identity, _)| identity), path, owned_absent: false, operation: 0 }
        }).collect();
        use sha2::{Digest, Sha256};
        let policy = format!("{:x}", Sha256::digest(paths_key(&members)));
        let registry = Arc::new(Self { parents, state: Mutex::new(State { members, snapshot: Arc::new(Snapshot { policy, ..Default::default() }), epoch: 0 }) });
        registry.sample();
        REGISTRIES.lock().unwrap().push(Arc::downgrade(&registry)); Ok(registry)
    }
    pub fn sample(&self) -> Arc<Snapshot> {
        self.sample_with(file_fact)
    }
    fn sample_with(&self, read: impl Fn(&str) -> Option<(RootIdentity, u64)>) -> Arc<Snapshot> {
        // Metadata I/O occurs outside both the Core lock and this registry lock.
        let (epoch, paths) = {
            let state = self.state.lock().unwrap();
            (state.epoch, state.members.iter().map(|member| member.path.clone()).collect::<Vec<_>>())
        };
        let parents: Vec<_> = self.parents.iter().map(|(path, expected)| (path, parent_fact(Path::new(path)).ok().map(|identity| identity == *expected))).collect();
        let facts: Vec<_> = paths.iter().map(|path| {
            let fact = read(path);
            let metadata = std::fs::symlink_metadata(path);
            let absent = metadata.as_ref().is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound);
            let is_file = metadata.as_ref().is_ok_and(|metadata| matches!(super::local::local_metadata_kind(metadata), MetadataKind::File(_)));
            let pending = metadata.as_ref().is_err_and(|error| error.kind() != std::io::ErrorKind::NotFound)
                || is_file != fact.is_some() || is_file && file_fact(path) != fact;
            let parent_valid = parents.iter().find(|(parent, _)| Path::new(path).parent() == Some(Path::new(parent))).and_then(|(_, valid)| *valid);
            (fact, absent, parent_valid, pending)
        }).collect();
        let mut state = self.state.lock().unwrap();
        // An operation or newer sampler won while metadata was read without
        // locks. Its snapshot is authoritative; retry on the next normal tick.
        if state.epoch != epoch { return state.snapshot.clone(); }
        state.epoch += 1;
        let facts = state.members.iter().zip(facts).map(|(member, (file, absent, parent_valid, pending))| {
            if pending || parent_valid.is_none() {
                if let Some(previous) = state.snapshot.facts.iter().find(|fact| fact.path == member.path) {
                    return Fact { pending: true, ..previous.clone() };
                }
            }
            Fact { path: member.path.clone(), bytes: file.map_or(0, |(_, bytes)| bytes), file: file.is_some(), parent_valid: parent_valid.unwrap_or(false),
                pending: pending || parent_valid.is_none(),
                trusted: member.operation != 0 || file.is_some_and(|(identity, _)| member.expected == Some(identity)) || absent && member.owned_absent }
        }).collect();
        let parents: Vec<_> = parents.into_iter().map(|(path, valid)| ParentFact { path: path.clone(), stable: valid == Some(true) }).collect();
        if state.snapshot.facts != facts || state.snapshot.parents != parents {
            state.snapshot = Arc::new(Snapshot { revision: state.snapshot.revision + 1, policy: state.snapshot.policy.clone(), facts, parents });
        }
        state.snapshot.clone()
    }
    pub fn cached(&self) -> Arc<Snapshot> { self.state.lock().unwrap().snapshot.clone() }
    fn contains(&self, path: &str) -> bool { self.state.lock().unwrap().members.iter().any(|member| member.path == path) }
    fn claim(&self, path: &str, file: Option<(RootIdentity, u64)>) {
        let mut state = self.state.lock().unwrap();
        state.epoch += 1;
        if let Some(member) = state.members.iter_mut().find(|member| member.path == path) {
            member.expected = file.map(|(identity, _)| identity); member.owned_absent = file.is_none();
            let mut snapshot = (*state.snapshot).clone();
            if let Some(fact) = snapshot.facts.iter_mut().find(|fact| fact.path == path) {
                fact.file = file.is_some(); fact.bytes = file.map_or(0, |(_, bytes)| bytes);
                fact.trusted = true; fact.pending = false;
            }
            snapshot.revision += 1; state.snapshot = Arc::new(snapshot);
        }
    }
    pub fn suppress_in_flight(&self, root: &str, relative: &str) -> bool {
        if relative.is_empty() || Path::new(relative).is_absolute() { return false; }
        let path = Path::new(root).join(relative); let state = self.state.lock().unwrap();
        state.members.iter().any(|member| member.operation > 0 && Path::new(&member.path) == path
            && state.snapshot.facts.iter().any(|fact| fact.path == member.path && fact.parent_valid))
    }
    fn operation(&self, path: &str, begin: bool) {
        let mut state = self.state.lock().unwrap();
        state.epoch += 1;
        if let Some(member) = state.members.iter_mut().find(|member| member.path == path) {
            if begin { member.operation += 1; } else { member.operation = member.operation.saturating_sub(1); }
        }
    }
}
fn paths_key(members: &[Member]) -> Vec<u8> {
    let mut key = b"directory-size-managed-v2\0".to_vec();
    for member in members { key.extend_from_slice(member.path.as_bytes()); key.push(0); }
    key
}

/// Captured once per ordinary directory listing, never a registry lookup per file.
#[derive(Default)]
pub(crate) struct ListingPolicy { names: HashSet<String> }
impl ListingPolicy {
    pub fn excludes(&self, name: &str, kind: MetadataKind) -> bool { matches!(kind, MetadataKind::File(_)) && self.names.contains(name) }
}
pub(crate) fn listing_policy(path: &Path) -> ListingPolicy {
    let Some(path) = path.to_str().and_then(|path| normalize_local_path(path).ok()) else { return ListingPolicy::default(); };
    let mut policy = ListingPolicy::default();
    for registry in registries().into_iter().filter(|registry| registry.parents.iter().any(|(parent, _)| parent == &path)) {
        let snapshot = registry.sample();
        for fact in snapshot.facts.iter().filter(|fact| fact.parent_valid && Path::new(&fact.path).parent() == Some(Path::new(&path))) {
            if let Some(name) = Path::new(&fact.path).file_name().and_then(|name| name.to_str()) { policy.names.insert(name.into()); }
        }
    }
    policy
}

/// A receipt is tied to an actual filesystem creation, not a time-based ignore window.
pub(super) struct Creation { path: Option<String>, registries: Vec<Arc<Registry>> }
impl Creation {
    pub fn begin(path: &Path) -> Self {
        let normalized = path.to_str().and_then(|path| normalize_local_path(path).ok());
        let registries: Vec<Arc<Registry>> = normalized.as_deref().map(|path| registries().into_iter().filter(|registry| registry.contains(path)).collect()).unwrap_or_default();
        let absent = std::fs::symlink_metadata(path).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound);
        let path = normalized.filter(|_| absent);
        if let Some(path) = &path { for registry in &registries { registry.operation(path, true); } }
        Self { path, registries }
    }
    pub fn finish(self) {
        if let Some(path) = &self.path {
            if let Some(file) = file_fact(path) { for registry in &self.registries { registry.claim(path, Some(file)); } }
        }
    }
}
impl Drop for Creation { fn drop(&mut self) { if let Some(path) = &self.path { for registry in &self.registries { registry.operation(path, false); } } } }
pub(super) struct Removal { path: Option<String>, registries: Vec<Arc<Registry>> }

/// Both names are protected only for this registered, verified replacement.
pub(super) struct Replacement { source: String, destination: String, identity: Option<RootIdentity>, registries: Vec<Arc<Registry>> }
impl Replacement {
    pub fn begin(source: &Path, destination: &Path) -> Self {
        let source = source.to_str().and_then(|path| normalize_local_path(path).ok()).unwrap_or_default();
        let destination = destination.to_str().and_then(|path| normalize_local_path(path).ok()).unwrap_or_default();
        let identity = file_fact(&source).map(|(identity, _)| identity);
        let registries: Vec<_> = registries().into_iter().filter(|registry| registry.contains(&source) && registry.contains(&destination)).collect();
        for registry in &registries { registry.operation(&source, true); registry.operation(&destination, true); }
        Self { source, destination, identity, registries }
    }
    pub fn finish(self) {
        let destination = file_fact(&self.destination);
        let same = self.identity.zip(destination).is_some_and(|(before, (after, _))| {
            // ReplaceFile can preserve the target's creation time. The source
            // volume/file ID proves this registered replacement; retain the
            // complete *destination* identity for subsequent external checks.
            #[cfg(windows)] { before == after || before.0[1] != 0 && before.0[..2] == after.0[..2] }
            #[cfg(not(windows))] { before == after }
        });
        if same
            && std::fs::symlink_metadata(&self.source).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound) {
            for registry in &self.registries { registry.claim(&self.source, None); registry.claim(&self.destination, destination); }
        }
    }
}
impl Drop for Replacement { fn drop(&mut self) { for registry in &self.registries { registry.operation(&self.source, false); registry.operation(&self.destination, false); } } }
impl Removal {
    pub fn begin(path: &Path) -> Self {
        let normalized = path.to_str().and_then(|path| normalize_local_path(path).ok());
        let identity = normalized.as_deref().and_then(file_fact).map(|(identity, _)| identity);
        let registries: Vec<Arc<Registry>> = normalized.as_deref().map(|path| registries().into_iter().filter(|registry| {
            registry.state.lock().unwrap().members.iter().any(|member| member.path == path && member.expected.is_some() && member.expected == identity)
        }).collect()).unwrap_or_default();
        if let Some(path) = &normalized { for registry in &registries { registry.operation(path, true); } }
        Self { path: normalized, registries }
    }
    pub fn finish(self) {
        if let Some(path) = &self.path {
            if std::fs::symlink_metadata(path).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound) {
                for registry in &self.registries { registry.claim(path, None); }
            }
        }
    }
}
impl Drop for Removal { fn drop(&mut self) { if let Some(path) = &self.path { for registry in &self.registries { registry.operation(path, false); } } } }

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, sync::atomic::AtomicBool};
    use super::super::{local::LocalMetadataSource, scan::{scan_directory, ScanLimits}, target::normalize_local_path};
    struct Root(std::path::PathBuf);
    impl Root { fn new() -> Self { let path = std::env::temp_dir().join(format!("athenaeum-artifacts-{}", uuid::Uuid::new_v4())); fs::create_dir(&path).unwrap(); Self(path) } }
    impl Drop for Root { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    #[test]
    #[cfg(windows)]
    fn size_artifact_parent_proof_rejects_metadata_changes_and_directory_replacement() {
        use std::os::windows::ffi::OsStrExt;
        use windows::{core::PCWSTR, Win32::Storage::FileSystem::{SetFileAttributesW, FILE_FLAGS_AND_ATTRIBUTES, FILE_ATTRIBUTE_HIDDEN}};
        for replace in [false, true] {
            let root = Root::new(); let cache = root.0.join("cache"); fs::create_dir(&cache).unwrap();
            fs::write(cache.join("startup.json"), b"saved").unwrap();
            let registry = Registry::register(&cache).unwrap(); let before = registry.cached();
            let scope = normalize_local_path(root.0.to_str().unwrap()).unwrap();
            assert!(before.suppress_parent_modified(&scope, "cache"));
            assert!(!before.suppress(&scope, "cache/unknown"));
            if replace {
                fs::rename(&cache, root.0.join("displaced")).unwrap(); fs::create_dir(&cache).unwrap();
                fs::write(cache.join("startup.json"), b"other").unwrap();
            } else {
                let attributes = parent_fact(&cache).unwrap().1 as u32;
                let path: Vec<_> = cache.as_os_str().encode_wide().chain(Some(0)).collect();
                unsafe { SetFileAttributesW(PCWSTR(path.as_ptr()), FILE_FLAGS_AND_ATTRIBUTES(attributes | FILE_ATTRIBUTE_HIDDEN.0)).unwrap(); }
            }
            let after = registry.sample();
            assert!(!after.suppress_parent_modified(&scope, "cache"));
            assert!(!after.suppress(&scope, "cache/startup.json"));
            assert!(!after.untrusted_changes(&before).is_empty());
        }
    }
    #[test]
    #[cfg(windows)]
    fn size_artifact_atomic_replace_handles_ntfs_creation_time_preservation() {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{Foundation::{FILETIME, HANDLE}, Storage::FileSystem::SetFileTime};
        let root = Root::new(); let destination = root.0.join("startup.json"); let source = root.0.join("startup.next");
        fs::write(&destination, b"old").unwrap();
        let file = fs::OpenOptions::new().write(true).open(&destination).unwrap();
        unsafe { SetFileTime(HANDLE(file.as_raw_handle()), Some(&FILETIME { dwLowDateTime: 0, dwHighDateTime: 29_000_000 }), None, None).unwrap(); }
        drop(file);
        let registry = Registry::register(&root.0).unwrap();
        let creation = Creation::begin(&source); fs::write(&source, b"new summary").unwrap(); creation.finish();
        let receipt = Replacement::begin(&source, &destination);
        crate::services::atomic_file::replace_file(&source, &destination).unwrap(); receipt.finish();
        let snapshot = registry.sample(); let scope = normalize_local_path(root.0.to_str().unwrap()).unwrap();
        assert!(snapshot.suppress(&scope, "startup.json"), "ReplaceFile preserves destination creation time but moves the source file identity");
        assert!(snapshot.suppress(&scope, "startup.next"));
    }
    #[test]
    fn size_artifact_sampling_does_not_join_facts_from_different_objects() {
        let root = Root::new(); let path = root.0.join("startup.json"); fs::write(&path, [0_u8; 100]).unwrap();
        let registry = Registry::register(&root.0).unwrap();
        let scope = normalize_local_path(root.0.to_str().unwrap()).unwrap();
        let sampled = registry.sample_with(|name| {
            let old = file_fact(name);
            if Path::new(name).file_name().unwrap() == "startup.json" {
                fs::rename(&path, root.0.join("external-old")).unwrap(); fs::create_dir(&path).unwrap();
            }
            old
        });
        assert!(sampled.pending(&scope), "a file fact followed by a directory fact is an incomplete sample");
        assert_eq!(sampled.contribution(&scope).bytes, 100);
        let settled = registry.sample();
        assert!(!settled.pending(&scope)); assert!(!settled.suppress(&scope, "startup.json"));
        assert_eq!(settled.contribution(&scope).bytes, 0);
    }
    #[test]
    fn size_artifact_old_sample_cannot_overwrite_registered_replacement_or_newer_sample() {
        for replace in [false, true] {
            let root = Root::new(); let path = root.0.join("startup.json"); fs::write(&path, [0_u8; 100]).unwrap();
            let registry = Registry::register(&root.0).unwrap();
            let scope = normalize_local_path(root.0.to_str().unwrap()).unwrap();
            let before = registry.cached();
            let once = AtomicBool::new(false);
            let sampled = registry.sample_with(|name| {
                let old = file_fact(name);
                if Path::new(name).file_name().unwrap() == "startup.json" && !once.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    if replace {
                        let next = root.0.join("startup.next");
                        let creation = Creation::begin(&next); fs::write(&next, [0_u8; 180]).unwrap(); creation.finish();
                        let receipt = Replacement::begin(&next, &path);
                        crate::services::atomic_file::replace_file(&next, &path).unwrap(); receipt.finish();
                    } else { fs::write(&path, [0_u8; 180]).unwrap(); }
                    assert_eq!(registry.sample().contribution(&scope).bytes, 180);
                }
                old
            });
            assert!(sampled.untrusted_changes(&before).is_empty(), "a registered replacement is not an external change: {replace} {before:?} -> {sampled:?}");
            assert_eq!(sampled.contribution(&scope).bytes, 180, "an older sampler must never roll back a newer contribution");
        }
    }
    #[test]
    fn size_artifact_sampling_failure_keeps_last_contribution_pending_until_recovered() {
        let root = Root::new(); let path = root.0.join("sizes.sqlite3"); fs::write(&path, [0_u8; 100]).unwrap();
        let registry = Registry::register(&root.0).unwrap();
        let scope = normalize_local_path(root.0.to_str().unwrap()).unwrap();
        let blocked = registry.sample_with(|_| None);
        assert_eq!(blocked.contribution(&scope).bytes, 100);
        assert!(blocked.pending(&scope));
        fs::write(&path, [0_u8; 180]).unwrap();
        let recovered = registry.sample();
        assert_eq!(recovered.contribution(&scope).bytes, 180); assert!(!recovered.pending(&scope));
    }
    #[test]
    fn size_artifact_policy_precedes_database_open_and_keeps_scan_listing_membership_equal() {
        let root = Root::new(); let cache = root.0.join("cache"); fs::create_dir(&cache).unwrap();
        fs::write(cache.join("sizes.sqlite3"), [0_u8; 100]).unwrap();
        fs::write(cache.join("ordinary"), [0_u8; 20]).unwrap();
        let registry = Registry::register(&cache).unwrap();
        let path = normalize_local_path(cache.to_str().unwrap()).unwrap();
        let scan = || scan_directory(&path, &mut LocalMetadataSource, &AtomicBool::new(false), ScanLimits::default(), |_| {});
        let first = scan();
        assert_eq!(first.stats.known_bytes, 20, "fixed cache members must be excluded from the stable base before SQLite opens");
        assert_eq!(first.stats.files, 1);
        assert_eq!(registry.sample().contribution(&path).bytes, 100);
        let receipt = Creation::begin(&cache.join("sizes.sqlite3-wal"));
        fs::write(cache.join("sizes.sqlite3-wal"), [0_u8; 64]).unwrap(); receipt.finish();
        let snapshot = registry.sample();
        assert_eq!(snapshot.contribution(&path).bytes, 164);
        assert_eq!(snapshot.contribution(&path).files, 2);
        let second = scan();
        assert_eq!(second.stats.known_bytes, 20);
        assert_eq!(first.directories[&*path].fingerprint, second.directories[&*path].fingerprint);
        let listing = crate::services::fs_service::list_directory(&cache, &[], |_| (vec![], None)).unwrap();
        assert_eq!(listing.size_fingerprint, second.directories[&*path].fingerprint);
        assert_eq!(listing.entries.len(), 3, "managed artifacts still appear in ordinary file listings");
        assert!(snapshot.suppress(&path, "sizes.sqlite3-wal"));
        assert!(!snapshot.suppress(&path, "ordinary"));
        fs::rename(cache.join("sizes.sqlite3-wal"), cache.join("old-wal")).unwrap();
        fs::write(cache.join("sizes.sqlite3-wal"), [0_u8; 12]).unwrap();
        assert!(!registry.sample().suppress(&path, "sizes.sqlite3-wal"), "unregistered identity replacements must invalidate the root");
        fs::remove_file(cache.join("sizes.sqlite3-wal")).unwrap();
        fs::create_dir(cache.join("sizes.sqlite3-wal")).unwrap();
        fs::write(cache.join("sizes.sqlite3-wal/payload"), [0_u8; 7]).unwrap();
        assert!(!registry.sample().suppress(&path, "sizes.sqlite3-wal"));
        let replaced = scan();
        assert_eq!(replaced.stats.known_bytes, 91, "ordinary names and a same-name directory remain in the stable base");
    }
}

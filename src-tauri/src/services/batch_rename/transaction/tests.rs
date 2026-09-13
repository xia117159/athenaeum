use super::super::{native, plan};
use super::*;
use std::sync::atomic::Ordering;

struct Fixture {
    root: PathBuf,
    logs: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("athenaeum-txn-{}", Uuid::new_v4()));
        let logs = root.join("journal");
        std::fs::create_dir_all(&root).unwrap();
        Self { root, logs }
    }
    fn file(&self, path: &str, content: &str) {
        let path = self.root.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }
    fn prepare(&self, mappings: &[(&str, &str)]) -> BatchPayload {
        let sources = mappings
            .iter()
            .map(|(path, _)| native::snapshot(&self.root.join(path)).unwrap())
            .collect::<Vec<_>>();
        let (rows, plan) = plan::plan_names(
            &sources,
            mappings
                .iter()
                .map(|(_, name)| Ok((*name).into()))
                .collect(),
        );
        let plan = plan.unwrap_or_else(|| panic!("valid plan: {rows:?}"));
        BatchPayload::forward(
            &plan,
            &Uuid::new_v4().to_string(),
            &Uuid::new_v4().to_string(),
        )
    }
    fn read(&self, path: &str) -> String {
        std::fs::read_to_string(self.root.join(path)).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}
fn quiet(_: Checkpoint, _: &BatchPayload) -> Result<()> {
    Ok(())
}

#[test]
fn transaction_swaps_names_changes_case_and_undoes_the_entire_batch() {
    let fixture = Fixture::new();
    fixture.file("a.txt", "A");
    fixture.file("b.txt", "B");
    fixture.file("Case.txt", "case");
    let payload = fixture.prepare(&[
        ("a.txt", "b.txt"),
        ("b.txt", "a.txt"),
        ("Case.txt", "CASE.txt"),
    ]);
    let outcome = run(
        payload,
        &fixture.logs,
        &AtomicBool::new(false),
        &mut |_| Ok(()),
        &mut quiet,
    );
    assert!(outcome.committed, "{:?}", outcome.error);
    assert_eq!(fixture.read("a.txt"), "B");
    assert_eq!(fixture.read("b.txt"), "A");
    assert!(std::fs::read_dir(&fixture.root)
        .unwrap()
        .flatten()
        .any(|entry| entry.file_name() == "CASE.txt"));
    fixture.file("a.txt", "B edited after rename");
    let undo = run(
        outcome.payload.for_undo(&Uuid::new_v4().to_string()),
        &fixture.logs,
        &AtomicBool::new(false),
        &mut |_| Ok(()),
        &mut quiet,
    );
    assert!(undo.committed, "{:?}", undo.error);
    assert_eq!(fixture.read("a.txt"), "A");
    assert_eq!(fixture.read("b.txt"), "B edited after rename");
}

#[test]
fn transaction_handles_multilevel_parent_child_selection() {
    let fixture = Fixture::new();
    fixture.file("Parent/Child/Test.txt", "content");
    let payload = fixture.prepare(&[
        ("Parent", "Renamed"),
        ("Parent/Child", "Nested"),
        ("Parent/Child/Test.txt", "New.txt"),
    ]);
    let result = run(
        payload,
        &fixture.logs,
        &AtomicBool::new(false),
        &mut |_| Ok(()),
        &mut quiet,
    );
    assert!(result.committed, "{:?}", result.error);
    assert_eq!(fixture.read("Renamed/Nested/New.txt"), "content");
    let restored = run(
        result.payload.for_undo(&Uuid::new_v4().to_string()),
        &fixture.logs,
        &AtomicBool::new(false),
        &mut |_| Ok(()),
        &mut quiet,
    );
    assert!(restored.committed, "{:?}", restored.error);
    assert_eq!(fixture.read("Parent/Child/Test.txt"), "content");
}

#[test]
fn every_phase_failure_and_commit_failure_restore_without_overwrite() {
    for checkpoint in [
        Checkpoint::Prepared,
        Checkpoint::BeforePending,
        Checkpoint::BeforeRename,
        Checkpoint::AfterRename,
        Checkpoint::AfterApplied,
        Checkpoint::BeforeCommit,
    ] {
        let fixture = Fixture::new();
        fixture.file("a.txt", "A");
        fixture.file("b.txt", "B");
        let payload = fixture.prepare(&[("a.txt", "b.txt"), ("b.txt", "a.txt")]);
        let mut injected = false;
        let result = run(
            payload,
            &fixture.logs,
            &AtomicBool::new(false),
            &mut |_| Ok(()),
            &mut |point, _| {
                if point == checkpoint && !injected {
                    injected = true;
                    anyhow::bail!("injected failure");
                }
                Ok(())
            },
        );
        assert!(injected, "must exercise {checkpoint:?}");
        assert!(!result.committed);
        assert!(result.restored, "{checkpoint:?}: {:?}", result.error);
        assert_eq!(fixture.read("a.txt"), "A");
        assert_eq!(fixture.read("b.txt"), "B");
    }
    let fixture = Fixture::new();
    fixture.file("a.txt", "A");
    let payload = fixture.prepare(&[("a.txt", "b.txt")]);
    let result = run(
        payload,
        &fixture.logs,
        &AtomicBool::new(false),
        &mut |_| anyhow::bail!("journal commit failed"),
        &mut quiet,
    );
    assert!(!result.committed);
    assert!(result.restored);
    assert_eq!(fixture.read("a.txt"), "A");
}

#[test]
fn cancellation_rolls_back_and_a_blocked_rollback_retains_real_locations() {
    let fixture = Fixture::new();
    fixture.file("a.txt", "A");
    fixture.file("b.txt", "B");
    let payload = fixture.prepare(&[("a.txt", "new-a.txt"), ("b.txt", "new-b.txt")]);
    let cancel = AtomicBool::new(false);
    let result = run(
        payload,
        &fixture.logs,
        &cancel,
        &mut |_| Ok(()),
        &mut |point, _| {
            if point == Checkpoint::AfterApplied {
                cancel.store(true, Ordering::Release);
            }
            Ok(())
        },
    );
    assert!(result.cancelled);
    assert!(result.restored);
    assert_eq!(fixture.read("a.txt"), "A");
    let payload = fixture.prepare(&[("a.txt", "new-a.txt")]);
    let mut fail_once = false;
    let result = run(
        payload,
        &fixture.logs,
        &AtomicBool::new(false),
        &mut |_| Ok(()),
        &mut |point, _| {
            if point == Checkpoint::AfterApplied && !fail_once {
                fail_once = true;
                fixture.file("a.txt", "external");
                anyhow::bail!("trigger rollback conflict");
            }
            Ok(())
        },
    );
    assert!(!result.restored);
    assert!(result.payload.pending_recovery);
    assert_eq!(fixture.read("a.txt"), "external");
    assert_eq!(
        std::fs::read_to_string(&result.payload.entries[0].current_path).unwrap(),
        "A"
    );
    assert!(fixture.logs.read_dir().unwrap().next().is_some());
}

#[test]
fn failures_after_each_parent_child_step_restore_the_original_tree() {
    for fail_at in 1..=6 {
        let fixture = Fixture::new();
        fixture.file("Parent/Child/Test.txt", "content");
        let payload = fixture.prepare(&[
            ("Parent", "Renamed"),
            ("Parent/Child", "Nested"),
            ("Parent/Child/Test.txt", "New.txt"),
        ]);
        let mut applied = 0;
        let outcome = run(
            payload,
            &fixture.logs,
            &AtomicBool::new(false),
            &mut |_| Ok(()),
            &mut |point, _| {
                if point == Checkpoint::AfterApplied {
                    applied += 1;
                    if applied == fail_at {
                        anyhow::bail!("failure after step {fail_at}");
                    }
                }
                Ok(())
            },
        );
        assert_eq!(applied, fail_at);
        assert!(outcome.restored, "step {fail_at}: {:?}", outcome.error);
        assert_eq!(fixture.read("Parent/Child/Test.txt"), "content");
    }
}

#[test]
fn hardlinks_are_independent_directory_entries_and_target_races_never_overwrite() {
    let fixture = Fixture::new();
    fixture.file("a.txt", "shared");
    std::fs::hard_link(fixture.root.join("a.txt"), fixture.root.join("b.txt")).unwrap();
    let payload = fixture.prepare(&[("a.txt", "new-a.txt"), ("b.txt", "new-b.txt")]);
    let result = run(
        payload,
        &fixture.logs,
        &AtomicBool::new(false),
        &mut |_| Ok(()),
        &mut quiet,
    );
    assert!(result.committed, "{:?}", result.error);
    assert_eq!(fixture.read("new-a.txt"), "shared");
    assert_eq!(
        native::snapshot(&fixture.root.join("new-a.txt"))
            .unwrap()
            .identity,
        native::snapshot(&fixture.root.join("new-b.txt"))
            .unwrap()
            .identity
    );
    let undo = run(
        result.payload.for_undo(&Uuid::new_v4().to_string()),
        &fixture.logs,
        &AtomicBool::new(false),
        &mut |_| Ok(()),
        &mut quiet,
    );
    assert!(undo.committed);
    let payload = fixture.prepare(&[("a.txt", "new-a.txt")]);
    let result = run(
        payload,
        &fixture.logs,
        &AtomicBool::new(false),
        &mut |_| Ok(()),
        &mut |point, state| {
            if point == Checkpoint::BeforeRename
                && native::name_of(&state.entries[0].current_path)
                    .unwrap()
                    .starts_with(".athenaeum-")
            {
                fixture.file("new-a.txt", "external");
            }
            Ok(())
        },
    );
    assert!(!result.committed);
    assert!(result.restored);
    assert_eq!(fixture.read("a.txt"), "shared");
    assert_eq!(fixture.read("new-a.txt"), "external");
}

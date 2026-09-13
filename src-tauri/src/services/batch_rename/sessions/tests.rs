use super::*;
use crate::domain::batch_rename::BatchRenameRowStatus;
use std::path::PathBuf;

struct Fixture {
    root: PathBuf,
    paths: Vec<String>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("athenaeum-session-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let paths = ["B.jpg", "A.txt"]
            .map(|name| {
                let path = root.join(name);
                std::fs::write(&path, name).unwrap();
                path.to_string_lossy().into_owned()
            })
            .to_vec();
        Self { root, paths }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}
fn request(id: &str, expression: &str, revision: u64) -> PreviewBatchRenameRequest {
    PreviewBatchRenameRequest {
        session_id: id.into(),
        expression: expression.into(),
        revision,
    }
}

#[tokio::test]
async fn order_preview_invalidation_and_confirmation_are_server_owned() {
    let fixture = Fixture::new();
    let sessions = BatchRenameSessions::default();
    let session = sessions.create("main", fixture.paths.clone()).unwrap();
    assert_eq!(session.items[0].old_name, "B.jpg");
    let initial = sessions
        .preview("main", request(&session.session_id, "*", 1))
        .await
        .unwrap();
    assert!(!initial.can_apply);
    let preview = sessions
        .preview("main", request(&session.session_id, "New<#00>", 2))
        .await
        .unwrap();
    assert_eq!(preview.items[0].new_name.as_deref(), Some("New00.jpg"));
    assert_eq!(preview.items[1].new_name.as_deref(), Some("New01.txt"));
    assert_eq!(preview.changed_count, 2);
    assert!(preview.can_apply);
    assert!(sessions
        .claim(
            "other",
            &session.session_id,
            preview.preview_id.as_deref().unwrap(),
            "request"
        )
        .is_err());
    let old_id = preview.preview_id.unwrap();
    let invalid = sessions
        .preview("main", request(&session.session_id, "<unknown *>", 3))
        .await
        .unwrap();
    assert!(!invalid.can_apply);
    assert!(!invalid.diagnostics.is_empty());
    assert!(sessions
        .claim("main", &session.session_id, &old_id, "request")
        .is_err());
    let valid = sessions
        .preview("main", request(&session.session_id, "Final<#1>", 4))
        .await
        .unwrap();
    let id = valid.preview_id.unwrap();
    let first = sessions
        .claim("main", &session.session_id, &id, "request")
        .unwrap();
    let duplicate = sessions
        .claim("main", &session.session_id, &id, "request")
        .unwrap();
    assert!(Arc::ptr_eq(&first, &duplicate));
    assert!(sessions
        .claim("main", &session.session_id, &id, "other-request")
        .is_err());
    sessions.close("main", &session.session_id);
    assert!(sessions
        .preview("main", request(&session.session_id, "*", 5))
        .await
        .is_err());
}

#[tokio::test]
async fn sessions_bound_capacity_and_keep_only_the_latest_preview_plan() {
    let fixture = Fixture::new();
    let sessions = BatchRenameSessions::default();
    let mut ids = Vec::new();
    for _ in 0..4 {
        ids.push(
            sessions
                .create("main", fixture.paths.clone())
                .unwrap()
                .session_id,
        );
    }
    assert!(sessions.create("main", fixture.paths.clone()).is_err());
    let id = &ids[0];
    let (first, second, last) = tokio::join!(
        sessions.preview("main", request(id, "First<#1>", 1)),
        sessions.preview("main", request(id, "Second<#1>", 2)),
        sessions.preview("main", request(id, "Last<#1>", 3)),
    );
    let latest = last.unwrap();
    assert_eq!(latest.items[0].new_name.as_deref(), Some("Last1.jpg"));
    for old in [first, second].into_iter().flatten() {
        if let Some(preview_id) = old.preview_id {
            assert!(sessions.claim("main", id, &preview_id, "old").is_err());
        }
    }
    sessions.close_owner("main");
    assert!(sessions.create("main", fixture.paths.clone()).is_ok());
}

#[test]
fn queued_create_from_a_reloaded_owner_cannot_register_late() {
    let fixture = Fixture::new();
    let sessions = BatchRenameSessions::default();
    let epoch = sessions.owner_epoch("main");
    sessions.close_owner("main");
    assert!(sessions
        .create_at_epoch("main", fixture.paths.clone(), epoch)
        .is_err());
    assert!(sessions
        .create_at_epoch("main", fixture.paths.clone(), sessions.owner_epoch("main"))
        .is_ok());
}

#[tokio::test]
async fn preview_rechecks_source_identity_and_captures_file_dates() {
    let fixture = Fixture::new();
    let sessions = BatchRenameSessions::default();
    let session = sessions.create("main", fixture.paths.clone()).unwrap();
    let preview = sessions
        .preview(
            "main",
            request(&session.session_id, "*-<date yyyymmddhhmmss>", 1),
        )
        .await
        .unwrap();
    let again = sessions
        .preview(
            "main",
            request(&session.session_id, "*-<date yyyymmddhhmmss>", 2),
        )
        .await
        .unwrap();
    assert_eq!(preview.items[0].new_name, again.items[0].new_name);
    std::fs::rename(&fixture.paths[0], fixture.root.join("moved.jpg")).unwrap();
    std::fs::write(&fixture.paths[0], "replacement").unwrap();
    let changed = sessions
        .preview("main", request(&session.session_id, "New-*", 3))
        .await
        .unwrap();
    assert!(!changed.can_apply);
    assert_eq!(changed.items[0].status, BatchRenameRowStatus::Error);
}

#[tokio::test]
async fn editing_invalidates_a_plan_before_the_debounced_preview() {
    let fixture = Fixture::new();
    let sessions = BatchRenameSessions::default();
    let id = sessions
        .create("main", fixture.paths.clone())
        .unwrap()
        .session_id;
    let preview = sessions
        .preview("main", request(&id, "New-*", 1))
        .await
        .unwrap();
    sessions
        .invalidate(
            "main",
            InvalidateBatchRenameRequest {
                session_id: id.clone(),
                revision: 2,
            },
        )
        .unwrap();
    assert!(
        sessions
            .claim("main", &id, preview.preview_id.as_deref().unwrap(), "old")
            .is_err(),
        "typing must invalidate the saved plan before the next evaluation starts"
    );
    assert!(sessions
        .invalidate(
            "other",
            InvalidateBatchRenameRequest {
                session_id: id.clone(),
                revision: 3
            }
        )
        .is_err());
    let next = sessions
        .preview("main", request(&id, "Final-*", 2))
        .await
        .unwrap();
    sessions
        .invalidate(
            "main",
            InvalidateBatchRenameRequest {
                session_id: id.clone(),
                revision: 2,
            },
        )
        .unwrap();
    sessions
        .invalidate(
            "main",
            InvalidateBatchRenameRequest {
                session_id: id.clone(),
                revision: 1,
            },
        )
        .unwrap();
    assert!(
        sessions
            .claim("main", &id, next.preview_id.as_deref().unwrap(), "latest")
            .is_ok(),
        "late or duplicate invalidations must not erase the current plan"
    );
}

#[tokio::test]
async fn invalidation_stops_the_actual_worker_without_waiting_for_old_evaluation() {
    use crate::domain::rename_expression::{EvalResult, EvalText, Evaluation, FunctionDefinition};
    static STARTED: AtomicBool = AtomicBool::new(false);
    fn slow(_: &[EvalText], evaluation: &mut Evaluation<'_, '_>) -> EvalResult {
        STARTED.store(true, Ordering::Release);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            evaluation.charge(0)?;
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        Err("old evaluation was not cancelled".into())
    }
    let fixture = Fixture::new();
    let mut functions = FunctionRegistry::builtins();
    functions
        .register(FunctionDefinition {
            info: FunctionInfo {
                name: "slow".into(),
                aliases: vec![],
                parameters: vec![],
                description: "controlled cancellation probe".into(),
                examples: vec![],
            },
            evaluate: slow,
        })
        .unwrap();
    let sessions = Arc::new(BatchRenameSessions {
        registry: Mutex::new(Registry::default()),
        functions: Arc::new(functions),
    });
    let id = sessions
        .create("main", fixture.paths.clone())
        .unwrap()
        .session_id;
    let worker_sessions = sessions.clone();
    let worker_id = id.clone();
    let old = tokio::spawn(async move {
        worker_sessions
            .preview("main", request(&worker_id, "<slow>", 1))
            .await
    });
    for _ in 0..1000 {
        if STARTED.load(Ordering::Acquire) {
            break;
        }
        tokio::task::yield_now().await;
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    assert!(STARTED.load(Ordering::Acquire));
    sessions
        .invalidate(
            "main",
            InvalidateBatchRenameRequest {
                session_id: id.clone(),
                revision: 2,
            },
        )
        .unwrap();
    for _ in 0..1000 {
        if old.is_finished() {
            break;
        }
        tokio::task::yield_now().await;
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    let stopped = old.is_finished();
    if !stopped {
        sessions.close("main", &id);
    }
    let result = old.await.unwrap();
    assert!(
        stopped,
        "new input must stop the old worker at its next checkpoint"
    );
    assert!(result.is_err());
    let newest = sessions
        .preview("main", request(&id, "Latest-*", 2))
        .await
        .unwrap();
    assert_eq!(newest.items[0].new_name.as_deref(), Some("Latest-B.jpg"));
}

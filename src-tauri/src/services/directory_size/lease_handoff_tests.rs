use super::*;

#[test]
fn size_handoff_malformed_optional_fields_cannot_fall_back_to_legacy_subscription() {
    for extra in [serde_json::json!({"slotId":"panel-1"}), serde_json::json!({"slotRevision":1}),
        serde_json::json!({"handoffFrom":"old"}), serde_json::json!({"slotId":"panel-1","slotRevision":"1"}),
        serde_json::json!({"slotId":null,"slotRevision":1})] {
        let mut request = serde_json::json!({"consumerId":"new","target":{"kind":"local","path":"C:\\root"}});
        request.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        assert!(serde_json::from_value::<SubscribeDirectorySizesRequest>(request).is_err());
    }
    let legacy = serde_json::json!({"consumerId":"old","target":{"kind":"local","path":"C:\\root"}});
    assert!(serde_json::from_value::<SubscribeDirectorySizesRequest>(legacy).unwrap().handoff.is_none());
}

fn slotted(id: &str, from: Option<&str>, revision: u64) -> SubscribeDirectorySizesRequest {
    serde_json::from_value(serde_json::json!({"consumerId": id, "target": {"kind":"local", "path":"C:\\root"},
        "refresh":false, "slotId":"panel-1", "slotRevision":revision, "handoffFrom":from})).unwrap()
}

#[test]
fn size_handoff_keeps_running_job_at_full_lease_capacity() {
    let mut core = core(); core.limits.leases = 1;
    let owner = core.owner_token("main").unwrap();
    core.subscribe(owner.clone(), slotted("a", None, 1), None, 0).unwrap();
    let job = core.take_jobs(0).remove(0); monitored(&mut core, &job);
    let next = core.subscribe(owner, slotted("b", Some("a"), 2), None, 1)
        .expect("atomic replacement must fit the final lease count");
    assert_eq!(next.generation, job.generation);
    assert!(!job.cancelled.load(Ordering::Relaxed));
    assert!(core.snapshot("a").is_none());
    assert!(core.take_jobs(1).is_empty());
    finish(&mut core, &job, 2);
    assert_eq!(core.snapshot("b").unwrap().total_bytes.as_deref(), Some("100"));
}

#[test]
fn size_handoff_close_fences_delayed_subscribe_and_last_release_cancels() {
    let mut core = core(); let owner = core.owner_token("main").unwrap();
    core.subscribe(owner.clone(), slotted("a", None, 1), None, 0).unwrap();
    let job = core.take_jobs(0).remove(0); monitored(&mut core, &job);
    core.release_slot(owner.clone(), "b", slotted("b", Some("a"), 2).handoff.unwrap(), 1).unwrap();
    assert!(job.cancelled.load(Ordering::Relaxed));
    assert!(core.subscribe(owner.clone(), slotted("b", Some("a"), 2), None, 2).is_err());
    finish(&mut core, &job, 3);
    assert!(core.snapshot("b").is_none());
    assert!(core.subscribe(owner, slotted("c", None, 3), None, 4).is_ok());
}

#[test]
fn size_handoff_failed_target_and_foreign_owner_keep_original_consumer() {
    let mut core = core(); core.limits.roots = 1;
    let owner = core.owner_token("main").unwrap();
    core.subscribe(owner.clone(), slotted("a", None, 1), None, 0).unwrap();
    let job = core.take_jobs(0).remove(0); monitored(&mut core, &job);
    let mut replacement = slotted("b", Some("a"), 2);
    replacement.target = DirectorySizeTarget::Local { path: "C:\\elsewhere".into() };
    assert!(core.subscribe(owner, replacement, None, 1).is_err());
    assert!(core.subscribe(core.owner_token("settings").unwrap(), slotted("b", Some("a"), 2), None, 1).is_err());
    assert!(!job.cancelled.load(Ordering::Relaxed));
    assert!(core.snapshot("a").is_some());
}

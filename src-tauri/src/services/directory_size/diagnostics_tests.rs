use super::*;
use crate::domain::models::{DirectoryListing, LocationDescriptor};

fn listing() -> DirectoryListing {
    DirectoryListing { location: LocationDescriptor::local("C:\\root"), entries: vec![], parent: None,
        can_go_up: true, size_fingerprint: Some("stamp".into()), directory_size_cache: None }
}

#[test]
fn size_diagnostics_explains_the_listing_decision_without_starting_work() {
    let mut core = core();
    let mut listing = listing();
    let report = core.diagnose_listing(&listing, 0);
    assert_eq!(report.reason, DirectorySizeCacheReason::NoAcceptedResult);
    assert_eq!(core.root_count(), 0);
    subscribe(&mut core, "a", "C:\\root", 0);
    let job = core.take_jobs(0).remove(0);
    let watch = monitored(&mut core, &job);
    finish(&mut core, &job, 1);
    assert_eq!(core.diagnose_listing(&listing, 1).reason, DirectorySizeCacheReason::LiveHit);
    assert!(core.listing_display_cache(&listing, 1).is_some());
    listing.size_fingerprint = Some("changed".into());
    let report = core.diagnose_listing(&listing, 2);
    assert_eq!(report.reason, DirectorySizeCacheReason::FingerprintMismatch);
    assert!(core.listing_display_cache(&listing, 2).is_none());
    watch.store(2, Ordering::Relaxed);
    let report = core.diagnose_listing(&listing, 3);
    assert_eq!(report.reason, DirectorySizeCacheReason::WatchLost);
    assert_eq!(report.scan_jobs_started, "1");
    assert_eq!(core.jobs_started, 1, "diagnostics must not schedule a scan");
    assert!(!report.transitions.is_empty());
    let wire = serde_json::to_value(report).unwrap();
    assert_eq!(wire["reason"], "watchLost");
    assert_eq!(wire["scanJobsStarted"], "1");
    assert_eq!(wire["storage"]["ready"], false);
    assert_eq!(wire["storage"]["queueBytes"], "0");
}

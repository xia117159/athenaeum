use super::{database::{Database, ScanHeader, StoredDirectory}, maintenance::{self, Kind, Maintenance, Protection}};
use super::super::{scan::{DirectorySize, ScanStats}, target::normalize_local_path};
use crate::domain::directory_sizes::DirectorySizeViewScope;
use std::{fs, path::PathBuf, sync::Arc};

struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("athenaeum-size-requests-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap(); Self(path)
    }
}
impl Drop for Root { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
fn record(path: &str) -> StoredDirectory {
    StoredDirectory { path: normalize_local_path(path).unwrap(), artifact_capture: None,
        size: DirectorySize { bytes: 1, complete: true, fingerprint: None, created_at: None, stats: ScanStats::default() } }
}
fn append(db: &mut Database, id: &str, root: &str, paths: &[String]) {
    let header = ScanHeader { id: id.into(), session: "session".into(), root: root.into(), generation: 1,
        captured_at: chrono::Utc::now(), policy_version: 2 };
    for chunk in paths.chunks(32) { db.append(&header, &chunk.iter().map(|path| record(path)).collect::<Vec<_>>()).unwrap(); }
}
fn publish(db: &mut Database, id: &str, root: &str, paths: &[&str], ticket: u64) {
    append(db, id, root, &paths.iter().map(|path| path.to_string()).collect::<Vec<_>>());
    db.publish(id, ticket).unwrap();
}
fn count(db: &Database, sql: &str) -> u64 { db.connection.query_row(sql, [], |row| row.get(0)).unwrap() }
fn pragma(db: &Database, name: &str) -> u64 { count(db, &format!("PRAGMA {name}")) }

/// Plan rows that scan `records` (or its alias `r`) instead of searching an index.
fn full_scans(db: &Database, sql: &str) -> Vec<String> {
    let mut statement = db.connection.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
    let nulls = vec![rusqlite::types::Null; statement.parameter_count()];
    statement.query_map(rusqlite::params_from_iter(nulls), |row| row.get::<_, String>(3)).unwrap()
        .map(Result::unwrap)
        .filter(|detail| { let mut words = detail.split_whitespace(); words.next() == Some("SCAN") && matches!(words.next(), Some("records" | "r")) })
        .collect()
}

#[test]
fn size_maintenance_sql_searches_records_through_an_index() {
    let root = Root::new(); let db = Database::open(&root.0).unwrap();
    let baseline_legacy = "DELETE FROM records WHERE (path,scan_id) IN
        (SELECT r.path,r.scan_id FROM records r JOIN scans s ON s.id=r.scan_id
            WHERE s.source=0 AND NOT EXISTS(SELECT 1 FROM operation_copies c JOIN cache_operations o ON o.id=c.operation_id
                WHERE (c.old_scan=r.scan_id OR c.shadow_scan=r.scan_id) AND o.state IN(0,1))
            ORDER BY r.path,r.scan_id LIMIT 128)";
    assert!(!full_scans(&db, baseline_legacy).is_empty(), "the check must recognize the baseline full scan");
    for sql in [maintenance::PATH_PAGE, maintenance::SCAN_PAGE, maintenance::LATEST, maintenance::FIRST_PAGE, maintenance::FIRST,
        maintenance::VERSIONS, maintenance::DELETE_VERSION, maintenance::COPYING, maintenance::SWEEP_SCANS, maintenance::SWEEP_RECORDS,
        maintenance::DROP_SCAN, maintenance::PROBE, super::maintenance_namespaces::SCRUB] {
        assert_eq!(full_scans(&db, sql), Vec::<String>::new(), "{sql}");
    }
}

#[test]
fn size_maintenance_sweep_removes_legacy_scans_but_keeps_scans_being_copied() {
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    for id in ["legacy", "legacy-copying"] {
        db.connection.execute("INSERT INTO scans(id,session,root_path,generation,source,state,ticket,publication,captured_at,policy_version)
            VALUES(?1,'old','C:\\root','1',0,1,1,1,'2020-01-01T00:00:00Z',1)", [id]).unwrap();
        for index in 0..300 {
            db.connection.execute("INSERT INTO records(path,scan_id,parent_path,payload) VALUES(?1,?2,'C:\\root','{}')",
                [format!("C:\\root\\{index:03}"), id.to_string()]).unwrap();
        }
    }
    db.connection.execute_batch("INSERT INTO cache_operations(id,state,spec,publication) VALUES('op',1,'{}',2);
        INSERT INTO operation_copies(operation_id,old_scan,shadow_scan) VALUES('op','legacy-copying','shadow');").unwrap();
    let mut maintenance = Maintenance::default();
    maintenance.request_sweep(); maintenance.run_until_idle(&mut db, &Protection::default()).unwrap();
    assert_eq!(count(&db, "SELECT count(*) FROM records WHERE scan_id='legacy'"), 0);
    assert_eq!(count(&db, "SELECT count(*) FROM scans WHERE id='legacy'"), 0);
    assert_eq!(count(&db, "SELECT count(*) FROM records WHERE scan_id='legacy-copying'"), 300, "an in-progress copy still reads its source");
}

#[test]
fn size_maintenance_passes_run_only_on_request_and_coalesce_repeats() {
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    for index in 0..5 { publish(&mut db, &format!("scan{index}"), &format!("C:\\root{index}"), &[&format!("C:\\root{index}")], index + 1); }
    let protection = Protection::default();
    let mut maintenance = Maintenance::default();
    assert!(!maintenance.pending() && maintenance.next(false, false).is_none());
    maintenance.request_sweep(); maintenance.request_sweep();
    let pass = maintenance.run_until_idle(&mut db, &protection).unwrap();
    assert!(!maintenance.pending(), "a finished pass leaves nothing pending");
    maintenance.request_sweep();
    assert_eq!(maintenance.next(false, false), Some(Kind::Sweep));
    maintenance.step(Kind::Sweep, &mut db, &protection).unwrap();
    maintenance.request_sweep(); maintenance.request_sweep();
    assert_eq!(maintenance.run_until_idle(&mut db, &protection).unwrap(), pass - 1 + pass, "requests during a pass add exactly one pass");
    maintenance.request_sweep();
    assert_eq!(maintenance.next(true, true), None, "flush admits only eviction for queued writes");
    assert!(maintenance.pending(), "requests survive a flush");
}

#[test]
fn size_maintenance_probe_selects_only_overlapping_publications() {
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    publish(&mut db, "a", "C:\\a", &["C:\\a", "C:\\a\\x"], 1);
    publish(&mut db, "b", "C:\\b", &["C:\\b", "C:\\b\\x"], 2);
    let protection = Protection::default();
    let mut maintenance = Maintenance::default();
    maintenance.request_probe("a".into()); maintenance.request_probe("b".into());
    while maintenance.next(false, false) == Some(Kind::Probe) { maintenance.step(Kind::Probe, &mut db, &protection).unwrap(); }
    assert!(maintenance.turnover_for_test().is_empty(), "first publications without overlap need no turnover");
    assert!(!maintenance.pending());
    assert_eq!(maintenance.probes, 2, "each scan probes only the roots inside it");
    publish(&mut db, "x1", "C:\\r", &["C:\\r", "C:\\r\\s", "C:\\r\\s\\t"], 3);
    publish(&mut db, "x2", "C:\\r\\s", &["C:\\r\\s", "C:\\r\\s\\t"], 4);
    publish(&mut db, "x3", "C:\\r\\s\\t", &["C:\\r\\s\\t"], 5);
    maintenance.request_probe("x3".into());
    while maintenance.next(false, false) == Some(Kind::Probe) { maintenance.step(Kind::Probe, &mut db, &protection).unwrap(); }
    assert_eq!(maintenance.turnover_for_test(), vec!["x3".to_string()]);
    maintenance.run_until_idle(&mut db, &protection).unwrap();
    let owners: Vec<String> = db.connection.prepare("SELECT scan_id FROM records WHERE path LIKE '%:\\r\\s\\t' ORDER BY scan_id").unwrap()
        .query_map([], |row| row.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
    assert_eq!(owners, vec!["x2", "x3"], "the oldest of three versions retires");
}

#[test]
fn size_maintenance_bulk_probe_matches_individual_probes_with_one_query_per_root() {
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    let mut ticket = 0; let mut ids = vec![];
    for top in 0..6 {
        for depth in 0..=top % 4 {
            let path = (0..=depth).fold(format!("C:\\t{top}"), |path, level| if level == 0 { path } else { format!("{path}\\d{level}") });
            let paths: Vec<String> = (depth..=3).map(|end| (depth + 1..=end).fold(path.clone(), |path, level| format!("{path}\\d{level}"))).collect();
            for copy in 0..2 {
                ticket += 1; let id = format!("s{top}-{depth}-{copy}"); ids.push(id.clone());
                publish(&mut db, &id, &path, &paths.iter().map(String::as_str).collect::<Vec<_>>(), ticket);
            }
        }
    }
    let protection = Protection { scans: ids.clone(), ..Default::default() }; // keep the fixture intact
    let probe = |requests: &[String], db: &mut Database| {
        let mut maintenance = Maintenance::default();
        for id in requests { maintenance.request_probe(id.clone()); }
        while maintenance.next(false, false) == Some(Kind::Probe) { maintenance.step(Kind::Probe, db, &protection).unwrap(); }
        let mut hits = maintenance.turnover_for_test(); hits.sort(); (hits, maintenance.probes)
    };
    let mut bulk = Maintenance::default(); bulk.opened(false);
    while bulk.next(false, false).is_some_and(|kind| kind != Kind::Probe) { let kind = bulk.next(false, false).unwrap(); bulk.step(kind, &mut db, &protection).unwrap(); }
    while bulk.next(false, false) == Some(Kind::Probe) { bulk.step(Kind::Probe, &mut db, &protection).unwrap(); }
    let mut bulk_hits = bulk.turnover_for_test(); bulk_hits.sort();
    let roots = count(&db, "SELECT count(DISTINCT root_path) FROM scans WHERE state=1 AND source=1");
    assert_eq!(bulk.probes, roots, "one point query per distinct published root");
    let mut individual: Vec<String> = ids.iter().flat_map(|id| probe(std::slice::from_ref(id), &mut db).0).collect();
    individual.sort(); individual.dedup();
    assert!(!bulk_hits.is_empty());
    assert_eq!(bulk_hits, individual);
}

#[test]
fn size_maintenance_exhausted_eviction_waits_for_an_event_that_can_change_it() {
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    publish(&mut db, "view", "C:\\root", &["C:\\root", "C:\\root\\child"], 1);
    let protection = Protection { scopes: Arc::new(vec![DirectorySizeViewScope { path: normalize_local_path("C:\\root").unwrap(), priority: 0 }]),
        ..Default::default() };
    let mut maintenance = Maintenance::default();
    maintenance.set_pressure(true); maintenance.request_evict(true);
    maintenance.run_until_idle(&mut db, &protection).unwrap();
    assert!(!maintenance.pending(), "a walk that deletes nothing ends even under pressure");
    assert_eq!(count(&db, "SELECT count(*) FROM records"), 2);
    maintenance.request_evict(false);
    assert!(!maintenance.pending(), "appends do not restart an exhausted walk");
    maintenance.request_evict(true);
    assert_eq!(maintenance.next(false, false), Some(Kind::Evict), "acceptance, pins, views, and reclaim restart it");
    maintenance.run_until_idle(&mut db, &protection).unwrap();
    maintenance.set_pressure(false);
    assert!(!maintenance.pending(), "relieved pressure ends eviction");
    maintenance.set_pressure(true); maintenance.request_evict(false);
    assert_eq!(maintenance.next(false, false), Some(Kind::Evict), "exhaustion lasts only one pressure episode");
}

#[test]
fn size_maintenance_eviction_requested_during_a_fruitless_walk_runs_one_more_walk() {
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    publish(&mut db, "view", "C:\\root", &["C:\\root", "C:\\root\\child"], 1);
    let protection = Protection { scopes: Arc::new(vec![DirectorySizeViewScope { path: normalize_local_path("C:\\root").unwrap(), priority: 0 }]),
        ..Default::default() };
    let mut maintenance = Maintenance::default();
    maintenance.set_pressure(true); maintenance.request_evict(true);
    maintenance.step(Kind::Evict, &mut db, &protection).unwrap();
    maintenance.request_evict(true); // e.g. the views changed mid-walk
    maintenance.step(Kind::Evict, &mut db, &protection).unwrap();
    assert_eq!(maintenance.next(false, false), Some(Kind::Evict), "the request must not be absorbed by the finishing walk");
}

#[test]
fn size_maintenance_appends_during_a_fruitless_walk_do_not_extend_it() {
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    publish(&mut db, "view", "C:\\root", &["C:\\root", "C:\\root\\child"], 1);
    let protection = Protection { scopes: Arc::new(vec![DirectorySizeViewScope { path: normalize_local_path("C:\\root").unwrap(), priority: 0 }]),
        ..Default::default() };
    let mut maintenance = Maintenance::default();
    maintenance.set_pressure(true); maintenance.request_evict(true);
    maintenance.step(Kind::Evict, &mut db, &protection).unwrap();
    maintenance.request_evict(false); // a scan keeps appending under pressure
    maintenance.step(Kind::Evict, &mut db, &protection).unwrap();
    assert_eq!(maintenance.next(false, false), None, "appends cannot change a walk's answer, so it still exhausts");
}

#[test]
fn size_maintenance_failed_probe_keeps_its_requests_for_the_retry() {
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    for ticket in 1..=3 { publish(&mut db, &format!("v{ticket}"), "C:\\root", &["C:\\root"], ticket); }
    let protection = Protection::default();
    let mut maintenance = Maintenance::default();
    maintenance.request_probe("v3".into());
    db.connection.execute_batch("ALTER TABLE scans RENAME TO scans_hidden").unwrap();
    assert!(maintenance.step(Kind::Probe, &mut db, &protection).is_err());
    db.connection.execute_batch("ALTER TABLE scans_hidden RENAME TO scans").unwrap();
    assert_eq!(maintenance.next(false, false), Some(Kind::Probe), "a failed probe is retried");
    maintenance.step(Kind::Probe, &mut db, &protection).unwrap();
    assert!(!maintenance.turnover_for_test().is_empty());
}

#[test]
fn size_maintenance_shrinks_only_once_at_open_above_the_threshold() {
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    publish(&mut db, "kept", "C:\\root", &["C:\\root"], 1);
    let wide = "x".repeat(1800);
    let bulk: Vec<String> = (0..4_000).map(|index| format!("C:\\root\\{index:05}{wide}")).collect();
    append(&mut db, "cancelled", "C:\\root", &bulk);
    let protection = Protection::default();
    let mut runtime = Maintenance::default();
    runtime.request_sweep(); runtime.run_until_idle(&mut db, &protection).unwrap();
    let free = pragma(&db, "freelist_count");
    assert!(free * 4096 >= 32 << 20 && free >= pragma(&db, "page_count") / 2, "runtime deletes leave their pages free");
    let before = fs::metadata(root.0.join("sizes.sqlite3")).unwrap().len();
    let mut opened = Maintenance::default(); opened.opened(false);
    opened.run_until_idle(&mut db, &protection).unwrap();
    assert!(pragma(&db, "freelist_count") < 1024);
    assert!(fs::metadata(root.0.join("sizes.sqlite3")).unwrap().len() < before);
    assert_eq!(fs::metadata(root.0.join("sizes.sqlite3-wal")).unwrap().len(), 0, "the shrink ends with a truncating checkpoint");
}

#[test]
fn size_maintenance_reclaim_keeps_the_pages_it_frees() {
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    for ticket in 1..=3 {
        let paths: Vec<String> = (0..200).map(|index| format!("C:\\cold\\{index:03}{}", "y".repeat(400))).collect();
        append(&mut db, &format!("cold{ticket}"), "C:\\cold", &paths); db.publish(&format!("cold{ticket}"), ticket).unwrap();
    }
    let (pages, free) = (pragma(&db, "page_count"), pragma(&db, "freelist_count"));
    Maintenance::default().reclaim_for(&mut db, &Protection::default(), 0, 64 << 10).unwrap();
    assert!(count(&db, "SELECT count(*) FROM records") < 600);
    assert_eq!(pragma(&db, "page_count"), pages, "a vacuum would truncate the file");
    assert!(pragma(&db, "freelist_count") > free, "reclaimed pages stay available for the retried write");
}

#[test]
fn size_maintenance_one_namespace_request_scrubs_a_large_barrier_completely() {
    use super::operations::{Operation, RenamePath};
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    let prefix = normalize_local_path("C:\\root\\deleted").unwrap();
    let paths: Vec<String> = (0..200).map(|index| format!("{prefix}\\{index:03}")).collect();
    append(&mut db, "old", "C:\\root", &paths); db.publish("old", 1).unwrap();
    db.prepare_operation(&Operation { id: "delete".into(), session: "session".into(), generation: 2,
        paths: vec![RenamePath { from: prefix.clone(), to: prefix.clone() }], scans: vec![], patches: vec![] }).unwrap();
    db.abort_operation("delete").unwrap();
    let mut maintenance = Maintenance::default();
    maintenance.request_namespaces(); maintenance.run_until_idle(&mut db, &Protection::default()).unwrap();
    assert_eq!(count(&db, "SELECT count(*) FROM barriers"), 0);
    assert_eq!(count(&db, "SELECT count(*) FROM records"), 0);
}

#[test]
fn size_maintenance_drops_scans_emptied_by_turnover_or_eviction() {
    let root = Root::new(); let mut db = Database::open(&root.0).unwrap();
    for ticket in 1..=3 { publish(&mut db, &format!("v{ticket}"), "C:\\root", &["C:\\root"], ticket); }
    let protection = Protection::default();
    let mut maintenance = Maintenance::default();
    maintenance.request_turnover("v3".into()); maintenance.run_until_idle(&mut db, &protection).unwrap();
    assert_eq!(count(&db, "SELECT count(*) FROM scans WHERE id='v1'"), 0, "turnover emptied v1");
    maintenance.set_pressure(true); maintenance.request_evict(true); maintenance.run_until_idle(&mut db, &protection).unwrap();
    assert_eq!(count(&db, "SELECT count(*) FROM records"), 0);
    assert_eq!(count(&db, "SELECT count(*) FROM scans"), 0, "eviction emptied the rest");
}

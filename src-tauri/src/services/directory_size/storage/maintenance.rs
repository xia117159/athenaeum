//! Request-driven cache maintenance. Every pass is started by an explicit
//! event, advances a persistent cursor in bounded steps, and ends; with no
//! request pending the worker never touches the database.
use std::{collections::{HashMap, HashSet, VecDeque}, path::Path, sync::Arc, time::{Duration, Instant}};
use anyhow::{Result, ensure};
use rusqlite::{params, Connection};
use super::database::Database;
use super::super::rename_proof::contains;
use crate::domain::directory_sizes::DirectorySizeViewScope;

const STEP_BUDGET: Duration = Duration::from_millis(25);
const TURNOVER_LIMIT: usize = 256;
const PROBE_LIMIT: usize = 256;
const SHRINK_FREE_BYTES: u64 = 32 << 20;
const SHRINK_KEEP_PAGES: u64 = 1024;
pub(super) const PATH_PAGE: &str = "SELECT DISTINCT path FROM records WHERE path>?1 ORDER BY path LIMIT 32";
pub(super) const SCAN_PAGE: &str = "SELECT path FROM records WHERE scan_id=?1 AND path>?2 ORDER BY path LIMIT 32";
pub(super) const LATEST: &str = "SELECT r.scan_id FROM records r JOIN scans s ON s.id=r.scan_id
    WHERE r.path=?1 AND s.state=1 AND s.source=1 ORDER BY s.publication DESC LIMIT 2";
pub(super) const FIRST_PAGE: &str = "SELECT count(*)<16 FROM (SELECT DISTINCT path FROM records
    WHERE parent_path=?1 AND path<?2 ORDER BY path LIMIT 16)";
pub(super) const FIRST: &str = "SELECT NOT EXISTS(SELECT 1 FROM records WHERE parent_path=?1 AND path<?2)";
pub(super) const VERSIONS: &str = "SELECT r.scan_id,s.state FROM records r JOIN scans s ON s.id=r.scan_id
    WHERE r.path=?1 ORDER BY s.source,s.publication LIMIT 128";
pub(super) const DELETE_VERSION: &str = "DELETE FROM records WHERE path=?1 AND scan_id=?2";
pub(super) const COPYING: &str = "SELECT EXISTS(SELECT 1 FROM operation_copies c JOIN cache_operations o ON o.id=c.operation_id
    WHERE (c.old_scan=?1 OR c.shadow_scan=?1) AND o.state IN(0,1))";
pub(super) const SWEEP_SCANS: &str = "SELECT id,state,source FROM scans WHERE id>?1 ORDER BY id LIMIT 16";
pub(super) const SWEEP_RECORDS: &str = "DELETE FROM records WHERE scan_id=?1
    AND path IN(SELECT path FROM records WHERE scan_id=?1 ORDER BY path LIMIT 128)";
pub(super) const DROP_SCAN: &str = "DELETE FROM scans WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM records WHERE scan_id=?1)
    AND NOT EXISTS(SELECT 1 FROM operation_copies c JOIN cache_operations o ON o.id=c.operation_id
        WHERE (c.old_scan=?1 OR c.shadow_scan=?1) AND o.state IN(0,1))";
pub(super) const PROBE: &str = "SELECT count(*) FROM (SELECT 1 FROM records r JOIN scans s ON s.id=r.scan_id
    WHERE r.path=?1 AND s.state=1 AND s.source=1 LIMIT 3)";
const PUBLISHED: &str = "SELECT id,root_path FROM scans WHERE state=1 AND source=1";

#[derive(Clone, Default)]
pub(super) struct Protection {
    pub session: String, pub scans: Vec<String>, pub scopes: Arc<Vec<DirectorySizeViewScope>>, pub hot: Vec<String>,
    pub reclaim: Option<Reclaim>,
}
#[derive(Clone, Copy)]
pub(super) struct Reclaim { pub priority: u8, pub keep_first: bool, pub allow_equal: bool }

/// Requests raised on other threads; the worker drains them under the queue lock.
#[derive(Default)]
pub(super) struct Requests { pub sweep: bool, pub namespaces: bool, pub evict: bool, probe_all: bool, probe: Vec<String> }
impl Requests {
    pub fn is_empty(&self) -> bool { !self.sweep && !self.namespaces && !self.evict && !self.probe_all && self.probe.is_empty() }
    pub fn probe(&mut self, scan: String) {
        if self.probe_all || self.probe.contains(&scan) { return; }
        if self.probe.len() >= PROBE_LIMIT { self.probe_all = true; self.probe.clear(); } else { self.probe.push(scan); }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Kind { Evict, Namespaces, Sweep, Probe, Turnover, Shrink }

/// One cursor walk. A request during a started walk runs exactly one more walk.
#[derive(Default)]
pub(super) struct Pass { running: bool, started: bool, again: bool }
impl Pass {
    fn request(&mut self) { if self.running && self.started { self.again = true; } else { self.running = true; } }
    fn finish(&mut self) { self.running = std::mem::take(&mut self.again); self.started = false; }
}
#[derive(Default)]
struct Evict { pass: Pass, after: String, origin: String, wrapped: bool, deleted: bool, exhausted: bool }
/// Probe points in path order and the published scans rooted at each point.
struct ProbeJob { owners: HashMap<String, Vec<String>>, points: Vec<String>, next: usize }

#[derive(Default)]
pub(super) struct Maintenance {
    pressure: bool, failures: usize,
    evict: Evict,
    namespaces: Pass, pub(super) barrier_after: String,
    sweep: Pass, sweep_after: String,
    probe: Requests, probe_job: Option<ProbeJob>,
    turnover: VecDeque<String>, turnover_after: String, turnover_deleted: bool,
    shrink: bool, shrinking: bool,
    #[cfg(test)] pub(super) probes: u64,
}
impl Maintenance {
    pub fn pressure(database: &Database) -> Result<bool> {
        let pages: u64 = database.connection.query_row("PRAGMA page_count", [], |row| row.get(0))?;
        let free: u64 = database.connection.query_row("PRAGMA freelist_count", [], |row| row.get(0))?;
        let limit: u64 = database.connection.query_row("PRAGMA max_page_count", [], |row| row.get(0))?;
        Ok(pages.saturating_sub(free) * 4096 >= (176 << 20).min(limit.saturating_mul(4096) * 85 / 100))
    }
    /// Requests that converge everything a crash or an earlier session left behind.
    pub fn opened(&mut self, pressure: bool) {
        self.set_pressure(pressure);
        self.sweep.request(); self.namespaces.request(); self.probe.probe_all = true; self.shrink = true;
        self.request_evict(true);
    }
    /// Relieved pressure ends eviction; the next pressure episode starts afresh.
    pub fn set_pressure(&mut self, pressure: bool) {
        self.pressure = pressure;
        if !pressure { self.evict.pass = Pass::default(); self.evict.exhausted = false; }
    }
    /// Starts eviction only under pressure. An exhausted walk found nothing to
    /// delete, so only events that can change the answer clear it.
    /// Appends cannot change that answer either: they start a walk only when
    /// none is running, so a scan that keeps appending cannot extend it.
    pub fn request_evict(&mut self, clear_exhausted: bool) {
        if clear_exhausted { self.evict.exhausted = false; }
        if !self.pressure || self.evict.exhausted { return; }
        if clear_exhausted { self.evict.pass.request(); } else { self.evict.pass.running = true; }
    }
    pub fn request_sweep(&mut self) { self.sweep.request(); }
    pub fn request_namespaces(&mut self) { self.namespaces.request(); }
    pub fn request_probe(&mut self, scan: String) { self.probe.probe(scan); }
    pub fn abandon_shrink(&mut self) { self.shrink = false; self.shrinking = false; }
    pub fn absorb(&mut self, requests: Requests) {
        if requests.sweep { self.sweep.request(); }
        if requests.namespaces { self.namespaces.request(); }
        if requests.evict { self.request_evict(true); }
        if requests.probe_all { self.probe.probe_all = true; }
        for scan in requests.probe { self.probe.probe(scan); }
    }
    fn evicting(&self) -> bool { self.evict.pass.running && self.pressure && !self.evict.exhausted }
    pub fn pending(&self) -> bool {
        self.evicting() || self.namespaces.running || self.sweep.running || self.probe_job.is_some()
            || !self.probe.is_empty() || !self.turnover.is_empty() || self.shrink
    }
    /// Flush and shutdown admit only eviction that makes room for queued writes;
    /// other requests wait for the flush, and an unfinished shrink is dropped.
    pub fn next(&mut self, force: bool, writes_pending: bool) -> Option<Kind> {
        if force { self.abandon_shrink(); return (writes_pending && self.evicting()).then_some(Kind::Evict); }
        if self.evicting() { Some(Kind::Evict) }
        else if self.namespaces.running { Some(Kind::Namespaces) }
        else if self.sweep.running { Some(Kind::Sweep) }
        else if self.probe_job.is_some() || !self.probe.is_empty() { Some(Kind::Probe) }
        else if !self.turnover.is_empty() { Some(Kind::Turnover) }
        else if self.shrink { Some(Kind::Shrink) }
        else { None }
    }
    pub fn succeeded(&mut self) { self.failures = 0; }
    /// Returns the retry delay, or `None` once the shared budget is spent and
    /// every pending request has been dropped until a new event arrives.
    pub fn failed(&mut self, kind: Kind, retry_ms: &[u64]) -> Option<u64> {
        if kind == Kind::Shrink { self.abandon_shrink(); return Some(0); }
        if let Some(delay) = retry_ms.get(self.failures) { self.failures += 1; return Some(*delay); }
        *self = Self { pressure: self.pressure, ..Self::default() };
        None
    }
    /// Runs one bounded step and reports whether it deleted cache data.
    pub fn step(&mut self, kind: Kind, database: &mut Database, protect: &Protection) -> Result<bool> {
        let deadline = Instant::now() + STEP_BUDGET;
        match kind {
            // Rows removed from other scans may leave them empty; one sweep drops them.
            Kind::Evict => self.evict_step(database, protect, deadline).inspect(|deleted| if *deleted { self.sweep.request(); }),
            Kind::Namespaces => self.namespaces_step(database, protect),
            Kind::Sweep => self.sweep_step(database, protect, deadline),
            Kind::Probe => self.probe_step(database, deadline).map(|_| false),
            Kind::Turnover => self.turnover_step(database, protect, deadline),
            Kind::Shrink => self.shrink_step(database).map(|_| false),
        }
    }
    pub(super) fn finish_namespaces(&mut self) { self.barrier_after.clear(); self.namespaces.finish(); }
    pub(super) fn start_namespaces(&mut self) { self.namespaces.started = true; }
    #[cfg(test)]
    pub fn turnover_for_test(&self) -> Vec<String> { self.turnover.iter().cloned().collect() }
    #[cfg(test)]
    pub fn run_until_idle(&mut self, database: &mut Database, protect: &Protection) -> Result<usize> {
        let mut steps = 0;
        while let Some(kind) = self.next(false, false) {
            self.step(kind, database, protect)?; steps += 1;
            ensure!(steps < 10_000, "maintenance did not converge");
        }
        Ok(steps)
    }

    fn evict_step(&mut self, database: &mut Database, protect: &Protection, deadline: Instant) -> Result<bool> {
        if !self.evict.pass.started {
            self.evict.pass.started = true;
            self.evict.origin = self.evict.after.clone(); self.evict.wrapped = false; self.evict.deleted = false;
        }
        let paths = path_page(database, &self.evict.after)?;
        let mut deleted = 0;
        if paths.is_empty() {
            self.evict.after.clear();
            if self.evict.wrapped || self.evict.origin.is_empty() { self.finish_evict(); } else { self.evict.wrapped = true; }
        } else {
            database.admit()?;
            let tx = database.connection.transaction()?;
            let (count, cursor) = prune_paths(&tx, &paths, protect, true, &self.evict.after, deadline)?;
            tx.commit()?;
            deleted = count; self.evict.after = cursor; self.evict.deleted |= count > 0;
            if self.evict.wrapped && self.evict.after >= self.evict.origin { self.finish_evict(); }
        }
        Ok(deleted > 0)
    }
    fn finish_evict(&mut self) {
        // A walk that deleted rows under continuing pressure starts another walk,
        // and so does a request that arrived during the walk. Otherwise a walk
        // that deleted nothing proves every remaining row is protected.
        if self.evict.deleted || self.evict.pass.again { self.evict.pass = Pass { running: true, ..Pass::default() }; }
        else { self.evict.pass = Pass::default(); self.evict.exhausted = true; }
    }
    fn sweep_step(&mut self, database: &mut Database, protect: &Protection, deadline: Instant) -> Result<bool> {
        self.sweep.started = true;
        let scans = {
            let mut query = database.connection.prepare_cached(SWEEP_SCANS)?;
            let scans = query.query_map([&self.sweep_after], |row| Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?, row.get::<_, u32>(2)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            scans
        };
        if scans.is_empty() { self.sweep_after.clear(); self.sweep.finish(); return Ok(false); }
        database.admit()?;
        let tx = database.connection.transaction()?;
        let mut cursor = self.sweep_after.clone(); let mut deleted = false; let mut removed = 0;
        for (id, state, source) in scans {
            if !protect.scans.contains(&id) && !copying(&tx, &id)? {
                // Unpublished, retired, and legacy scans are located through the
                // scans table and removed through the scan index in batches.
                if source == 0 || state != 1 {
                    removed = tx.execute(SWEEP_RECORDS, [&id])?;
                    deleted |= removed > 0;
                    // A full batch keeps the cursor on this scan for the next step.
                    if removed == 128 { break; }
                }
                deleted |= tx.execute(DROP_SCAN, [&id])? > 0;
            }
            cursor = id;
            if removed > 0 || Instant::now() >= deadline { break; }
        }
        tx.commit()?;
        self.sweep_after = cursor;
        Ok(deleted)
    }
    fn probe_step(&mut self, database: &mut Database, deadline: Instant) -> Result<()> {
        let mut job = match self.probe_job.take() {
            Some(job) => job,
            None => {
                // Requests are taken only once the job that carries them exists.
                let published = {
                    let mut query = database.connection.prepare_cached(PUBLISHED)?;
                    let published = query.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    published
                };
                let requests = std::mem::take(&mut self.probe);
                let mut owners: HashMap<String, Vec<String>> = HashMap::new();
                for (id, root) in &published { owners.entry(root.clone()).or_default().push(id.clone()); }
                // A path with three published versions lies under three published
                // roots; the deepest of them has at least three versions itself.
                let mut points: Vec<String> = if requests.probe_all { owners.keys().cloned().collect() } else {
                    let inputs: Vec<&str> = published.iter().filter(|(id, _)| requests.probe.contains(id)).map(|(_, root)| root.as_str()).collect();
                    owners.keys().filter(|root| inputs.iter().any(|input| contains(input, root))).cloned().collect()
                };
                points.sort();
                ProbeJob { owners, points, next: 0 }
            }
        };
        let result = self.probe_points(database, &mut job, deadline);
        // An unfinished or failed job resumes at its first unprobed point.
        if job.next < job.points.len() { self.probe_job = Some(job); }
        result
    }
    fn probe_points(&mut self, database: &Database, job: &mut ProbeJob, deadline: Instant) -> Result<()> {
        let mut query = database.connection.prepare_cached(PROBE)?;
        while let Some(point) = job.points.get(job.next) {
            #[cfg(test)] { self.probes += 1; }
            if query.query_row([point], |row| row.get::<_, u32>(0))? >= 3 {
                for scan in job.owners.get(point).into_iter().flatten() { self.request_turnover(scan.clone()); }
            }
            job.next += 1;
            if Instant::now() >= deadline { break; }
        }
        Ok(())
    }
    pub(super) fn request_turnover(&mut self, scan: String) {
        if self.turnover.contains(&scan) { return; }
        if self.turnover.len() >= TURNOVER_LIMIT { self.turnover.pop_front(); self.turnover_after.clear(); }
        self.turnover.push_back(scan);
    }
    fn turnover_step(&mut self, database: &mut Database, protect: &Protection, deadline: Instant) -> Result<bool> {
        let Some(scan) = self.turnover.front().cloned() else { return Ok(false); };
        let published: bool = database.connection.query_row("SELECT EXISTS(SELECT 1 FROM scans WHERE id=?1 AND state=1)", [&scan], |row| row.get(0))?;
        let paths = if published {
            let mut query = database.connection.prepare_cached(SCAN_PAGE)?;
            let paths = query.query_map(params![scan, self.turnover_after], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            ensure!(paths.iter().map(String::len).sum::<usize>() <= 2 << 20, "maintenance path page limit");
            paths
        } else { vec![] };
        if paths.is_empty() {
            self.turnover.pop_front(); self.turnover_after.clear();
            if self.turnover.is_empty() && std::mem::take(&mut self.turnover_deleted) { self.sweep.request(); }
            return Ok(false);
        }
        database.admit()?;
        let tx = database.connection.transaction()?;
        // Turnover only retires surplus versions; it never evicts.
        let (deleted, cursor) = prune_paths(&tx, &paths, protect, false, &self.turnover_after, deadline)?;
        tx.commit()?;
        self.turnover_after = cursor; self.turnover_deleted |= deleted > 0;
        Ok(deleted > 0)
    }
    fn shrink_step(&mut self, database: &mut Database) -> Result<()> {
        let pragma = |name: &str| -> Result<u64> { Ok(database.connection.query_row(&format!("PRAGMA {name}"), [], |row| row.get(0))?) };
        if !self.shrinking {
            let (mode, pages, free) = (pragma("auto_vacuum")?, pragma("page_count")?, pragma("freelist_count")?);
            if mode != 2 || self.pressure || free * 4096 < SHRINK_FREE_BYTES || free < pages / 2 { self.shrink = false; return Ok(()); }
            self.shrinking = true;
        }
        database.admit()?;
        // The pragma frees one page per result row; `execute_batch` would stop after the first.
        let mut vacuum = database.connection.prepare("PRAGMA incremental_vacuum(256)")?;
        let mut rows = vacuum.query([])?; let mut freed = 0;
        while rows.next()?.is_some() { freed += 1; }
        drop(rows); drop(vacuum);
        // A step that frees nothing cannot make progress; end rather than spin.
        if freed == 0 || pragma("freelist_count")? < SHRINK_KEEP_PAGES {
            database.checkpoint()?;
            self.abandon_shrink();
        }
        Ok(())
    }

    /// A hard-full write gets a bounded search beyond the first protected page.
    /// Shrink later rows first, then minimum pages, and only finally equal-tier
    /// rows. The caller's exit budget is independent of this finite work budget.
    /// Freed pages stay in the file for the retried write.
    pub fn reclaim_for(&mut self, database: &mut Database, protect: &Protection, priority: u8, bytes: usize) -> Result<()> {
        let deadline = Instant::now() + Duration::from_millis(250);
        let target = bytes.saturating_mul(4).saturating_add(16 << 10) as u64;
        let mut protect = protect.clone(); let mut stage = 0; let mut after = String::new();
        for _ in 0..64 { // At most 2048 paths, one 32-path page resident at a time.
            protect.reclaim = Some(Reclaim { priority, keep_first: stage == 0, allow_equal: stage == 2 });
            let paths = path_page(database, &after)?;
            if paths.is_empty() {
                // Complete a whole priority pass before reducing its protection.
                after.clear(); stage += 1; if stage > 2 { break; } continue;
            }
            database.admit()?;
            let tx = database.connection.transaction()?;
            after = prune_paths(&tx, &paths, &protect, true, &after, deadline + STEP_BUDGET)?.1;
            tx.commit()?;
            let free: u64 = database.connection.query_row("PRAGMA freelist_count", [], |row| row.get(0))?;
            if free * 4096 >= target || Instant::now() >= deadline { break; }
        }
        Ok(())
    }
}

fn path_page(database: &Database, after: &str) -> Result<Vec<String>> {
    let mut query = database.connection.prepare_cached(PATH_PAGE)?;
    let paths = query.query_map([after], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    ensure!(paths.iter().map(String::len).sum::<usize>() <= 2 << 20, "maintenance path page limit");
    Ok(paths)
}
fn copying(connection: &Connection, scan: &str) -> Result<bool> {
    Ok(connection.prepare_cached(COPYING)?.query_row([scan], |row| row.get(0))?)
}
/// Applies the per-path version policy to a page and returns the deleted row
/// count and the new cursor. The cursor stays before a path that still has
/// unvisited versions after a deleting visit, and stops at the time budget.
fn prune_paths(connection: &Connection, paths: &[String], protect: &Protection, pressure: bool, after: &str, deadline: Instant) -> Result<(usize, String)> {
    let pins: HashSet<_> = protect.scans.iter().map(String::as_str).collect();
    let mut cursor = after.to_string(); let mut total = 0;
    for path in paths {
        let (deleted, complete) = prune_path(connection, path, protect, &pins, pressure)?;
        total += deleted;
        if !complete && deleted > 0 { break; }
        cursor.clone_from(path);
        if Instant::now() >= deadline { break; }
    }
    Ok((total, cursor))
}
fn prune_path(connection: &Connection, path: &str, protect: &Protection, pins: &HashSet<&str>, pressure: bool) -> Result<(usize, bool)> {
    let latest = connection.prepare_cached(LATEST)?.query_map([path], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<HashSet<_>>>()?;
    let parent = Path::new(path).parent().and_then(Path::to_str);
    let root = protect.scopes.iter().any(|scope| path == scope.path);
    let child = protect.scopes.iter().any(|scope| parent == Some(scope.path.as_str()));
    // A bounded first page per scope prevents a wide directory from
    // protecting the whole database. Other details remain reclaimable.
    let first_page = child && connection.prepare_cached(FIRST_PAGE)?.query_row(params![parent, path], |row| row.get::<_, bool>(0))?;
    let hot = protect.hot.iter().any(|old| old == path);
    let mut protected = root || first_page || hot;
    if let Some(reclaim) = protect.reclaim {
        let tier = protect.scopes.iter().filter(|scope| scope.path == path).map(|scope| scope.priority).min()
            .or_else(|| protect.scopes.iter().filter(|scope| parent == Some(scope.path.as_str())).map(|scope| 3 + scope.priority).min())
            .unwrap_or(if hot { 6 } else { 7 });
        let first = child && connection.prepare_cached(FIRST)?.query_row(params![parent, path], |row| row.get::<_, bool>(0))?;
        protected = tier < reclaim.priority || tier == reclaim.priority && !reclaim.allow_equal || reclaim.keep_first && (root || first);
    }
    let records = connection.prepare_cached(VERSIONS)?.query_map([path], |row| Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let whole_path_fits = records.len() < 128;
    // Under pressure remove older versions first.
    let evict = pressure && !protected;
    let mut deleted = 0;
    for (id, state) in records {
        if pins.contains(id.as_str()) && !evict { continue; }
        if copying(connection, &id)? { continue; }
        if state != 1 || !latest.contains(&id) || evict && whole_path_fits {
            deleted += connection.prepare_cached(DELETE_VERSION)?.execute(params![path, id])?;
        }
    }
    Ok((deleted, whole_path_fits))
}

use std::{collections::HashSet, path::Path, sync::Arc};
use anyhow::{Result, ensure};
use rusqlite::params;
use super::database::Database;
use crate::domain::directory_sizes::DirectorySizeViewScope;

#[derive(Clone, Default)]
pub(super) struct Protection {
    pub session: String, pub scans: Vec<String>, pub scopes: Arc<Vec<DirectorySizeViewScope>>, pub hot: Vec<String>,
    pub migrating: bool,
    pub reclaim: Option<Reclaim>,
}
#[derive(Clone, Copy)]
pub(super) struct Reclaim { pub priority: u8, pub keep_first: bool, pub allow_equal: bool }
#[derive(Default)]
pub(super) struct Maintenance { after: String, scan_after: String, pub(super) barrier_after: String }
impl Maintenance {
    pub fn pressure(database: &Database) -> Result<bool> {
        let pages: u64 = database.connection.query_row("PRAGMA page_count", [], |row| row.get(0))?;
        let free: u64 = database.connection.query_row("PRAGMA freelist_count", [], |row| row.get(0))?;
        let limit: u64 = database.connection.query_row("PRAGMA max_page_count", [], |row| row.get(0))?;
        Ok(pages.saturating_sub(free) * 4096 >= (176 << 20).min(limit.saturating_mul(4096) * 85 / 100))
    }
    pub fn step(&mut self, database: &mut Database, protect: &Protection, pressure: bool) -> Result<()> {
        database.admit()?;
        let mut query = database.connection.prepare_cached("SELECT DISTINCT path FROM records WHERE path>?1 ORDER BY path LIMIT 32")?;
        let paths = query.query_map([&self.after], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        ensure!(paths.iter().map(String::len).sum::<usize>() <= 2 << 20, "maintenance path page limit");
        drop(query);
        if paths.is_empty() { self.after.clear(); } else { self.after = paths.last().unwrap().clone(); }
        let pins: HashSet<_> = protect.scans.iter().map(String::as_str).collect();
        let tx = database.connection.transaction()?;
        for path in paths {
            let mut query = tx.prepare_cached("SELECT r.scan_id FROM records r JOIN scans s ON s.id=r.scan_id
                WHERE r.path=?1 AND s.state=1 ORDER BY s.source DESC,s.publication DESC LIMIT 2")?;
            let latest = query.query_map([&path], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<HashSet<_>>>()?;
            drop(query);
            let root = protect.scopes.iter().any(|scope| path == scope.path);
            let child = protect.scopes.iter().any(|scope| Path::new(&path).parent() == Some(Path::new(&scope.path)));
            // A bounded first page per scope prevents a wide directory from
            // protecting the whole database. Other details remain reclaimable.
            let first_page = child && tx.query_row("SELECT count(*)<16 FROM (SELECT DISTINCT path FROM records
                WHERE parent_path=?1 AND path<?2 ORDER BY path LIMIT 16)",
                params![Path::new(&path).parent().and_then(Path::to_str), path], |row| row.get::<_, bool>(0))?;
            let mut protected = root || first_page || protect.hot.contains(&path);
            if let Some(reclaim) = protect.reclaim {
                let tier = protect.scopes.iter().filter(|scope| scope.path == path).map(|scope| scope.priority).min()
                    .or_else(|| protect.scopes.iter().filter(|scope| Path::new(&path).parent() == Some(Path::new(&scope.path)))
                        .map(|scope| 3 + scope.priority).min()).unwrap_or(if protect.hot.contains(&path) { 6 } else { 7 });
                let first = child && tx.query_row("SELECT NOT EXISTS(SELECT 1 FROM records WHERE parent_path=?1 AND path<?2)",
                    params![Path::new(&path).parent().and_then(Path::to_str), path], |row| row.get::<_, bool>(0))?;
                protected = tier < reclaim.priority || tier == reclaim.priority && !reclaim.allow_equal
                    || reclaim.keep_first && (root || first);
            }
            let mut query = tx.prepare_cached("SELECT r.scan_id,s.state,s.session FROM records r JOIN scans s ON s.id=r.scan_id
                WHERE r.path=?1 ORDER BY s.source,s.publication LIMIT 128")?;
            let records = query.query_map([&path], |row| Ok((row.get::<_, String>(0)?,row.get::<_, u32>(1)?,row.get::<_, String>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let whole_path_fits = records.len() < 128;
            drop(query);
            // Under pressure remove older versions first; never leave legacy visible
            // after removing the normal version which previously shadowed it.
            let evict = pressure && !protected;
            for (id, state, _) in records {
                if pins.contains(id.as_str()) && !evict { continue; }
                let copying: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM operation_copies c JOIN cache_operations o ON o.id=c.operation_id WHERE (c.old_scan=?1 OR c.shadow_scan=?1) AND o.state IN(0,1))", [&id], |row| row.get(0))?;
                if copying { continue; }
                if state != 1 || !latest.contains(&id) || evict && whole_path_fits {
                    tx.execute("DELETE FROM records WHERE path=?1 AND scan_id=?2", params![path,id])?;
                }
            }
        }
        let mut query = tx.prepare_cached("SELECT id FROM scans WHERE id>?1 ORDER BY id LIMIT 128")?;
        let scans = query.query_map([&self.scan_after], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        drop(query);
        self.scan_after = scans.last().cloned().unwrap_or_default();
        for id in scans {
            if !pins.contains(id.as_str()) {
                tx.execute("DELETE FROM scans WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM records WHERE scan_id=?1)
                    AND NOT EXISTS(SELECT 1 FROM operation_copies c JOIN cache_operations o ON o.id=c.operation_id
                        WHERE (c.old_scan=?1 OR c.shadow_scan=?1) AND o.state IN(0,1))", [&id])?;
            }
        }
        tx.commit()?;
        self.cleanup_namespaces(database, protect)?;
        database.admit()?; database.connection.execute_batch("PRAGMA incremental_vacuum(16)")?;
        Ok(())
    }

    /// A hard-full write gets a bounded search beyond the first protected page.
    /// Shrink later rows first, then minimum pages, and only finally equal-tier
    /// rows. The caller's exit budget is independent of this finite work budget.
    pub fn reclaim_for(&mut self, database: &mut Database, protect: &Protection, priority: u8, bytes: usize) -> Result<()> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(250);
        let target = bytes.saturating_mul(4).saturating_add(16 << 10) as u64;
        let mut protect = protect.clone(); let mut stage = 0;
        self.after.clear(); // Complete a whole priority pass before reducing its protection.
        for _ in 0..64 { // At most 2048 paths, one 32-path page resident at a time.
            protect.reclaim = Some(Reclaim { priority, keep_first: stage == 0, allow_equal: stage == 2 });
            self.step(database, &protect, true)?;
            let free: u64 = database.connection.query_row("PRAGMA freelist_count", [], |row| row.get(0))?;
            if free * 4096 >= target || std::time::Instant::now() >= deadline { break; }
            if self.after.is_empty() { stage += 1; if stage > 2 { break; } }
        }
        Ok(())
    }
}

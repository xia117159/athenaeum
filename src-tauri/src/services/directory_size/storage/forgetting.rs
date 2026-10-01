use super::database::Database;
use super::super::{forget::{ForgetFence, ForgetItem}, target::normalize_local_path};
use anyhow::{ensure, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction};

pub(super) fn load_fence(connection: &Connection) -> Result<ForgetFence> {
    let version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    ensure!(version <= 3, "unsupported directory size cache schema");
    if version < 3 { return Ok(ForgetFence::default()); }
    let mut fence = ForgetFence::default();
    fence.floor = connection.query_row("SELECT cutoff FROM size_forget_floor WHERE id=1", [], |row| row.get(0)).optional()?;
    let mut query = connection.prepare("SELECT path,recursive,cutoff FROM size_forgets LIMIT 4097")?;
    let mut rows = query.query([])?; let mut count = 0; let mut bytes = 0;
    while let Some(row) = rows.next()? {
        let path: String = row.get(0)?; let recursive: bool = row.get(1)?; let cutoff: i64 = row.get(2)?;
        count += 1; bytes += path.len();
        ensure!(count <= 4096 && bytes <= 1 << 20, "persistent forget fence exceeds its budget");
        ensure!(normalize_local_path(&path).ok().as_deref() == Some(&path), "invalid forget path");
        fence.insert(&[if recursive { ForgetItem::Prefix(path) } else { ForgetItem::Exact(path) }], cutoff);
    }
    Ok(fence)
}

pub(super) fn persist_fence(tx: &Transaction<'_>, before: &ForgetFence, after: &ForgetFence) -> Result<()> {
    if after.floor != before.floor {
        if let Some(floor) = after.floor {
            tx.execute("INSERT INTO size_forget_floor(id,cutoff) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET cutoff=max(cutoff,excluded.cutoff)", [floor])?;
            tx.execute("DELETE FROM size_forgets WHERE cutoff<=?1", [floor])?;
        }
    }
    for (path, recursive, cutoff) in after.entries() {
        if before.get(path, recursive) == Some(cutoff) { continue; }
        tx.execute("INSERT INTO size_forgets(path,recursive,cutoff) VALUES(?1,?2,?3)
            ON CONFLICT(path,recursive) DO UPDATE SET cutoff=max(cutoff,excluded.cutoff)", params![path,recursive,cutoff])?;
    }
    Ok(())
}

fn delete_item(tx: &Transaction<'_>, item: &ForgetItem, cutoff: i64) -> Result<()> {
    tx.execute("DELETE FROM records WHERE path=?1 AND scan_id IN(SELECT id FROM scans WHERE captured_micros<=?2)", params![item.path(), cutoff])?;
    if item.recursive() {
        let separator = if item.path().starts_with('/') { '/' } else { '\\' };
        let low = format!("{}{separator}", item.path().trim_end_matches(separator));
        let high = format!("{}{}", item.path().trim_end_matches(separator), if separator == '/' { '0' } else { ']' });
        tx.execute("DELETE FROM records WHERE path>=?1 AND path<?2 AND scan_id IN(SELECT id FROM scans WHERE captured_micros<=?3)", params![low,high,cutoff])?;
    }
    Ok(())
}

impl Database {
    pub(super) fn upgrade_forgetting(&mut self) -> Result<()> {
        let tx = self.connection.transaction()?;
        tx.execute_batch("CREATE TABLE size_forgets(path TEXT NOT NULL, recursive INTEGER NOT NULL CHECK(recursive IN(0,1)),
            cutoff INTEGER NOT NULL, PRIMARY KEY(path,recursive)) WITHOUT ROWID;
            CREATE TABLE size_forget_floor(id INTEGER PRIMARY KEY CHECK(id=1), cutoff INTEGER NOT NULL);
            ALTER TABLE scans ADD COLUMN captured_micros INTEGER NOT NULL DEFAULT 0;")?;
        let scans = {
            let mut statement = tx.prepare("SELECT id,captured_at FROM scans")?;
            let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (id, at) in scans {
            let time = chrono::DateTime::parse_from_rfc3339(&at)?.timestamp_micros();
            tx.execute("UPDATE scans SET captured_micros=?2 WHERE id=?1", params![id,time])?;
        }
        tx.execute_batch("PRAGMA user_version=3;")?;
        tx.commit()?; Ok(())
    }
    pub fn forget(&mut self, items: &[ForgetItem], cutoff: i64) -> Result<()> {
        self.admit()?;
        ensure!(items.len() <= 256, "forget batch exceeds its limit");
        let mut items = items.iter().map(|item| normalize_local_path(item.path()).map(|path|
            if item.recursive() { ForgetItem::Prefix(path) } else { ForgetItem::Exact(path) }).map_err(anyhow::Error::msg))
            .collect::<Result<Vec<_>>>()?;
        // Already copied pages and pages still to come must inherit source invalidation.
        let operations = {
            let mut statement = self.connection.prepare("SELECT spec FROM cache_operations WHERE state IN(0,1) ORDER BY publication")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for json in operations {
            let operation: super::operations::Operation = serde_json::from_str(&json)?;
            for pair in operation.paths {
                let mapped: Vec<_> = items.iter().filter_map(|item| super::super::forget::rewritten(item, &pair.from, &pair.to)).collect();
                items.extend(mapped);
            }
        }
        let before = self.forget_cache.borrow().1.clone(); let mut next = before.clone();
        next.insert(&items, cutoff);
        let tx = self.connection.transaction()?;
        persist_fence(&tx, &before, &next)?;
        for item in &items { delete_item(&tx, item, cutoff)?; }
        tx.commit()?;
        self.forget_cache.borrow_mut().1 = next;
        Ok(())
    }
}

pub(super) fn summary_fence(directory: &std::path::Path) -> Result<ForgetFence> {
    let connection = Connection::open_with_flags(directory.join("sizes.sqlite3"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    connection.busy_timeout(std::time::Duration::from_millis(25))?;
    let tx = connection.unchecked_transaction()?;
    let fence = load_fence(&tx)?;
    tx.commit()?; Ok(fence)
}

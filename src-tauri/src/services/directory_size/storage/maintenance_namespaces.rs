use anyhow::Result;
use rusqlite::{params, OptionalExtension};
use super::{database::Database, maintenance::{Maintenance, Protection}};
use super::super::rename_proof::overlaps;

impl Maintenance {
    pub(super) fn cleanup_namespaces(&mut self, db: &mut Database, protect: &Protection) -> Result<()> {
        // A legacy source may still supply old names. Keep its fences until its
        // cursor reaches a committed completion marker, including across restart.
        if protect.migrating || db.connection.query_row("SELECT EXISTS(SELECT 1 FROM migrations WHERE complete=0)", [], |row| row.get::<_, bool>(0))? {
            return Ok(());
        }
        let barrier: Option<(String, String, u64)> = db.connection.query_row(
            "SELECT prefix,session,generation FROM barriers WHERE prefix>?1 AND state=1 ORDER BY prefix LIMIT 1",
            [&self.barrier_after], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?;
        let Some((prefix, session, generation)) = barrier else { self.barrier_after.clear(); return Ok(()); };
        self.barrier_after = prefix.clone();
        for id in &protect.scans {
            let scan: Option<(String, String, u64)> = db.connection.query_row(
                "SELECT root_path,session,CAST(generation AS INTEGER) FROM scans WHERE id=?1", [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?;
            if scan.is_some_and(|(root, owner, age)| owner == session && age <= generation && overlaps(&root, &prefix)) { return Ok(()); }
            // Running streams can be pinned before their first SQL append.
            if id.strip_prefix(&format!("{session}:")).and_then(|age| age.parse::<u64>().ok()).is_some_and(|age| age <= generation) { return Ok(()); }
        }
        db.admit()?;
        let tx = db.connection.transaction()?;
        let removed = tx.execute("DELETE FROM records WHERE (path,scan_id) IN (
            SELECT r.path,r.scan_id FROM records r JOIN scans s ON s.id=r.scan_id JOIN barriers b ON b.prefix=?1
            WHERE r.path>=?1 AND r.path<?1||char(1114111)
            AND (r.path=b.prefix OR substr(r.path,1,length(b.prefix)+1)=b.prefix||char(92))
            AND (s.source=0 OR s.publication<=b.cutoff OR (s.session=b.session AND CAST(s.generation AS INTEGER)<=b.generation))
            LIMIT 64)", [&prefix])?;
        if removed < 64 { tx.execute("DELETE FROM barriers WHERE prefix=?1", [&prefix])?; }
        // Retain a small replay window; older terminal specs and copy cursors have
        // no purpose after their barriers are gone. Remove at most 16 per turn.
        tx.execute("DELETE FROM operation_copies WHERE operation_id IN(
            SELECT id FROM cache_operations WHERE state IN(2,3) AND NOT EXISTS(SELECT 1 FROM barriers WHERE operation_id=cache_operations.id)
            ORDER BY publication DESC LIMIT 16 OFFSET 32)", [])?;
        tx.execute("DELETE FROM cache_operations WHERE id IN(
            SELECT id FROM cache_operations WHERE state IN(2,3) AND NOT EXISTS(SELECT 1 FROM barriers WHERE operation_id=cache_operations.id)
            ORDER BY publication DESC LIMIT 16 OFFSET 32)", [])?;
        tx.execute("DELETE FROM sessions WHERE id IN(SELECT id FROM sessions WHERE id<>?1
            AND NOT EXISTS(SELECT 1 FROM scans WHERE session=sessions.id) LIMIT 8)", params![protect.session])?;
        tx.commit()?;
        Ok(())
    }
}

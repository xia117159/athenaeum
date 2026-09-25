//! Persistent namespace fences and invisible, paged rename revisions.
use std::path::Path;
use anyhow::{Result, ensure};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use super::database::{Database, ScanHeader, StoredDirectory};
use super::super::{rename_proof::{contains, rewrite}, target::normalize_local_path};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(in crate::services::directory_size) struct RenamePath { pub from: String, pub to: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(in crate::services::directory_size) struct Operation {
    pub id: String, pub session: String, pub generation: u64, pub paths: Vec<RenamePath>,
    pub scans: Vec<String>, pub patches: Vec<(String, Option<String>)>,
}
impl Operation {
    pub fn shadow(&self, scan: &str) -> String {
        use sha2::{Digest, Sha256};
        format!("{}:{:x}", self.id, Sha256::digest(scan.as_bytes()))
    }
    fn checked_json(&self) -> Result<String> {
        ensure!(!self.id.is_empty() && self.id.len() <= 64 && self.session.len() <= 64 && self.scans.len() <= 8
            && !self.paths.is_empty() && self.paths.len() <= 2048 && self.patches.len() <= 4096
            && self.generation < i64::MAX as u64 && self.scans.iter().all(|scan| !scan.is_empty() && self.shadow(scan).len() <= 192), "cache operation bounds");
        for path in self.paths.iter().flat_map(|pair| [&pair.from, &pair.to]) {
            ensure!(normalize_local_path(path).ok().as_deref() == Some(path.as_str()), "cache operation path is not canonical");
        }
        let json = serde_json::to_string(self)?; ensure!(json.len() <= 96 << 10, "cache operation byte limit"); Ok(json)
    }
    fn same_preparation(&self, other: &Self) -> bool {
        self.id == other.id && self.session == other.session && self.generation == other.generation
            && self.paths == other.paths && self.scans == other.scans
    }
    fn rewritten(&self, path: &str) -> String {
        // Pairs describe final disjoint moves; intermediate batch names are fenced separately.
        self.paths.iter().find(|pair| contains(&pair.from, path)).map_or_else(|| path.to_string(), |pair| rewrite(path, &pair.from, &pair.to))
    }
}

impl Database {
    pub(super) fn upgrade_operations(&mut self) -> Result<()> {
        self.admit()?;
        self.connection.execute_batch("BEGIN IMMEDIATE;
            ALTER TABLE barriers ADD COLUMN cutoff INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE barriers ADD COLUMN session TEXT NOT NULL DEFAULT '';
            ALTER TABLE barriers ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
            CREATE TABLE cache_operations(id TEXT PRIMARY KEY,state INTEGER NOT NULL,spec TEXT NOT NULL,publication INTEGER) WITHOUT ROWID;
            CREATE TABLE operation_copies(operation_id TEXT NOT NULL,old_scan TEXT NOT NULL,shadow_scan TEXT NOT NULL,
                cursor TEXT NOT NULL DEFAULT '',done INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(operation_id,old_scan)) WITHOUT ROWID;
            PRAGMA user_version=2; COMMIT;")?; Ok(())
    }
    pub(super) fn recover_operations(&mut self) -> Result<()> {
        self.admit()?;
        self.connection.execute_batch("BEGIN IMMEDIATE;
            UPDATE scans SET state=2 WHERE state=0 AND id IN(SELECT c.shadow_scan FROM operation_copies c JOIN cache_operations o ON o.id=c.operation_id WHERE o.state IN(0,1));
            UPDATE barriers SET state=1 WHERE operation_id IN(SELECT id FROM cache_operations WHERE state IN(0,1));
            UPDATE cache_operations SET state=3 WHERE state IN(0,1); COMMIT;")?; Ok(())
    }
    pub fn prepare_operation(&mut self, operation: &Operation) -> Result<()> {
        let json = operation.checked_json()?; self.admit()?;
        let tx = self.connection.transaction()?;
        let previous: Option<String> = tx.query_row("SELECT spec FROM cache_operations WHERE id=?1", [&operation.id], |row| row.get(0)).optional()?;
        if let Some(previous) = previous {
            ensure!(operation.same_preparation(&serde_json::from_str(&previous)?), "conflicting cache operation replay");
            return Ok(());
        }
        let count: u64 = tx.query_row("SELECT count(*) FROM barriers", [], |row| row.get(0))?;
        let bytes: u64 = tx.query_row("SELECT coalesce(sum(length(prefix)),0) FROM barriers", [], |row| row.get(0))?;
        ensure!(count + operation.paths.len() as u64 * 2 <= 1024 && bytes as usize + json.len() <= 1 << 20, "namespace fence capacity");
        tx.execute("INSERT INTO cache_operations(id,state,spec) VALUES(?1,0,?2)", params![operation.id,json])?;
        for path in operation.paths.iter().flat_map(|pair| [&pair.from, &pair.to]) {
            tx.execute("INSERT INTO barriers(prefix,operation_id,state,cutoff,session,generation)
                VALUES(?1,?2,0,(SELECT sequence FROM metadata WHERE id=1),?3,?4)
                ON CONFLICT(prefix) DO UPDATE SET operation_id=excluded.operation_id,state=0,cutoff=excluded.cutoff,session=excluded.session,generation=excluded.generation",
                params![path,operation.id,operation.session,operation.generation])?;
        }
        for scan in &operation.scans {
            tx.execute("INSERT INTO operation_copies(operation_id,old_scan,shadow_scan) VALUES(?1,?2,?3)", params![operation.id,scan,operation.shadow(scan)])?;
        }
        tx.commit()?; Ok(())
    }
    pub(super) fn write_blocked(&self, path: &str, header: &ScanHeader) -> Result<bool> {
        Ok(self.connection.query_row("SELECT EXISTS(SELECT 1 FROM barriers b WHERE (?1=b.prefix OR substr(?1,1,length(b.prefix)+1)=b.prefix||char(92))
            AND (b.state=0 OR ?2=0 OR (b.session=?3 AND b.generation>=?4)))", params![path,header.source,header.session,header.generation], |row| row.get(0))?)
    }
    pub fn authorize_operation(&mut self, operation: &Operation) -> Result<()> {
        let json = operation.checked_json()?; self.admit()?;
        let tx = self.connection.transaction()?;
        let (state, saved): (u32, String) = tx.query_row("SELECT state,spec FROM cache_operations WHERE id=?1", [&operation.id], |row| Ok((row.get(0)?,row.get(1)?)))?;
        let prepared: Operation = serde_json::from_str(&saved)?;
        ensure!(operation.same_preparation(&prepared), "authorization changed the prepared namespace");
        if state == 1 || state == 2 {
            ensure!(operation.patches == prepared.patches, "conflicting cache authorization replay"); return Ok(());
        }
        ensure!(state == 0, "cache operation is no longer prepared");
        let sequence: u64 = tx.query_row("UPDATE metadata SET sequence=sequence+1 WHERE id=1 AND sequence<9223372036854775807 RETURNING sequence", [], |row| row.get(0))?;
        // Reserve acceptance order now; delayed copying cannot outrank a later scan.
        tx.execute("UPDATE cache_operations SET state=1,spec=?2,publication=?3 WHERE id=?1", params![operation.id,json,sequence])?;
        for scan in &operation.scans {
            let root: String = tx.query_row("SELECT root_path FROM scans WHERE id=?1 AND state=1", [scan], |row| row.get(0))?;
            tx.execute("INSERT INTO scans(id,session,root_path,generation,source,state,ticket,publication,captured_at,policy_version)
                SELECT ?1,?2,?3,?4,source,0,NULL,?5,captured_at,policy_version FROM scans WHERE id=?6",
                params![operation.shadow(scan),operation.session,operation.rewritten(&root),(operation.generation + 1).to_string(),sequence,scan])?;
        }
        tx.commit()?; Ok(())
    }
    pub fn abort_operation(&mut self, id: &str) -> Result<()> {
        self.admit()?; let tx = self.connection.transaction()?;
        tx.execute("UPDATE scans SET state=2 WHERE state=0 AND id IN(SELECT shadow_scan FROM operation_copies WHERE operation_id=?1)", [id])?;
        tx.execute("UPDATE barriers SET state=1 WHERE operation_id=?1", [id])?;
        tx.execute("UPDATE cache_operations SET state=3 WHERE id=?1 AND state IN(0,1)", [id])?;
        tx.commit()?; Ok(())
    }
    pub fn advance_operation(&mut self) -> Result<bool> {
        self.admit()?;
        let json: Option<String> = self.connection.query_row("SELECT spec FROM cache_operations WHERE state=1 ORDER BY publication LIMIT 1", [], |row| row.get(0)).optional()?;
        let Some(json) = json else { return Ok(false); };
        ensure!(json.len() <= 96 << 10, "cache operation decode limit");
        let operation: Operation = serde_json::from_str(&json)?;
        operation.checked_json()?;
        let copy: Option<(String,String,String)> = self.connection.query_row("SELECT old_scan,shadow_scan,cursor FROM operation_copies WHERE operation_id=?1 AND done=0 ORDER BY old_scan LIMIT 1",
            [&operation.id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?;
        if let Some((old, shadow, cursor)) = copy {
            let mut query = self.connection.prepare_cached("SELECT path,payload FROM records WHERE scan_id=?1 AND path>?2 ORDER BY path LIMIT 64")?;
            let mut rows = query.query(params![old,cursor])?; let mut page = vec![]; let mut bytes = 0;
            while let Some(row) = rows.next()? {
                let path: String = row.get(0)?; let payload: String = row.get(1)?;
                bytes += path.len() + payload.len(); if bytes > 1 << 20 { break; }
                page.push((path,payload));
            }
            drop(rows); drop(query);
            let tx = self.connection.transaction()?;
            for (_, payload) in &page {
                let mut record: StoredDirectory = serde_json::from_str(payload)?;
                record.path = operation.rewritten(&record.path);
                if let Some((_, fingerprint)) = operation.patches.iter().find(|(path, _)| path == &record.path) { record.size.fingerprint = fingerprint.clone(); }
                let parent = Path::new(&record.path).parent().and_then(Path::to_str).unwrap_or(&record.path);
                tx.execute("INSERT INTO records(path,scan_id,parent_path,created_at,payload) VALUES(?1,?2,?3,?4,?5)",
                    params![record.path,shadow,parent,record.size.created_at.map(|at| at.to_rfc3339()),serde_json::to_string(&record)?])?;
            }
            if let Some((path, _)) = page.last() { tx.execute("UPDATE operation_copies SET cursor=?3 WHERE operation_id=?1 AND old_scan=?2", params![operation.id,old,path])?; }
            else { tx.execute("UPDATE operation_copies SET done=1 WHERE operation_id=?1 AND old_scan=?2", params![operation.id,old])?; }
            tx.commit()?;
        } else {
            let tx = self.connection.transaction()?;
            tx.execute("UPDATE scans SET state=1 WHERE id IN(SELECT shadow_scan FROM operation_copies WHERE operation_id=?1)", [&operation.id])?;
            tx.execute("UPDATE scans SET state=2 WHERE id IN(SELECT old_scan FROM operation_copies WHERE operation_id=?1)", [&operation.id])?;
            tx.execute("UPDATE barriers SET state=1 WHERE operation_id=?1", [&operation.id])?;
            tx.execute("UPDATE cache_operations SET state=2 WHERE id=?1", [&operation.id])?;
            tx.commit()?;
        }
        Ok(true)
    }
}

use super::{BatchPayload, FileIdentity};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub entry: usize,
    pub from: PathBuf,
    pub to: PathBuf,
    pub identity_before: FileIdentity,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum LogEvent {
    Prepared { payload: BatchPayload },
    Pending { step: Step },
    Applied { identity: FileIdentity },
    Skipped,
    Restored,
}

pub struct RecoveryLog {
    file: File,
    durable_length: u64,
    healthy: bool,
}
pub struct RecoveredLog {
    pub payload: BatchPayload,
    pub restored: bool,
    pub had_steps: bool,
}

pub fn log_path(root: &Path, attempt: &str) -> Result<PathBuf> {
    let id = uuid::Uuid::parse_str(attempt).context("无效恢复日志 ID")?;
    Ok(root.join(format!("{id}.jsonl")))
}
pub fn remove_log(root: &Path, attempt: &str) -> Result<()> {
    match fs::remove_file(log_path(root, attempt)?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).context("恢复日志暂时无法清理，相关操作历史将保留"),
    }
}
pub fn has_logs(root: &Path, payload: &BatchPayload) -> bool {
    payload.log_attempts.iter().any(|attempt| {
        log_path(root, attempt)
            .map(|path| path.try_exists().unwrap_or(true))
            .unwrap_or(true)
    })
}
impl RecoveryLog {
    pub fn create(root: &Path, payload: &BatchPayload) -> Result<Self> {
        fs::create_dir_all(root).context("无法创建恢复日志目录")?;
        let path = log_path(root, &payload.attempt_id)?;
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .read(true)
            .open(path)
            .context("无法创建恢复日志")?;
        let mut log = Self {
            file,
            durable_length: 0,
            healthy: true,
        };
        log.append(&LogEvent::Prepared {
            payload: payload.clone(),
        })?;
        Ok(log)
    }
    pub fn append(&mut self, event: &LogEvent) -> Result<()> {
        if !self.healthy {
            bail!("恢复日志无法继续写入，已停止改名");
        }
        let mut content = serde_json::to_vec(event)?;
        content.push(b'\n');
        if let Err(error) = self
            .file
            .write_all(&content)
            .and_then(|_| self.file.sync_all())
        {
            // A partial tail must never hide an earlier durable record or be joined
            // to the next JSON event. Stop mutations if truncation cannot be synced.
            self.healthy = self
                .file
                .set_len(self.durable_length)
                .and_then(|_| self.file.seek(SeekFrom::End(0)).map(|_| ()))
                .and_then(|_| self.file.sync_all())
                .is_ok();
            return Err(error).context("无法持久保存恢复步骤");
        }
        self.durable_length += content.len() as u64;
        Ok(())
    }
}

pub fn read_log(root: &Path, attempt: &str) -> Result<RecoveredLog> {
    let file = File::open(log_path(root, attempt)?).context("无法读取恢复日志")?;
    if file.metadata()?.len() > 128 * 1024 * 1024 {
        bail!("恢复日志大小异常，需要人工检查");
    }
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut payload: Option<BatchPayload> = None;
    let mut initial_paths = Vec::new();
    let mut pending: Option<Step> = None;
    let mut had_steps = false;
    let mut restored = false;
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line)? == 0 {
            break;
        }
        if line.last() != Some(&b'\n') {
            break;
        } // An incomplete tail was never durable.
        let event: LogEvent =
            serde_json::from_slice(&line).context("恢复日志损坏，需要人工检查")?;
        match event {
            LogEvent::Prepared { payload: prepared } => {
                if payload.is_some()
                    || prepared.version != 1
                    || prepared.attempt_id != attempt
                    || prepared.entries.len() > 10_000
                {
                    bail!("不支持或不连续的恢复日志");
                }
                initial_paths = prepared
                    .entries
                    .iter()
                    .map(|entry| entry.current_path.clone())
                    .collect();
                payload = Some(prepared);
            }
            LogEvent::Pending { step } => {
                let current = payload.as_ref().context("恢复日志缺少准备记录")?;
                let entry = current
                    .entries
                    .get(step.entry)
                    .context("恢复日志条目越界")?;
                if pending.is_some()
                    || restored
                    || entry.current_path != step.from
                    || entry.identity != step.identity_before
                    || step.from.parent() != step.to.parent()
                {
                    bail!("恢复日志步骤不连续");
                }
                crate::services::batch_rename::plan::validate_name(super::native::name_of(
                    &step.to,
                )?)
                .map_err(anyhow::Error::msg)?;
                pending = Some(step);
                had_steps = true;
            }
            LogEvent::Applied { identity } => {
                let step = pending.take().context("恢复日志缺少 Pending")?;
                payload.as_mut().context("恢复日志缺少准备记录")?.moved(
                    step.entry,
                    &step.from,
                    &step.to,
                    Some(identity),
                )?;
            }
            LogEvent::Skipped => {
                if pending.take().is_none() {
                    bail!("恢复日志缺少 Pending");
                }
            }
            LogEvent::Restored => {
                let current = payload.as_ref().context("恢复日志缺少准备记录")?;
                if pending.is_some()
                    || !current
                        .entries
                        .iter()
                        .zip(&initial_paths)
                        .all(|(entry, path)| entry.current_path == *path)
                {
                    bail!("恢复完成标记与实际映射不一致");
                }
                restored = true;
            }
        }
    }
    let mut payload = payload.context("恢复日志缺少完整准备记录，需要人工检查")?;
    if let Some(step) = pending {
        let expected_parent = &payload.entries[step.entry].parent_identity;
        let from = super::native::snapshot(&step.from).ok().filter(|source| {
            source.identity == step.identity_before
                && source.parent_identity == *expected_parent
                && source.path == step.from
        });
        let to = super::native::snapshot(&step.to).ok().filter(|source| {
            source.identity == step.identity_before
                && source.parent_identity == *expected_parent
                && source.path == step.to
        });
        match (from, to) {
            (Some(_), None) => {}
            (None, Some(actual)) => {
                payload.moved(step.entry, &step.from, &step.to, Some(actual.identity))?
            }
            _ => {
                payload.entries[step.entry].identity_uncertain = true;
                payload.recovery_diagnostic = Some(format!(
                    "无法确认未完成步骤的文件身份，请检查 {} 与 {}。未自动修改任何文件。",
                    step.from.display(),
                    step.to.display()
                ));
            }
        }
    }
    if had_steps {
        for entry in &mut payload.entries {
            if entry.identity_uncertain {
                continue;
            }
            entry.verify_identity();
        }
    }
    Ok(RecoveredLog {
        payload,
        restored,
        had_steps,
    })
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::services::batch_rename::{native, plan};
    #[test]
    fn recovery_replays_steps_and_resolves_a_durable_pending_rename() {
        let root =
            std::env::temp_dir().join(format!("athenaeum-recovery-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("a.txt");
        fs::write(&path, "original").unwrap();
        let source = native::snapshot(&path).unwrap();
        let (_, plan) = plan::plan_names(&[source.clone()], vec![Ok("b.txt".into())]);
        let payload = BatchPayload::forward(
            &plan.unwrap(),
            &uuid::Uuid::new_v4().to_string(),
            &uuid::Uuid::new_v4().to_string(),
        );
        let log_root = root.join("logs");
        let mut log = RecoveryLog::create(&log_root, &payload).unwrap();
        let step = Step {
            entry: 0,
            from: path.clone(),
            to: root.join("b.txt"),
            identity_before: source.identity.clone(),
        };
        log.append(&LogEvent::Pending { step }).unwrap();
        {
            let group = native::GroupGuard::new(&root, &source.parent_identity).unwrap();
            let handle = group.open_source(&path, &source.identity).unwrap();
            handle.rename_to(&group, "b.txt").unwrap();
        }
        drop(log); // Interrupted after rename, before Applied.
        let recovered = read_log(&log_root, &payload.attempt_id).unwrap();
        assert!(!recovered.payload.identity_unknown());
        assert!(recovered.had_steps);
        assert_eq!(
            recovered.payload.entries[0].current_path,
            root.join("b.txt")
        );
        assert_eq!(fs::read_to_string(root.join("b.txt")).unwrap(), "original");
        fs::remove_dir_all(root).unwrap();
    }
}

use super::{
    recovery::{self, LogEvent, RecoveryLog, Step},
    BatchPayload, BatchRunOutcome, Checkpoint, Direction, Observer,
};
use crate::services::batch_rename::{
    native::{self, GroupGuard},
    plan,
};
use anyhow::{bail, Context, Result};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

fn preflight(payload: &BatchPayload, cancelled: &AtomicBool) -> Result<()> {
    if payload.version != 1 || payload.entries.is_empty() || payload.entries.len() > 10_000 {
        bail!("不支持的批量重命名记录");
    }
    if payload.identity_unknown() {
        bail!("部分项目身份无法确认，请先检查操作记录中的实际位置");
    }
    let mut sources = Vec::with_capacity(payload.entries.len());
    for entry in &payload.entries {
        if cancelled.load(Ordering::Acquire) {
            bail!("操作已取消");
        }
        let source = native::snapshot(&entry.current_path)?;
        if source.identity != entry.identity
            || source.parent_identity != entry.parent_identity
            || source.path != entry.current_path
        {
            bail!("原项目已被替换或改名：{}", entry.current_path.display());
        }
        if payload.direction == Direction::Forward
            && (source.modified != entry.expected_modified
                || source.length != entry.expected_length)
        {
            bail!(
                "项目自预览后已改变，请重新预览：{}",
                entry.current_path.display()
            );
        }
        sources.push(source);
    }
    let (rows, _) = plan::plan_names_cancelable(
        &sources,
        payload
            .entries
            .iter()
            .map(|entry| Ok(entry.target_name.clone()))
            .collect(),
        &|| cancelled.load(Ordering::Acquire),
    );
    if cancelled.load(Ordering::Acquire) {
        bail!("操作已取消");
    }
    if let Some(row) = rows.iter().find(|row| row.diagnostic.is_some()) {
        bail!(
            "{}：{}",
            row.old_name,
            row.diagnostic.as_ref().unwrap().message
        );
    }
    // Check every group's namespace and DELETE access before the first mutation.
    for indices in groups(payload) {
        let first = &payload.entries[indices[0]];
        let guard = GroupGuard::new(
            first.current_path.parent().context("无效父目录")?,
            &first.parent_identity,
        )?;
        for index in indices {
            let entry = &payload.entries[index];
            guard.open_source(&entry.current_path, &entry.identity)?;
        }
    }
    Ok(())
}

fn groups(payload: &BatchPayload) -> Vec<Vec<usize>> {
    let mut by_parent: HashMap<PathBuf, Vec<usize>> = HashMap::new();
    for (index, entry) in payload.entries.iter().enumerate() {
        if native::name_of(&entry.current_path).ok() != Some(&entry.target_name) {
            if let Some(parent) = entry.current_path.parent() {
                by_parent
                    .entry(parent.to_path_buf())
                    .or_default()
                    .push(index);
            }
        }
    }
    let mut groups = by_parent.into_values().collect::<Vec<_>>();
    groups.sort_by(|a, b| {
        let a_depth = payload.entries[a[0]].current_path.components().count();
        let b_depth = payload.entries[b[0]].current_path.components().count();
        let depth = if payload.direction == Direction::Forward {
            b_depth.cmp(&a_depth)
        } else {
            a_depth.cmp(&b_depth)
        };
        depth.then_with(|| a[0].cmp(&b[0]))
    });
    groups
}

struct Runner<'a, 'b> {
    payload: BatchPayload,
    log: RecoveryLog,
    steps: Vec<Step>,
    unsettled: Option<LogEvent>,
    unknown_pending: bool,
    touched_parents: HashSet<PathBuf>,
    sizes: Option<&'a mut crate::services::directory_size::RenameSession<'b>>,
}

impl Runner<'_, '_> {
    fn settle(&mut self, event: LogEvent) -> Result<()> {
        self.unsettled = Some(event);
        self.log.append(self.unsettled.as_ref().unwrap())?;
        self.unsettled = None;
        Ok(())
    }
    fn step(
        &mut self,
        group: &GroupGuard,
        index: usize,
        name: &str,
        check_metadata: bool,
        observer: &mut Observer<'_>,
    ) -> Result<()> {
        let entry = &self.payload.entries[index];
        let from = entry.current_path.clone();
        let to = from.parent().context("无效父目录")?.join(name);
        let handle = group.open_source(&from, &entry.identity)?;
        if check_metadata && (!entry.is_directory || !self.touched_parents.contains(&from)) {
            handle.check_metadata(entry.expected_modified, entry.expected_length)?;
        }
        let step = Step {
            entry: index,
            from: from.clone(),
            to: to.clone(),
            identity_before: entry.identity.clone(),
        };
        observer(Checkpoint::BeforePending, &self.payload)?;
        self.log.append(&LogEvent::Pending { step: step.clone() })?;
        if let Err(error) = observer(Checkpoint::BeforeRename, &self.payload) {
            self.settle(LogEvent::Skipped)?;
            return Err(error);
        }
        let renamed = match self.sizes.as_deref_mut() {
            Some(sizes) => sizes.step(&from, &to, || handle.rename_to(group, name)),
            None => handle.rename_to(group, name),
        };
        if let Err(error) = renamed {
            self.settle(LogEvent::Skipped)?;
            return Err(error);
        }
        self.steps.push(step);
        self.touched_parents
            .insert(from.parent().unwrap().to_path_buf());
        let identity = match handle.identity() {
            Ok(identity) => identity,
            Err(error) => {
                self.payload.moved(index, &from, &to, None)?;
                self.unknown_pending = true;
                return Err(error.context("改名后无法确认文件身份，已保留恢复记录"));
            }
        };
        self.payload
            .moved(index, &from, &to, Some(identity.clone()))?;
        // If an observer fails, still record the known result before rolling back.
        // A process exit here leaves one resolvable Pending record.
        let observed = observer(Checkpoint::AfterRename, &self.payload);
        self.settle(LogEvent::Applied { identity })?;
        observed?;
        observer(Checkpoint::AfterApplied, &self.payload)?;
        Ok(())
    }
    fn execute(&mut self, cancelled: &AtomicBool, observer: &mut Observer<'_>) -> Result<()> {
        observer(Checkpoint::Prepared, &self.payload)?;
        for indices in groups(&self.payload) {
            let first = &self.payload.entries[indices[0]];
            let guard = GroupGuard::new(
                first.current_path.parent().context("无效父目录")?,
                &first.parent_identity,
            )?;
            for index in &indices {
                if cancelled.load(Ordering::Acquire) {
                    bail!("操作已取消");
                }
                let temporary = format!(".athenaeum-{}-{index}", self.payload.attempt_id);
                self.step(
                    &guard,
                    *index,
                    &temporary,
                    self.payload.direction == Direction::Forward,
                    observer,
                )?;
            }
            for index in &indices {
                if cancelled.load(Ordering::Acquire) {
                    bail!("操作已取消");
                }
                let target = self.payload.entries[*index].target_name.clone();
                self.step(&guard, *index, &target, false, observer)?;
            }
            // Both the group and its child handles close before a parent is renamed.
        }
        for entry in &self.payload.entries {
            if cancelled.load(Ordering::Acquire) {
                bail!("操作已取消");
            }
            let actual = native::snapshot(&entry.current_path)?;
            if actual.identity != entry.identity
                || actual.parent_identity != entry.parent_identity
                || actual.path != entry.current_path
                || native::name_of(&entry.current_path)? != entry.target_name
            {
                bail!("最终项目位置已改变：{}", entry.current_path.display());
            }
        }
        Ok(())
    }
    fn rollback(&mut self, observer: &mut Observer<'_>) -> Result<()> {
        if let Some(sizes) = self.sizes.as_deref_mut() { sizes.abandon(); }
        observer(Checkpoint::BeforeRollback, &self.payload)?;
        if self.unknown_pending {
            bail!("最后一步身份未知，已停止自动恢复");
        }
        if let Some(event) = self.unsettled.clone() {
            self.settle(event)?;
        }
        let mut errors = Vec::new();
        for step in self.steps.clone().into_iter().rev() {
            let restored = (|| -> Result<()> {
                let entry = &self.payload.entries[step.entry];
                if entry.identity_unknown() || entry.current_path != step.to {
                    bail!("恢复位置已改变：{}", entry.current_path.display());
                }
                let guard = GroupGuard::new(
                    entry.current_path.parent().context("无效父目录")?,
                    &entry.parent_identity,
                )?;
                self.step(
                    &guard,
                    step.entry,
                    native::name_of(&step.from)?,
                    false,
                    &mut |_, _| Ok(()),
                )
            })();
            if let Err(error) = restored {
                if errors.len() < 5 {
                    errors.push(error.to_string());
                }
                if self.unknown_pending || self.unsettled.is_some() {
                    break;
                }
            }
        }
        if !errors.is_empty() {
            bail!("{}", errors.join("；"));
        }
        self.log.append(&LogEvent::Restored)?;
        Ok(())
    }
}

pub(super) fn run(
    payload: BatchPayload,
    log_root: &Path,
    cancelled: &AtomicBool,
    commit: &mut dyn FnMut(&BatchPayload) -> Result<()>,
    observer: &mut Observer<'_>,
    sizes: Option<&mut crate::services::directory_size::RenameSession<'_>>,
) -> BatchRunOutcome {
    let failure = |payload, error: anyhow::Error| BatchRunOutcome {
        payload,
        committed: false,
        restored: true,
        cancelled: cancelled.load(Ordering::Acquire),
        error: Some(error.to_string()),
        cleanup_warning: None,
    };
    if let Err(error) = preflight(&payload, cancelled) {
        return failure(payload, error);
    }
    let log = match RecoveryLog::create(log_root, &payload) {
        Ok(log) => log,
        Err(error) => return failure(payload, error),
    };
    let before = payload
        .entries
        .iter()
        .map(|entry| entry.current_path.clone())
        .collect::<Vec<_>>();
    let was_recovery = payload.pending_recovery;
    let mut runner = Runner {
        payload,
        log,
        steps: Vec::new(),
        unsettled: None,
        unknown_pending: false,
        touched_parents: HashSet::new(),
        sizes,
    };
    let execution = runner.execute(cancelled, observer).and_then(|_| {
        observer(Checkpoint::BeforeCommit, &runner.payload)?;
        if cancelled.load(Ordering::Acquire) {
            bail!("操作已取消");
        }
        let mut committed = runner.payload.clone();
        committed.pending_recovery = false;
        committed.recovery_diagnostic = None;
        for attempt in &committed.log_attempts {
            if !committed.committed_attempts.contains(attempt) {
                committed.committed_attempts.push(attempt.clone());
            }
        }
        commit(&committed)?;
        runner.payload = committed;
        Ok(())
    });
    match execution {
        Ok(()) => {
            let Runner { payload, log, .. } = runner;
            drop(log);
            let warning = recovery::remove_log(log_root, &payload.attempt_id)
                .err()
                .map(|error| error.to_string());
            BatchRunOutcome {
                payload,
                committed: true,
                restored: false,
                cancelled: false,
                error: None,
                cleanup_warning: warning,
            }
        }
        Err(error) => {
            let rollback = runner.rollback(observer);
            let restored = !runner.payload.identity_unknown()
                && runner
                    .payload
                    .entries
                    .iter()
                    .zip(&before)
                    .all(|(entry, before)| entry.current_path == *before);
            runner.payload.pending_recovery = was_recovery || !restored;
            let message = match rollback {
                Ok(()) => format!("{error}；本批次的改名已恢复"),
                Err(rollback) => format!("{error}；恢复未完成：{rollback}"),
            };
            let Runner { payload, log, .. } = runner;
            drop(log);
            // Even a restored undo may have new FAT IDs; its caller must persist the
            // resulting payload before deleting this attempt's log.
            let warning = if restored && payload.direction == Direction::Forward {
                recovery::remove_log(log_root, &payload.attempt_id)
                    .err()
                    .map(|error| error.to_string())
            } else {
                None
            };
            BatchRunOutcome {
                payload,
                committed: false,
                restored,
                cancelled: cancelled.load(Ordering::Acquire),
                error: Some(message),
                cleanup_warning: warning,
            }
        }
    }
}

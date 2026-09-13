use super::{
    native::{self, EntrySnapshot},
    plan::{self, RenamePlan},
};
use crate::domain::batch_rename::{
    BatchRenamePreview, BatchRenameSessionSnapshot, InvalidateBatchRenameRequest,
    PreviewBatchRenameRequest,
};
use crate::domain::rename_expression::{
    Budget, FunctionInfo, FunctionRegistry, RenameContext, MAX_EXPRESSION_BYTES,
};
use anyhow::{bail, Context, Result};
use chrono::{DateTime, FixedOffset, Local};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
};
use tokio::sync::oneshot;
use uuid::Uuid;

#[derive(Default)]
struct Registry {
    sessions: HashMap<String, Arc<Session>>,
    pending_creates: usize,
    owner_epochs: HashMap<String, u64>,
}
pub struct BatchRenameSessions {
    registry: Mutex<Registry>,
    functions: Arc<FunctionRegistry>,
}
impl Default for BatchRenameSessions {
    fn default() -> Self {
        Self {
            registry: Mutex::new(Registry::default()),
            functions: Arc::new(FunctionRegistry::builtins()),
        }
    }
}
struct PreviewJob {
    expression: String,
    revision: u64,
    reply: oneshot::Sender<Result<BatchRenamePreview>>,
}
#[derive(Default)]
struct Editor {
    queued_revision: u64,
    pending: Option<PreviewJob>,
    plan: Option<(String, Arc<RenamePlan>)>,
    applied: Option<(String, String, Arc<RenamePlan>)>,
}
struct Session {
    id: String,
    owner: String,
    now: DateTime<FixedOffset>,
    sources: Vec<EntrySnapshot>,
    functions: Arc<FunctionRegistry>,
    latest: AtomicU64,
    closed: AtomicBool,
    editor: Mutex<Editor>,
    wake: Condvar,
}

const MAX_SESSIONS: usize = 4;
const MAX_ITEMS: usize = 10_000;
const MAX_SOURCE_TEXT: usize = 8 * 1024 * 1024;
const MAX_TOTAL_TEXT: usize = 64 * 1024 * 1024;

impl BatchRenameSessions {
    pub fn owner_epoch(&self, owner: &str) -> u64 {
        self.registry
            .lock()
            .expect("batch registry poisoned")
            .owner_epochs
            .get(owner)
            .copied()
            .unwrap_or_default()
    }
    #[cfg(test)]
    pub fn create(&self, owner: &str, paths: Vec<String>) -> Result<BatchRenameSessionSnapshot> {
        self.create_at_epoch(owner, paths, self.owner_epoch(owner))
    }
    pub fn catalog(&self) -> Vec<FunctionInfo> {
        self.functions.catalog()
    }
    /// Called on a filesystem worker, never under the registry mutex.
    pub fn create_at_epoch(
        &self,
        owner: &str,
        paths: Vec<String>,
        expected_epoch: u64,
    ) -> Result<BatchRenameSessionSnapshot> {
        if paths.is_empty() || paths.len() > MAX_ITEMS {
            bail!("请选择 1–10000 个本地项目");
        }
        if paths.iter().map(String::len).sum::<usize>() > MAX_SOURCE_TEXT {
            bail!("选择的路径文本过大，请减少项目数量");
        }
        let epoch = {
            let mut registry = self.registry.lock().expect("batch registry poisoned");
            if registry
                .owner_epochs
                .get(owner)
                .copied()
                .unwrap_or_default()
                != expected_epoch
            {
                bail!("所属窗口已关闭或重新加载");
            }
            if registry.sessions.len() + registry.pending_creates >= MAX_SESSIONS {
                bail!("最多同时打开 4 个批量重命名会话");
            }
            registry.pending_creates += 1;
            *registry.owner_epochs.entry(owner.into()).or_default()
        };
        let now = Local::now().fixed_offset();
        let captured = (|| -> Result<Vec<EntrySnapshot>> {
            let mut sources = Vec::with_capacity(paths.len());
            let mut bytes = 0;
            for path in paths {
                let source = native::snapshot(Path::new(&path))?;
                bytes += source.path.to_string_lossy().len();
                if bytes > MAX_SOURCE_TEXT {
                    bail!("规范路径文本过大，请减少项目数量");
                }
                sources.push(source);
            }
            let mut ordered = sources.iter().collect::<Vec<_>>();
            ordered.sort_by(|a, b| {
                native::compare_names(&a.path.to_string_lossy(), &b.path.to_string_lossy())
            });
            if ordered
                .windows(2)
                .any(|pair| native::path_eq(&pair[0].path, &pair[1].path))
            {
                bail!("重复选择了同一个目录项（包含长短路径别名）");
            }
            Ok(sources)
        })();
        let mut registry = self.registry.lock().expect("batch registry poisoned");
        registry.pending_creates -= 1;
        if registry
            .owner_epochs
            .get(owner)
            .copied()
            .unwrap_or_default()
            != epoch
        {
            bail!("所属窗口已关闭");
        }
        let sources = captured?;
        let id = Uuid::new_v4().to_string();
        let snapshot = BatchRenameSessionSnapshot {
            session_id: id.clone(),
            frozen_at: now.to_rfc3339(),
            items: plan::initial_rows(&sources),
        };
        let session = Arc::new(Session {
            id: id.clone(),
            owner: owner.into(),
            sources,
            now,
            functions: self.functions.clone(),
            latest: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            editor: Mutex::new(Editor::default()),
            wake: Condvar::new(),
        });
        registry.sessions.insert(id.clone(), session.clone());
        drop(registry);
        if let Err(error) = std::thread::Builder::new()
            .name("batch-rename-preview".into())
            .spawn(move || session.work())
        {
            self.close(owner, &id);
            return Err(error).context("无法启动重命名预览");
        }
        Ok(snapshot)
    }
    fn get(&self, owner: &str, id: &str) -> Result<Arc<Session>> {
        let registry = self.registry.lock().expect("batch registry poisoned");
        registry
            .sessions
            .get(id)
            .filter(|session| session.owner == owner && !session.closed.load(Ordering::Acquire))
            .cloned()
            .context("批量重命名会话已关闭或不属于当前窗口")
    }
    pub async fn preview(
        &self,
        owner: &str,
        request: PreviewBatchRenameRequest,
    ) -> Result<BatchRenamePreview> {
        let session = self.get(owner, &request.session_id)?;
        let (reply, result) = oneshot::channel();
        {
            let mut editor = session.editor.lock().expect("batch editor poisoned");
            if session.closed.load(Ordering::Acquire) {
                bail!("会话已关闭");
            }
            if request.revision == 0
                || request.revision > 9_007_199_254_740_991
                || request.revision < session.latest.load(Ordering::Acquire)
                || request.revision <= editor.queued_revision
            {
                bail!("预览版本已过期");
            }
            if editor.applied.is_some() {
                bail!("本次批量重命名已经开始");
            }
            session.latest.store(request.revision, Ordering::Release);
            editor.queued_revision = request.revision;
            editor.plan = None;
            if let Some(old) = editor.pending.take() {
                let _ = old.reply.send(Err(anyhow::anyhow!("预览已被新版本替代")));
            }
            if request.expression.len() > MAX_EXPRESSION_BYTES {
                bail!("表达式超过 16 KiB");
            }
            editor.pending = Some(PreviewJob {
                expression: request.expression,
                revision: request.revision,
                reply,
            });
        }
        session.wake.notify_one();
        result.await.context("预览会话已关闭")?
    }
    pub fn invalidate(&self, owner: &str, request: InvalidateBatchRenameRequest) -> Result<()> {
        let session = self.get(owner, &request.session_id)?;
        let mut editor = session.editor.lock().expect("batch editor poisoned");
        if session.closed.load(Ordering::Acquire) {
            bail!("会话已关闭");
        }
        if request.revision == 0 || request.revision > 9_007_199_254_740_991 {
            bail!("无效的预览版本");
        }
        if request.revision <= session.latest.load(Ordering::Acquire) {
            return Ok(());
        }
        if editor.applied.is_some() {
            bail!("本次批量重命名已经开始");
        }
        session.latest.store(request.revision, Ordering::Release);
        editor.plan = None;
        if let Some(old) = editor.pending.take() {
            let _ = old.reply.send(Err(anyhow::anyhow!("预览已被新版本替代")));
        }
        Ok(())
    }
    pub fn claim(
        &self,
        owner: &str,
        id: &str,
        preview: &str,
        request: &str,
    ) -> Result<Arc<RenamePlan>> {
        if request.is_empty() || request.len() > 128 {
            bail!("无效的重命名请求 ID");
        }
        let session = self.get(owner, id)?;
        let mut editor = session.editor.lock().expect("batch editor poisoned");
        if session.closed.load(Ordering::Acquire) {
            bail!("会话已关闭");
        }
        if let Some((previous, previous_preview, plan)) = &editor.applied {
            if previous == request && previous_preview == preview {
                return Ok(plan.clone());
            }
            bail!("批量重命名已开始，不能重复确认");
        }
        let (preview_id, plan) = editor
            .plan
            .as_ref()
            .filter(|(key, _)| key == preview)
            .context("预览已失效，请等待最新预览")?;
        let plan = plan.clone();
        editor.applied = Some((request.into(), preview_id.clone(), plan.clone()));
        editor.plan = None;
        Ok(plan)
    }
    pub fn close(&self, owner: &str, id: &str) {
        let mut registry = self.registry.lock().expect("batch registry poisoned");
        if registry
            .sessions
            .get(id)
            .is_some_and(|session| session.owner == owner)
        {
            if let Some(session) = registry.sessions.remove(id) {
                session.close();
            }
        }
    }
    pub fn close_owner(&self, owner: &str) {
        let mut registry = self.registry.lock().expect("batch registry poisoned");
        *registry.owner_epochs.entry(owner.into()).or_default() += 1;
        registry.sessions.retain(|_, session| {
            if session.owner == owner {
                session.close();
                false
            } else {
                true
            }
        });
    }
}
impl Drop for BatchRenameSessions {
    fn drop(&mut self) {
        if let Ok(registry) = self.registry.get_mut() {
            for session in registry.sessions.values() {
                session.close();
            }
        }
    }
}
impl Session {
    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let mut editor = self.editor.lock().expect("batch editor poisoned");
        editor.plan = None;
        if let Some(pending) = editor.pending.take() {
            let _ = pending.reply.send(Err(anyhow::anyhow!("会话已关闭")));
        }
        self.wake.notify_one();
    }
    fn outdated(&self, revision: u64) -> bool {
        self.closed.load(Ordering::Acquire) || self.latest.load(Ordering::Acquire) != revision
    }
    fn work(self: Arc<Self>) {
        loop {
            let job = {
                let mut editor = self.editor.lock().expect("batch editor poisoned");
                while editor.pending.is_none() && !self.closed.load(Ordering::Acquire) {
                    editor = self.wake.wait(editor).expect("batch editor poisoned");
                }
                if self.closed.load(Ordering::Acquire) {
                    return;
                }
                editor.pending.take().expect("pending preview")
            };
            let computed = self.compute(&job.expression, job.revision);
            let mut editor = self.editor.lock().expect("batch editor poisoned");
            if self.outdated(job.revision) {
                let _ = job.reply.send(Err(anyhow::anyhow!("预览已被新版本替代")));
                continue;
            }
            let result = computed.map(|(preview, plan)| {
                editor.plan = preview.preview_id.clone().zip(plan.map(Arc::new));
                preview
            });
            let _ = job.reply.send(result);
        }
    }
    fn compute(
        &self,
        expression: &str,
        revision: u64,
    ) -> Result<(BatchRenamePreview, Option<RenamePlan>)> {
        let mut preview = BatchRenamePreview {
            session_id: self.id.clone(),
            expression: expression.into(),
            revision,
            preview_id: None,
            items: Vec::new(),
            diagnostics: Vec::new(),
            changed_count: 0,
            can_apply: false,
        };
        let compiled = match self.functions.compile(expression) {
            Ok(compiled) => compiled,
            Err(error) => {
                preview.items = plan::initial_rows(&self.sources);
                for row in &mut preview.items {
                    row.new_name = None;
                    row.target_path = None;
                    row.status = crate::domain::batch_rename::BatchRenameRowStatus::Error;
                }
                preview.diagnostics.push(error);
                return Ok((preview, None));
            }
        };
        let cancelled = || self.outdated(revision);
        let mut budget = Budget::new(&cancelled);
        let mut cache = HashMap::new();
        let mut names = Vec::with_capacity(self.sources.len());
        let mut name_bytes = 0;
        for (index, source) in self.sources.iter().enumerate() {
            if cancelled() {
                bail!("预览已取消");
            }
            let context = RenameContext {
                name: native::name_of(&source.path)?.into(),
                is_directory: source.is_directory,
                now: self.now,
                modified: source.modified,
                created: source.created,
                index,
            };
            let name = compiled.evaluate(&context, &mut budget, &mut cache);
            name_bytes += match &name {
                Ok(name) => name.len(),
                Err(error) => error.message.len(),
            };
            if name_bytes > MAX_TOTAL_TEXT / 4 {
                bail!("预览结果过大，请简化表达式或减少选择");
            }
            names.push(name);
        }
        if cancelled() {
            bail!("预览已取消");
        }
        let (rows, plan) = plan::plan_names_cancelable(&self.sources, names, &cancelled);
        if cancelled() {
            bail!("预览已取消");
        }
        let text_bytes = self
            .sources
            .iter()
            .map(|source| source.path.to_string_lossy().len())
            .sum::<usize>()
            + rows
                .iter()
                .map(|row| {
                    row.source_path.len()
                        + row.parent_path.len()
                        + row.old_name.len()
                        + row.new_name.as_ref().map_or(0, String::len)
                        + row.target_path.as_ref().map_or(0, String::len)
                        + row
                            .diagnostic
                            .as_ref()
                            .map_or(0, |error| error.message.len())
                })
                .sum::<usize>()
            + plan.as_ref().map_or(0, |plan| {
                plan.items
                    .iter()
                    .map(|item| {
                        item.snapshot.path.to_string_lossy().len()
                            + item.final_path.to_string_lossy().len()
                            + item.target_name.len()
                    })
                    .sum::<usize>()
            });
        if text_bytes > MAX_TOTAL_TEXT {
            bail!("会话文本超过 64 MiB，请减少选择");
        }
        preview.changed_count = rows
            .iter()
            .filter(|row| row.status == crate::domain::batch_rename::BatchRenameRowStatus::Changed)
            .count();
        preview.can_apply = plan.is_some();
        preview.preview_id = plan.as_ref().map(|_| Uuid::new_v4().to_string());
        preview.items = rows;
        Ok((preview, plan))
    }
}

#[cfg(all(test, windows))]
mod tests;

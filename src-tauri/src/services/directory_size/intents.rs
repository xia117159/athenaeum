use super::*;
use DirectorySizeIntent::*;

const UNCOMPUTED: &str = "尚未计算或上次结果已不可用，请重新计算";
const COOLDOWN: &str = "距上次自动计算不足 30 秒，稍后自动开始";

impl Core {
    pub(super) fn validate_intent(&self, request: &SubscribeDirectorySizesRequest, target: &ScanTarget) -> Result<(), String> {
        if request.intent == Auto && target.profile.is_some() { return Err("自动计算只支持本地目录".into()); }
        if request.intent == Start && target.profile.is_none() { return Err("首次计算意图只支持远程目录".into()); }
        if request.retry_failed && request.intent != Auto { return Err("只有自动计算可以请求失败重试".into()); }
        Ok(())
    }
    pub(super) fn intent_key(&self, target: &ScanTarget, intent: DirectorySizeIntent) -> String {
        let direct = self.roots.get(&target.key);
        if intent == Resume && direct.is_some_and(|root| !matches!(root.phase, DirectorySizePhase::Cancelled | DirectorySizePhase::Stale)) {
            return target.key.clone();
        }
        if matches!(intent, Resume | Auto) && target.profile.is_none() {
            if let Some(key) = self.reusable_root(target) {
                if intent == Resume || !self.roots[&key].stale.contains(&target.path) { return key; }
            }
        }
        target.key.clone()
    }
    pub(super) fn admit_root(&mut self, key: &str) -> Result<(), String> {
        while self.roots.values().filter(|root| !root.placeholder).count() >= self.limits.roots {
            if !self.evict_unleased(Some(key)) { return Err("目录统计已达到 8 个根目录上限".into()); }
        }
        Ok(())
    }
    /// `quiet` applies to automatic scheduling only: 0 for a new subscription, 500 when rerooting (§6.3).
    pub(super) fn prepare_intent_root(&mut self, key: &str, target: &ScanTarget, intent: DirectorySizeIntent, quiet: u64, now: u64) -> Result<(), String> {
        let missing = !self.roots.contains_key(key);
        let promote = self.roots.get(key).is_some_and(|root| root.placeholder) && intent != Resume;
        if (missing && intent != Resume) || promote { self.admit_root(key)?; }
        if missing {
            self.generation += 1;
            let mut root = Root::new(target.clone(), self.generation, now);
            root.scan_explicit = matches!(intent, Calculate | Start);
            if intent == Resume { root.placeholder = true; root.needs_scan = false; root.phase = DirectorySizePhase::Stale; root.reason = Some(UNCOMPUTED.into()); }
            if intent == Auto { root.due = self.scan_due(key, now, quiet, false); if root.due > now { root.reason = Some(COOLDOWN.into()); } }
            self.roots.insert(key.into(), root);
        } else if promote { self.roots.get_mut(key).unwrap().placeholder = false; }
        Ok(())
    }
    pub(super) fn active_scan(&self, key: &str) -> bool {
        self.roots.get(key).is_some_and(|root| root.needs_scan || root.running.as_ref().is_some_and(|run|
            run.generation == root.generation && !run.cancelled.load(Ordering::Relaxed)))
    }
    pub(super) fn apply_intent(&mut self, key: &str, intent: DirectorySizeIntent, retry: bool, quiet: u64, now: u64) {
        let root = &self.roots[key];
        let phase = root.phase;
        match intent {
            Resume => {
                if phase == DirectorySizePhase::Cancelled {
                    self.invalidate_with_intent(key, now, false, true, 0, false, UNCOMPUTED);
                    self.roots.get_mut(key).unwrap().placeholder = true;
                } else { self.accept_advisory_result(key); }
            }
            Calculate | Start => {
                if intent == Start && matches!(phase, DirectorySizePhase::Complete | DirectorySizePhase::Partial) { return; }
                if self.active_scan(key) {
                    // D18 shares the queued generation, but an explicit request is never held
                    // back by the automatic cooldown of the scan it joins.
                    let due = self.scan_due(key, now, 0, true);
                    let root = self.roots.get_mut(key).unwrap();
                    if root.needs_scan && root.running.is_none() && due < root.due { root.due = due; root.scan_explicit = true; root.reason = None; self.emit(key); }
                    return;
                }
                self.invalidate_with_intent(key, now, true, false, 0, true, "已请求重新统计");
                self.roots.get_mut(key).unwrap().phase = DirectorySizePhase::Queued;
                self.emit(key);
            }
            Auto => {
                if self.active_scan(key) || root.identity_expired || phase == DirectorySizePhase::Failed && !retry { return; }
                if root.result.is_some() && root.watch.is_some() && matches!(phase, DirectorySizePhase::Complete | DirectorySizePhase::Partial) { self.schedule_stale_auto(key, now); return; }
                let quiet = if root.result.is_some() { 500 } else { quiet };
                if root.result.is_some() || root.running.is_some() {
                    self.invalidate_with_intent(key, now, true, false, quiet, false, "等待自动计算");
                } else {
                    let due = self.scan_due(key, now, quiet, false);
                    let root = self.roots.get_mut(key).unwrap();
                    root.needs_scan = true; root.scan_explicit = false; root.due = due;
                }
                let root = self.roots.get_mut(key).unwrap();
                root.phase = DirectorySizePhase::Queued;
                root.reason = Some(if root.due > now + quiet { COOLDOWN } else { "等待自动计算" }.into());
                self.emit(key);
            }
        }
    }
}

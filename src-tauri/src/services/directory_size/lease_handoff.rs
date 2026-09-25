use super::*;

pub(super) struct Slot { revision: u32, consumer: Option<String> }
fn validate(handoff: &DirectorySizeHandoff) -> Result<(), String> {
    if !matches!(handoff.slot_id.as_str(), "panel-1" | "panel-2" | "panel-3" | "panel-4") || handoff.slot_revision == 0 {
        return Err("无效的目录统计面板版本".into());
    }
    Ok(())
}

impl Core {
    pub fn subscribe(&mut self, owner: OwnerToken, request: SubscribeDirectorySizesRequest, profile: Option<RemoteProfile>, now: u64) -> Result<DirectorySizeSnapshot, String> {
        let Some(handoff) = request.handoff.clone() else { return self.subscribe_inner(owner, request, profile, now, 0); };
        validate(&handoff)?;
        if self.owner_token(&owner.label)?.epoch != owner.epoch { return Err("统计窗口生命周期已结束".into()); }
        let key = (owner.label.clone(), handoff.slot_id.clone());
        if let Some(slot) = self.slots.get(&key) {
            if handoff.slot_revision <= slot.revision { return Err("目录统计交接请求已过期".into()); }
            if slot.consumer != handoff.handoff_from { return Err("目录统计交接来源不匹配".into()); }
        }
        let previous = handoff.handoff_from.as_deref();
        if previous == Some(request.consumer_id.as_str()) { return Err("目录统计交接需要新的订阅标识".into()); }
        if self.leases.contains_key(&request.consumer_id) { return Err("目录统计交接订阅标识已存在".into()); }
        if let Some(previous) = previous {
            let lease = self.leases.get(previous).ok_or("目录统计交接来源已结束")?;
            if lease.owner.label != owner.label || lease.owner.epoch != owner.epoch { return Err("目录统计交接不属于当前窗口".into()); }
        }
        // Install the new lease before release can cancel the last consumer.
        // All validation and final-count admission happens under the Core mutex.
        let consumer = request.consumer_id.clone();
        let result = self.subscribe_inner(owner.clone(), request, profile, now, usize::from(previous.is_some()));
        if result.is_ok() {
            if let Some(previous) = previous { self.release(&owner.label, previous, now)?; }
            self.slots.insert(key, Slot { revision: handoff.slot_revision, consumer: Some(consumer) });
        }
        result
    }

    pub fn release_slot(&mut self, owner: OwnerToken, consumer: &str, handoff: DirectorySizeHandoff, now: u64) -> Result<(), String> {
        validate(&handoff)?;
        if self.owner_token(&owner.label)?.epoch != owner.epoch { return Err("统计窗口生命周期已结束".into()); }
        let key = (owner.label.clone(), handoff.slot_id);
        if let Some(slot) = self.slots.get(&key) {
            if handoff.slot_revision < slot.revision { return self.release(&owner.label, consumer, now); }
            if slot.consumer.as_deref().is_some_and(|id| id != consumer && Some(id) != handoff.handoff_from.as_deref()) {
                return Err("目录统计关闭来源不匹配".into());
            }
        }
        let previous = self.slots.insert(key, Slot { revision: handoff.slot_revision, consumer: None }).and_then(|slot| slot.consumer);
        if let Some(previous) = previous { self.release(&owner.label, &previous, now)?; }
        self.release(&owner.label, consumer, now)
    }
}

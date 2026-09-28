import assert from "node:assert/strict";
import { test } from "node:test";
import { manualSubscribeIntent, reduceDirectorySizes } from "./directorySizeState";
import { sizeFixture, sizeRecord, sizeSnapshot } from "./directorySizeTestSupport";
import { getPathComparisonKey } from "./workspacePathRelations";
import type { TabState } from "./types";

function target(kind: "local" | "ftp" = "local") {
  const fixture = sizeFixture(kind);
  const base = { panelId: "panel-1" as const, tabId: fixture.tab.id, rootPath: fixture.path };
  return { ...fixture, base, lease: { ...base, consumerId: "size-test", requestVersion: 0,
    expectedRoot: fixture.tab.snapshot, expectedExpansion: fixture.tab.folderExpansion } };
}
const fresh = (tab: TabState): TabState => ({ ...tab, directorySizes: undefined });

test("calculate authorizes a manual lease without committing it; remote first calculate starts, later ones recalculate", () => {
  const { tab, base } = target("ftp");
  const requested = reduceDirectorySizes(fresh(tab), { type: "directorySizeRequested", payload: { ...base, intent: "calculate", requestedAt: 7 } });
  const sizes = requested.directorySizes!;
  assert.equal(sizes.requested, true);
  assert.equal(sizes.forceRefresh, true);
  assert.equal(sizes.requestedAt, 7);
  assert.equal(sizes.manualStarted, false, "only a committed lease records that remote work started");
  assert.equal(manualSubscribeIntent(sizes, true), "start");
  const started = reduceDirectorySizes(requested, { type: "directorySizeLeaseStarted", payload: { ...base, consumerId: "c1", requestVersion: 1, mode: "manual" } });
  assert.equal(started.directorySizes?.manualStarted, true);
  assert.equal(started.directorySizes?.forceRefresh, false);
  assert.equal(manualSubscribeIntent(started.directorySizes!, true), "resume");
  const again = reduceDirectorySizes(started, { type: "directorySizeRequested", payload: { ...base, intent: "calculate", requestedAt: 8 } });
  assert.equal(manualSubscribeIntent(again.directorySizes!, true), "calculate");
  assert.equal(manualSubscribeIntent(again.directorySizes!, false), "calculate");
});

test("lease start never sets requested; auto commit clears it and the manual pause; release keeps requested", () => {
  const { tab, base } = target();
  const idle = reduceDirectorySizes(fresh(tab), { type: "directorySizeLeaseStarted", payload: { ...base, consumerId: "a", requestVersion: 0, mode: "manual" } });
  assert.equal(idle.directorySizes?.requested, false);
  const requested = reduceDirectorySizes(fresh(tab), { type: "directorySizeRequested", payload: { ...base, intent: "calculate" } });
  const manual = reduceDirectorySizes(requested, { type: "directorySizeLeaseStarted", payload: { ...base, consumerId: "m", requestVersion: 1, mode: "manual" } });
  assert.equal(manual.directorySizes?.mode, "manual");
  assert.equal(manual.directorySizes?.requested, true);
  const released = reduceDirectorySizes(manual, { type: "directorySizeReleased", payload: { ...base, consumerId: "m", requestVersion: 1 } });
  assert.equal(released.directorySizes?.requested, true);
  assert.equal(released.directorySizes?.forceRefresh, false);
  assert.equal(released.directorySizes?.consumerId, undefined);
  assert.equal(released.directorySizes?.snapshot?.reason, "视图已离开，返回后恢复显示");
  const paused = { ...manual, directorySizes: { ...manual.directorySizes!, paused: true } };
  const auto = reduceDirectorySizes(paused, { type: "directorySizeLeaseStarted", payload: { ...base, consumerId: "x", requestVersion: 1, mode: "auto" } });
  assert.equal(auto.directorySizes?.mode, "auto");
  assert.equal(auto.directorySizes?.requested, false, "automatic coverage replaces the manual request");
  assert.equal(auto.directorySizes?.paused, false);
  assert.equal(auto.directorySizes?.autoAttempted, true);
});

test("invalidation revision changes drop records and fence older listing caches", () => {
  const { tab, lease, parent } = target();
  const first = reduceDirectorySizes(tab, { type: "directorySizeSnapshotReceived", payload: { ...lease,
    snapshot: sizeSnapshot({ sequence: 3, invalidationRevision: "0" }) } });
  const withRecords = { ...first, directorySizes: { ...first.directorySizes!, records: tab.directorySizes!.records } };
  const same = reduceDirectorySizes(withRecords, { type: "directorySizeSnapshotReceived", payload: { ...lease,
    snapshot: sizeSnapshot({ sequence: 4, invalidationRevision: "0" }) } });
  assert.ok(same.directorySizes?.records[getPathComparisonKey(parent.path)], "unchanged revision keeps records");
  const changed = reduceDirectorySizes(withRecords, { type: "directorySizeSnapshotReceived", payload: { ...lease,
    snapshot: sizeSnapshot({ sequence: 5, invalidationRevision: "1", invalidated: true }) } });
  assert.deepEqual(changed.directorySizes?.records, {});
  assert.deepEqual(changed.directorySizes?.cacheFence, { generation: 1, sequence: 5 });
});

test("a readable stale snapshot accepts lookups; an unreadable one does not", () => {
  const { tab, lease, parent } = target();
  const lookup = { consumerId: "size-test", generation: 1, sequence: 2, stale: false, directories: [sizeRecord(parent.path, "75", "stamp", "stale")] };
  const readable = { ...tab, directorySizes: { ...tab.directorySizes!, records: {}, snapshot: sizeSnapshot({ phase: "stale", staleReadable: true, totalBytes: null }) } };
  const received = reduceDirectorySizes(readable, { type: "directorySizeLookupReceived", payload: { ...lease, lookup } });
  assert.equal(received.directorySizes?.records[getPathComparisonKey(parent.path)].state, "stale");
  const unreadable = { ...readable, directorySizes: { ...readable.directorySizes, snapshot: sizeSnapshot({ phase: "stale", totalBytes: null }) } };
  assert.equal(reduceDirectorySizes(unreadable, { type: "directorySizeLookupReceived", payload: { ...lease, lookup } }), unreadable);
});

test("automatic failures pause only automatic calculation and survive release until an explicit retry", () => {
  const { tab, base } = target();
  const auto = reduceDirectorySizes(fresh(tab), { type: "directorySizeLeaseStarted", payload: { ...base, consumerId: "a", requestVersion: 0, mode: "auto" } });
  const failed = reduceDirectorySizes(auto, { type: "directorySizeSnapshotReceived", payload: { ...base, consumerId: "a", requestVersion: 0,
    snapshot: sizeSnapshot({ consumerId: "a", phase: "failed", reason: "拒绝访问", totalBytes: null }) } });
  assert.equal(failed.directorySizes?.autoPaused, true);
  assert.equal(failed.directorySizes?.autoError, "拒绝访问");
  assert.equal(failed.directorySizes?.paused, false, "a manual pause is independent");
  const released = reduceDirectorySizes(failed, { type: "directorySizeReleased", payload: { ...base, consumerId: "a", requestVersion: 0 } });
  assert.equal(released.directorySizes?.autoPaused, true);
  assert.equal(released.directorySizes?.snapshot?.phase, "failed", "release keeps the failure visible");
  const retried = reduceDirectorySizes(released, { type: "directorySizeAutoRetried", payload: base });
  assert.equal(retried.directorySizes?.autoPaused, false);
  assert.equal(retried.directorySizes?.autoError, undefined);
  assert.equal(retried.directorySizes?.autoAttempted, false, "the next subscription is authorized to retry");
  assert.equal(retried.directorySizes?.requestVersion, 1);
  assert.equal(retried.directorySizes?.snapshot, undefined);
  const lookupFailed = reduceDirectorySizes(auto, { type: "directorySizeFailed", payload: { ...base, consumerId: "a", requestVersion: 0, message: "查询失败" } });
  assert.equal(lookupFailed.directorySizes?.autoPaused, true);
  assert.equal(lookupFailed.directorySizes?.paused, false);
});

test("a failed automatic replacement keeps the live manual fallback and its retry only advances the attempt", () => {
  const { tab, base } = target();
  const requested = reduceDirectorySizes(fresh(tab), { type: "directorySizeRequested", payload: { ...base, intent: "calculate" } });
  const manual = reduceDirectorySizes(requested, { type: "directorySizeLeaseStarted", payload: { ...base, consumerId: "m", requestVersion: 1, mode: "manual" } });
  const running = reduceDirectorySizes(manual, { type: "directorySizeSnapshotReceived", payload: { ...base, consumerId: "m", requestVersion: 1,
    snapshot: sizeSnapshot({ consumerId: "m", phase: "scanning", totalBytes: null }) } });
  const failed = reduceDirectorySizes(running, { type: "directorySizeLeaseFailed", payload: { ...base, consumerId: "x", requestVersion: 1, mode: "auto", attemptVersion: 0, message: "交接超时" } });
  const sizes = failed.directorySizes!;
  assert.equal(sizes.consumerId, "m");
  assert.equal(sizes.mode, "manual");
  assert.equal(sizes.requested, true);
  assert.equal(sizes.paused, false);
  assert.equal(sizes.snapshot?.phase, "scanning", "the running manual task keeps updating");
  assert.equal(sizes.autoPaused, true);
  assert.equal(sizes.autoError, "交接超时");
  const retried = reduceDirectorySizes(failed, { type: "directorySizeAutoRetried", payload: base });
  assert.equal(retried.directorySizes?.requestVersion, 1);
  assert.equal(retried.directorySizes?.attemptVersion, 1);
  assert.equal(retried.directorySizes?.consumerId, "m");
  assert.equal(retried.directorySizes?.snapshot?.phase, "scanning");
  const stale = reduceDirectorySizes(retried, { type: "directorySizeLeaseStarted", payload: { ...base, consumerId: "old", requestVersion: 1, mode: "auto", attemptVersion: 0 } });
  assert.equal(stale, retried, "an older automatic attempt cannot commit");
  const committed = reduceDirectorySizes(retried, { type: "directorySizeLeaseStarted", payload: { ...base, consumerId: "new", requestVersion: 1, mode: "auto", attemptVersion: 1 } });
  assert.equal(committed.directorySizes?.consumerId, "new");
  const late = reduceDirectorySizes(committed, { type: "directorySizeSnapshotReceived", payload: { ...base, consumerId: "m", requestVersion: 1,
    snapshot: sizeSnapshot({ consumerId: "m", sequence: 50 }) } });
  assert.equal(late, committed, "the replaced manual consumer is fenced");
});

test("a failed subscription without a live lease is an ordinary failure of that mode", () => {
  const { tab, base } = target();
  const requested = reduceDirectorySizes(fresh(tab), { type: "directorySizeRequested", payload: { ...base, intent: "calculate" } });
  const manual = reduceDirectorySizes(requested, { type: "directorySizeLeaseFailed", payload: { ...base, consumerId: "m", requestVersion: 1, mode: "manual", message: "无法订阅" } });
  assert.equal(manual.directorySizes?.paused, true);
  assert.equal(manual.directorySizes?.requested, false);
  assert.equal(manual.directorySizes?.snapshot?.phase, "failed");
  const auto = reduceDirectorySizes(fresh(tab), { type: "directorySizeLeaseFailed", payload: { ...base, consumerId: "a", requestVersion: 0, mode: "auto", attemptVersion: 0, message: "无法订阅" } });
  assert.equal(auto.directorySizes?.autoPaused, true);
  assert.equal(auto.directorySizes?.autoAttempted, true);
  assert.equal(auto.directorySizes?.paused, false);
  assert.equal(auto.directorySizes?.snapshot?.phase, "failed");
  assert.equal(reduceDirectorySizes(requested, { type: "directorySizeLeaseFailed", payload: { ...base, consumerId: "m", requestVersion: 0, mode: "manual", message: "old" } }), requested);
});

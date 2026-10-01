import assert from "node:assert/strict";
import { test } from "node:test";
import { createEntrySizeProjector, projectEntrySize } from "./directorySizes";
import { expansionEntry } from "./folderExpansionTestSupport";
import { getPathComparisonKey } from "./workspacePathRelations";
import { sizeFixture, sizeRecord, sizeSnapshot } from "./directorySizeTestSupport";

test("a stale record shows its old value grey, without a share, and outside every denominator", () => {
  const f = sizeFixture();
  const other = expansionEntry(f.path, "other");
  f.tab.snapshot.entries.push(other);
  f.sizes.records[getPathComparisonKey(f.parent.path)] = sizeRecord(f.parent.path, "60", "parent-stamp", "stale");
  f.sizes.records[getPathComparisonKey(other.path)] = sizeRecord(other.path, "20", "other-stamp");
  const project = createEntrySizeProjector(f.tab);
  const parent = project(f.parent).sizeDisplay!;
  assert.equal(parent.state, "stale");
  assert.equal(parent.invalidated, true);
  assert.equal(parent.bytes, "60");
  assert.equal(parent.share, null);
  assert.equal(parent.label, "60 B");
  assert.equal(parent.title, "已过期：目录内容已变化，请重新计算；旧值 60 字节");
  // 20 + 30 + 10 known; the stale 60 is excluded.
  assert.equal(project(other).sizeDisplay?.share, 20 / 60 - (20 / 60) % 0.000001);
  assert.match(project(other).sizeDisplay?.title ?? "", /已知/);
});

test("a stale parent record keeps its fingerprint from hiding the rows it still describes", () => {
  const f = sizeFixture();
  f.tab.snapshot.sizeFingerprint = "root-changed";
  f.sizes.records[getPathComparisonKey(f.path)] = sizeRecord(f.path, "100", "root-stamp", "stale");
  assert.equal(projectEntrySize(f.tab, f.parent).sizeDisplay?.bytes, "60");
  assert.equal(projectEntrySize(f.tab, f.parent).sizeDisplay?.state, "complete");
});

test("retained rows never cover a stale current record", () => {
  const f = sizeFixture();
  const before = projectEntrySize(f.tab, f.parent).sizeDisplay!;
  f.tab.directorySizePresentation = { current: { rootPath: f.path, locationKind: "local", rows: {
    [f.parent.path]: { path: f.parent.path, parentPath: f.path, kind: "folder", createdAt: f.parent.sizeCreatedAt, total: before, max: before }
  } } } as never;
  f.sizes.records[getPathComparisonKey(f.parent.path)] = sizeRecord(f.parent.path, "70", "parent-stamp", "stale");
  const display = projectEntrySize(f.tab, f.parent).sizeDisplay!;
  assert.equal(display.retained, undefined);
  assert.equal(display.invalidated, true);
  assert.equal(display.bytes, "70");
});

test("a readable stale phase projects old records grey; an unreadable one shows nothing", () => {
  const f = sizeFixture();
  f.sizes.snapshot = sizeSnapshot({ phase: "stale", staleReadable: true, invalidated: true, totalBytes: null });
  f.sizes.records[getPathComparisonKey(f.parent.path)] = sizeRecord(f.parent.path, "60", "parent-stamp", "stale");
  const display = projectEntrySize(f.tab, f.parent).sizeDisplay!;
  assert.equal(display.invalidated, true);
  assert.equal(display.bytes, "60");
  assert.equal(display.share, null);
  f.sizes.snapshot = sizeSnapshot({ phase: "stale", staleReadable: false, totalBytes: null });
  assert.equal(projectEntrySize(f.tab, f.parent).sizeDisplay?.bytes, null);
});

test("history hints name when they were calculated and what the lease is doing", () => {
  const cachedAt = "2026-09-25T00:00:00Z";
  const captured = new Date(cachedAt).toLocaleString();
  const withHint = (historical: boolean) => {
    const f = sizeFixture();
    f.sizes.records = {};
    f.tab.snapshot.directorySizeCache = { generation: 0, sequence: 0, historical, directories: [
      { ...sizeRecord(f.parent.path, "60"), createdAt: f.parent.sizeCreatedAt, cachedAt }
    ] };
    return f;
  };
  const title = (f: ReturnType<typeof withHint>) => projectEntrySize(f.tab, f.parent).sizeDisplay?.title ?? "";
  const cases: Array<[string, (f: ReturnType<typeof withHint>) => void]> = [
    ["，仅供参考", (f) => { f.sizes.consumerId = undefined; f.sizes.snapshot = undefined; }],
    ["，正在重新计算", (f) => { f.sizes.snapshot = sizeSnapshot({ phase: "scanning", totalBytes: null }); }],
    ["，正在重新计算", (f) => { f.sizes.snapshot = sizeSnapshot({ phase: "queued", totalBytes: null }); }],
    ["，本次统计未包含此项", () => undefined],
    ["，已取消刷新", (f) => { f.sizes.snapshot = sizeSnapshot({ phase: "cancelled", totalBytes: null }); }],
    ["，刷新失败：拒绝访问", (f) => { f.sizes.snapshot = sizeSnapshot({ phase: "failed", totalBytes: null, reason: "拒绝访问" }); }]
  ];
  for (const [suffix, arrange] of cases) {
    const f = withHint(true); arrange(f);
    assert.equal(title(f).split("；占已知")[0], `历史值（计算于 ${captured}）；60 字节${suffix}`);
  }
  const live = withHint(false);
  live.tab.snapshot.directorySizeCache!.generation = 1;
  live.tab.snapshot.directorySizeCache!.sequence = 2;
  live.sizes.consumerId = undefined; live.sizes.snapshot = undefined;
  assert.equal(title(live).split("；占已知")[0], `历史值（计算于 ${captured}）；60 字节，仅供参考`);
  assert.doesNotMatch(title(live), /等待目录身份校验/);
});

test("retained rows say why they are kept", () => {
  const f = sizeFixture();
  const before = projectEntrySize(f.tab, f.parent).sizeDisplay!;
  f.tab.directorySizePresentation = { current: { rootPath: f.path, locationKind: "local", rows: {
    [f.parent.path]: { path: f.parent.path, parentPath: f.path, kind: "folder", createdAt: f.parent.sizeCreatedAt, total: before, max: before }
  } } } as never;
  f.sizes.records = {};
  f.sizes.snapshot = sizeSnapshot({ phase: "scanning", totalBytes: null });
  assert.match(projectEntrySize(f.tab, f.parent).sizeDisplay?.title ?? "", /^上次结果（等待刷新结果）/);
  f.sizes.snapshot = sizeSnapshot({ phase: "stale", totalBytes: null, reason: "视图已离开，返回后恢复显示" });
  f.sizes.consumerId = undefined;
  assert.match(projectEntrySize(f.tab, f.parent).sizeDisplay?.title ?? "", /^上次结果（上次显示结果）/);
});

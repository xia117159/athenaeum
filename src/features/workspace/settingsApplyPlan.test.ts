import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SettingsApplyFailure,
  formatSettingsApplyFailure,
  runSettingsApplyPlan
} from "./settingsApplyPlan";

test("settings apply plan commits in durable dependency order", async () => {
  const calls: string[] = [];
  await runSettingsApplyPlan([
    { label: "常规设置", run: async () => { calls.push("run-settings"); }, onCommitted: () => { calls.push("commit-settings"); } },
    { label: "颜色规则", run: async () => { calls.push("run-rules"); }, onCommitted: () => { calls.push("commit-rules"); } },
    { label: "连接配置", run: async () => { calls.push("run-connections"); }, onCommitted: () => { calls.push("commit-connections"); } }
  ]);

  assert.deepEqual(calls, [
    "run-settings",
    "commit-settings",
    "run-rules",
    "commit-rules",
    "run-connections",
    "commit-connections"
  ]);
});

test("settings apply plan exposes committed and failed sections at every failure boundary", async () => {
  const labels = ["常规设置", "颜色规则", "连接 A", "连接 B"];
  for (let failureIndex = 0; failureIndex < labels.length; failureIndex += 1) {
    const committedCallbacks: string[] = [];
    const steps = labels.map((label, index) => ({
      label,
      run: async () => {
        if (index === failureIndex) throw new Error(`failure-${index}`);
      },
      onCommitted: () => { committedCallbacks.push(label); }
    }));

    await assert.rejects(
      () => runSettingsApplyPlan(steps),
      (error: unknown) => {
        assert.equal(error instanceof SettingsApplyFailure, true);
        const failure = error as SettingsApplyFailure;
        assert.deepEqual(failure.committedLabels, labels.slice(0, failureIndex));
        assert.equal(failure.failedLabel, labels[failureIndex]);
        assert.deepEqual(committedCallbacks, labels.slice(0, failureIndex));
        assert.match(formatSettingsApplyFailure(failure), new RegExp(`未完成：${labels[failureIndex]}`));
        if (failureIndex > 0) assert.match(formatSettingsApplyFailure(failure), /已保存：/);
        return true;
      }
    );
  }
});

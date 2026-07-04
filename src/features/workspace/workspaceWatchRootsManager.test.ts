import assert from "node:assert/strict";
import { WatchRootsManager } from "./workspaceWatchRootsManager";
import type { WorkspaceGateway } from "./workspaceGateway";
import type { WorkspaceWatchRootsRequest } from "./types";

async function assertAsyncTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function createMockGateway(): {
  gateway: Pick<WorkspaceGateway, "setWatchRoots">;
  calls: WorkspaceWatchRootsRequest[];
} {
  const calls: WorkspaceWatchRootsRequest[] = [];
  return {
    gateway: {
      async setWatchRoots(request: WorkspaceWatchRootsRequest) {
        calls.push({ ...request });
      }
    },
    calls
  };
}

export const workspaceWatchRootsManagerTests = (async () => {
  await assertAsyncTest("WatchRootsManager only calls gateway when roots change", async () => {
    const { gateway, calls } = createMockGateway();
    const manager = new WatchRootsManager(gateway as WorkspaceGateway, { enableLogging: false });

    await manager.update({ directoryPaths: ["C:\\test"], navigationParentPaths: [] });
    await manager.update({ directoryPaths: ["C:\\test"], navigationParentPaths: [] }); // 重复
    await manager.update({ directoryPaths: ["C:\\test"], navigationParentPaths: [] }); // 重复

    assert.equal(calls.length, 1, "Should only call gateway once for duplicate roots");
    assert.deepEqual(calls[0], { directoryPaths: ["C:\\test"], navigationParentPaths: [], gitSentinelPaths: [] });

    await manager.dispose();
  });

  await assertAsyncTest("WatchRootsManager deduplicates and sorts paths", async () => {
    const { gateway, calls } = createMockGateway();
    const manager = new WatchRootsManager(gateway as WorkspaceGateway, { enableLogging: false });

    await manager.update({
      directoryPaths: ["C:\\b", "C:\\a", "C:\\b", "C:\\a"], // 有重复
      navigationParentPaths: ["D:\\z", "D:\\x"]
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].directoryPaths, ["C:\\a", "C:\\b"], "Should dedupe and sort");
    assert.deepEqual(calls[0].navigationParentPaths, ["D:\\x", "D:\\z"], "Should dedupe and sort");

    await manager.dispose();
  });

  await assertAsyncTest("WatchRootsManager treats different order as same roots", async () => {
    const { gateway, calls } = createMockGateway();
    const manager = new WatchRootsManager(gateway as WorkspaceGateway, { enableLogging: false });

    await manager.update({ directoryPaths: ["C:\\a", "C:\\b"], navigationParentPaths: [] });
    await manager.update({ directoryPaths: ["C:\\b", "C:\\a"], navigationParentPaths: [] }); // 顺序不同但内容相同

    assert.equal(calls.length, 1, "Should treat different order as same roots");

    await manager.dispose();
  });

  await assertAsyncTest("WatchRootsManager detects actual changes", async () => {
    const { gateway, calls } = createMockGateway();
    const manager = new WatchRootsManager(gateway as WorkspaceGateway, { enableLogging: false });

    await manager.update({ directoryPaths: ["C:\\test1"], navigationParentPaths: [] });
    await manager.update({ directoryPaths: ["C:\\test2"], navigationParentPaths: [] });
    await manager.update({ directoryPaths: ["C:\\test1", "C:\\test2"], navigationParentPaths: [] });

    assert.equal(calls.length, 3, "Should detect all actual changes");
    assert.deepEqual(calls[0].directoryPaths, ["C:\\test1"]);
    assert.deepEqual(calls[1].directoryPaths, ["C:\\test2"]);
    assert.deepEqual(calls[2].directoryPaths, ["C:\\test1", "C:\\test2"]);

    await manager.dispose();
  });

  await assertAsyncTest("WatchRootsManager clears roots on dispose", async () => {
    const { gateway, calls } = createMockGateway();
    const manager = new WatchRootsManager(gateway as WorkspaceGateway, { enableLogging: false });

    await manager.update({ directoryPaths: ["C:\\test"], navigationParentPaths: [] });
    await manager.dispose();

    // dispose 应该清空 roots
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], { directoryPaths: [], navigationParentPaths: [], gitSentinelPaths: [] });
  });

  await assertAsyncTest("WatchRootsManager ignores updates after dispose", async () => {
    const { gateway, calls } = createMockGateway();
    const manager = new WatchRootsManager(gateway as WorkspaceGateway, { enableLogging: false });

    await manager.update({ directoryPaths: ["C:\\test"], navigationParentPaths: [] });
    await manager.dispose();

    const callsBeforeDisposedUpdate = calls.length;
    await manager.update({ directoryPaths: ["C:\\new"], navigationParentPaths: [] }); // 应该被忽略

    assert.equal(calls.length, callsBeforeDisposedUpdate, "Should ignore updates after dispose");
  });

  await assertAsyncTest("WatchRootsManager tracks update count and history", async () => {
    const { gateway, calls } = createMockGateway();
    const manager = new WatchRootsManager(gateway as WorkspaceGateway, {
      enableLogging: false,
      maxHistorySize: 5
    });

    await manager.update({ directoryPaths: ["C:\\1"], navigationParentPaths: [] });
    await manager.update({ directoryPaths: ["C:\\1"], navigationParentPaths: [] }); // 重复，不计入
    await manager.update({ directoryPaths: ["C:\\2"], navigationParentPaths: [] });
    await manager.update({ directoryPaths: ["C:\\3"], navigationParentPaths: [] });

    const debug = manager.getDebugState();
    assert.equal(debug.updateCount, 3, "Should count only actual updates");
    assert.equal(debug.history.length, 3, "Should track history");
    assert.deepEqual(debug.currentRoots.directoryPaths, ["C:\\3"]);

    await manager.dispose();
  });

  await assertAsyncTest("WatchRootsManager respects maxHistorySize", async () => {
    const { gateway, calls } = createMockGateway();
    const manager = new WatchRootsManager(gateway as WorkspaceGateway, {
      enableLogging: false,
      maxHistorySize: 3
    });

    for (let i = 1; i <= 5; i++) {
      await manager.update({ directoryPaths: [`C:\\${i}`], navigationParentPaths: [] });
    }

    const debug = manager.getDebugState();
    assert.equal(debug.history.length, 3, "Should keep only last 3 items");
    assert.deepEqual(debug.history[0].roots.directoryPaths, ["C:\\3"]);
    assert.deepEqual(debug.history[2].roots.directoryPaths, ["C:\\5"]);

    await manager.dispose();
  });

  await assertAsyncTest("WatchRootsManager filters out empty paths", async () => {
    const { gateway, calls } = createMockGateway();
    const manager = new WatchRootsManager(gateway as WorkspaceGateway, { enableLogging: false });

    await manager.update({
      directoryPaths: ["", "C:\\test", "", "D:\\other", ""],
      navigationParentPaths: []
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].directoryPaths, ["C:\\test", "D:\\other"], "Should filter empty paths");

    await manager.dispose();
  });
})();

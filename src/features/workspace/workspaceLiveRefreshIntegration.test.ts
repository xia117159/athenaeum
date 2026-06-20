import assert from "node:assert/strict";
import {
  hasTauriRuntime,
  invokeRequired
} from "./workspaceIpc";
import {
  listenWorkspaceFsChanges,
  setWorkspaceWatchRoots
} from "./workspaceLiveRefreshGateway";

async function assertAsyncTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

export const workspaceLiveRefreshIntegrationTests = (async () => {
  await assertAsyncTest("hasTauriRuntime returns true when __TAURI_INTERNALS__ is present", async () => {
    const runtimeHost = { __TAURI_INTERNALS__: {} };
    assert.equal(hasTauriRuntime(runtimeHost), true);
  });

  await assertAsyncTest("hasTauriRuntime returns false when __TAURI_INTERNALS__ is missing", async () => {
    const runtimeHost = {};
    assert.equal(hasTauriRuntime(runtimeHost), false);
  });

  await assertAsyncTest("setWorkspaceWatchRoots invokes backend when Tauri runtime present", async () => {
    let invoked = false;
    const runtimeHost = { __TAURI_INTERNALS__: {} };

    await setWorkspaceWatchRoots(
      { directoryPaths: ["C:\\test"], navigationParentPaths: [] },
      async <T>(_command: string, _args: Record<string, unknown>) => {
        invoked = true;
        return undefined as T;
      },
      runtimeHost
    );

    assert.equal(invoked, true, "Backend command should be invoked with Tauri runtime");
  });

  await assertAsyncTest("setWorkspaceWatchRoots returns undefined when Tauri runtime missing", async () => {
    let invoked = false;
    const runtimeHost = {};

    await setWorkspaceWatchRoots(
      { directoryPaths: ["C:\\test"], navigationParentPaths: [] },
      async <T>(_command: string, _args: Record<string, unknown>) => {
        invoked = true;
        return undefined as T;
      },
      runtimeHost
    );

    assert.equal(invoked, false, "Backend should not be invoked without Tauri runtime");
  });

  await assertAsyncTest("listenWorkspaceFsChanges returns noop when Tauri runtime missing", async () => {
    const runtimeHost = {};
    const unlisten = await listenWorkspaceFsChanges(
      () => { throw new Error("Should not be called"); },
      { runtimeHost }
    );

    // Should return a noop function
    unlisten();
    assert.ok(true);
  });

  await assertAsyncTest("listenWorkspaceFsChanges subscribes when Tauri runtime present", async () => {
    const runtimeHost = { __TAURI_INTERNALS__: {} };
    let subscribed = false;

    const unlisten = await listenWorkspaceFsChanges(
      () => {},
      {
        runtimeHost,
        listen: async () => {
          subscribed = true;
          return () => {};
        }
      }
    );

    assert.equal(subscribed, true, "Should subscribe to events with Tauri runtime");
    unlisten();
  });

  await assertAsyncTest("invokeRequired uses browserFallback when runtime missing", async () => {
    let invokedBackend = false;
    let usedFallback = false;
    const runtimeHost = {};

    await invokeRequired(
      "test_command",
      {},
      () => {
        usedFallback = true;
        return "fallback";
      },
      async <T>(_command: string, _args: Record<string, unknown>) => {
        invokedBackend = true;
        return "backend" as T;
      },
      runtimeHost
    );

    assert.equal(invokedBackend, false, "Backend should not be invoked");
    assert.equal(usedFallback, true, "Should use browser fallback");
  });

  await assertAsyncTest("invokeRequired invokes backend when runtime present", async () => {
    let invokedBackend = false;
    let usedFallback = false;
    const runtimeHost = { __TAURI_INTERNALS__: {} };

    await invokeRequired(
      "test_command",
      {},
      () => {
        usedFallback = true;
        return "fallback";
      },
      async <T>(_command: string, _args: Record<string, unknown>) => {
        invokedBackend = true;
        return "backend" as T;
      },
      runtimeHost
    );

    assert.equal(invokedBackend, true, "Backend should be invoked");
    assert.equal(usedFallback, false, "Should not use browser fallback");
  });
})();

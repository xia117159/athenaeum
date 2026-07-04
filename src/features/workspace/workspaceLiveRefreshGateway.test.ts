import assert from "node:assert/strict";
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

const runtimeHost = { __TAURI_INTERNALS__: {} };

export const workspaceLiveRefreshGatewayTests = (async () => {
  await assertAsyncTest("setWorkspaceWatchRoots invokes the stable watch-roots command", async () => {
    let invokedCommand: string | null = null;
    let invokedArgs: Record<string, unknown> | null = null;

    await setWorkspaceWatchRoots(
      {
        directoryPaths: ["D:\\Projects\\Atlas"],
        navigationParentPaths: ["C:\\Users\\Admin\\Documents"]
      },
      async <T>(command: string, args: Record<string, unknown>) => {
        invokedCommand = command;
        invokedArgs = args;
        return undefined as T;
      },
      runtimeHost
    );

    assert.equal(invokedCommand, "set_workspace_watch_roots");
    assert.deepEqual(invokedArgs, {
      request: {
        directoryPaths: ["D:\\Projects\\Atlas"],
        navigationParentPaths: ["C:\\Users\\Admin\\Documents"],
        gitSentinelPaths: []
      }
    });
  });

  await assertAsyncTest("listenWorkspaceFsChanges subscribes to the stable file-system event", async () => {
    const listened: string[] = [];
    const received: unknown[] = [];
    const unlisten = await listenWorkspaceFsChanges((event) => {
      received.push(event);
    }, {
      runtimeHost,
      listen: async <T,>(eventName: string, handler: (event: { payload: T }) => void | Promise<void>) => {
        listened.push(eventName);
        await handler({
          payload: {
            roots: ["D:\\Projects\\Atlas"],
            directoryRoots: ["D:\\Projects\\Atlas"],
            navigationParentRoots: [],
            sequence: 3
          } as T
        });
        return () => listened.push("unlisten");
      }
    });

    assert.deepEqual(listened, ["workspace_fs_changed"]);
    assert.deepEqual(received, [
      {
        roots: ["D:\\Projects\\Atlas"],
        directoryRoots: ["D:\\Projects\\Atlas"],
        navigationParentRoots: [],
        sequence: 3
      }
    ]);
    unlisten();
    assert.deepEqual(listened, ["workspace_fs_changed", "unlisten"]);
  });
})();

import assert from "node:assert/strict";
import {
  openWorkspacePathWithSystemDefault,
  resolveWorkspaceNavigationTargets
} from "./workspaceNavigationGateway";
import type { NavigationTargetInfo } from "../../app/types";
import type { WorkspaceInvoke } from "./workspaceIpc";

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

export const workspaceNavigationGatewayTests = (async () => {
  await assertAsyncTest("resolveWorkspaceNavigationTargets invokes the batch command and maps target info", async () => {
    const invocations: Array<{ command: string; args: Record<string, unknown> }> = [];
    const backendInfo: NavigationTargetInfo = {
      path: "C:\\Users\\Admin\\Documents",
      normalizedPath: "C:\\Users\\Admin\\Documents",
      canonicalPath: null,
      displayName: "Documents",
      targetKind: "folder",
      targetStatus: "ok",
      message: null,
      exists: true,
      isLocal: true,
      parentPath: "C:\\Users\\Admin"
    };
    const invoke: WorkspaceInvoke = async <T>(command: string, args: Record<string, unknown>) => {
      invocations.push({ command, args });
      return [backendInfo] as T;
    };

    const result = await resolveWorkspaceNavigationTargets(["C:\\Users\\Admin\\Documents"], {
      invoke,
      runtimeHost
    });

    assert.deepEqual(invocations, [
      {
        command: "resolve_navigation_targets",
        args: {
          paths: ["C:\\Users\\Admin\\Documents"]
        }
      }
    ]);
    assert.deepEqual(result, [
      {
        path: "C:\\Users\\Admin\\Documents",
        normalizedPath: "C:\\Users\\Admin\\Documents",
        canonicalPath: undefined,
        displayName: "Documents",
        targetKind: "folder",
        targetStatus: "ok",
        message: undefined,
        exists: true,
        isLocal: true,
        parentPath: "C:\\Users\\Admin"
      }
    ]);
  });

  await assertAsyncTest("openWorkspacePathWithSystemDefault invokes the system-open command with path", async () => {
    const invocations: Array<{ command: string; args: Record<string, unknown> }> = [];
    const invoke: WorkspaceInvoke = async <T>(command: string, args: Record<string, unknown>) => {
      invocations.push({ command, args });
      return undefined as T;
    };

    await openWorkspacePathWithSystemDefault("C:\\Users\\Admin\\Documents\\report.txt", {
      invoke,
      runtimeHost
    });

    assert.deepEqual(invocations, [
      {
        command: "open_path_with_system_default",
        args: {
          path: "C:\\Users\\Admin\\Documents\\report.txt"
        }
      }
    ]);
  });
})();

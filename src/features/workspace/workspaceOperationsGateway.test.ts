import assert from "node:assert/strict";
import {
  cancelWorkspaceOperation,
  copyWorkspaceEntries,
  createWorkspaceFile,
  createWorkspaceDirectory,
  deleteWorkspaceEntries,
  listenWorkspaceOperationConflicts,
  listenWorkspaceOperationHistory,
  listenWorkspaceOperationTasks,
  moveWorkspaceEntries,
  resolveWorkspaceOperationConflict,
  runWorkspaceOperationCommands,
  undoLatestWorkspaceOperation,
  undoWorkspaceOperation
} from "./workspaceOperationsGateway";
import type { RemoteProfile as BackendRemoteProfile } from "../../app/types";
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

const sftpProfile = {
  id: "remote-test",
  name: "Test SFTP",
  protocol: "sftp",
  host: "127.0.0.1",
  port: 6666,
  username: "cheng",
  rootPath: "/home/cheng"
} satisfies BackendRemoteProfile;

export const workspaceOperationsGatewayTests = (async () => {
  await assertAsyncTest("moveWorkspaceEntries invokes start_file_operation with canonical path refs", async () => {
    const invocations: Array<{ command: string; args: Record<string, unknown> }> = [];
    const invoke: WorkspaceInvoke = async <T>(command: string, args: Record<string, unknown>) => {
      invocations.push({ command, args });
      return { taskId: "task-move" } as T;
    };

    await moveWorkspaceEntries(
      ["D:\\Projects\\Atlas\\README.md"],
      "sftp://cheng@127.0.0.1:6666/home/cheng/inbox",
      {
        invoke,
        runtimeHost,
        listRemoteProfiles: async () => [sftpProfile]
      },
      { requestId: "move-request", source: "dragDrop", panelId: "panel-1", tabId: "tab-1" }
    );

    assert.deepEqual(invocations, [
      {
        command: "start_file_operation",
        args: {
          intent: {
            requestId: "move-request",
            source: "dragDrop",
            panelId: "panel-1",
            tabId: "tab-1",
            kind: "move",
            sources: [{ kind: "local", path: "D:\\Projects\\Atlas\\README.md" }],
            destination: {
              kind: "remote",
              profileId: "remote-test",
              protocol: "sftp",
              remotePath: "/home/cheng/inbox"
            },
            conflictPolicy: {
              defaultResolution: "ask",
              allowApplyToAll: true
            }
          }
        }
      }
    ]);
  });

  await assertAsyncTest("runWorkspaceOperationCommands propagates Tauri failures", async () => {
    const invocations: string[] = [];
    const invoke: WorkspaceInvoke = async <T>(command: string) => {
      invocations.push(command);
      if (command === "delete_entries") {
        throw new Error("delete failed");
      }
      return { affectedPaths: [] } as T;
    };

    await assert.rejects(
      () =>
        runWorkspaceOperationCommands(
          [
            { command: "copy_entries", args: { request: { sources: ["A"], destination: "B" } } },
            { command: "delete_entries", args: { request: { sources: ["A"] } } },
            { command: "rename_entry", args: { request: { source: "B", newName: "C" } } }
          ],
          { invoke, runtimeHost }
        ),
      /delete failed/
    );

    assert.deepEqual(invocations, ["copy_entries", "delete_entries"]);
  });

  await assertAsyncTest("workspace operations keep browser fallback when Tauri runtime is absent", async () => {
    const invokedCommands: string[] = [];
    const invoke: WorkspaceInvoke = async <T>(command: string) => {
      invokedCommands.push(command);
      throw new Error("invoke should not run without Tauri runtime");
    };

    await createWorkspaceDirectory("D:\\Projects", "New Folder", {
      invoke,
      runtimeHost: undefined,
      listRemoteProfiles: async () => []
    });

    assert.deepEqual(invokedCommands, []);
  });

  await assertAsyncTest("copy/delete/create operations invoke task intents", async () => {
    const invocations: Array<{ command: string; args: Record<string, unknown> }> = [];
    const invoke: WorkspaceInvoke = async <T>(command: string, args: Record<string, unknown>) => {
      invocations.push({ command, args });
      return { taskId: `task-${invocations.length}` } as T;
    };

    await copyWorkspaceEntries(["D:\\Projects\\README.md"], "D:\\Archive", {
      invoke,
      runtimeHost,
      listRemoteProfiles: async () => []
    }, { requestId: "copy-request" });
    await deleteWorkspaceEntries(["D:\\Projects\\old.txt"], {
      invoke,
      runtimeHost,
      listRemoteProfiles: async () => []
    }, { requestId: "delete-request" });
    await createWorkspaceDirectory("D:\\Projects", "New Folder", {
      invoke,
      runtimeHost,
      listRemoteProfiles: async () => []
    }, { requestId: "mkdir-request" });
    await createWorkspaceFile("D:\\Projects", "notes.txt", {
      invoke,
      runtimeHost,
      listRemoteProfiles: async () => []
    }, { requestId: "file-request" });

    assert.deepEqual(invocations.map((item) => item.command), [
      "start_file_operation",
      "start_file_operation",
      "start_file_operation",
      "start_file_operation"
    ]);
    assert.deepEqual(invocations.map((item) => (item.args.intent as { kind: string; requestId: string }).kind), [
      "copy",
      "delete",
      "createDirectory",
      "createFile"
    ]);
    assert.deepEqual(invocations.map((item) => (item.args.intent as { requestId: string }).requestId), [
      "copy-request",
      "delete-request",
      "mkdir-request",
      "file-request"
    ]);
  });

  await assertAsyncTest("cancel, resolve conflict, and undo operations invoke their task commands", async () => {
    const invocations: Array<{ command: string; args: Record<string, unknown> }> = [];
    const invoke: WorkspaceInvoke = async <T>(command: string, args: Record<string, unknown>) => {
      invocations.push({ command, args });
      return { taskId: command } as T;
    };

    await cancelWorkspaceOperation("task-1", { invoke, runtimeHost });
    await resolveWorkspaceOperationConflict(
      { conflictId: "conflict-1", resolution: "rename", newName: "report-final.txt", applyToAll: true },
      { invoke, runtimeHost }
    );
    await undoLatestWorkspaceOperation("undo-latest-request", { invoke, runtimeHost });
    await undoWorkspaceOperation("history-1", "undo-record-request", { invoke, runtimeHost });

    assert.deepEqual(invocations, [
      { command: "cancel_file_operation", args: { taskId: "task-1" } },
      {
        command: "resolve_file_operation_conflict",
        args: {
          resolution: {
            conflictId: "conflict-1",
            resolution: "rename",
            newName: "report-final.txt",
            applyToAll: true
          }
        }
      },
      { command: "undo_latest_operation", args: { requestId: "undo-latest-request" } },
      { command: "undo_operation", args: { recordId: "history-1", requestId: "undo-record-request" } }
    ]);
  });

  await assertAsyncTest("operation event listeners subscribe to stable event names", async () => {
    const listened: string[] = [];
    const listen = async <T>(eventName: string, handler: (event: { payload: T }) => void) => {
      listened.push(eventName);
      void handler;
      return () => undefined;
    };

    await listenWorkspaceOperationTasks(() => undefined, { runtimeHost, listen });
    await listenWorkspaceOperationConflicts(() => undefined, { runtimeHost, listen });
    await listenWorkspaceOperationHistory(() => undefined, { runtimeHost, listen });

    assert.deepEqual(listened, [
      "operation_task_snapshot",
      "operation_conflict_requested",
      "operation_history_changed"
    ]);
  });
})();

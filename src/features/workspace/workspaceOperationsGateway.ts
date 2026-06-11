import { listen } from "@tauri-apps/api/event";
import type {
  OperationConflictRequest,
  OperationConflictResolution,
  OperationHistoryEventEnvelope,
  OperationHistoryListSnapshot,
  OperationIntent,
  OperationPathRef,
  OperationTaskEventEnvelope,
  OperationTaskListSnapshot,
  OperationTaskSnapshot,
  RemoteProfile as BackendRemoteProfile
} from "../../app/types";
import {
  planCopyOrMoveEntries,
  planCreateDirectory,
  planCreateFile,
  planDeleteEntries,
  planRenameEntry,
  resolveRemotePath,
  type WorkspaceOperationCommand
} from "./remoteUri";
import { listRemoteProfilesRequired } from "./workspaceDirectoryGateway";
import { hasTauriRuntime, invokeRequired, type WorkspaceInvoke } from "./workspaceIpc";

type BackendOperationResult = {
  affectedPaths: string[];
};

type RuntimeHost = object | null | undefined;

type WorkspaceOperationRuntime = {
  invoke?: WorkspaceInvoke;
  runtimeHost?: RuntimeHost;
  listRemoteProfiles?: () => Promise<BackendRemoteProfile[]>;
  listen?: WorkspaceOperationListen;
};

type WorkspaceEvent<T> = {
  payload: T;
};

export type WorkspaceOperationListen = <T>(
  eventName: string,
  handler: (event: WorkspaceEvent<T>) => void | Promise<void>
) => Promise<() => void>;

async function listOperationRemoteProfiles(runtime: WorkspaceOperationRuntime) {
  if (runtime.listRemoteProfiles) {
    return runtime.listRemoteProfiles();
  }
  return listRemoteProfilesRequired({
    invoke: runtime.invoke,
    runtimeHost: runtime.runtimeHost
  });
}

export async function runWorkspaceOperationCommands(
  commands: WorkspaceOperationCommand[],
  runtime: WorkspaceOperationRuntime = {}
) {
  for (const command of commands) {
    await invokeRequired<BackendOperationResult>(
      command.command,
      command.args,
      async () => ({
        affectedPaths: []
      }),
      runtime.invoke,
      runtime.runtimeHost
    );
  }
}

export function createOperationRequestId(prefix = "operation") {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createPathRef(path: string, profiles: BackendRemoteProfile[]): OperationPathRef {
  const remote = resolveRemotePath(path, profiles);
  if (remote) {
    return {
      kind: "remote",
      profileId: remote.profile.id,
      protocol: remote.profile.protocol === "ftp" ? "ftp" : "sftp",
      remotePath: remote.remotePath
    };
  }
  return {
    kind: "local",
    path
  };
}

function createBrowserTaskSnapshot(intent: OperationIntent): OperationTaskSnapshot {
  const now = new Date().toISOString();
  return {
    taskId: intent.requestId,
    requestId: intent.requestId,
    kind: intent.kind,
    label: `Browser ${intent.kind}`,
    status: "succeeded",
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    totalEntries: intent.sources?.length ?? 1,
    completedEntries: intent.sources?.length ?? 1,
    failedEntries: 0,
    totalBytes: null,
    completedBytes: null,
    currentPath: null,
    message: "Browser fallback does not mutate files.",
    cancelable: false,
    undoable: false,
    affectedRoots: [],
    entryResults: [],
    sequence: 0,
    updatedAt: now
  };
}

export async function startWorkspaceOperation(intent: OperationIntent, runtime: WorkspaceOperationRuntime = {}) {
  return invokeRequired<OperationTaskSnapshot>(
    "start_file_operation",
    { intent },
    async () => createBrowserTaskSnapshot(intent),
    runtime.invoke,
    runtime.runtimeHost
  );
}

export async function listWorkspaceOperationTasks(runtime: WorkspaceOperationRuntime = {}) {
  return invokeRequired<OperationTaskListSnapshot>(
    "list_file_operation_tasks",
    {},
    async () => ({
      tasks: [],
      taskSequence: 0
    }),
    runtime.invoke,
    runtime.runtimeHost
  );
}

export async function listWorkspaceOperationHistory(runtime: WorkspaceOperationRuntime = {}) {
  return invokeRequired<OperationHistoryListSnapshot>(
    "list_operation_history",
    {},
    async () => ({
      records: [],
      historySequence: 0
    }),
    runtime.invoke,
    runtime.runtimeHost
  );
}

export async function cancelWorkspaceOperation(taskId: string, runtime: WorkspaceOperationRuntime = {}) {
  return invokeRequired<OperationTaskSnapshot>(
    "cancel_file_operation",
    { taskId },
    async () => ({
      ...createBrowserTaskSnapshot({
        requestId: taskId,
        source: "toolbar",
        kind: "delete"
      }),
      taskId,
      status: "cancelled"
    }),
    runtime.invoke,
    runtime.runtimeHost
  );
}

export async function resolveWorkspaceOperationConflict(
  resolution: OperationConflictResolution,
  runtime: WorkspaceOperationRuntime = {}
) {
  return invokeRequired<OperationTaskSnapshot>(
    "resolve_file_operation_conflict",
    { resolution },
    async () => createBrowserTaskSnapshot({ requestId: resolution.conflictId, source: "toolbar", kind: "copy" }),
    runtime.invoke,
    runtime.runtimeHost
  );
}

export async function undoLatestWorkspaceOperation(requestId = createOperationRequestId("undo"), runtime: WorkspaceOperationRuntime = {}) {
  return invokeRequired<OperationTaskSnapshot>(
    "undo_latest_operation",
    { requestId },
    async () => createBrowserTaskSnapshot({ requestId, source: "shortcut", kind: "undo" }),
    runtime.invoke,
    runtime.runtimeHost
  );
}

export async function undoWorkspaceOperation(
  recordId: string,
  requestId = createOperationRequestId("undo"),
  runtime: WorkspaceOperationRuntime = {}
) {
  return invokeRequired<OperationTaskSnapshot>(
    "undo_operation",
    { recordId, requestId },
    async () => createBrowserTaskSnapshot({ requestId, source: "toolbar", kind: "undo", undoRecordId: recordId }),
    runtime.invoke,
    runtime.runtimeHost
  );
}

async function listenWorkspaceOperationEvent<T>(
  eventName: string,
  handler: (payload: T) => void,
  runtime: WorkspaceOperationRuntime = {}
) {
  if (!hasTauriRuntime(runtime.runtimeHost)) {
    return () => undefined;
  }
  const listenFn = runtime.listen ?? listen;
  return listenFn<T>(eventName, (event) => handler(event.payload));
}

export function listenWorkspaceOperationTasks(
  handler: (payload: OperationTaskEventEnvelope) => void,
  runtime: WorkspaceOperationRuntime = {}
) {
  return listenWorkspaceOperationEvent("operation_task_snapshot", handler, runtime);
}

export function listenWorkspaceOperationConflicts(
  handler: (payload: OperationConflictRequest) => void,
  runtime: WorkspaceOperationRuntime = {}
) {
  return listenWorkspaceOperationEvent("operation_conflict_requested", handler, runtime);
}

export function listenWorkspaceOperationHistory(
  handler: (payload: OperationHistoryEventEnvelope) => void,
  runtime: WorkspaceOperationRuntime = {}
) {
  return listenWorkspaceOperationEvent("operation_history_changed", handler, runtime);
}

export async function copyWorkspaceEntries(
  paths: string[],
  destination: string,
  runtime: WorkspaceOperationRuntime = {},
  options: Partial<Pick<OperationIntent, "requestId" | "source" | "panelId" | "tabId">> = {}
) {
  const profiles = await listOperationRemoteProfiles(runtime);
  return startWorkspaceOperation(
    {
      requestId: options.requestId ?? createOperationRequestId("copy"),
      source: options.source ?? "toolbar",
      panelId: options.panelId ?? null,
      tabId: options.tabId ?? null,
      kind: "copy",
      sources: paths.map((path) => createPathRef(path, profiles)),
      destination: createPathRef(destination, profiles),
      conflictPolicy: {
        defaultResolution: "ask",
        allowApplyToAll: true
      }
    },
    runtime
  );
}

export async function moveWorkspaceEntries(
  paths: string[],
  destination: string,
  runtime: WorkspaceOperationRuntime = {},
  options: Partial<Pick<OperationIntent, "requestId" | "source" | "panelId" | "tabId">> = {}
) {
  const profiles = await listOperationRemoteProfiles(runtime);
  return startWorkspaceOperation(
    {
      requestId: options.requestId ?? createOperationRequestId("move"),
      source: options.source ?? "toolbar",
      panelId: options.panelId ?? null,
      tabId: options.tabId ?? null,
      kind: "move",
      sources: paths.map((path) => createPathRef(path, profiles)),
      destination: createPathRef(destination, profiles),
      conflictPolicy: {
        defaultResolution: "ask",
        allowApplyToAll: true
      }
    },
    runtime
  );
}

export async function deleteWorkspaceEntries(
  paths: string[],
  runtime: WorkspaceOperationRuntime = {},
  options: Partial<Pick<OperationIntent, "requestId" | "source" | "panelId" | "tabId">> = {}
) {
  const profiles = await listOperationRemoteProfiles(runtime);
  return startWorkspaceOperation(
    {
      requestId: options.requestId ?? createOperationRequestId("delete"),
      source: options.source ?? "toolbar",
      panelId: options.panelId ?? null,
      tabId: options.tabId ?? null,
      kind: "delete",
      sources: paths.map((path) => createPathRef(path, profiles))
    },
    runtime
  );
}

export async function renameWorkspaceEntry(
  source: string,
  newName: string,
  runtime: WorkspaceOperationRuntime = {},
  options: Partial<Pick<OperationIntent, "requestId" | "source" | "panelId" | "tabId">> = {}
) {
  const profiles = await listOperationRemoteProfiles(runtime);
  return startWorkspaceOperation(
    {
      requestId: options.requestId ?? createOperationRequestId("rename"),
      source: options.source ?? "inlineEdit",
      panelId: options.panelId ?? null,
      tabId: options.tabId ?? null,
      kind: "rename",
      sourcePath: createPathRef(source, profiles),
      newName
    },
    runtime
  );
}

export async function createWorkspaceDirectory(
  parent: string,
  name: string,
  runtime: WorkspaceOperationRuntime = {},
  options: Partial<Pick<OperationIntent, "requestId" | "source" | "panelId" | "tabId">> = {}
) {
  const profiles = await listOperationRemoteProfiles(runtime);
  return startWorkspaceOperation(
    {
      requestId: options.requestId ?? createOperationRequestId("create-directory"),
      source: options.source ?? "inlineEdit",
      panelId: options.panelId ?? null,
      tabId: options.tabId ?? null,
      kind: "createDirectory",
      parent: createPathRef(parent, profiles),
      name,
      conflictPolicy: {
        defaultResolution: "ask",
        allowApplyToAll: false
      }
    },
    runtime
  );
}

export async function createWorkspaceFile(
  parent: string,
  name: string,
  runtime: WorkspaceOperationRuntime = {},
  options: Partial<Pick<OperationIntent, "requestId" | "source" | "panelId" | "tabId">> = {}
) {
  const profiles = await listOperationRemoteProfiles(runtime);
  return startWorkspaceOperation(
    {
      requestId: options.requestId ?? createOperationRequestId("create-file"),
      source: options.source ?? "inlineEdit",
      panelId: options.panelId ?? null,
      tabId: options.tabId ?? null,
      kind: "createFile",
      parent: createPathRef(parent, profiles),
      name,
      conflictPolicy: {
        defaultResolution: "ask",
        allowApplyToAll: false
      }
    },
    runtime
  );
}

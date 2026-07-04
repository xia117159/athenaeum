import assert from "node:assert/strict";
import { createMockWorkspaceBootstrap } from "./mockData";
import { createNavigationTab, createWorkspaceState } from "./workspaceReducer";
import {
  getOperationRefreshPaths,
  getParentPathForRefresh,
  getVisibleDirectoryRefreshTargets,
  getVisibleWatchRoots,
  hasSameParentPath,
  isTerminalOperationTask,
  pathRefToWorkspacePath,
  pathsEqual
} from "./workspaceRefreshPlanner";
import type { NavigationItem, OperationTaskSnapshot, RemoteConnectionProfile, WorkspaceState } from "./types";

function assertTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const remoteProfile: RemoteConnectionProfile = {
  id: "remote-wsl",
  name: "WSL",
  protocol: "sftp",
  host: "192.168.1.12",
  port: 6666,
  username: "cheng",
  rootPath: "/",
  authKind: "password",
  passiveMode: true,
  ignoreHostKey: false,
  connectTimeoutSecs: 10,
  commandTimeoutSecs: 20
};

function createNavigationItem(id: string, path: string): NavigationItem {
  return {
    id,
    displayName: id,
    description: "",
    path,
    targetKind: "folder",
    targetStatus: "ok",
    sortOrder: 1,
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z"
  };
}

function createReadyState(): WorkspaceState {
  return createWorkspaceState(createMockWorkspaceBootstrap("tauri"));
}

function createOperationTask(overrides: Partial<OperationTaskSnapshot> = {}): OperationTaskSnapshot {
  return {
    taskId: "task-1",
    requestId: "request-1",
    kind: "copy",
    label: "Copy",
    status: "succeeded",
    createdAt: "2026-06-01T00:00:00Z",
    startedAt: "2026-06-01T00:00:00Z",
    finishedAt: "2026-06-01T00:00:01Z",
    totalEntries: 1,
    completedEntries: 1,
    failedEntries: 0,
    totalBytes: null,
    completedBytes: null,
    currentPath: null,
    message: null,
    cancelable: false,
    undoable: true,
    affectedRoots: [],
    entryResults: [],
    sequence: 1,
    updatedAt: "2026-06-01T00:00:01Z",
    ...overrides
  };
}

assertTest("getParentPathForRefresh handles local and remote parent paths", () => {
  assert.equal(getParentPathForRefresh("C:\\Users\\Admin\\Downloads\\Installer.msi"), "C:\\Users\\Admin\\Downloads");
  assert.equal(getParentPathForRefresh("sftp://cheng@127.0.0.1:6666/home/cheng/report.txt"), "sftp://cheng@127.0.0.1:6666/home/cheng");
  assert.equal(getParentPathForRefresh("sftp://cheng@127.0.0.1:6666/home/cheng/nested/"), "sftp://cheng@127.0.0.1:6666/home/cheng");
  assert.equal(getParentPathForRefresh("sftp://cheng@127.0.0.1:6666/"), null);
});

assertTest("path comparison normalizes Windows case while preserving remote case sensitivity", () => {
  assert.equal(pathsEqual("C:\\Users\\Admin", "c:\\users\\admin"), true);
  assert.equal(pathsEqual("sftp://host/home/File.txt", "sftp://host/home/file.txt"), false);
  assert.equal(hasSameParentPath("C:\\Users\\Admin\\Downloads\\Installer.msi", "c:\\users\\admin\\downloads"), true);
});

assertTest("getVisibleWatchRoots registers visible local directories and navigation parent folders", () => {
  const state = createReadyState();
  state.layoutMode = "dual";
  state.panels["panel-2"].tabs = [createNavigationTab("nav-tab")];
  state.panels["panel-2"].activeTabId = "nav-tab";
  state.navigation.items = [
    createNavigationItem("docs", "D:\\Projects\\Atlas\\README.md"),
    createNavigationItem("remote", "sftp://cheng@192.168.1.12:6666/home/cheng")
  ];

  const roots = getVisibleWatchRoots(state);

  assert.deepEqual(roots.directoryPaths, ["D:\\Projects\\Atlas"]);
  assert.deepEqual(roots.navigationParentPaths, ["D:\\Projects\\Atlas"]);
});

assertTest("getVisibleDirectoryRefreshTargets returns visible directory tabs matching changed roots", () => {
  const state = createReadyState();
  state.layoutMode = "dual";
  const activeTab = state.panels["panel-1"].tabs.find((tab) => tab.id === state.panels["panel-1"].activeTabId);

  const targets = getVisibleDirectoryRefreshTargets(state, ["d:\\projects\\atlas"]);

  assert.deepEqual(targets, [
    {
      panelId: "panel-1",
      tabId: activeTab?.id,
      path: "D:\\Projects\\Atlas",
      historyIndex: 0
    }
  ]);
});

assertTest("operation refresh paths include affected roots and entry result parents", () => {
  const task = createOperationTask({
    affectedRoots: [
      { kind: "local", path: "D:\\Projects\\Atlas" },
      { kind: "remote", profileId: "remote-wsl", remotePath: "/home/cheng", protocol: "sftp" }
    ],
    entryResults: [
      {
        entryResultId: "entry-1",
        kind: "created",
        source: { kind: "local", path: "C:\\Users\\Admin\\Downloads\\Installer.msi" },
        destination: { kind: "remote", profileId: "remote-wsl", remotePath: "/home/cheng/Installer.msi", protocol: "sftp" }
      }
    ]
  });

  assert.deepEqual(getOperationRefreshPaths(task, [remoteProfile]), [
    "D:\\Projects\\Atlas",
    "sftp://cheng@192.168.1.12:6666/home/cheng",
    "C:\\Users\\Admin\\Downloads"
  ]);
});

assertTest("pathRefToWorkspacePath returns null for missing remote profiles", () => {
  assert.equal(pathRefToWorkspacePath({ kind: "remote", profileId: "missing", remotePath: "/", protocol: "sftp" }, []), null);
});

assertTest("isTerminalOperationTask recognizes only final task states", () => {
  assert.equal(isTerminalOperationTask(createOperationTask({ status: "succeeded" })), true);
  assert.equal(isTerminalOperationTask(createOperationTask({ status: "partialSucceeded" })), true);
  assert.equal(isTerminalOperationTask(createOperationTask({ status: "failed" })), true);
  assert.equal(isTerminalOperationTask(createOperationTask({ status: "cancelled" })), true);
  assert.equal(isTerminalOperationTask(createOperationTask({ status: "running" })), false);
});

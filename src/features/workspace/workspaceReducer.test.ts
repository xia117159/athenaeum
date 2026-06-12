import assert from "node:assert/strict";
import { createMockWorkspaceBootstrap, createTabState, resolveMockDirectory } from "./mockData";
import {
  createNavigationTab,
  createWorkspaceState,
  getActiveTab,
  type WorkspaceAction,
  workspaceReducer
} from "./workspaceReducer";
import type {
  OperationConflictRequest,
  OperationHistoryRecord,
  OperationTaskSnapshot,
  SearchResult,
  TabState,
  WorkspaceState
} from "./types";

function createState() {
  return createWorkspaceState(createMockWorkspaceBootstrap());
}

function createResult(id: string, name = "report.txt"): SearchResult {
  return {
    id,
    name,
    kind: "file",
    path: `D:\\Projects\\Atlas\\${name}`,
    parentPath: "D:\\Projects\\Atlas",
    openPath: "D:\\Projects\\Atlas",
    location: { kind: "local", label: "Atlas", path: "D:\\Projects\\Atlas" },
    match: "matched content"
  };
}

function createSearchTab(id: string, sourceTab: TabState, sourceTabId?: string): TabState {
  return {
    id,
    title: "搜索结果",
    kind: "search-results",
    snapshot: {
      location: {
        kind: sourceTab.snapshot.location.kind,
        label: "搜索结果",
        path: sourceTab.snapshot.location.path
      },
      breadcrumbs: [{ id, label: "搜索结果", path: sourceTab.snapshot.location.path }],
      entries: []
    },
    addressDraft: sourceTab.snapshot.location.path,
    history: [sourceTab.snapshot.location.path],
    historyIndex: 0,
    selectedEntryIds: [],
    expandedNodePaths: [...sourceTab.expandedNodePaths],
    viewMode: "details",
    sort: { columnId: "name", direction: "asc" },
    columns: sourceTab.columns.map((column) => ({ ...column })),
    status: "ready",
    search: {
      sourceTabId,
      sourcePath: sourceTab.snapshot.location.path,
      query: {
        name: "",
        content: "content",
        nameMode: "normal",
        contentMode: "normal",
        extensionFilterText: "",
        extensionFilterMode: "include",
        includeFolders: false,
        recursive: true,
        caseSensitive: false,
        scope: "active-panel"
      },
      results: [createResult(`${id}-result`)],
      progress: {
        scannedEntries: 20,
        matchedEntries: 1,
        cancelled: false,
        statusText: "搜索完成：已扫描 20 项，匹配 1 项"
      }
    }
  };
}

function createOperationTask(taskId: string, sequence: number, status: OperationTaskSnapshot["status"]): OperationTaskSnapshot {
  return {
    taskId,
    requestId: `request-${taskId}`,
    kind: "copy",
    label: `Copy ${taskId}`,
    status,
    createdAt: "2026-06-10T08:00:00Z",
    startedAt: "2026-06-10T08:00:01Z",
    finishedAt: status === "succeeded" ? "2026-06-10T08:00:02Z" : null,
    totalEntries: 2,
    completedEntries: status === "succeeded" ? 2 : 1,
    failedEntries: 0,
    totalBytes: null,
    completedBytes: null,
    currentPath: "D:\\Projects\\Atlas\\report.txt",
    message: null,
    cancelable: status === "running",
    undoable: status === "succeeded",
    affectedRoots: [{ kind: "local", path: "D:\\Projects\\Atlas" }],
    entryResults: [],
    sequence,
    updatedAt: `2026-06-10T08:00:0${sequence}Z`
  };
}

function createOperationHistoryRecord(
  recordId: string,
  status: OperationHistoryRecord["status"] = "undoable"
): OperationHistoryRecord {
  return {
    recordId,
    taskId: `task-${recordId}`,
    kind: "copy",
    label: `Copy ${recordId}`,
    status,
    createdAt: "2026-06-10T08:00:02Z",
    updatedAt: "2026-06-10T08:00:02Z",
    undoTaskId: null,
    blockedReason: null,
    payloadExpiresAt: null,
    affectedRoots: [{ kind: "local", path: "D:\\Projects\\Atlas" }]
  };
}

function createOperationConflict(): OperationConflictRequest {
  return {
    conflictId: "conflict-1",
    taskId: "task-1",
    createdAt: "2026-06-10T08:00:02Z",
    source: { kind: "local", path: "D:\\Source\\report.txt" },
    destination: { kind: "local", path: "D:\\Target\\report.txt" },
    existingKind: "file",
    incomingKind: "file",
    suggestedName: "report (1).txt",
    allowedResolutions: ["skip", "keepBoth", "rename"],
    message: "Target exists"
  };
}

function withPanelTabs(state: WorkspaceState, panelId: "panel-2", tabs: TabState[], activeTabId: string): WorkspaceState {
  return {
    ...state,
    activePanelId: panelId,
    panels: {
      ...state.panels,
      [panelId]: {
        ...state.panels[panelId],
        tabs,
        activeTabId
      }
    }
  };
}

function assertTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

assertTest("workspaceReducer cycles focus across visible panels and wraps in quad layout", () => {
    const state = createState();

    const focus2 = workspaceReducer(state, { type: "focusNextPanel" });
    const focus3 = workspaceReducer(focus2, { type: "focusNextPanel" });
    const focus4 = workspaceReducer(focus3, { type: "focusNextPanel" });
    const focus1 = workspaceReducer(focus4, { type: "focusNextPanel" });

    assert.equal(focus2.activePanelId, "panel-2");
    assert.equal(focus3.activePanelId, "panel-3");
    assert.equal(focus4.activePanelId, "panel-4");
    assert.equal(focus1.activePanelId, "panel-1");
  });

assertTest("workspaceReducer projects operation task snapshots and ignores stale task events", () => {
  const state = createState();
  const running = createOperationTask("task-1", 2, "running");
  const staleQueued = createOperationTask("task-1", 1, "queued");
  const completed = createOperationTask("task-1", 3, "succeeded");

  const loaded = workspaceReducer(state, {
    type: "operationTasksSnapshotLoaded",
    payload: { tasks: [running], taskSequence: 2 }
  } as WorkspaceAction);
  const ignored = workspaceReducer(loaded, {
    type: "operationTaskEventReceived",
    payload: staleQueued
  } as WorkspaceAction);
  const updated = workspaceReducer(ignored, {
    type: "operationTaskEventReceived",
    payload: completed
  } as WorkspaceAction);

  assert.equal(loaded.operations.tasks[0].status, "running");
  assert.equal(ignored.operations.tasks[0].status, "running");
  assert.equal(updated.operations.tasks[0].status, "succeeded");
  assert.equal(updated.operations.taskSequence, 3);
});

assertTest("workspaceReducer projects operation history by backend sequence", () => {
  const state = createState();
  const record = createOperationHistoryRecord("history-1");
  const undone = createOperationHistoryRecord("history-1", "undone");

  const loaded = workspaceReducer(state, {
    type: "operationHistorySnapshotLoaded",
    payload: { records: [record], historySequence: 4 }
  } as WorkspaceAction);
  const stale = workspaceReducer(loaded, {
    type: "operationHistoryEventReceived",
    payload: { record: undone, historySequence: 4 }
  } as WorkspaceAction);
  const updated = workspaceReducer(stale, {
    type: "operationHistoryEventReceived",
    payload: { record: undone, historySequence: 5 }
  } as WorkspaceAction);

  assert.equal(loaded.operations.history[0].status, "undoable");
  assert.equal(stale.operations.history[0].status, "undoable");
  assert.equal(updated.operations.history[0].status, "undone");
  assert.equal(updated.operations.historySequence, 5);
});

assertTest("workspaceReducer opens and updates the operation conflict dialog from backend requests", () => {
  const state = createState();
  const requested = workspaceReducer(state, {
    type: "operationConflictRequested",
    payload: createOperationConflict()
  } as WorkspaceAction);
  const changed = workspaceReducer(requested, {
    type: "operationConflictDialogChanged",
    payload: { selectedResolution: "rename", renameValue: "report-final.txt", applyToAll: true }
  } as WorkspaceAction);
  const ignoredClose = workspaceReducer(changed, {
    type: "operationConflictDialogClosed",
    payload: { conflictId: "other-conflict" }
  } as WorkspaceAction);
  const closed = workspaceReducer(ignoredClose, {
    type: "operationConflictDialogClosed",
    payload: { conflictId: "conflict-1" }
  } as WorkspaceAction);

  assert.equal(requested.operations.tasksOpen, true);
  assert.equal(requested.operations.conflictDialog?.selectedResolution, "keepBoth");
  assert.equal(changed.operations.conflictDialog?.selectedResolution, "rename");
  assert.equal(changed.operations.conflictDialog?.renameValue, "report-final.txt");
  assert.equal(changed.operations.conflictDialog?.applyToAll, true);
  assert.ok(ignoredClose.operations.conflictDialog);
  assert.equal(closed.operations.conflictDialog, undefined);
});

assertTest("workspaceReducer clears the previously focused panel selection when focus changes", () => {
  const state = createState();
  const panel1Tab = getActiveTab(state.panels["panel-1"]);
  const panel2Tab = getActiveTab(state.panels["panel-2"]);
  const selected = workspaceReducer(
    workspaceReducer(state, {
      type: "entrySelectionChanged",
      payload: {
        panelId: "panel-1",
        tabId: panel1Tab.id,
        entryId: panel1Tab.snapshot.entries[0].id,
        multi: false
      }
    } as WorkspaceAction),
    {
      type: "entrySelectionChanged",
      payload: {
        panelId: "panel-2",
        tabId: panel2Tab.id,
        entryId: panel2Tab.snapshot.entries[0].id,
        multi: false
      }
    } as WorkspaceAction
  );

  const focused = workspaceReducer(selected, {
    type: "panelFocused",
    payload: { panelId: "panel-2" }
  });
  const focusedNext = workspaceReducer(focused, { type: "focusNextPanel" });

  assert.deepEqual(getActiveTab(focused.panels["panel-1"]).selectedEntryIds, []);
  assert.deepEqual(getActiveTab(focused.panels["panel-2"]).selectedEntryIds, [panel2Tab.snapshot.entries[0].id]);
  assert.deepEqual(getActiveTab(focusedNext.panels["panel-2"]).selectedEntryIds, []);
});

assertTest("workspaceReducer selects all entries with allEntriesSelected action", () => {
  const state = createState();
  const activeTab = getActiveTab(state.panels["panel-1"]);
  const allEntryIds = activeTab.snapshot.entries.map((entry) => entry.id);

  const selected = workspaceReducer(state, {
    type: "allEntriesSelected",
    payload: {
      panelId: "panel-1",
      tabId: activeTab.id
    }
  } as WorkspaceAction);

  assert.deepEqual(getActiveTab(selected.panels["panel-1"]).selectedEntryIds, allEntryIds);
  assert.ok(getActiveTab(selected.panels["panel-1"]).selectedEntryIds.length > 0);
});

assertTest("workspaceReducer clears all selection with entrySelectionCleared action", () => {
  const state = createState();
  const activeTab = getActiveTab(state.panels["panel-1"]);

  const selected = workspaceReducer(state, {
    type: "entrySelectionChanged",
    payload: {
      panelId: "panel-1",
      tabId: activeTab.id,
      entryId: activeTab.snapshot.entries[0].id,
      multi: false
    }
  } as WorkspaceAction);

  const cleared = workspaceReducer(selected, {
    type: "entrySelectionCleared",
    payload: {
      panelId: "panel-1",
      tabId: activeTab.id
    }
  } as WorkspaceAction);

  assert.deepEqual(getActiveTab(cleared.panels["panel-1"]).selectedEntryIds, []);
});

assertTest("workspaceReducer selects range of entries with entryRangeSelected action", () => {
  const state = createState();
  const activeTab = getActiveTab(state.panels["panel-1"]);
  const entries = activeTab.snapshot.entries;

  if (entries.length < 3) {
    return;
  }

  const fromEntry = entries[0];
  const toEntry = entries[2];

  const selected = workspaceReducer(state, {
    type: "entryRangeSelected",
    payload: {
      panelId: "panel-1",
      tabId: activeTab.id,
      fromEntryId: fromEntry.id,
      toEntryId: toEntry.id
    }
  } as WorkspaceAction);

  const selectedIds = getActiveTab(selected.panels["panel-1"]).selectedEntryIds;
  assert.deepEqual(selectedIds, [entries[0].id, entries[1].id, entries[2].id]);
});

assertTest("workspaceReducer sets specific entry ids with entrySelectionSet action", () => {
  const state = createState();
  const activeTab = getActiveTab(state.panels["panel-1"]);
  const entries = activeTab.snapshot.entries;

  if (entries.length < 3) {
    return;
  }

  const targetIds = [entries[0].id, entries[2].id];

  const selected = workspaceReducer(state, {
    type: "entrySelectionSet",
    payload: {
      panelId: "panel-1",
      tabId: activeTab.id,
      entryIds: targetIds
    }
  } as WorkspaceAction);

  assert.deepEqual(getActiveTab(selected.panels["panel-1"]).selectedEntryIds, targetIds);
});

assertTest("workspaceReducer moves focus to the first visible panel when current one gets hidden", () => {
    const state = {
      ...createState(),
      activePanelId: "panel-4" as const
    };

    const reduced = workspaceReducer(state, { type: "layoutModeSet", payload: "dual" });

    assert.equal(reduced.layoutMode, "dual");
    assert.equal(reduced.activePanelId, "panel-1");
  });

assertTest("workspaceReducer stores independent triple and quad vertical split ratios without a fixed 80 percent clamp", () => {
    const state = createState();

    const withQuadLeft = workspaceReducer(
      state,
      {
        type: "splitRatioSet",
        payload: { key: "quadLeftSecondary", value: 0.88 }
      } as unknown as WorkspaceAction
    );
    const withQuadRight = workspaceReducer(
      withQuadLeft,
      {
        type: "splitRatioSet",
        payload: { key: "quadRightSecondary", value: 0.33 }
      } as unknown as WorkspaceAction
    );
    const withTriple = workspaceReducer(
      withQuadRight,
      {
        type: "splitRatioSet",
        payload: { key: "tripleSecondary", value: 0.71 }
      } as unknown as WorkspaceAction
    );

    const ratios = withTriple.layoutRatios as unknown as Record<string, number>;
    assert.equal(ratios.quadLeftSecondary, 0.88);
    assert.equal(ratios.quadRightSecondary, 0.33);
    assert.equal(ratios.tripleSecondary, 0.71);
  });

assertTest("workspaceReducer opens a tab and activates it in the owning panel", () => {
    const state = createState();
    const tab = createTabState("C:\\Users\\Admin\\Desktop", "panel-2-extra");

    const nextState = workspaceReducer(state, {
      type: "tabOpened",
      payload: { panelId: "panel-2", tab }
    });

    assert.equal(nextState.activePanelId, "panel-2");
    assert.equal(nextState.panels["panel-2"].tabs.length, 3);
    assert.equal(nextState.panels["panel-2"].activeTabId, "panel-2-extra");
  });

assertTest("workspaceReducer opens a single global navigation tab and reactivates it", () => {
  const state = createState();
  const opened = workspaceReducer(state, {
    type: "navigationTabOpened",
    payload: { panelId: "panel-1" }
  } as WorkspaceAction);
  const reopened = workspaceReducer(opened, {
    type: "navigationTabOpened",
    payload: { panelId: "panel-2" }
  } as WorkspaceAction);

  const navigationTabs = Object.values(reopened.panels).flatMap((panel) => panel.tabs.filter((tab) => tab.kind === "navigation"));

  assert.equal(navigationTabs.length, 1);
  assert.equal(reopened.panels["panel-1"].activeTabId, navigationTabs[0].id);
  assert.equal(reopened.activePanelId, "panel-1");
});

assertTest("workspaceReducer moves an existing navigation tab from a hidden panel to the visible active panel", () => {
  const state = createState();
  const withHiddenNavigation = {
    ...state,
    layoutMode: "single" as const,
    activePanelId: "panel-1" as const,
    panels: {
      ...state.panels,
      "panel-4": {
        ...state.panels["panel-4"],
        tabs: [createNavigationTab("navigation-tab")],
        activeTabId: "navigation-tab"
      }
    }
  };

  const opened = workspaceReducer(withHiddenNavigation, {
    type: "navigationTabOpened",
    payload: { panelId: "panel-1" }
  } as WorkspaceAction);

  assert.equal(opened.panels["panel-4"].tabs.some((tab) => tab.kind === "navigation"), false);
  assert.equal(opened.panels["panel-1"].tabs.some((tab) => tab.kind === "navigation"), true);
  assert.equal(opened.panels["panel-1"].activeTabId, "navigation-tab");
});

assertTest("createWorkspaceState deduplicates abnormal navigation tabs across panels", () => {
  const bootstrap = createMockWorkspaceBootstrap();
  const normalized = createWorkspaceState({
    ...bootstrap,
    panels: {
      ...bootstrap.panels,
      "panel-1": {
        ...bootstrap.panels["panel-1"],
        tabs: [createNavigationTab("navigation-tab"), ...bootstrap.panels["panel-1"].tabs],
        activeTabId: "navigation-tab"
      },
      "panel-2": {
        ...bootstrap.panels["panel-2"],
        tabs: [createNavigationTab("navigation-tab-duplicate"), ...bootstrap.panels["panel-2"].tabs],
        activeTabId: "navigation-tab-duplicate"
      }
    }
  });

  assert.equal(Object.values(normalized.panels).flatMap((panel) => panel.tabs.filter((tab) => tab.kind === "navigation")).length, 1);
  assert.equal(normalized.panels["panel-1"].activeTabId, "navigation-tab");
});

assertTest("workspaceReducer rejects duplicate tab ids when opening a tab", () => {
  const state = createState();
  const existingTab = state.panels["panel-1"].tabs[0];

  const nextState = workspaceReducer(state, {
    type: "tabOpened",
    payload: {
      panelId: "panel-1",
      tab: createTabState("C:\\Users\\Admin\\Desktop", existingTab.id)
    }
  });

  assert.equal(nextState, state);
  assert.equal(new Set(nextState.panels["panel-1"].tabs.map((tab) => tab.id)).size, nextState.panels["panel-1"].tabs.length);
});

assertTest("workspaceReducer toggles tab locking and refuses to close locked tabs", () => {
  const state = createState();
  const panel = state.panels["panel-1"];
  const tabId = panel.tabs[0].id;

  const locked = workspaceReducer(state, {
    type: "tabLockedToggled",
    payload: { panelId: "panel-1", tabId }
  });
  const closed = workspaceReducer(locked, {
    type: "tabClosed",
    payload: { panelId: "panel-1", tabId }
  });

  assert.equal(locked.panels["panel-1"].tabs[0].locked, true);
  assert.equal(closed.panels["panel-1"].tabs.some((tab) => tab.id === tabId), true);
});

assertTest("workspaceReducer closes other tabs while preserving locked tabs on request", () => {
  const state = createState();
  const activeTab = state.panels["panel-1"].tabs[0];
  const lockedTab = createTabState("C:\\Users\\Admin\\Desktop", "panel-1-locked", {
    locked: true
  });
  const extraTab = createTabState("C:\\Users\\Admin\\Downloads", "panel-1-extra");
  const withTabs = {
    ...state,
    panels: {
      ...state.panels,
      "panel-1": {
        ...state.panels["panel-1"],
        tabs: [activeTab, lockedTab, extraTab],
        activeTabId: activeTab.id
      }
    }
  };

  const keepLocked = workspaceReducer(withTabs, {
    type: "otherTabsClosed",
    payload: { panelId: "panel-1", tabId: activeTab.id, includeLocked: false }
  });
  const closeAllOthers = workspaceReducer(withTabs, {
    type: "otherTabsClosed",
    payload: { panelId: "panel-1", tabId: activeTab.id, includeLocked: true }
  });

  assert.deepEqual(keepLocked.panels["panel-1"].tabs.map((tab) => tab.id), [activeTab.id, lockedTab.id]);
  assert.deepEqual(closeAllOthers.panels["panel-1"].tabs.map((tab) => tab.id), [activeTab.id]);
});

assertTest("workspaceReducer renames tab titles and preserves the override across navigation", () => {
  const state = createState();
  const panel = state.panels["panel-1"];
  const tabId = panel.tabs[0].id;
  const renamed = workspaceReducer(state, {
    type: "tabTitleRenamed",
    payload: { panelId: "panel-1", tabId, title: "Work Root" }
  });
  const snapshot = resolveMockDirectory("C:\\Users\\Admin\\Downloads");
  const navigated = workspaceReducer(renamed, {
    type: "tabSnapshotCommitted",
    payload: { panelId: "panel-1", tabId, snapshot, pushHistory: true }
  });

  assert.equal(navigated.panels["panel-1"].tabs[0].title, "Work Root");
  assert.equal(navigated.panels["panel-1"].tabs[0].titleOverride, "Work Root");
});

assertTest("workspaceReducer moves tabs within and across panels without moving the last source tab", () => {
  const state = createState();
  const first = state.panels["panel-1"].tabs[0];
  const second = state.panels["panel-1"].tabs[1];

  const reordered = workspaceReducer(state, {
    type: "tabMoved",
    payload: { sourcePanelId: "panel-1", targetPanelId: "panel-1", tabId: first.id, targetIndex: 2 }
  });
  assert.deepEqual(reordered.panels["panel-1"].tabs.map((tab) => tab.id), [second.id, first.id]);
  assert.equal(reordered.panels["panel-1"].activeTabId, first.id);

  const moved = workspaceReducer(reordered, {
    type: "tabMoved",
    payload: { sourcePanelId: "panel-1", targetPanelId: "panel-2", tabId: first.id, targetIndex: 1 }
  });
  assert.equal(moved.panels["panel-1"].tabs.length, 1);
  assert.equal(moved.panels["panel-2"].tabs[1].id, first.id);
  assert.equal(moved.panels["panel-2"].activeTabId, first.id);

  const blocked = workspaceReducer(moved, {
    type: "tabMoved",
    payload: { sourcePanelId: "panel-1", targetPanelId: "panel-2", tabId: second.id, targetIndex: 0 }
  });
  assert.equal(blocked, moved);
});

assertTest("workspaceReducer ignores activation requests for missing tab ids", () => {
  const state = createState();
  const panel = state.panels["panel-1"];

  const nextState = workspaceReducer(state, {
    type: "tabActivated",
    payload: {
      panelId: "panel-1",
      tabId: "missing-tab"
    }
  });

  assert.equal(nextState, state);
  assert.equal(nextState.panels["panel-1"].activeTabId, panel.activeTabId);
});

assertTest("createWorkspaceState fills empty panels with a recovered fallback tab", () => {
  const bootstrap = createMockWorkspaceBootstrap();
  const recovered = createWorkspaceState({
    ...bootstrap,
    activePanelId: "panel-1",
    panels: {
      ...bootstrap.panels,
      "panel-1": {
        ...bootstrap.panels["panel-1"],
        tabs: [],
        activeTabId: "missing"
      }
    }
  });

  assert.equal(recovered.panels["panel-1"].tabs.length, 1);
  assert.equal(recovered.panels["panel-1"].activeTabId, recovered.panels["panel-1"].tabs[0].id);
  assert.equal(getActiveTab(recovered.panels["panel-1"]).snapshot.location.path, bootstrap.panels["panel-2"].tabs[0].snapshot.location.path);
});

assertTest("workspaceReducer closes the active tab and falls back to the left neighbor", () => {
    const state = createState();
    const opened = workspaceReducer(state, {
      type: "tabOpened",
      payload: {
        panelId: "panel-1",
        tab: createTabState("C:\\Users\\Admin\\Desktop", "panel-1-extra")
      }
    });

    const closed = workspaceReducer(opened, {
      type: "tabClosed",
      payload: { panelId: "panel-1", tabId: "panel-1-extra" }
    });

    assert.equal(closed.panels["panel-1"].tabs.length, 2);
    assert.equal(closed.panels["panel-1"].activeTabId, "panel-1-tab-2");
  });

assertTest("workspaceReducer closes only one matching tab and never empties a panel", () => {
  const state = createState();
  const duplicateTab = createTabState("C:\\Users\\Admin\\Desktop", "panel-1-tab-2");
  const corruptedState = {
    ...state,
    panels: {
      ...state.panels,
      "panel-1": {
        ...state.panels["panel-1"],
        tabs: [state.panels["panel-1"].tabs[0], state.panels["panel-1"].tabs[1], duplicateTab],
        activeTabId: duplicateTab.id
      }
    }
  };

  const closed = workspaceReducer(corruptedState, {
    type: "tabClosed",
    payload: {
      panelId: "panel-1",
      tabId: duplicateTab.id
    }
  });

  assert.equal(closed.panels["panel-1"].tabs.length, 2);
  assert.equal(closed.panels["panel-1"].tabs.filter((tab) => tab.id === duplicateTab.id).length, 1);
  assert.ok(closed.panels["panel-1"].tabs.some((tab) => tab.id === closed.panels["panel-1"].activeTabId));
});

assertTest("workspaceReducer leaves a single-tab panel intact when the tab is closed", () => {
  const state = createState();
  const tab = state.panels["panel-1"].tabs[0];
  const singleTabState = {
    ...state,
    panels: {
      ...state.panels,
      "panel-1": {
        ...state.panels["panel-1"],
        tabs: [tab],
        activeTabId: tab.id
      }
    }
  };

  const closed = workspaceReducer(singleTabState, {
    type: "tabClosed",
    payload: {
      panelId: "panel-1",
      tabId: tab.id
    }
  });

  assert.equal(closed.panels["panel-1"].tabs.length, 1);
  assert.equal(closed.panels["panel-1"].activeTabId, tab.id);
});

assertTest("workspaceReducer commits a new snapshot and appends history when path changes", () => {
    const state = createState();
    const activeTab = getActiveTab(state.panels["panel-1"]);

    const nextState = workspaceReducer(state, {
      type: "tabSnapshotCommitted",
      payload: {
        panelId: "panel-1",
        tabId: activeTab.id,
        snapshot: resolveMockDirectory("C:\\Users\\Admin\\Downloads"),
        pushHistory: true
      }
    });

    const updatedTab = getActiveTab(nextState.panels["panel-1"]);
    assert.equal(updatedTab.snapshot.location.path, "C:\\Users\\Admin\\Downloads");
    assert.equal(updatedTab.history[updatedTab.history.length - 1], "C:\\Users\\Admin\\Downloads");
    assert.equal(updatedTab.historyIndex, updatedTab.history.length - 1);
  });

assertTest("workspaceReducer can commit a background refresh without stealing active panel focus", () => {
  const state = {
    ...createState(),
    activePanelId: "panel-1" as const
  };
  const panel2ActiveTab = getActiveTab(state.panels["panel-2"]);

  const refreshed = workspaceReducer(state, {
    type: "tabSnapshotCommitted",
    payload: {
      panelId: "panel-2",
      tabId: panel2ActiveTab.id,
      snapshot: resolveMockDirectory(panel2ActiveTab.snapshot.location.path),
      pushHistory: false,
      activatePanel: false
    }
  } as WorkspaceAction);

  assert.equal(refreshed.activePanelId, "panel-1");
});

assertTest("workspaceReducer keeps history index when refreshing a repeated history path", () => {
  const state = createState();
  const activeTab = getActiveTab(state.panels["panel-1"]);
  const repeatedHistory = ["C:\\Alpha", "C:\\Beta", "C:\\Alpha"];
  const withRepeatedHistory = {
    ...state,
    panels: {
      ...state.panels,
      "panel-1": {
        ...state.panels["panel-1"],
        tabs: state.panels["panel-1"].tabs.map((tab) =>
          tab.id === activeTab.id
            ? {
                ...tab,
                history: repeatedHistory,
                historyIndex: 2
              }
            : tab
        )
      }
    }
  };

  const refreshed = workspaceReducer(withRepeatedHistory, {
    type: "tabSnapshotCommitted",
    payload: {
      panelId: "panel-1",
      tabId: activeTab.id,
      snapshot: resolveMockDirectory("C:\\Alpha"),
      pushHistory: false
    }
  });

  assert.equal(getActiveTab(refreshed.panels["panel-1"]).historyIndex, 2);
});

assertTest("workspaceReducer can commit explicit history so up navigation keeps the child as forward history", () => {
  const state = createState();
  const activeTab = getActiveTab(state.panels["panel-1"]);

  const navigated = workspaceReducer(state, {
    type: "tabSnapshotCommitted",
    payload: {
      panelId: "panel-1",
      tabId: activeTab.id,
      snapshot: resolveMockDirectory("D:\\Projects\\Atlas"),
      pushHistory: true
    }
  });
  const childTab = getActiveTab(navigated.panels["panel-1"]);

  const parent = workspaceReducer(navigated, {
    type: "tabSnapshotCommitted",
    payload: {
      panelId: "panel-1",
      tabId: childTab.id,
      snapshot: resolveMockDirectory("D:\\Projects"),
      pushHistory: false,
      history: ["D:\\Projects", "D:\\Projects\\Atlas"],
      historyIndex: 0
    }
  } as WorkspaceAction);

  const parentTab = getActiveTab(parent.panels["panel-1"]);
  assert.equal(parentTab.snapshot.location.path, "D:\\Projects");
  assert.deepEqual(parentTab.history.slice(0, 2), ["D:\\Projects", "D:\\Projects\\Atlas"]);
  assert.equal(parentTab.historyIndex, 0);
});

assertTest("workspaceReducer replaces the children of a lazy-loaded directory node", () => {
    const state = createState();

    const nextState = workspaceReducer(state, {
      type: "treeChildrenLoaded",
      payload: {
        path: "D:\\Projects\\Atlas",
        children: [
          {
            id: "D:\\Projects\\Atlas\\src",
            label: "src",
            path: "D:\\Projects\\Atlas\\src",
            kind: "folder",
            expandable: false,
            children: []
          }
        ]
      }
    });

    const atlasNode = nextState.directoryTree
      .find((node) => node.path === "D:\\")!
      .children.find((node) => node.path === "D:\\Projects")!
      .children.find((node) => node.path === "D:\\Projects\\Atlas");

    assert.ok(atlasNode);
    assert.equal(atlasNode!.children.length, 1);
    assert.equal(atlasNode!.children[0].path, "D:\\Projects\\Atlas\\src");
  });

assertTest("workspaceReducer tracks remote tree connection state without removing the remote root", () => {
  const state = workspaceReducer(createState(), {
    type: "remoteProfilesUpdated",
    payload: [
      {
        id: "remote-1",
        name: "Edge",
        protocol: "sftp",
        host: "edge-01.internal",
        port: 22,
        username: "deploy",
        rootPath: "/releases",
        authKind: "password",
        passiveMode: true,
        ignoreHostKey: false,
        connectTimeoutSecs: 10,
        commandTimeoutSecs: 20
      }
    ]
  });

  const connecting = workspaceReducer(state, {
    type: "treeNodeConnectionStarted",
    payload: { path: "sftp://deploy@edge-01.internal/releases" }
  } as WorkspaceAction);
  const failed = workspaceReducer(connecting, {
    type: "treeNodeConnectionFailed",
    payload: { path: "sftp://deploy@edge-01.internal/releases", message: "connection refused" }
  } as WorkspaceAction);

  const remoteRoot = failed.directoryTree.find((node) => node.kind === "remote-root");
  assert.ok(remoteRoot);
  assert.equal(remoteRoot!.connectionState, "error");
  assert.equal(remoteRoot!.errorMessage, "connection refused");
  assert.equal(remoteRoot!.path, "sftp://deploy@edge-01.internal/releases");
});

assertTest("workspaceReducer marks a remote tab as reconnect-required and clears it after navigation succeeds", () => {
  const state = createState();
  const activeTab = getActiveTab(state.panels["panel-1"]);
  const remotePath = "sftp://deploy@edge-01.internal/releases/current";

  const failed = workspaceReducer(state, {
    type: "tabReconnectRequired",
    payload: {
      panelId: "panel-1",
      tabId: activeTab.id,
      path: remotePath,
      message: "connection refused"
    }
  } as WorkspaceAction);
  const reconnecting = workspaceReducer(failed, {
    type: "tabReconnectStarted",
    payload: {
      panelId: "panel-1",
      tabId: activeTab.id
    }
  } as WorkspaceAction);
  const committed = workspaceReducer(reconnecting, {
    type: "tabSnapshotCommitted",
    payload: {
      panelId: "panel-1",
      tabId: activeTab.id,
      snapshot: resolveMockDirectory("D:\\Projects\\Atlas"),
      pushHistory: false
    }
  });

  const failedTab = getActiveTab(failed.panels["panel-1"]);
  assert.equal(failedTab.status, "reconnect-required");
  assert.deepEqual(failedTab.reconnect, {
    path: remotePath,
    message: "connection refused"
  });
  assert.equal(failedTab.snapshot.location.path, remotePath);
  assert.equal(reconnecting.panels["panel-1"].tabs[0].status, "loading");
  assert.equal(getActiveTab(committed.panels["panel-1"]).status, "ready");
  assert.equal(getActiveTab(committed.panels["panel-1"]).reconnect, undefined);
});

assertTest("workspaceReducer keeps explicit tree expansion state without double toggling", () => {
    const state = createState();
    const activeTab = getActiveTab(state.panels["panel-1"]);

    const expanded = workspaceReducer(state, {
      type: "treeNodeExpansionSet",
      payload: {
        panelId: "panel-1",
        tabId: activeTab.id,
        path: "D:\\Projects",
        expanded: true
      }
    });

    assert.equal(getActiveTab(expanded.panels["panel-1"]).expandedNodePaths.includes("D:\\Projects"), true);

    const collapsed = workspaceReducer(expanded, {
      type: "treeNodeExpansionSet",
      payload: {
        panelId: "panel-1",
        tabId: activeTab.id,
        path: "D:\\Projects",
        expanded: false
      }
    });

    assert.equal(getActiveTab(collapsed.panels["panel-1"]).expandedNodePaths.includes("D:\\Projects"), false);
  });

assertTest("workspaceReducer toggles tab sort direction when the same column header is clicked twice", () => {
    const state = createState();
    const activeTab = getActiveTab(state.panels["panel-1"]);

    const firstSort = workspaceReducer(state, {
      type: "tabSortChanged",
      payload: {
        panelId: "panel-1",
        tabId: activeTab.id,
        columnId: "modified"
      }
    });

    assert.equal(getActiveTab(firstSort.panels["panel-1"]).sort.columnId, "modified");
    assert.equal(getActiveTab(firstSort.panels["panel-1"]).sort.direction, "asc");

    const secondSort = workspaceReducer(firstSort, {
      type: "tabSortChanged",
      payload: {
        panelId: "panel-1",
        tabId: activeTab.id,
        columnId: "modified"
      }
    });

    assert.equal(getActiveTab(secondSort.panels["panel-1"]).sort.direction, "desc");
  });

assertTest("workspaceReducer stores view mode per tab", () => {
    const state = createState();
    const activeTab = getActiveTab(state.panels["panel-1"]);

    const nextState = workspaceReducer(state, {
      type: "tabViewModeSet",
      payload: {
        panelId: "panel-1",
        tabId: activeTab.id,
        viewMode: "tiles"
      }
    });

    assert.equal(getActiveTab(nextState.panels["panel-1"]).viewMode, "tiles");
  assert.equal(getActiveTab(nextState.panels["panel-2"]).viewMode, "details");
});

assertTest("workspaceReducer stores inline edits per tab and clears them on snapshot refresh", () => {
  const state = createState();
  const activeTab = getActiveTab(state.panels["panel-1"]);
  const otherTab = state.panels["panel-1"].tabs.find((tab) => tab.id !== activeTab.id);
  assert.ok(otherTab);

  const editing = workspaceReducer(state, {
    type: "inlineEditStarted",
    payload: {
      panelId: "panel-1",
      tabId: activeTab.id,
      edit: {
        mode: "create-folder",
        value: "New folder",
        kind: "folder",
        parentPath: activeTab.snapshot.location.path
      }
    }
  } as WorkspaceAction);

  assert.equal(getActiveTab(editing.panels["panel-1"]).inlineEdit?.value, "New folder");
  assert.equal(editing.panels["panel-1"].tabs.find((tab) => tab.id === otherTab.id)?.inlineEdit, undefined);

  const changed = workspaceReducer(editing, {
    type: "inlineEditChanged",
    payload: {
      panelId: "panel-1",
      tabId: activeTab.id,
      value: "Release"
    }
  } as WorkspaceAction);

  assert.equal(getActiveTab(changed.panels["panel-1"]).inlineEdit?.value, "Release");

  const refreshed = workspaceReducer(changed, {
    type: "tabSnapshotCommitted",
    payload: {
      panelId: "panel-1",
      tabId: activeTab.id,
      snapshot: resolveMockDirectory(activeTab.snapshot.location.path),
      pushHistory: false
    }
  });

  assert.equal(getActiveTab(refreshed.panels["panel-1"]).inlineEdit, undefined);
});

assertTest("createWorkspaceState initializes the docked information panel search defaults", () => {
  const state = createState();

  assert.equal(state.search.open, false);
  assert.equal(state.search.loading, false);
  assert.equal(state.search.filterText, "");
  assert.deepEqual(state.search.query, {
    name: "",
    content: "",
    nameMode: "normal",
    contentMode: "normal",
    extensionFilterText: "",
    extensionFilterMode: "include",
    includeFolders: false,
    recursive: true,
    caseSensitive: false,
    scope: "active-panel"
  });
  assert.equal(state.search.activeTab, "content");
  assert.deepEqual(state.search.histories, {
    name: [],
    content: []
  });
  assert.deepEqual(state.search.history, []);
  assert.deepEqual(state.search.progress, {
    scannedEntries: 0,
    matchedEntries: 0,
    cancelled: false,
    statusText: "就绪"
  });
});

assertTest("workspaceReducer tracks information panel filter text and search progress", () => {
  const state = createState();
  const started = workspaceReducer(state, {
    type: "searchStarted",
    payload: { searchId: "search-42" }
  } as WorkspaceAction);
  const filtered = workspaceReducer(started, {
    type: "searchFilterChanged",
    payload: "atlas"
  } as WorkspaceAction);
  const progressed = workspaceReducer(filtered, {
    type: "searchProgressUpdated",
    payload: {
      searchId: "search-42",
      scannedEntries: 120,
      matchedEntries: 6,
      cancelled: false,
      statusText: "已扫描 120 项，匹配 6 项"
    }
  } as WorkspaceAction);

  assert.equal(progressed.search.open, true);
  assert.equal(progressed.search.loading, true);
  assert.equal(progressed.search.filterText, "atlas");
  assert.deepEqual(progressed.search.results, []);
  assert.deepEqual(progressed.search.progress, {
    searchId: "search-42",
    scannedEntries: 120,
    matchedEntries: 6,
    cancelled: false,
    statusText: "已扫描 120 项，匹配 6 项"
  });
});

assertTest("workspaceReducer stores content search history with newest unique items capped at twenty", () => {
  const state = workspaceReducer(createState(), {
    type: "searchHistoryLoaded",
    payload: {
      tab: "content",
      history: Array.from({ length: 25 }, (_, index) => `item-${index}`)
    }
  } as WorkspaceAction);
  const withDuplicate = workspaceReducer(
    workspaceReducer(state, {
      type: "searchQueryChanged",
      payload: {
        content: " item-4 "
      }
    } as WorkspaceAction),
    {
      type: "searchStarted",
      payload: { searchId: "search-history" }
    } as WorkspaceAction
  );

  assert.equal(withDuplicate.search.history.length, 20);
  assert.equal(withDuplicate.search.history[0], "item-4");
  assert.equal(withDuplicate.search.history.filter((item) => item.toLowerCase() === "item-4").length, 1);
  assert.equal(withDuplicate.search.histories.content[0], "item-4");
  assert.deepEqual(withDuplicate.search.histories.name, []);
  assert.equal(withDuplicate.search.progress?.statusText, "正在搜索...");
});

assertTest("workspaceReducer loads, selects, and deletes content search history entries", () => {
  const state = workspaceReducer(createState(), {
    type: "searchHistoryLoaded",
    payload: {
      tab: "content",
      history: ["alpha", "beta", "alpha", " "]
    }
  } as WorkspaceAction);
  const selected = workspaceReducer(state, {
    type: "searchHistorySelected",
    payload: { index: 1 }
  } as WorkspaceAction);
  const deleted = workspaceReducer(selected, {
    type: "searchHistoryDeleted",
    payload: { index: 1 }
  } as WorkspaceAction);

  assert.deepEqual(state.search.history, ["alpha", "beta"]);
  assert.equal(selected.search.query.content, "beta");
  assert.equal(selected.search.selectedHistoryIndex, 1);
  assert.deepEqual(deleted.search.history, ["alpha"]);
  assert.equal(deleted.search.selectedHistoryIndex, undefined);
});

assertTest("workspaceReducer stores independent name search history and applies selected history to the name field", () => {
  const named = workspaceReducer(
    workspaceReducer(createState(), {
      type: "searchTabChanged",
      payload: "name"
    } as WorkspaceAction),
    {
      type: "searchHistoryLoaded",
      payload: {
        tab: "name",
        history: ["report", "archive", "report"]
      }
    } as WorkspaceAction
  );
  const selected = workspaceReducer(named, {
    type: "searchHistorySelected",
    payload: { index: 1 }
  } as WorkspaceAction);
  const started = workspaceReducer(
    workspaceReducer(selected, {
      type: "searchQueryChanged",
      payload: {
        name: " release "
      }
    } as WorkspaceAction),
    {
      type: "searchStarted",
      payload: { searchId: "search-name-history" }
    } as WorkspaceAction
  );
  const deleted = workspaceReducer(started, {
    type: "searchHistoryDeleted",
    payload: { index: 0 }
  } as WorkspaceAction);

  assert.equal(named.search.activeTab, "name");
  assert.deepEqual(named.search.history, ["report", "archive"]);
  assert.equal(selected.search.query.name, "archive");
  assert.equal(selected.search.query.content, "");
  assert.equal(started.search.histories.name[0], "release");
  assert.deepEqual(started.search.histories.content, []);
  assert.deepEqual(deleted.search.histories.name, ["report", "archive"]);
});

assertTest("workspaceReducer marks search completion with final progress", () => {
  const state = workspaceReducer(createState(), {
    type: "searchStarted",
    payload: { searchId: "search-42" }
  } as WorkspaceAction);
  const completed = workspaceReducer(state, {
    type: "searchCompleted",
    payload: {
      results: [
        {
          id: "result-1",
          name: "report.txt",
          kind: "file",
          path: "D:\\report.txt",
          parentPath: "D:\\",
          openPath: "D:\\",
          location: { kind: "local", label: "D:", path: "D:\\" },
          match: "report"
        }
      ],
      progress: {
        searchId: "search-42",
        scannedEntries: 200,
        matchedEntries: 1,
        cancelled: false,
        statusText: "搜索完成：已扫描 200 项，匹配 1 项"
      }
    }
  } as WorkspaceAction);

  assert.equal(completed.search.loading, false);
  assert.equal(completed.search.results.length, 1);
  assert.deepEqual(completed.search.progress, {
    searchId: "search-42",
    scannedEntries: 200,
    matchedEntries: 1,
    cancelled: false,
    statusText: "搜索完成：已扫描 200 项，匹配 1 项"
  });
});

assertTest("workspaceReducer marks an active search as stopped without clearing the typed query or history", () => {
  const stateWithQuery = workspaceReducer(createState(), {
    type: "searchQueryChanged",
    payload: {
      content: "needle"
    }
  } as WorkspaceAction);
  const started = workspaceReducer(stateWithQuery, {
    type: "searchStarted",
    payload: { searchId: "search-stop" }
  } as WorkspaceAction);
  const stopped = workspaceReducer(started, {
    type: "searchCancelled"
  } as WorkspaceAction);

  assert.equal(stopped.search.loading, false);
  assert.equal(stopped.search.query.content, "needle");
  assert.deepEqual(stopped.search.history, ["needle"]);
  assert.deepEqual(stopped.search.progress, {
    searchId: "search-stop",
    scannedEntries: 0,
    matchedEntries: 0,
    cancelled: true,
    statusText: "搜索已停止"
  });
});

assertTest("workspaceReducer creates a bound search results tab next to the source tab in the selected panel", () => {
  const state = createState();
  const sourceTab = getActiveTab(state.panels["panel-2"]);
  const results = [createResult("result-1")];

  const completed = workspaceReducer(state, {
    type: "searchResultsTabCommitted",
    payload: {
      panelId: "panel-2",
      sourceTabId: sourceTab.id,
      tabId: "panel-2-search-1",
      query: state.search.query,
      results,
      progress: {
        scannedEntries: 200,
        matchedEntries: 1,
        cancelled: false,
        statusText: "搜索完成：已扫描 200 项，匹配 1 项"
      }
    }
  } as WorkspaceAction);

  const panel = completed.panels["panel-2"];
  const sourceIndex = panel.tabs.findIndex((tab) => tab.id === sourceTab.id);
  const resultTab = panel.tabs[sourceIndex + 1];

  assert.equal(completed.activePanelId, "panel-2");
  assert.equal(panel.activeTabId, "panel-2-search-1");
  assert.equal(resultTab.id, "panel-2-search-1");
  assert.equal(resultTab.kind, "search-results");
  assert.equal(resultTab.search?.sourceTabId, sourceTab.id);
  assert.equal(resultTab.search?.sourcePath, sourceTab.snapshot.location.path);
  assert.deepEqual(resultTab.search?.results, results);
  assert.equal(completed.search.loading, false);
  assert.equal(completed.search.results.length, 1);
});

assertTest("workspaceReducer reuses the first unbound search results tab in the same panel from left to right", () => {
  const state = createState();
  const panel = state.panels["panel-2"];
  const sourceTab = panel.tabs[0];
  const boundSearchTab = createSearchTab("bound-search", sourceTab, "other-source-tab");
  const unboundSearchTab = createSearchTab("unbound-search", sourceTab, undefined);
  const withSearchTabs = withPanelTabs(
    state,
    "panel-2",
    [sourceTab, boundSearchTab, unboundSearchTab, panel.tabs[1]],
    sourceTab.id
  );

  const completed = workspaceReducer(withSearchTabs, {
    type: "searchResultsTabCommitted",
    payload: {
      panelId: "panel-2",
      sourceTabId: sourceTab.id,
      tabId: "new-search-tab",
      query: state.search.query,
      results: [createResult("result-2", "readme.txt")]
    }
  } as WorkspaceAction);

  const panelAfter = completed.panels["panel-2"];
  assert.equal(panelAfter.tabs.length, 4);
  assert.equal(panelAfter.activeTabId, "unbound-search");
  assert.equal(panelAfter.tabs[2].search?.sourceTabId, sourceTab.id);
  assert.equal(panelAfter.tabs[2].search?.results[0].name, "readme.txt");
  assert.equal(panelAfter.tabs[1].search?.sourceTabId, "other-source-tab");
});

assertTest("workspaceReducer inserts a new search results tab when every result tab in the panel is bound", () => {
  const state = createState();
  const panel = state.panels["panel-2"];
  const sourceTab = panel.tabs[0];
  const withBoundSearchTabs = withPanelTabs(
    state,
    "panel-2",
    [sourceTab, createSearchTab("bound-search", sourceTab, "other-source-tab"), panel.tabs[1]],
    sourceTab.id
  );

  const completed = workspaceReducer(withBoundSearchTabs, {
    type: "searchResultsTabCommitted",
    payload: {
      panelId: "panel-2",
      sourceTabId: sourceTab.id,
      tabId: "panel-2-search-new",
      query: state.search.query,
      results: [createResult("result-3")]
    }
  } as WorkspaceAction);

  const panelAfter = completed.panels["panel-2"];
  assert.equal(panelAfter.tabs.length, 4);
  assert.equal(panelAfter.tabs[1].id, "panel-2-search-new");
  assert.equal(panelAfter.tabs[1].search?.sourceTabId, sourceTab.id);
  assert.equal(panelAfter.activeTabId, "panel-2-search-new");
});

assertTest("workspaceReducer unbinds search results tabs when the source tab path changes", () => {
  const state = createState();
  const panel = state.panels["panel-2"];
  const sourceTab = panel.tabs[0];
  const withBoundResult = withPanelTabs(
    state,
    "panel-2",
    [sourceTab, createSearchTab("search-for-source", sourceTab, sourceTab.id), panel.tabs[1]],
    sourceTab.id
  );

  const navigated = workspaceReducer(withBoundResult, {
    type: "tabSnapshotCommitted",
    payload: {
      panelId: "panel-2",
      tabId: sourceTab.id,
      snapshot: resolveMockDirectory("D:\\Projects\\Helix"),
      pushHistory: true
    }
  });

  const searchTab = navigated.panels["panel-2"].tabs.find((tab) => tab.id === "search-for-source");
  assert.ok(searchTab);
  assert.equal(searchTab!.kind, "search-results");
  assert.equal(searchTab!.search?.sourceTabId, undefined);
  assert.equal(searchTab!.search?.sourcePath, undefined);
});

assertTest("workspaceReducer converts a search results tab back to a directory tab when it navigates to a real path", () => {
  const state = createState();
  const panel = state.panels["panel-2"];
  const sourceTab = panel.tabs[0];
  const searchTab = createSearchTab("search-for-source", sourceTab, sourceTab.id);
  const withSearchTab = withPanelTabs(state, "panel-2", [sourceTab, searchTab, panel.tabs[1]], searchTab.id);

  const navigated = workspaceReducer(withSearchTab, {
    type: "tabSnapshotCommitted",
    payload: {
      panelId: "panel-2",
      tabId: searchTab.id,
      snapshot: resolveMockDirectory("D:\\Projects\\Atlas"),
      pushHistory: true
    }
  });

  const activeTab = getActiveTab(navigated.panels["panel-2"]);
  assert.equal(activeTab.id, searchTab.id);
  assert.equal(activeTab.kind, "directory");
  assert.equal(activeTab.search, undefined);
  assert.equal(activeTab.snapshot.location.path, "D:\\Projects\\Atlas");
});

assertTest("workspaceReducer cancels inline edit on the target tab only", () => {
  const state = createState();
  const activeTab = getActiveTab(state.panels["panel-1"]);
  const panel2Tab = getActiveTab(state.panels["panel-2"]);
  const editing = workspaceReducer(
    workspaceReducer(state, {
      type: "inlineEditStarted",
      payload: {
        panelId: "panel-1",
        tabId: activeTab.id,
        edit: {
          mode: "rename",
          value: "sprint-plan.md",
          kind: "file",
          parentPath: activeTab.snapshot.location.path,
          entryId: "D:\\Projects\\Atlas:sprint-plan.md",
          originalName: "sprint-plan.md",
          originalPath: "D:\\Projects\\Atlas\\sprint-plan.md"
        }
      }
    } as WorkspaceAction),
    {
      type: "inlineEditStarted",
      payload: {
        panelId: "panel-2",
        tabId: panel2Tab.id,
        edit: {
          mode: "create-folder",
          value: "New folder",
          kind: "folder",
          parentPath: panel2Tab.snapshot.location.path
        }
      }
    } as WorkspaceAction
  );

  const canceled = workspaceReducer(editing, {
    type: "inlineEditCanceled",
    payload: {
      panelId: "panel-1",
      tabId: activeTab.id
    }
  } as WorkspaceAction);

  assert.equal(getActiveTab(canceled.panels["panel-1"]).inlineEdit, undefined);
  assert.equal(getActiveTab(canceled.panels["panel-2"]).inlineEdit?.mode, "create-folder");
});

assertTest("workspaceReducer stores a clamped details row height in settings", () => {
  const state = createState();

  const nextState = workspaceReducer(state, {
    type: "detailsRowHeightSet",
    payload: { value: 84 }
  } as unknown as WorkspaceAction);

  assert.equal(nextState.settings.model.detailsRowHeight, 72);
});

assertTest("workspaceReducer stores a valid panel focus accent in theme settings", () => {
  const state = createState();

  const updated = workspaceReducer(state, {
    type: "themePanelFocusAccentSet",
    payload: { color: "#c02f7a" }
  } as unknown as WorkspaceAction);
  const rejected = workspaceReducer(updated, {
    type: "themePanelFocusAccentSet",
    payload: { color: "not-a-color" }
  } as unknown as WorkspaceAction);

  assert.equal(updated.settings.model.theme.panelFocusAccent, "#c02f7a");
  assert.equal(rejected.settings.model.theme.panelFocusAccent, "#c02f7a");
});

assertTest("workspaceReducer stores tab minimum width with a 1px floor and no upper cap", () => {
  const state = createState();

  const updated = workspaceReducer(state, {
    type: "themeTabMinWidthSet",
    payload: { value: 4096 }
  } as unknown as WorkspaceAction);
  const rejectedLow = workspaceReducer(updated, {
    type: "themeTabMinWidthSet",
    payload: { value: 0 }
  } as unknown as WorkspaceAction);

  assert.equal(updated.settings.model.theme.tabMinWidth, 4096);
  assert.equal(rejectedLow.settings.model.theme.tabMinWidth, 1);
});

assertTest("workspaceReducer stores resized detail column widths on the target tab only", () => {
  const state = createState();
  const targetTab = state.panels["panel-1"].tabs[0];
  const otherTab = state.panels["panel-2"].tabs[0];
  const originalSettingsWidth = state.settings.model.columns.find((column) => column.id === "name")?.width;
  const originalOtherTabWidth = otherTab.columns.find((column) => column.id === "name")?.width;

  const nextState = workspaceReducer(state, {
    type: "columnWidthSet",
    payload: { panelId: "panel-1", tabId: targetTab.id, id: "name", width: "34px" }
  } as unknown as WorkspaceAction);

  const nameColumn = nextState.panels["panel-1"].tabs[0].columns.find((column) => column.id === "name");
  assert.ok(nameColumn);
  assert.equal(nameColumn!.width, "48px");
  assert.equal(nextState.panels["panel-2"].tabs[0].columns.find((column) => column.id === "name")?.width, originalOtherTabWidth);
  assert.equal(nextState.settings.model.columns.find((column) => column.id === "name")?.width, originalSettingsWidth);
});

assertTest("workspaceReducer preserves local-only columns and tag filters when backend settings sync", () => {
  const state = workspaceReducer(
    workspaceReducer(createState(), {
      type: "columnVisibilityToggled",
      payload: { id: "location" }
    } as unknown as WorkspaceAction),
    {
      type: "tagRuleUpdated",
      payload: { id: "tag-latest", quickFilter: "本地筛选" }
    } as unknown as WorkspaceAction
  );
  const backendDefaults = createState().settings.model;

  const nextState = workspaceReducer(state, {
    type: "settingsSnapshotSynced",
    payload: {
      bookmarks: [
        {
          id: "bookmark-synced",
          label: "Synced",
          path: "D:\\Synced",
          tint: "#2266a8",
          note: "D:\\Synced",
          kind: "bookmark"
        }
      ],
      hotlist: state.hotlist,
      remoteProfiles: state.remoteProfiles,
      navigationItems: state.navigation.items,
      settingsModel: {
        ...backendDefaults,
        detailsRowHeight: 44,
        theme: {
          ...backendDefaults.theme,
          tabMinWidth: 132
        }
      }
    }
  } as WorkspaceAction);

  assert.equal(nextState.bookmarks[0].label, "Synced");
  assert.equal(nextState.settings.model.detailsRowHeight, 44);
  assert.equal(nextState.settings.model.theme.tabMinWidth, 132);
  assert.equal(nextState.settings.model.columns.find((column) => column.id === "location")?.visible, true);
  assert.equal(nextState.settings.model.tagRules.find((rule) => rule.id === "tag-latest")?.quickFilter, "本地筛选");
});

assertTest("workspaceReducer replaces bookmark and hotlist collections after backend sync", () => {
    const state = createState();

    const nextState = workspaceReducer(state, {
      type: "favoritesUpdated",
      payload: {
        bookmarks: [
          {
            id: "bookmark-new",
            label: "Workspace",
            path: "D:\\Projects\\Atlas",
            tint: "#2266a8",
            note: "D:\\Projects\\Atlas",
            kind: "bookmark"
          }
        ],
        hotlist: [
          {
            id: "hot-new",
            label: "Downloads",
            path: "C:\\Users\\Admin\\Downloads",
            tint: "#8d6b2c",
            note: "C:\\Users\\Admin\\Downloads",
            kind: "hotlist"
          }
        ]
      }
    });

    assert.equal(nextState.bookmarks.length, 1);
    assert.equal(nextState.bookmarks[0].label, "Workspace");
    assert.equal(nextState.hotlist.length, 1);
    assert.equal(nextState.hotlist[0].label, "Downloads");
  });

assertTest("workspaceReducer refreshes remote profiles and tree roots after remote save", () => {
  const state = createState();

    const nextState = workspaceReducer(state, {
      type: "remoteProfilesUpdated",
      payload: [
        {
          id: "remote-1",
          name: "Edge",
          protocol: "sftp",
          host: "edge-01.internal",
          port: 22,
          username: "deploy",
          rootPath: "/releases",
          authKind: "password",
          passiveMode: true,
          ignoreHostKey: false,
          connectTimeoutSecs: 10,
          commandTimeoutSecs: 20
        }
      ]
    });

    assert.equal(nextState.remoteProfiles.length, 1);
    const remoteRoot = nextState.directoryTree.find((node) => node.kind === "remote-root");
  assert.ok(remoteRoot);
  assert.equal(remoteRoot!.label, "Edge");
  assert.equal(remoteRoot!.path, "sftp://deploy@edge-01.internal/releases");
});

assertTest("workspaceReducer removes remote roots when the remote profile list becomes empty", () => {
  const state = workspaceReducer(createState(), {
    type: "remoteProfilesUpdated",
    payload: [
      {
        id: "remote-1",
        name: "Edge",
        protocol: "sftp",
        host: "edge-01.internal",
        port: 22,
        username: "deploy",
        rootPath: "/releases",
        authKind: "password",
        passiveMode: true,
        ignoreHostKey: false,
        connectTimeoutSecs: 10,
        commandTimeoutSecs: 20
      }
    ]
  });

  const nextState = workspaceReducer(state, {
    type: "remoteProfilesUpdated",
    payload: []
  });

  assert.equal(nextState.remoteProfiles.length, 0);
  assert.equal(nextState.directoryTree.some((node) => node.kind === "remote-root"), false);
  assert.equal(nextState.directoryTree.some((node) => node.kind === "drive"), true);
});

assertTest("workspaceReducer merges new breadcrumb paths into expandedNodePaths on navigation", () => {
  const state = createState();
  const activeTab = getActiveTab(state.panels["panel-1"]);

  const expanded = workspaceReducer(state, {
    type: "treeNodeExpansionSet",
    payload: {
      panelId: "panel-1",
      tabId: activeTab.id,
      path: "D:\\Archive",
      expanded: true
    }
  });

  const navigated = workspaceReducer(expanded, {
    type: "tabSnapshotCommitted",
    payload: {
      panelId: "panel-1",
      tabId: activeTab.id,
      snapshot: resolveMockDirectory("C:\\Users\\Admin\\Downloads"),
      pushHistory: true
    }
  });

  const updatedTab = getActiveTab(navigated.panels["panel-1"]);
  assert.equal(updatedTab.expandedNodePaths.includes("D:\\Archive"), true);
  assert.equal(updatedTab.expandedNodePaths.includes("C:\\"), true);
  assert.equal(updatedTab.expandedNodePaths.includes("C:\\Users"), true);
  assert.equal(updatedTab.expandedNodePaths.includes("C:\\Users\\Admin"), true);
  assert.equal(updatedTab.expandedNodePaths.includes("C:\\Users\\Admin\\Downloads"), true);
});

assertTest("workspaceReducer preserves pre-loaded children when treeChildrenLoaded provides empty fallback", () => {
  const state = createState();

  const atlasNodeBefore = state.directoryTree
    .find((node) => node.path === "D:\\")!
    .children.find((node) => node.path === "D:\\Projects")!
    .children.find((node) => node.path === "D:\\Projects\\Atlas");

  assert.ok(atlasNodeBefore);
  assert.equal(atlasNodeBefore!.loaded, true);
  assert.ok(atlasNodeBefore!.children.length > 0);

  const nextState = workspaceReducer(state, {
    type: "treeChildrenLoaded",
    payload: {
      path: "D:\\Projects\\Atlas",
      children: []
    }
  });

  const atlasNodeAfter = nextState.directoryTree
    .find((node) => node.path === "D:\\")!
    .children.find((node) => node.path === "D:\\Projects")!
    .children.find((node) => node.path === "D:\\Projects\\Atlas");

  assert.ok(atlasNodeAfter);
  assert.equal(atlasNodeAfter!.loaded, true);
  assert.equal(atlasNodeAfter!.children.length, atlasNodeBefore!.children.length);
});

assertTest("workspaceReducer normalizes Windows verbatim paths when tree children are loaded", () => {
  const state = createState();

  const nextState = workspaceReducer(state, {
    type: "treeChildrenLoaded",
    payload: {
      path: "D:\\",
      children: [
        {
          id: "\\\\?\\D:\\Projects",
          label: "Projects",
          path: "\\\\?\\D:\\Projects",
          kind: "folder",
          expandable: true,
          children: []
        }
      ]
    }
  });

  const projectsNode = nextState.directoryTree
    .find((node) => node.path === "D:\\")!
    .children.find((node) => node.label === "Projects");

  assert.ok(projectsNode);
  assert.equal(projectsNode!.path, "D:\\Projects");
  assert.equal(projectsNode!.id, "D:\\Projects");
});

assertTest("workspaceReducer normalizes Windows verbatim paths before storing tree expansion state", () => {
  const state = createState();
  const activeTab = getActiveTab(state.panels["panel-1"]);

  const expanded = workspaceReducer(state, {
    type: "treeNodeExpansionSet",
    payload: {
      panelId: "panel-1",
      tabId: activeTab.id,
      path: "\\\\?\\D:\\Projects",
      expanded: true
    }
  });

  const updatedTab = getActiveTab(expanded.panels["panel-1"]);
  assert.equal(updatedTab.expandedNodePaths.includes("D:\\Projects"), true);
  assert.equal(updatedTab.expandedNodePaths.includes("\\\\?\\D:\\Projects"), false);
});

assertTest("workspaceReducer does not duplicate paths already in expandedNodePaths during breadcrumb merge", () => {
  const state = createState();
  const activeTab = getActiveTab(state.panels["panel-1"]);
  const initialCount = activeTab.expandedNodePaths.length;

  const navigated = workspaceReducer(state, {
    type: "tabSnapshotCommitted",
    payload: {
      panelId: "panel-1",
      tabId: activeTab.id,
      snapshot: resolveMockDirectory(activeTab.snapshot.location.path),
      pushHistory: false
    }
  });

  const updatedTab = getActiveTab(navigated.panels["panel-1"]);
  const uniquePaths = new Set(updatedTab.expandedNodePaths);
  assert.equal(uniquePaths.size, updatedTab.expandedNodePaths.length);
  assert.ok(updatedTab.expandedNodePaths.length >= initialCount);
});

import assert from "node:assert/strict";
import React, { act } from "react";
import { useWorkspaceController } from "./useWorkspaceController";
import { getTabEntries } from "./folderExpansion";
import { expansionEntry, expansionFixture, expansionInteractions, expansionSnapshot } from "./folderExpansionTestSupport";
import { createTestGateway, flushEffects, installDomEnvironment, waitFor } from "./workspaceControllerTestHarness";
import type { DirectorySnapshot, WorkspaceFsChangedEvent } from "./types";
import type { OperationTaskEventEnvelope, OperationTaskSnapshot } from "../../app/types";
import type { BatchRenameRow } from "../../app/batchRename";

export const completion = (async () => {
  installDomEnvironment();
  const ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  for (const scenario of ["watcher-first", "later-refresh", "parent-child", "navigate", "manual-choice"] as const) {
    const f = expansionFixture();
    const a = expansionEntry(f.path, "Test.txt", "file"), b = expansionEntry(f.path, "Other.txt", "file");
    const keep = expansionEntry(f.path, "Keep.txt", "file");
    const directory = scenario === "parent-child";
    const sources = directory ? [f.parent, f.child] : [a, b];
    const newParent = expansionEntry(f.path, "New-parent");
    const destinations = directory ? [newParent, expansionEntry(newParent.path, "New-child.txt", "file")]
      : [expansionEntry(f.path, "New-Test.txt", "file"), expansionEntry(f.path, "New-Other.txt", "file")];
    const tab = f.bootstrap.panels["panel-1"].tabs[0];
    tab.snapshot = expansionSnapshot(f.path, directory ? [f.parent, keep] : [a, b, keep]);
    tab.viewMode = "details";
    const other = expansionEntry("C:\\elsewhere", "Stay.txt", "file");
    let changed = false, queueRootReads = false, watchSequence = 0;
    const rootReads: Array<(snapshot: DirectorySnapshot) => void> = [];
    const interactions = { ...expansionInteractions(), fileSystemChangeListeners: [] as Array<(event: WorkspaceFsChangedEvent) => void | Promise<void>> };
    const finalRoot = () => expansionSnapshot(f.path, directory ? [newParent, keep] : [...destinations, keep]);
    let emit!: (event: OperationTaskEventEnvelope) => void;
    const gateway = createTestGateway(() => {}, interactions, { loadBootstrap: () => f.bootstrap,
      listenOperationTasks: async handler => { emit = handler; return () => {}; },
      resolveDirectory: async path => {
        if (path === "C:\\elsewhere") return expansionSnapshot(path, [other]);
        if (path === f.path && queueRootReads) return new Promise<DirectorySnapshot>(resolve => rootReads.push(resolve));
        if (path === f.path) return changed ? finalRoot() : tab.snapshot;
        return expansionSnapshot(path, changed ? [destinations[1]] : [f.child]);
      } });
    const rows = (): BatchRenameRow[] => sources.map((entry, index) => ({ id: String(index), sourcePath: entry.path,
      parentPath: entry.parentPath, oldName: entry.name, newName: destinations[index].name, targetPath: destinations[index].path,
      isDirectory: entry.kind === "folder", status: "changed", diagnostic: null }));
    gateway.batchRename.create = async () => ({ sessionId: scenario, frozenAt: "2026-09-12", items: rows() });
    gateway.batchRename.invalidate = async () => {};
    gateway.batchRename.close = async () => {};
    gateway.batchRename.preview = async request => ({ ...request, previewId: "preview", canApply: request.expression !== "*",
      changedCount: 2, diagnostics: [], items: rows() });
    let task!: OperationTaskSnapshot;
    gateway.batchRename.apply = async request => task = { taskId: scenario, requestId: request.requestId, kind: "rename", label: "批量重命名",
      status: "running", totalEntries: 2, completedEntries: 0, failedEntries: 0, cancelable: true, undoable: false,
      createdAt: "2026-09-12", updatedAt: "2026-09-12", sequence: 1, affectedRoots: [{ kind: "local", path: f.path }], entryResults: [] };
    let controller!: ReturnType<typeof useWorkspaceController>;
    function Harness() { controller = useWorkspaceController(gateway); return null; }
    const root = ReactDOM.createRoot(document.getElementById("root")!);
    const tick = async (fn: () => void, delay = 0) => act(async () => { fn(); await flushEffects();
      if (delay) await new Promise(resolve => setTimeout(resolve, delay)); await flushEffects(); });
    const currentTab = () => controller.state.panels["panel-1"].tabs[0];
    const selected = () => getTabEntries(currentTab()).filter(entry => currentTab().selectedEntryIds.includes(entry.id)).map(entry => entry.path).sort();
    const watch = () => tick(() => { void interactions.fileSystemChangeListeners[0]({ roots: [f.path], directoryRoots: [f.path],
      navigationParentRoots: [], sequence: ++watchSequence }); }, 430);
    const finish = () => tick(() => {
      task = { ...task, status: "succeeded", sequence: 2, completedEntries: 2, cancelable: false, undoable: true,
        entryResults: sources.map((entry, index) => ({ entryResultId: String(index), kind: "renamed",
          source: { kind: "local", path: entry.path }, destination: { kind: "local", path: destinations[index].path } })) };
      emit({ taskId: task.taskId, sequence: task.sequence, updatedAt: task.updatedAt, snapshot: task });
    });
    try {
      await tick(() => root.render(React.createElement(Harness)));
      if (directory) await tick(() => controller.actions.toggleFolderExpansion("panel-1", f.tabId, f.parent.path));
      await tick(() => controller.actions.selectEntry("panel-1", f.tabId, sources[0].id, false));
      await tick(() => controller.actions.selectEntry("panel-1", f.tabId, sources[1].id, true));
      await tick(() => controller.actions.renameSelection("panel-1"));
      await waitFor(() => controller.state.batchRename?.phase === "editing", "initial preview did not arrive");
      await tick(() => controller.actions.changeBatchRename(controller.state.batchRename!.id, "New-*"), 150);
      await tick(() => { void controller.actions.confirmBatchRename(controller.state.batchRename!.id); });
      assert.equal(controller.state.batchRename?.phase, "running");
      changed = true;
      if (scenario === "watcher-first") { await watch(); assert.deepEqual(selected(), []); }
      if (scenario === "navigate") await tick(() => controller.actions.navigateToPath("panel-1", "C:\\elsewhere"));
      queueRootReads = scenario === "later-refresh" || scenario === "manual-choice";
      await finish();
      if (queueRootReads) {
        assert.equal(rootReads.length, 1);
        if (scenario === "manual-choice") await tick(() => controller.actions.selectEntry("panel-1", f.tabId, keep.id, false));
        await watch(); assert.equal(rootReads.length, 2);
        await tick(() => rootReads[1](finalRoot()));
        await tick(() => rootReads[0](finalRoot()));
      }
      if (directory) await waitFor(() => getTabEntries(currentTab()).some(entry => entry.path === destinations[1].path), "renamed child did not become reachable");
      assert.equal(controller.state.batchRename, undefined);
      const expected = scenario === "navigate" ? [other.path] : scenario === "manual-choice" ? [keep.path] : destinations.map(entry => entry.path);
      assert.deepEqual(selected(), expected.sort(), `${scenario}: restore captured selection after actual refresh without replacing a newer user choice`);
      console.log(`ok - batch completion selection: ${scenario}`);
    } finally { await tick(() => root.unmount()); }
  }
})();

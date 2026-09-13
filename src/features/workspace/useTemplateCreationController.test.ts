import assert from "node:assert/strict";
import React, { act } from "react";
import { useWorkspaceController } from "./useWorkspaceController";
import { expansionEntry, expansionFixture, expansionInteractions, expansionSnapshot } from "./folderExpansionTestSupport";
import { createTestGateway, flushEffects, installDomEnvironment, waitFor } from "./workspaceControllerTestHarness";
import type { OperationTaskEventEnvelope, OperationTaskSnapshot } from "../../app/types";
import type { CreateTemplateItemsRequest, CreationTemplateEntry } from "../../app/templates";

export const completion = (async () => {
  installDomEnvironment();
  const ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  for (const scenario of ["single", "multiple", "navigate", "intermediate-edit", "early-event", "pending-navigation-copy-first", "pending-navigation-reply-first",
    "ready-navigation-single", "ready-navigation-multiple", "ready-selection-single", "ready-selection-multiple"] as const) {
    const f = expansionFixture(); f.bootstrap.settingsModel.templateRoot = "C:\\Templates";
    const original = f.bootstrap.panels["panel-1"].tabs.find(tab => tab.id === f.tabId)!;
    const created = [expansionEntry(f.path, "Result (1).txt", "file"), expansionEntry(f.path, "Project")];
    const templates: CreationTemplateEntry[] = [{ name: "Template.txt", path: "C:\\Templates\\Word\\Template.txt", relativePath: "Word/Template.txt", kind: "file" },
      { name: "Project", path: "C:\\Templates\\Project", relativePath: "Project", kind: "directory" }];
    let copied = false, emit!: (event: OperationTaskEventEnvelope) => void, submitted: CreateTemplateItemsRequest | undefined;
    let task!: OperationTaskSnapshot;
    const requests: string[][] = [];
    const resolvedPaths: string[] = [];
    const pendingNavigation = scenario.startsWith("pending-navigation");
    const readyNavigation = scenario.startsWith("ready-navigation"), readySelection = scenario.startsWith("ready-selection");
    const lateInteraction = readyNavigation || readySelection;
    let finishNavigation!: () => void;
    const navigationGate = new Promise<void>(resolve => { finishNavigation = resolve; });
    const count = scenario === "multiple" || scenario.endsWith("-multiple") ? 2 : 1;
    const gateway = createTestGateway(() => {}, expansionInteractions(), { loadBootstrap: () => f.bootstrap,
      resolveDirectory: async path => {
        resolvedPaths.push(path);
        if ((pendingNavigation || readyNavigation) && path === "C:\\elsewhere") await navigationGate;
        return path === f.path ? expansionSnapshot(path, copied ? [...original.snapshot.entries, ...created.slice(0, count)] : original.snapshot.entries) : expansionSnapshot(path, []);
      },
      listenOperationTasks: async handler => { emit = handler; return () => {}; },
      listOperationTasks: async () => ({ tasks: task ? [task] : [], taskSequence: task?.sequence ?? 0 }) });
    const finalTask = (): OperationTaskSnapshot => ({ ...task, status: "succeeded", sequence: 3, completedEntries: count, cancelable: false, undoable: true,
      entryResults: created.slice(0, count).map((entry,index) => ({ entryResultId: String(index), kind: "created", source: { kind: "local", path: templates[index].path }, destination: { kind: "local", path: entry.path } })) });
    gateway.templates.list = async () => ({ rootPath: "C:\\Templates", relativePath: "", entries: templates });
    gateway.templates.create = async request => {
      submitted = request;
      task = { taskId: scenario, requestId: request.requestId, kind: "copy", label: "新建项目", status: "running", sequence: 1,
        createdAt: "now", updatedAt: "now", completedEntries: 0, failedEntries: 0, cancelable: true, undoable: false, affectedRoots: [{ kind: "local", path: f.path }], entryResults: [] };
      if (scenario === "early-event") { copied = true; emit({ taskId: task.taskId, sequence: 3, updatedAt: "now", snapshot: finalTask() }); }
      return task;
    };
    gateway.batchRename.create = async paths => { requests.push(paths); return { sessionId: "rename", frozenAt: "now", items: [] }; };
    gateway.batchRename.preview = async request => ({ ...request, previewId: null, canApply: false, changedCount: 0, diagnostics: [], items: [] });
    let controller!: ReturnType<typeof useWorkspaceController>;
    function Harness() { controller = useWorkspaceController(gateway); return null; }
    const root = ReactDOM.createRoot(document.getElementById("root")!);
    const tick = async (fn: () => void) => act(async () => { fn(); await flushEffects(); await flushEffects(); });
    try {
      await tick(() => root.render(React.createElement(Harness)));
      await tick(() => controller.actions.openTemplateMenu("panel-1", f.tabId, { x: 40, y: 40 }));
      await waitFor(() => !!controller.state.templateMenu?.directories[""], "template menu did not load");
      const id = controller.state.templateMenu!.id;
      if (count === 2) {
        await tick(() => controller.actions.toggleTemplateItem(id, templates[0]));
        await tick(() => controller.actions.toggleTemplateItem(id, templates[1]));
        await tick(() => controller.actions.createSelectedTemplates(id));
      } else await tick(() => controller.actions.activateTemplateItem(id, templates[0]));
      assert.equal(submitted?.destination, f.path);
      assert.deepEqual(submitted?.relativePaths, templates.slice(0, count).map(entry => entry.relativePath));
      if (scenario === "navigate" || pendingNavigation) await tick(() => controller.actions.navigateToPath("panel-1", "C:\\elsewhere"));
      const refreshesBeforeCompletion = resolvedPaths.filter(path => path === f.path).length;
      if (scenario === "intermediate-edit") {
        await tick(() => controller.actions.createFile("panel-1"));
        await tick(() => controller.actions.cancelInlineEdit("panel-1", f.tabId));
      }
      if (lateInteraction) await act(async () => {
        copied = true; task = finalTask(); emit({ taskId: task.taskId, sequence: 3, updatedAt: "now", snapshot: task });
        // Let the real refresh promises settle while React still batches the completion and the next user intent.
        for (let turn = 0; turn < 50; turn++) await Promise.resolve();
        if (readyNavigation) controller.actions.navigateToPath("panel-1", "C:\\elsewhere");
        else controller.actions.selectEntry("panel-1", f.tabId, f.sibling.id, false);
        await flushEffects(); await flushEffects();
      });
      else if (scenario !== "early-event") await tick(() => {
        copied = true; task = finalTask(); emit({ taskId: task.taskId, sequence: 3, updatedAt: "now", snapshot: task });
        if (scenario === "pending-navigation-reply-first") finishNavigation();
      });
      if (pendingNavigation) {
        assert.equal(resolvedPaths.filter(path => path === f.path).length, refreshesBeforeCompletion,
          "template completion must not refresh the old folder over an in-flight user navigation");
        await tick(finishNavigation);
        await waitFor(() => controller.state.panels["panel-1"].tabs.find(tab => tab.id === f.tabId)!.snapshot.location.path === "C:\\elsewhere",
          "the user navigation was replaced by template completion");
      }
      await waitFor(() => !controller.state.templateCreation, "creation did not complete");
      const tab = controller.state.panels["panel-1"].tabs.find(tab => tab.id === f.tabId)!;
      if (lateInteraction) {
        assert.equal(tab.inlineEdit, undefined, "superseded ready completion must not open inline rename");
        assert.deepEqual(requests, [], "superseded ready completion must not open batch rename");
        assert.equal(controller.state.batchRename, undefined);
        assert.ok(created.slice(0, count).every(entry => tab.snapshot.entries.some(item => item.path === entry.path)), "all copies remain");
        if (readySelection) assert.deepEqual(tab.selectedEntryIds, [f.sibling.id], "new selection must not be restored to the copies");
        assert.ok(controller.state.notifications.some(item => item.message.includes("可手动重命名")));
      }
      else if (count === 2) assert.deepEqual(requests, [created.map(entry => entry.path)], "batch editor uses copied destinations");
      else if (scenario === "navigate" || scenario === "intermediate-edit" || pendingNavigation) assert.equal(tab.inlineEdit, undefined, scenario);
      else {
        assert.equal(tab.inlineEdit?.originalPath, created[0].path);
        await tick(() => controller.actions.cancelInlineEdit("panel-1", f.tabId));
        assert.ok(tab.snapshot.entries.some(entry => entry.path === created[0].path), "rename cancellation retains the copy");
      }
      console.log(`ok - template completion: ${scenario}`);
    } finally { await tick(finishNavigation); await tick(() => root.unmount()); }
  }
})();

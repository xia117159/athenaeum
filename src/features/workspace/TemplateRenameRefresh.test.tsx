import assert from "node:assert/strict";
import React, { act } from "react";
import { FileListingShell } from "./FileListing";
import { getFolderListingRows } from "./folderExpansion";
import { expansionEntry, expansionFixture, expansionInteractions, expansionSnapshot, quickFilterProgram } from "./folderExpansionTestSupport";
import { useWorkspaceController } from "./useWorkspaceController";
import { createTestGateway, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { CreationTemplateEntry } from "../../app/templates";
import type { DirectorySnapshot, WorkspaceFsChangedEvent } from "./types";

export const completion = (async () => {
  const dom = installDomEnvironment(); globalThis.Element = dom.window.Element;
  const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");
  for (const viewMode of ["details", "large-icons"] as const) {
    for (const kind of ["file", "folder"] as const) {
      const f = expansionFixture(); f.bootstrap.settingsModel.templateRoot = "C:\\Templates";
      const original = f.bootstrap.panels["panel-1"].tabs[0]; original.viewMode = viewMode;
      const created = expansionEntry(f.path, kind === "file" ? "Created.txt" : "Project", kind);
      const template: CreationTemplateEntry = { name: created.name, path: `C:\\Templates\\${created.name}`,
        relativePath: created.name, kind: kind === "folder" ? "directory" : "file" };
      const interactions = { ...expansionInteractions(), fileSystemChangeListeners: [] as Array<(event: WorkspaceFsChangedEvent) => void> };
      let copied = false, reads = 0, release: ((value: DirectorySnapshot) => void) | undefined;
      let deferNextRead = false;
      const listing = () => expansionSnapshot(f.path, copied ? [...original.snapshot.entries, { ...created }] : original.snapshot.entries);
      const gateway = createTestGateway(() => {}, interactions, { loadBootstrap: () => f.bootstrap,
        resolveDirectory: async () => {
          reads++;
          if (deferNextRead) { deferNextRead = false; return new Promise(resolve => { release = resolve; }); }
          return listing();
        } });
      gateway.templates.list = async () => ({ rootPath: "C:\\Templates", relativePath: "", entries: [template] });
      gateway.templates.create = async request => {
        copied = true;
        return { taskId: "created", requestId: request.requestId, kind: "copy", label: "新建项目", status: "succeeded",
          sequence: 1, createdAt: "now", updatedAt: "now", completedEntries: 1, failedEntries: 0, cancelable: false, undoable: true,
          affectedRoots: [{ kind: "local", path: f.path }], entryResults: [{ entryResultId: "created", kind: "created",
            source: { kind: "local", path: template.path }, destination: { kind: "local", path: created.path } }] };
      };
      let controller!: ReturnType<typeof useWorkspaceController>;
      const activeTab = () => controller.state.panels["panel-1"].tabs.find(tab => tab.id === f.tabId)!;
      function Harness() {
        controller = useWorkspaceController(gateway);
        if (controller.state.status !== "ready") return null;
        const tab = activeTab(), { actions } = controller;
        // A quick filter must not hide the copied row while it is being renamed.
        const rows = getFolderListingRows(tab, undefined, quickFilterProgram("does-not-match"));
        return <FileListingShell panelId="panel-1" tabId={tab.id} columns={tab.columns} sort={tab.sort} currentPath={f.path}
          entries={rows.map(row => row.entry)} folderRows={rows} selectedEntryIds={tab.selectedEntryIds} viewMode={tab.viewMode}
          detailsRowHeight={24} inlineEdit={tab.inlineEdit} onSort={() => {}} onSelect={() => {}} onOpen={() => {}}
          onOpenContextMenu={() => {}} onOpenNativeContextMenu={() => {}} onResizeColumn={() => {}} onDropEntries={() => {}}
          onInlineEditChange={value => actions.updateInlineEdit("panel-1", tab.id, value)}
          onInlineEditCommit={value => { void actions.commitInlineEdit("panel-1", tab.id, value); }}
          onInlineEditCancel={() => actions.cancelInlineEdit("panel-1", tab.id)} />;
      }
      const root = createRoot(document.getElementById("root")!);
      const tick = async (fn: () => void) => act(async () => { fn(); await flushEffects(); await flushEffects(); });
      const notify = () => interactions.fileSystemChangeListeners.forEach(handler => handler({ roots: [f.path], directoryRoots: [f.path],
        navigationParentRoots: [], sequence: reads + 1 }));
      const refresh = async () => act(async () => { notify(); await new Promise(resolve => setTimeout(resolve, 400)); await flushEffects(); });
      const key = async (element: HTMLElement, name: string) => tick(() => element.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));
      try {
        await tick(() => root.render(<Harness />));
        await tick(() => controller.actions.openTemplateMenu("panel-1", f.tabId, { x: 30, y: 30 }));
        await tick(() => controller.actions.activateTemplateItem(controller.state.templateMenu!.id, template));
        const input = document.querySelector<HTMLInputElement>(".inline-edit-input");
        assert.ok(input, `${viewMode}/${kind}: creating a template opens the editor`);
        assert.equal(activeTab().inlineEdit?.originalPath, created.path);
        await tick(() => controller.actions.updateInlineEdit("panel-1", f.tabId, "My draft.txt"));
        input.setSelectionRange(3, 8);
        const readsBefore = reads;
        await refresh();
        assert.ok(reads > readsBefore, "the test must actually refresh the target directory");
        assert.equal(activeTab().inlineEdit?.value, "My draft.txt", "the watcher must preserve the rename draft");
        assert.ok(document.querySelector(".inline-edit-input") === input, "the same editor node survives the refresh");
        assert.ok(document.activeElement === input);
        assert.deepEqual([input.selectionStart, input.selectionEnd], [3, 8], "refresh must not select all text again");

        deferNextRead = true;
        await refresh(); assert.ok(release, "a second refresh is pending");
        await tick(() => controller.actions.updateInlineEdit("panel-1", f.tabId, "A newer draft.txt"));
        input.setSelectionRange(2, 7);
        await tick(() => { release!(listing()); release = undefined; });
        assert.equal(activeTab().inlineEdit?.value, "A newer draft.txt", "late replies retain the latest draft");
        assert.ok(document.activeElement === input);
        assert.deepEqual([input.selectionStart, input.selectionEnd], [2, 7]);

        deferNextRead = true; await refresh(); assert.ok(release);
        await key(input, "Escape");
        await tick(() => { release!(listing()); release = undefined; });
        assert.equal(activeTab().inlineEdit, undefined, "a late refresh cannot resurrect a cancelled editor");
        assert.ok(!document.querySelector(".inline-edit-input"));
        assert.ok(activeTab().snapshot.entries.some(entry => entry.path === created.path), "cancelling keeps the copied item");
        assert.deepEqual(interactions.renameCalls, []);

        await tick(() => controller.actions.renameSelection("panel-1"));
        const confirmed = document.querySelector<HTMLInputElement>(".inline-edit-input"); assert.ok(confirmed);
        await tick(() => controller.actions.updateInlineEdit("panel-1", f.tabId, "Confirmed.txt"));
        await key(confirmed, "Enter");
        assert.deepEqual(interactions.renameCalls, [{ source: created.path, newName: "Confirmed.txt" }]);
        assert.equal(activeTab().inlineEdit, undefined);
        console.log(`ok - ${viewMode}/${kind}: template rename survives watcher refresh with focus and text selection`);
      } finally {
        if (release) await tick(() => { release!(listing()); release = undefined; });
        await tick(() => root.unmount());
      }
    }
  }
})();

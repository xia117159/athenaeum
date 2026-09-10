import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { useWorkspaceController } from "./useWorkspaceController";
import { getFolderBranch, getTabEntries } from "./folderExpansion";
import { expansionEntry, expansionFixture, expansionInteractions, expansionSnapshot } from "./folderExpansionTestSupport";
import { assertTest, createTestGateway, flushEffects, installDomEnvironment, waitFor } from "./workspaceControllerTestHarness";
import type { DirectorySnapshot, WorkspaceBootstrap } from "./types";
import type { WorkspaceGateway } from "./workspaceGateway";

type Controller = ReturnType<typeof useWorkspaceController>;
async function mount(bootstrap: WorkspaceBootstrap, overrides: Parameters<typeof createTestGateway>[2] = {}, configure?: (gateway: WorkspaceGateway) => void) {
  const interactions = expansionInteractions();
  const gateway = createTestGateway(() => undefined, interactions, { loadBootstrap: () => bootstrap, ...overrides });
  configure?.(gateway);
  let current!: Controller;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  function Harness() { current = useWorkspaceController(gateway); return React.createElement("div"); }
  await act(async () => { root.render(React.createElement(Harness)); await flushEffects(); });
  await waitFor(() => current?.state.status === "ready", "bootstrap did not complete");
  return {
    get controller() { return current; },
    get tab() { return current.state.panels["panel-1"].tabs[0]; },
    interactions, gateway,
    async close() { await act(async () => { root.unmount(); await flushEffects(); }); container.remove(); }
  };
}
async function toggle(harness: Awaited<ReturnType<typeof mount>>, path: string, retry = false) {
  const name = retry ? "retryFolderExpansion" : "toggleFolderExpansion";
  const action = Reflect.get(harness.controller.actions, name);
  assert.equal(typeof action, "function", `workspace controller must expose ${name}`);
  await act(async () => { action("panel-1", harness.tab.id, path); await flushEffects(); });
}

export const completion = (async () => {
  const dom = installDomEnvironment();
  dom.window.confirm = () => true;
  for (const kind of ["local", "ftp", "sftp"] as const) {
    await assertTest(`folder expansion lazily loads ${kind} child entries and keeps the parent location`, async () => {
      const f = expansionFixture(kind);
      const harness = await mount(f.bootstrap, { resolveDirectory: async (path) => expansionSnapshot(path, [f.child, f.nested]) });
      try {
        assert.deepEqual(harness.interactions.resolvedPaths, []);
        await toggle(harness, f.parent.path);
        await waitFor(() => getFolderBranch(harness.tab, f.parent.path)?.status === "ready", "branch did not load");
        assert.deepEqual(harness.interactions.resolvedPaths, [f.parent.path]);
        assert.equal(harness.tab.snapshot.location.path, f.path);
        assert.equal(getTabEntries(harness.tab).some((entry) => entry.id === f.child.id), true);
        await act(async () => { harness.controller.actions.selectEntry("panel-1", f.tabId, f.child.id, false); await flushEffects(); });
        await act(async () => { harness.controller.actions.copySelection("panel-1"); await flushEffects(); });
        assert.deepEqual(harness.controller.state.clipboard?.paths, [f.child.path]);
        await toggle(harness, f.parent.path);
        assert.equal(getTabEntries(harness.tab).some((entry) => entry.id === f.child.id), false);
        assert.equal(harness.tab.selectedEntryIds.includes(f.child.id), false);
      } finally { await harness.close(); }
    });
  }

  await assertTest("late responses after collapse/re-expand cannot replace the new child listing", async () => {
    const f = expansionFixture();
    const pending: Array<(value: DirectorySnapshot) => void> = [];
    const harness = await mount(f.bootstrap, { resolveDirectory: () => new Promise((resolve) => pending.push(resolve)) });
    try {
      await toggle(harness, f.parent.path);
      await toggle(harness, f.parent.path);
      await toggle(harness, f.parent.path);
      assert.equal(pending.length, 2);
      await act(async () => { pending[1](expansionSnapshot(f.parent.path, [f.child])); await flushEffects(); });
      await act(async () => { pending[0](expansionSnapshot(f.parent.path, [f.nested])); await flushEffects(); });
      assert.deepEqual(getFolderBranch(harness.tab, f.parent.path)?.entries.map((entry) => entry.id), [f.child.id]);
    } finally { await harness.close(); }
  });

  await assertTest("remote read failure stays on its branch and retry loads the empty folder", async () => {
    const f = expansionFixture("sftp");
    let attempts = 0;
    const harness = await mount(f.bootstrap, { resolveDirectory: async (path) => {
      if (++attempts === 1) throw new Error("remote access denied");
      return expansionSnapshot(path, []);
    } });
    try {
      await toggle(harness, f.parent.path);
      assert.equal(getFolderBranch(harness.tab, f.parent.path)?.status, "error");
      assert.equal(getFolderBranch(harness.tab, f.parent.path)?.errorMessage?.includes("remote access denied"), true);
      assert.equal(harness.tab.status, "ready");
      assert.equal(harness.tab.snapshot.location.path, f.path);
      await toggle(harness, f.parent.path, true);
      assert.equal(getFolderBranch(harness.tab, f.parent.path)?.status, "ready");
      assert.deepEqual(getFolderBranch(harness.tab, f.parent.path)?.entries, []);
    } finally { await harness.close(); }
  });

  await assertTest("expanded directory reads have bounded concurrency and stale queued branches do not start", async () => {
    const f = expansionFixture("ftp");
    const folders = Array.from({ length: 6 }, (_, index) => expansionEntry(f.path, `folder${index}`));
    f.bootstrap.panels["panel-1"].tabs[0].snapshot.entries = folders;
    const pending: Array<{ path: string; resolve: (snapshot: DirectorySnapshot) => void }> = [];
    const harness = await mount(f.bootstrap, { resolveDirectory: (path) => new Promise((resolve) => pending.push({ path, resolve })) });
    try {
      for (const folder of folders) await toggle(harness, folder.path);
      assert.equal(pending.length, 4);
      await toggle(harness, folders[4].path);
      await act(async () => { pending[0].resolve(expansionSnapshot(pending[0].path, [])); await flushEffects(); });
      assert.equal(pending.length, 5);
      assert.equal(pending[4].path, folders[5].path);
      await act(async () => { pending.forEach(({ path, resolve }) => resolve(expansionSnapshot(path, []))); await flushEffects(); });
    } finally { await harness.close(); }
  });

  await assertTest("rename and delete expanded children refresh their real parent directory", async () => {
    const f = expansionFixture();
    let children = [f.child];
    const renamed = expansionEntry(f.parent.path, "renamed.txt", "file");
    const harness = await mount(f.bootstrap, {
      resolveDirectory: async (path) => path === f.path ? expansionSnapshot(path, [f.parent, f.sibling]) : expansionSnapshot(path, children),
      renameEntry: async () => { children = [renamed]; return undefined; },
      deleteEntries: async () => { children = []; return undefined; }
    });
    try {
      await toggle(harness, f.parent.path);
      await act(async () => { harness.controller.actions.selectEntry("panel-1", f.tabId, f.child.id, false); await flushEffects(); });
      await act(async () => { harness.controller.actions.renameSelection("panel-1"); await flushEffects(); });
      assert.equal(harness.tab.inlineEdit?.parentPath, f.parent.path);
      await act(async () => { harness.controller.actions.commitInlineEdit("panel-1", f.tabId, renamed.name); await flushEffects(); });
      await waitFor(() => getFolderBranch(harness.tab, f.parent.path)?.entries[0]?.id === renamed.id, "renamed branch did not refresh");
      assert.deepEqual(harness.tab.selectedEntryIds, [renamed.id]);
      await act(async () => { harness.controller.actions.deleteSelection("panel-1"); await flushEffects(); });
      await waitFor(() => getFolderBranch(harness.tab, f.parent.path)?.entries.length === 0, "deleted child remains visible");
      assert.equal(harness.tab.snapshot.location.path, f.path);
    } finally { await harness.close(); }
  });

  await assertTest("settings disable clears expansions and late results without repeated settings saves", async () => {
    const f = expansionFixture();
    let resolve!: (snapshot: DirectorySnapshot) => void;
    const harness = await mount(f.bootstrap, { resolveDirectory: () => new Promise((done) => { resolve = done; }) });
    try {
      await toggle(harness, f.parent.path);
      harness.interactions.savedSettingsModels.length = 0;
      await act(async () => {
        await harness.controller.actions.applySettingsModel({ ...harness.controller.state.settings.model, folderExpansionEnabled: false });
        await flushEffects();
      });
      await act(async () => { resolve(expansionSnapshot(f.parent.path, [f.child])); await flushEffects(); });
      assert.equal(harness.tab.folderExpansion, undefined);
      assert.deepEqual(harness.interactions.savedSettingsModels.map((model) => model.folderExpansionEnabled), [false]);
    } finally { await harness.close(); }
  });

  await assertTest("copy, cut, delete, paste and drop normalize parent-child selections to top-level sources", async () => {
    const f = expansionFixture();
    const harness = await mount(f.bootstrap, {
      resolveDirectory: async (path) => expansionSnapshot(path, path === f.path ? [f.parent, f.sibling] : [f.child]),
      readSystemFileClipboard: async () => ({ mode: "copy", paths: [f.parent.path, f.child.path] })
    });
    try {
      await toggle(harness, f.parent.path);
      await act(async () => { harness.controller.actions.selectMultipleEntries("panel-1", f.tabId, [f.parent.id, f.child.id]); await flushEffects(); });
      for (const operation of ["copySelection", "cutSelection"] as const) {
        await act(async () => { harness.controller.actions[operation]("panel-1"); await flushEffects(); });
        assert.deepEqual(harness.controller.state.clipboard?.paths, [f.parent.path]);
        assert.deepEqual(harness.interactions.systemClipboardWrites.at(-1)?.paths, [f.parent.path]);
      }
      await act(async () => { await harness.controller.actions.dropEntries([f.parent.path, f.child.path], f.sibling.path, "move"); await flushEffects(); });
      assert.deepEqual(harness.interactions.moveCalls.at(-1)?.paths, [f.parent.path]);
      await act(async () => { harness.controller.actions.pasteIntoPanel("panel-1"); await flushEffects(); });
      assert.deepEqual(harness.interactions.copyCalls.at(-1)?.paths, [f.parent.path]);
      await act(async () => { harness.controller.actions.deleteSelection("panel-1"); await flushEffects(); });
      assert.deepEqual(harness.interactions.deleteCalls.at(-1)?.paths, [f.parent.path]);
    } finally { await harness.close(); }
  });

  for (const kind of ["local", "ftp", "sftp"] as const) {
    await assertTest("collapsing a mixed " + kind + " selection never adds an unselected parent to delete or move", async () => {
      const f = expansionFixture(kind);
      const harness = await mount(f.bootstrap, {
        resolveDirectory: async (path) => expansionSnapshot(path, path === f.path ? [f.parent, f.sibling] : [f.child])
      });
      try {
        await toggle(harness, f.parent.path);
        await act(async () => { harness.controller.actions.selectEntry("panel-1", f.tabId, f.child.id, false); await flushEffects(); });
        await act(async () => { harness.controller.actions.selectEntry("panel-1", f.tabId, f.sibling.id, true); await flushEffects(); });
        await toggle(harness, f.parent.path);
        assert.deepEqual(harness.tab.selectedEntryIds, [f.sibling.id]);
        await act(async () => { harness.controller.actions.cutSelection("panel-1"); await flushEffects(); });
        assert.deepEqual(harness.controller.state.clipboard?.paths, [f.sibling.path]);
        await act(async () => {
          await harness.controller.actions.dropEntries(harness.controller.state.clipboard!.paths, f.parent.path, "move");
          await flushEffects();
        });
        assert.deepEqual(harness.interactions.moveCalls.at(-1)?.paths, [f.sibling.path]);
        await act(async () => { harness.controller.actions.deleteSelection("panel-1"); await flushEffects(); });
        assert.deepEqual(harness.interactions.deleteCalls.at(-1)?.paths, [f.sibling.path]);
      } finally { await harness.close(); }
    });
  }

  for (const enabled of [false, true]) {
    for (const mode of ["copy", "cut"] as const) {
      await assertTest("UNC clipboard and native drag sources stay absolute with expansion " + enabled + " / " + mode, async () => {
        const f = expansionFixture();
        f.bootstrap.settingsModel = { ...f.bootstrap.settingsModel, folderExpansionEnabled: enabled };
        const parent = "\\\\server\\share\\parent";
        const sources = [parent + "\\child.txt", parent];
        const drags: string[][] = [];
        const harness = await mount(f.bootstrap, {
          readSystemFileClipboard: async () => ({ mode, paths: sources }),
          resolveDirectory: async (path) => expansionSnapshot(path, [f.parent, f.sibling])
        }, (gateway) => { gateway.startSystemFileDrag = async (paths) => { drags.push(paths); return null; }; });
        try {
          await act(async () => { harness.controller.actions.pasteIntoPanel("panel-1"); await flushEffects(); });
          const calls = mode === "copy" ? harness.interactions.copyCalls : harness.interactions.moveCalls;
          assert.deepEqual(calls.at(-1), { paths: [parent], destination: f.path });
          await act(async () => { harness.controller.actions.startSystemFileDrag(sources); await flushEffects(); });
          assert.deepEqual(drags, [[parent]]);
          await act(async () => { await harness.controller.actions.dropEntries(sources, f.sibling.path, "copy"); await flushEffects(); });
          assert.deepEqual(harness.interactions.copyCalls.at(-1), { paths: [parent], destination: f.sibling.path });
        } finally { await harness.close(); }
      });
    }
  }

  await assertTest("failed navigation into an expanded remote folder reconnects without the old deep cache", async () => {
    const f = expansionFixture("sftp");
    const leaf = expansionEntry(f.nested.path, "leaf.txt", "file");
    let failNavigation = false;
    const harness = await mount(f.bootstrap, {
      resolveDirectory: async (path) => {
        if (failNavigation && path === f.parent.path) throw new Error("connection refused");
        return expansionSnapshot(path, path === f.parent.path ? [f.nested, f.child] : path === f.nested.path ? [leaf] : [f.parent, f.sibling]);
      }
    });
    try {
      await toggle(harness, f.parent.path);
      await toggle(harness, f.nested.path);
      failNavigation = true;
      await act(async () => { harness.controller.actions.openEntry("panel-1", f.parent); await flushEffects(); });
      await waitFor(() => harness.tab.status === "reconnect-required", "remote navigation did not fail");
      assert.equal(harness.tab.folderExpansion, undefined);
      failNavigation = false;
      await act(async () => { harness.controller.actions.reconnectTab("panel-1", f.tabId); await flushEffects(); });
      await waitFor(() => harness.tab.status === "ready", "remote navigation did not reconnect");
      assert.equal(harness.tab.snapshot.location.path, f.parent.path);
      assert.equal(harness.tab.folderExpansion, undefined);
      assert.equal(getTabEntries(harness.tab).some((entry) => entry.id === leaf.id), false);
      assert.equal(harness.interactions.resolvedPaths.filter((path) => path === f.nested.path).length, 1);
    } finally { await harness.close(); }
  });

  for (const scenario of ["navigate", "refresh", "close", "move", "switch"] as const) {
    await assertTest(`pending folder loads stay isolated through tab ${scenario}`, async () => {
      const f = expansionFixture("sftp");
      f.bootstrap.layoutMode = "dual";
      const spare = { ...f.bootstrap.panels["panel-1"].tabs[0], id: "spare", snapshot: expansionSnapshot(`${f.path}/elsewhere`, []) };
      f.bootstrap.panels["panel-1"].tabs.push(spare);
      const pending: Array<(snapshot: DirectorySnapshot) => void> = [];
      const harness = await mount(f.bootstrap, { resolveDirectory: (path) => path === f.parent.path
        ? new Promise((resolve) => pending.push(resolve)) : Promise.resolve(expansionSnapshot(path, path === f.path ? [f.parent, f.sibling] : [])) });
      try {
        await toggle(harness, f.parent.path);
        await act(async () => {
          if (scenario === "navigate") harness.controller.actions.navigateToPath("panel-1", spare.snapshot.location.path);
          if (scenario === "refresh") harness.controller.actions.refreshPanel("panel-1");
          if (scenario === "close") harness.controller.actions.closeTab("panel-1", f.tabId);
          if (scenario === "move") harness.controller.actions.moveTab("panel-1", "panel-2", f.tabId, 0);
          if (scenario === "switch") harness.controller.actions.activateTab("panel-1", spare.id);
          await flushEffects();
        });
        if (scenario === "move" || scenario === "refresh") {
          assert.equal(pending.length, 2, "new tab/root identity must reschedule the branch");
          await act(async () => { pending[1](expansionSnapshot(f.parent.path, [f.child])); await flushEffects(); });
        }
        await act(async () => { pending[0](expansionSnapshot(f.parent.path, [f.nested])); await flushEffects(); });
        const panels = Object.values(harness.controller.state.panels);
        const target = panels.flatMap((panel) => panel.tabs).find((tab) => tab.snapshot.location.path === f.path);
        if (scenario === "close" || scenario === "navigate") assert.equal(target, undefined);
        if (scenario === "move" || scenario === "refresh") {
          assert.ok(target);
          assert.deepEqual(getFolderBranch(target, f.parent.path)?.entries.map((entry) => entry.id), [f.child.id]);
        }
        if (scenario === "switch") {
          assert.ok(target);
          assert.equal(getFolderBranch(target, f.parent.path)?.status, "ready");
          await act(async () => { harness.controller.actions.activateTab("panel-1", f.tabId); await flushEffects(); });
          assert.equal(pending.length, 1);
          assert.equal(getFolderBranch(harness.tab, f.parent.path)?.status, "ready");
        }
      } finally { await harness.close(); }
    });
  }

  await assertTest("keyboard movement and Enter use the tree's visible preorder", async () => {
    const f = expansionFixture();
    const harness = await mount(f.bootstrap, { resolveDirectory: async (path) => expansionSnapshot(path, path === f.parent.path ? [f.child, f.nested] : []) });
    const key = async (key: string) => act(async () => { window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true })); await flushEffects(); });
    try {
      await toggle(harness, f.parent.path);
      await act(async () => { harness.controller.actions.selectEntry("panel-1", f.tabId, f.parent.id, false); await flushEffects(); });
      await key("ArrowDown");
      assert.deepEqual(harness.tab.selectedEntryIds, [f.nested.id]);
      await key("ArrowDown");
      assert.deepEqual(harness.tab.selectedEntryIds, [f.child.id]);
      await key("Enter");
      assert.deepEqual(harness.interactions.systemOpens, [f.child.path]);
      await act(async () => { harness.controller.actions.selectEntry("panel-1", f.tabId, f.nested.id, false); await flushEffects(); });
      await key("Enter");
      assert.equal(harness.tab.snapshot.location.path, f.nested.path);
      assert.equal(harness.tab.folderExpansion, undefined);
    } finally { await harness.close(); }
  });

  await assertTest("expanded roots reach the watcher manager and watcher/metadata events refresh children", async () => {
    const f = expansionFixture();
    let child = f.child;
    let onFs!: Parameters<WorkspaceGateway["listenFileSystemChanges"]>[0];
    let onMetadata!: Parameters<WorkspaceGateway["listenEntryMetadataChanged"]>[0];
    const harness = await mount(f.bootstrap, {
      resolveDirectory: async (path) => expansionSnapshot(path, path === f.path ? [f.parent, f.sibling] : [child])
    }, (gateway) => {
      gateway.listenFileSystemChanges = async (listener) => { onFs = listener; return () => undefined; };
      gateway.listenEntryMetadataChanged = async (listener) => { onMetadata = listener; return () => undefined; };
    });
    try {
      await toggle(harness, f.parent.path);
      assert.equal(harness.interactions.watchRootUpdates.at(-1)?.directoryPaths.includes(f.parent.path), true);
      child = { ...f.child, comment: "external update" };
      await act(async () => {
        onFs({ roots: [f.parent.path], directoryRoots: [f.parent.path], navigationParentRoots: [], sequence: 1 });
        await new Promise((resolve) => setTimeout(resolve, 400)); await flushEffects();
      });
      assert.equal(getFolderBranch(harness.tab, f.parent.path)?.entries[0]?.comment, "external update");
      child = { ...f.child, tags: ["updated"] };
      await act(async () => { onMetadata([child.path]); await flushEffects(); });
      assert.deepEqual(getFolderBranch(harness.tab, f.parent.path)?.entries[0]?.tags, ["updated"]);
      await toggle(harness, f.parent.path);
      assert.equal(harness.interactions.watchRootUpdates.at(-1)?.directoryPaths.includes(f.parent.path), false);
    } finally { await harness.close(); }
  });

  await assertTest("settings_changed toggles expansion without echo saves or restoring transient branches", async () => {
    const f = expansionFixture();
    let onSettings!: Parameters<WorkspaceGateway["listenSettingsChanged"]>[0];
    const harness = await mount(f.bootstrap, { resolveDirectory: async (path) => expansionSnapshot(path, [f.child]) }, (gateway) => {
      gateway.listenSettingsChanged = async (listener) => { onSettings = listener; return () => undefined; };
    });
    try {
      await toggle(harness, f.parent.path);
      harness.interactions.savedSettingsModels.length = 0;
      for (const enabled of [false, true]) {
        await act(async () => {
          const state = harness.controller.state;
          onSettings({ settingsModel: { ...state.settings.model, folderExpansionEnabled: enabled }, bookmarks: state.bookmarks,
            hotlist: state.hotlist, remoteProfiles: state.remoteProfiles, navigationItems: state.navigation.items });
          await flushEffects();
        });
        assert.equal(harness.controller.state.settings.model.folderExpansionEnabled, enabled);
        assert.equal(harness.tab.folderExpansion, undefined);
      }
      assert.equal(harness.interactions.savedSettingsModels.length, 0);
    } finally { await harness.close(); }
  });

  await assertTest("multi-selection properties remain ready while unrelated branch state changes", async () => {
    const f = expansionFixture();
    f.bootstrap.informationPanel.expanded = true;
    f.bootstrap.informationPanel.activeTab = "properties";
    const harness = await mount(f.bootstrap, { resolveDirectory: async (path) => expansionSnapshot(path, path === f.parent.path ? [f.child, f.nested] : []) });
    try {
      await toggle(harness, f.parent.path);
      await act(async () => { harness.controller.actions.selectMultipleEntries("panel-1", f.tabId, [f.sibling.id, f.nested.id]); await flushEffects(); });
      assert.equal(harness.controller.state.informationPanel.properties.status, "ready");
      await toggle(harness, f.nested.path);
      assert.equal(harness.controller.state.informationPanel.properties.status, "ready");
      assert.equal(harness.controller.state.informationPanel.properties.summary?.count, 2);
    } finally { await harness.close(); }
  });

  await assertTest("a failed same-directory root refresh makes cached expanded children inoperable", async () => {
    const f = expansionFixture();
    const harness = await mount(f.bootstrap, { resolveDirectory: async (path) => {
      if (path === f.path) throw new Error("root access denied");
      return expansionSnapshot(path, [f.child]);
    } });
    try {
      await toggle(harness, f.parent.path);
      await act(async () => { harness.controller.actions.selectEntry("panel-1", f.tabId, f.child.id, false); await flushEffects(); });
      await act(async () => { harness.controller.actions.refreshPanel("panel-1"); await flushEffects(); });
      assert.equal(getTabEntries(harness.tab).some((entry) => entry.path === f.child.path), false);
      assert.equal(harness.tab.selectedEntryIds.includes(f.child.id), false);
      assert.equal(getFolderBranch(harness.tab, f.parent.path)?.status, "error");
      await act(async () => { harness.controller.actions.deleteSelection("panel-1"); await flushEffects(); });
      assert.equal(harness.interactions.deleteCalls.length, 0);
      await toggle(harness, f.parent.path, true);
      assert.equal(getFolderBranch(harness.tab, f.parent.path)?.status, "ready");
    } finally { await harness.close(); }
  });

  await assertTest("quick-filtered or visibility-hidden descendants cannot be deleted from an old selection", async () => {
    const f = expansionFixture();
    f.parent.isHidden = true;
    f.bootstrap.settingsModel.fileVisibility.showHidden = true;
    const harness = await mount(f.bootstrap, { resolveDirectory: async (path) => expansionSnapshot(path, [f.child]) });
    try {
      await toggle(harness, f.parent.path);
      await act(async () => { harness.controller.actions.selectEntry("panel-1", f.tabId, f.child.id, false); await flushEffects(); });
      await act(async () => { harness.controller.actions.updateSearchFilter("sibling"); await flushEffects(); });
      await act(async () => { harness.controller.actions.deleteSelection("panel-1"); await flushEffects(); });
      assert.equal(harness.interactions.deleteCalls.length, 0);
      await act(async () => {
        harness.controller.actions.updateSearchFilter("");
        harness.controller.actions.setFileVisibility({ showHidden: false });
        await flushEffects();
      });
      await act(async () => { harness.controller.actions.deleteSelection("panel-1"); await flushEffects(); });
      assert.equal(harness.interactions.deleteCalls.length, 0);
      assert.equal(harness.interactions.watchRootUpdates.at(-1)?.directoryPaths.includes(f.parent.path), false);
    } finally { await harness.close(); }
  });

  await assertTest("hiding a selected child then collapsing its visible parent never creates a new delete target", async () => {
    const f = expansionFixture();
    f.child.isHidden = true;
    f.bootstrap.settingsModel.fileVisibility.showHidden = true;
    const harness = await mount(f.bootstrap, { resolveDirectory: async (path) => expansionSnapshot(path, [f.child]) });
    try {
      await toggle(harness, f.parent.path);
      await act(async () => { harness.controller.actions.selectEntry("panel-1", f.tabId, f.child.id, false); await flushEffects(); });
      await act(async () => { harness.controller.actions.setFileVisibility({ showHidden: false }); await flushEffects(); });
      await act(async () => { harness.controller.actions.deleteSelection("panel-1"); await flushEffects(); });
      assert.equal(harness.interactions.deleteCalls.length, 0);
      await toggle(harness, f.parent.path);
      assert.deepEqual(harness.tab.selectedEntryIds, []);
      await act(async () => { harness.controller.actions.deleteSelection("panel-1"); await flushEffects(); });
      assert.equal(harness.interactions.deleteCalls.length, 0);
    } finally { await harness.close(); }
  });
})();

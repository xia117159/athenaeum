import assert from "node:assert/strict";
import React, { act } from "react";
import type { FileAssociationRule } from "../../app/fileAssociations";
import { createMockWorkspaceBootstrap } from "./mockData";
import { mergeBootstrapWithSession } from "./workspaceBootstrapSession";
import { createTestGateway, flushEffects, installDomEnvironment, waitFor } from "./workspaceControllerTestHarness";
import { normalizeSettingsModel } from "./workspaceMappers";
import { toPersistedSession, type PersistedWorkspaceSession } from "./workspaceSessionStore";
import type { WorkspaceGateway } from "./workspaceGateway";

export const completion = (async () => {
  const dom = installDomEnvironment();
  const closeDom = dom.window.close.bind(dom.window);
  const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");
  const controller = require("./useWorkspaceController") as typeof import("./useWorkspaceController");
  const originalController = controller.useWorkspaceController;
  const base = createMockWorkspaceBootstrap("tauri");
  base.settingsModel = normalizeSettingsModel({ ...base.settingsModel, fileAssociations: [] });
  let backendModel = structuredClone(base.settingsModel);
  let cachedSession: PersistedWorkspaceSession | null = null;
  const readSession = () => { assert.ok(cachedSession); return cachedSession; };
  const listeners = new Set<Parameters<WorkspaceGateway["listenSettingsChanged"]>[0]>();
  const savedRules: FileAssociationRule[][] = [];
  let rejectNextSave = false;
  const gateway = createTestGateway(() => undefined, {
    resolvedPaths: [], copyCalls: [], moveCalls: [], deleteCalls: [], renameCalls: [],
    createDirectoryCalls: [], createFileCalls: [], treeLoadPaths: [], savedDetailsRowHeights: [], nativeContextMenus: []
  }, {
    loadBootstrap: async () => mergeBootstrapWithSession(
      { ...structuredClone(base), settingsModel: structuredClone(backendModel) }, cachedSession, [],
      async () => base.panels["panel-1"].tabs[0].snapshot
    )
  });
  gateway.saveSession = async state => { cachedSession = structuredClone(toPersistedSession(state)); };
  gateway.listenSettingsChanged = async handler => {
    listeners.add(handler);
    return () => { listeners.delete(handler); };
  };
  const broadcast = () => {
    const payload = {
      settingsModel: structuredClone(backendModel), bookmarks: base.bookmarks, hotlist: base.hotlist,
      remoteProfiles: base.remoteProfiles, navigationItems: base.navigationItems
    };
    for (const handler of [...listeners]) handler(payload);
  };
  gateway.saveSettingsModel = async model => {
    if (rejectNextSave) { rejectNextSave = false; throw new Error("association save rejected"); }
    backendModel = structuredClone(model);
    savedRules.push(structuredClone(model.fileAssociations ?? []));
    broadcast();
  };
  gateway.inspectAssociationPrograms = async () => [];
  let main!: ReturnType<typeof originalController>;
  function Main() { main = originalController(gateway); return null; }
  // Inject only the gateway; both windows retain the production controller and reducer.
  controller.useWorkspaceController = (_gateway, options) => originalController(gateway, options);
  const { SettingsWindowView } = require("./SettingsWindowView") as typeof import("./SettingsWindowView");
  const mainContainer = document.createElement("div");
  const settingsContainer = document.createElement("div");
  document.body.append(mainContainer, settingsContainer);
  const mainRoot = createRoot(mainContainer);
  const settingsRoot = createRoot(settingsContainer);
  let closeCount = 0;
  dom.window.close = () => { closeCount++; };
  dom.window.history.replaceState(null, "", "/?view=settings&section=file-associations");
  const tick = async (action: () => void) => act(async () => { action(); await flushEffects(); });
  const button = (label: string) => {
    const found = [...settingsContainer.querySelectorAll("button")].find(item => item.textContent?.trim() === label);
    assert.ok(found, label);
    return found;
  };
  const openSettings = async (key: string) => {
    await tick(() => settingsRoot.render(<SettingsWindowView key={key} />));
    await waitFor(() => settingsContainer.querySelector<HTMLButtonElement>('[data-action="association-add"]')?.disabled === false,
      "settings bootstrap must complete");
  };
  const addRule = async (expression: string) => {
    await tick(() => button("新建").click());
    const input = settingsContainer.querySelector<HTMLInputElement>('[aria-label="关联表达式"]');
    assert.ok(input);
    await tick(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, expression);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    const id = input.closest<HTMLElement>("[data-rule-id]")?.dataset.ruleId;
    assert.ok(id);
    return id;
  };
  try {
    await tick(() => mainRoot.render(<Main />));
    await waitFor(() => main?.state.status === "ready", "main bootstrap must complete");
    await openSettings("new");
    const id = await addRule(String.raw`*.txt; .md > "C:\Program Files\编辑器.exe" --new-window "{file}"`);
    const expected: FileAssociationRule[] = [{ id, patterns: "*.txt;.md", executablePath: String.raw`C:\Program Files\编辑器.exe`, argumentsTemplate: '--new-window "{file}"' }];
    const beforeConfirm = savedRules.length;
    await tick(() => button("确定").click());
    await waitFor(() => closeCount === 1, "successful confirmation closes settings");
    assert.deepEqual(backendModel.fileAssociations, expected);
    assert.deepEqual(main.state.settings.model.fileAssociations, expected, "main must receive association-only changes");
    assert.deepEqual(readSession().settingsModel.fileAssociations, expected, "main must update the session");
    assert.deepEqual(savedRules.slice(beforeConfirm), [expected], "notification must not echo a full-model save");
    assert.equal(settingsContainer.querySelector('[role="alert"]'), null);

    await tick(() => settingsRoot.render(null));
    // An old session can already exist before upgrading; do not rely solely on live synchronization.
    readSession().settingsModel.fileAssociations = [];
    await openSettings("reopened");
    assert.equal(settingsContainer.querySelectorAll("[data-rule-id]").length, 1);
    assert.equal(settingsContainer.querySelector<HTMLElement>("[data-rule-id]")?.dataset.ruleId, id);
    assert.ok(settingsContainer.textContent?.includes(expected[0].executablePath));
    assert.deepEqual(backendModel.fileAssociations, expected, "reopening must not erase backend rules");
    assert.ok(savedRules.slice(beforeConfirm).every(rules => JSON.stringify(rules) === JSON.stringify(expected)),
      "every subsequent save must preserve complete rule content");
    await tick(() => settingsRoot.render(null));

    const second: FileAssociationRule = { ...expected[0], id: "second", patterns: "json", argumentsTemplate: "" };
    for (const rules of [[...expected, second], [second, ...expected], [{ ...second, argumentsTemplate: "--reuse {file}" }], []]) {
      const beforeNotification = savedRules.length;
      await tick(() => { backendModel = { ...backendModel, fileAssociations: rules }; broadcast(); });
      assert.deepEqual(main.state.settings.model.fileAssociations, rules, "replacement, ordering and deletion must synchronize");
      assert.deepEqual(readSession().settingsModel.fileAssociations, rules);
      assert.equal(savedRules.length, beforeNotification, "incoming rules must not trigger a full-model save");
    }
    const beforeLocalChange = savedRules.length;
    await tick(() => main.actions.setFileVisibility({ showHidden: !main.state.fileVisibility.showHidden }));
    assert.equal(savedRules.length, beforeLocalChange + 1, "the next local change must not be skipped");
    assert.equal(backendModel.fileVisibility.showHidden, main.state.fileVisibility.showHidden);
    assert.deepEqual(backendModel.fileAssociations, []);

    readSession().settingsModel.fileAssociations = expected;
    await openSettings("after-delete");
    assert.equal(settingsContainer.querySelectorAll("[data-rule-id]").length, 0, "deleted rules must not return from cache");
    const draftId = await addRule(String.raw`txt > C:\editor.exe`);
    const beforeFailure = savedRules.length;
    rejectNextSave = true;
    await tick(() => button("确定").click());
    assert.equal(closeCount, 1, "save failure must leave settings open");
    assert.ok(settingsContainer.textContent?.includes("association save rejected"));
    assert.equal(settingsContainer.querySelector<HTMLElement>("[data-rule-id]")?.dataset.ruleId, draftId);
    assert.deepEqual(backendModel.fileAssociations, []);
    assert.deepEqual(main.state.settings.model.fileAssociations, []);
    assert.equal(savedRules.length, beforeFailure);
    await tick(() => button("取消").click());
    assert.equal(closeCount, 2);
    assert.deepEqual(backendModel.fileAssociations, []);
    console.log("ok - associations survive confirmation, cross-window sync and stale sessions; failures retain drafts");
  } finally {
    await tick(() => { settingsRoot.unmount(); mainRoot.unmount(); });
    controller.useWorkspaceController = originalController;
    mainContainer.remove();
    settingsContainer.remove();
    closeDom();
  }
})();

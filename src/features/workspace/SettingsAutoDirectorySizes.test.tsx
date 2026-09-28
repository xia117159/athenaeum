import assert from "node:assert/strict";
import React, { act } from "react";
import { createMockWorkspaceBootstrap } from "./mockData";
import { createWorkspaceState } from "./workspaceReducer";
import { flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { SettingsModel, WorkspaceState } from "./types";

export const completion = (async () => {
  const dom = installDomEnvironment();
  dom.window.close = () => undefined;
  const ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  const controller = require("./useWorkspaceController") as typeof import("./useWorkspaceController");
  const original = controller.useWorkspaceController;
  let state: WorkspaceState = createWorkspaceState(createMockWorkspaceBootstrap("tauri"));
  dom.window.history.replaceState(null, "", "/?view=settings&section=file-associations");
  state.settings.model.fileAssociations = [{ id: "saved", patterns: "md", executablePath: "C:\\editor.exe", argumentsTemplate: "" }];
  state.settings.model.autoDirectorySizePaths = ["D:\\A"];
  const persist = (paths: string[]) => {
    state = { ...state, settings: { ...state.settings, model: { ...state.settings.model, autoDirectorySizePaths: paths } } };
    return paths;
  };
  const saved: SettingsModel[] = [];
  const commands: string[] = [];
  controller.useWorkspaceController = (() => ({ state, actions: {
    applySettingsModel: async (model: SettingsModel) => { saved.push(structuredClone(model)); },
    validateColorRule: async () => ({ valid: true, message: null, span: null }),
    chooseAssociationProgram: async () => null,
    inspectAssociationPrograms: async () => [],
    addAutoDirectorySizePath: async (path: string) => { commands.push(`add:${path}`); return persist([...state.settings.model.autoDirectorySizePaths ?? [], path]); },
    removeAutoDirectorySizePath: async (path: string) => { commands.push(`remove:${path}`); return persist((state.settings.model.autoDirectorySizePaths ?? []).filter((item) => item !== path)); },
    chooseAutoDirectorySizeFolder: async () => null
  } })) as unknown as typeof original;
  const { SettingsWindowView } = require("./SettingsWindowView") as typeof import("./SettingsWindowView");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  const tick = async (action: () => void) => act(async () => { action(); await flushEffects(); });
  const view = () => <SettingsWindowView key="auto" />;
  const button = (text: string) => [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === text)!;
  const setValue = (input: HTMLInputElement, value: string) => tick(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const rows = () => [...container.querySelectorAll<HTMLElement>('[aria-label="自动计算大小的文件夹"] [role="option"]')].map((row) => row.textContent);
  const nav = (id: string) => container.querySelector<HTMLButtonElement>(`[data-section-id="${id}"]`)!;
  try {
    await tick(() => root.render(view()));
    // Leave an unsaved draft in another section first.
    await tick(() => button("编辑").click());
    await setValue(container.querySelector<HTMLInputElement>('[aria-label="关联表达式"]')!, "txt > C:\\other.exe");
    assert.ok(nav("file-associations").querySelector(".settings-window__nav-dirty"));

    assert.ok(nav("auto-directory-sizes"), "the page sits in the settings navigation");
    assert.equal(nav("auto-directory-sizes").textContent?.includes("自动计算大小"), true);
    await tick(() => nav("auto-directory-sizes").click());
    assert.deepEqual(rows(), ["D:\\A"]);

    // An edit from the main window (settings_changed) shows up while the other draft stays dirty.
    persist(["D:\\A", "E:\\Media"]);
    await tick(() => root.render(view()));
    assert.deepEqual(rows(), ["D:\\A", "E:\\Media"]);
    assert.ok(nav("file-associations").querySelector(".settings-window__nav-dirty"), "other drafts are kept");

    // The page itself saves through the dedicated command immediately.
    await setValue(container.querySelector<HTMLInputElement>('[aria-label="要自动计算大小的文件夹路径"]')!, "f:/x");
    await tick(() => button("添加").click());
    await tick(() => root.render(view()));
    assert.deepEqual(commands, ["add:F:\\x"]);
    assert.deepEqual(rows(), ["D:\\A", "E:\\Media", "F:\\x"]);
    assert.equal(nav("auto-directory-sizes").querySelector(".settings-window__nav-dirty"), null, "the list is never a draft");

    // Saving the other section does not carry a stale list.
    await tick(() => button("确定").click());
    assert.equal(saved.length, 1);
    assert.equal(saved[0].fileAssociations?.[0].patterns, "txt");
    assert.deepEqual(saved[0].autoDirectorySizePaths, ["D:\\A", "E:\\Media", "F:\\x"]);
    console.log("ok - settings window edits the automatic size list immediately and keeps other drafts");
  } finally {
    await tick(() => root.unmount());
    controller.useWorkspaceController = original;
    container.remove();
  }
})();

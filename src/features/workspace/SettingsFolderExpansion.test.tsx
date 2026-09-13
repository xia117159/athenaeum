import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { createWorkspaceState } from "./workspaceReducer";
import { expansionFixture } from "./folderExpansionTestSupport";
import { assertTest, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { SettingsModel } from "./types";

export const completion = (async () => {
  const dom = installDomEnvironment();
  dom.window.close = () => undefined;
  const controllerModule = require("./useWorkspaceController") as typeof import("./useWorkspaceController");
  const originalController = controllerModule.useWorkspaceController;
  const state = createWorkspaceState(expansionFixture().bootstrap);
  state.settings.section = "file-list";
  state.settings.model.folderExpansionEnabled = false;
  const saved: SettingsModel[] = [];
  controllerModule.useWorkspaceController = (() => ({ state, actions: {
    applySettingsModel: async (model: SettingsModel) => { saved.push(model); },
    validateColorRule: async () => ({ valid: true, message: null, span: null })
  } })) as unknown as typeof originalController;
  const { SettingsWindowView } = require("./SettingsWindowView") as typeof import("./SettingsWindowView");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  const render = async (key: string) => act(async () => { root.render(<SettingsWindowView key={key} />); await flushEffects(); });
  const checkbox = () => {
    const element = container.querySelector<HTMLInputElement>('[data-setting-id="folder-expansion-enabled"]');
    assert.ok(element, "文件列表设置应提供原地展开文件夹开关");
    return element;
  };
  const click = async (element: HTMLElement) => act(async () => { element.click(); await flushEffects(); });
  const button = (text: string) => {
    const element = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
    assert.ok(element);
    return element;
  };
  try {
    await assertTest("folder expansion setting stays in the draft until Confirm and marks File List dirty", async () => {
      await render("confirm");
      assert.equal(checkbox().checked, false);
      await click(checkbox());
      assert.equal(checkbox().checked, true);
      assert.equal(state.settings.model.folderExpansionEnabled, false);
      assert.equal(saved.length, 0);
      assert.ok(container.querySelector('[data-section-id="file-list"] .settings-window__nav-dirty'));
      await click(button("确定"));
      assert.deepEqual(saved.map((model) => model.folderExpansionEnabled), [true]);
    });
    await assertTest("Cancel discards folder expansion draft and opening settings preserves persisted true", async () => {
      saved.length = 0;
      state.settings.model.folderExpansionEnabled = true;
      await render("cancel");
      assert.equal(checkbox().checked, true);
      await click(checkbox());
      assert.equal(checkbox().checked, false);
      await click(button("取消"));
      assert.equal(saved.length, 0);
      assert.equal(state.settings.model.folderExpansionEnabled, true);
    });
  } finally {
    await act(async () => { root.unmount(); await flushEffects(); });
    container.remove();
    controllerModule.useWorkspaceController = originalController;
  }
})();

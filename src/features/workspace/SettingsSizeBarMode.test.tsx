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
  const click = async (element: HTMLElement) => act(async () => { element.click(); await flushEffects(); });
  const mode = () => {
    const element = container.querySelector<HTMLButtonElement>('[data-setting-id="size-bar-mode-folder-max"]');
    assert.ok(element);
    return element;
  };
  try {
    await assertTest("file-list exposes size-bar mode as a segmented draft setting", async () => {
      await render("confirm");
      const total = container.querySelector<HTMLButtonElement>('[data-setting-id="size-bar-mode-folder-total"]');
      assert.ok(total);
      assert.equal(total.getAttribute("aria-pressed"), "true");
      await click(mode());
      assert.equal(mode().getAttribute("aria-pressed"), "true");
      assert.ok(container.querySelector('[data-section-id="file-list"] .settings-window__nav-dirty'));
      assert.equal(state.settings.model.sizeBarMode, "folder-total");
      await click(container.querySelector<HTMLButtonElement>('[data-action="confirm-settings"]')!);
      assert.equal(saved.at(-1)?.sizeBarMode, "folder-max");
    });
    await assertTest("cancel keeps the persisted total mode", async () => {
      saved.length = 0;
      await render("cancel");
      await click(mode());
      await click(container.querySelector<HTMLButtonElement>('.settings-window__footer .toolbar-button--ghost')!);
      assert.equal(saved.length, 0);
      assert.equal(state.settings.model.sizeBarMode, "folder-total");
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    controllerModule.useWorkspaceController = originalController;
  }
})();

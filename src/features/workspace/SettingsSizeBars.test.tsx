import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { createWorkspaceState } from "./workspaceReducer";
import { expansionFixture } from "./folderExpansionTestSupport";
import { assertTest, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { SettingsModel } from "./types";

export const completion = (async () => {
  const dom = installDomEnvironment(); dom.window.close = () => undefined;
  Object.defineProperty(globalThis, "self", { configurable: true, value: dom.window });
  const controllerModule = require("./useWorkspaceController") as typeof import("./useWorkspaceController");
  const original = controllerModule.useWorkspaceController;
  const state = createWorkspaceState(expansionFixture().bootstrap); state.settings.section = "appearance";
  const saved: SettingsModel[] = [];
  controllerModule.useWorkspaceController = ((_gateway, options) => {
    assert.equal(options?.role, "settings");
    return { state, actions: { applySettingsModel: async (model: SettingsModel) => { saved.push(model); },
      validateColorRule: async () => ({ valid: true, message: null, span: null }) } } as unknown as ReturnType<typeof original>;
  });
  const { SettingsWindowView } = require("./SettingsWindowView") as typeof import("./SettingsWindowView");
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  const render = async (key: string) => act(async () => { root.render(<SettingsWindowView key={key} />); await flushEffects(); });
  const click = async (element: HTMLElement) => act(async () => { element.click(); await flushEffects(); });
  const button = (label: string) => {
    const item = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label); assert.ok(item); return item;
  };
  const input = async (id: string, value: string) => {
    const control = container.querySelector<HTMLInputElement>(`[data-setting-id="${id}"]`); assert.ok(control);
    await act(async () => { control.value = value; control.dispatchEvent(new dom.window.Event("input", { bubbles: true })); await flushEffects(); });
  };
  try {
    await assertTest("appearance exposes two size-bar endpoints with opacity; Confirm persists the draft only", async () => {
      await render("confirm");
      const low = container.querySelector<HTMLButtonElement>('[data-setting-id="size-bar-low"]'); assert.ok(low);
      await click(low); await input("size-bar-low-hex", "#ABCDEF80");
      assert.equal(saved.length, 0); assert.equal(state.settings.model.theme.sizeBarLow, "#dceaf7");
      const high = container.querySelector<HTMLButtonElement>('[data-setting-id="size-bar-high"]'); assert.ok(high);
      await click(high); await input("size-bar-high-opacity", "25");
      assert.ok(container.querySelector('[data-section-id="appearance"] .settings-window__nav-dirty'));
      await click(button("确定"));
      assert.equal(saved[0].theme.sizeBarLow, "#abcdef80");
      assert.equal(saved[0].theme.sizeBarHigh, "#3979b740");
    });
    await assertTest("Cancel discards size-bar edits and restores stored endpoints on reopening", async () => {
      saved.length = 0; await render("cancel");
      await click(container.querySelector<HTMLButtonElement>('[data-setting-id="size-bar-low"]')!);
      await input("size-bar-low-hex", "#ffffff00");
      await click(button("取消"));
      assert.equal(saved.length, 0); assert.equal(state.settings.model.theme.sizeBarLow, "#dceaf7");
      await render("reopen");
      assert.match(container.querySelector<HTMLButtonElement>('[data-setting-id="size-bar-low"]')?.title ?? "", /^#dceaf7/);
    });
  } finally { await act(async () => root.unmount()); container.remove(); controllerModule.useWorkspaceController = original; }
})();

import assert from "node:assert/strict";
import React, { act } from "react";
import { createMockWorkspaceBootstrap } from "./mockData";
import { createWorkspaceState } from "./workspaceReducer";
import { flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { SettingsModel } from "./types";
import { defaultSettingsNavigationRuntime } from "./settingsNavigation";

export const completion = (async () => {
  const dom = installDomEnvironment(); dom.window.close = () => {};
  const scrollTargets: string[] = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function () { scrollTargets.push(this.id); };
  const ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  const controller = require("./useWorkspaceController") as typeof import("./useWorkspaceController");
  const original = controller.useWorkspaceController;
  const state = createWorkspaceState(createMockWorkspaceBootstrap("tauri"));
  state.settings.model.templateRoot = "C:\\Templates";
  dom.window.history.replaceState(null, "", "/?view=settings&section=templates");
  const saved: SettingsModel[] = [];
  let picked: string | null = null;
  controller.useWorkspaceController = (() => ({ state, actions: {
    applySettingsModel: async (model: SettingsModel) => { saved.push(structuredClone(model)); },
    validateColorRule: async () => ({ valid: true, message: null, span: null }),
    chooseTemplateRoot: async () => picked
  } })) as unknown as typeof original;
  const { SettingsWindowView } = require("./SettingsWindowView") as typeof import("./SettingsWindowView");
  const root = ReactDOM.createRoot(document.getElementById("root")!);
  const tick = async (fn: () => void) => act(async () => { fn(); await flushEffects(); });
  const button = (text: string) => {
    const result = [...document.querySelectorAll("button")].find(item => item.textContent?.trim() === text);
    assert.ok(result, text); return result;
  };
  const input = () => { const result = document.querySelector<HTMLInputElement>('[aria-label="模板文件夹"]'); assert.ok(result); return result; };
  try {
    await tick(() => root.render(<SettingsWindowView key="apply" />));
    assert.ok(document.querySelector('[data-section-id="general"].is-active'), "settings deep link");
    assert.equal(scrollTargets.at(-1), "settings-group-templates");
    const initialScrollCount = scrollTargets.length;
    await tick(() => {
      defaultSettingsNavigationRuntime.write({ id: "repeat-template-navigation", section: "templates" });
      dom.window.dispatchEvent(new dom.window.Event("storage"));
    });
    assert.equal(scrollTargets.length, initialScrollCount + 1, "a new request for the same section repositions it");
    assert.equal(input().value, "C:\\Templates");
    await tick(() => button("选择文件夹").click());
    assert.equal(input().value, "C:\\Templates", "picker cancellation keeps draft");
    picked = "D:\\我的模板";
    await tick(() => button("选择文件夹").click());
    assert.equal(input().value, picked);
    assert.ok(document.querySelector('[data-section-id="general"] .settings-window__nav-dirty'));
    assert.equal(scrollTargets.length, initialScrollCount + 1, "editing does not reset scroll");
    assert.equal(state.settings.model.templateRoot, "C:\\Templates", "editing never publishes drafts");
    await tick(() => button("确定").click());
    assert.equal(saved[0].templateRoot, picked);
    saved.length = 0;
    await tick(() => root.render(<SettingsWindowView key="cancel" />));
    await tick(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input(), "D:\\Manual");
      input().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(input().value, "D:\\Manual");
    await tick(() => button("取消").click()); assert.equal(saved.length, 0);
    console.log("ok - template settings navigate, choose, cancel, edit and apply through the existing draft model");
  } finally { await tick(() => root.unmount()); controller.useWorkspaceController = original; }
})();

import assert from "node:assert/strict";
import React, { act } from "react";
import { createMockWorkspaceBootstrap } from "./mockData";
import { createWorkspaceState } from "./workspaceReducer";
import { flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { SettingsModel } from "./types";

export const completion = (async () => {
  const dom = installDomEnvironment();
  dom.window.close = () => undefined;
  const ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  const controller = require("./useWorkspaceController") as typeof import("./useWorkspaceController");
  const original = controller.useWorkspaceController;
  const state = createWorkspaceState(createMockWorkspaceBootstrap("tauri"));
  state.settings.section = "appearance";
  dom.window.history.replaceState(null, "", "/?view=settings&section=file-associations");
  state.settings.model.fileAssociations = [{id:"saved", patterns:"md", executablePath:"C:\\editor.exe", argumentsTemplate:""}];
  const saved: SettingsModel[] = [];
  controller.useWorkspaceController = (() => ({state, actions:{
    applySettingsModel: async (model: SettingsModel) => { saved.push(structuredClone(model)); },
    validateColorRule: async () => ({valid:true, message:null, span:null}),
    chooseAssociationProgram: async () => null,
    inspectAssociationPrograms: async () => []
  }})) as unknown as typeof original;
  const { SettingsWindowView } = require("./SettingsWindowView") as typeof import("./SettingsWindowView");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  const tick = async (action: () => void) => act(async () => {action(); await flushEffects();});
  const button = (text: string) => {
    const found = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === text);
    assert.ok(found, text);
    return found;
  };
  const typeExpression = async (value: string) => {
    await tick(() => button("编辑").click());
    const input = container.querySelector<HTMLInputElement>('[aria-label="关联表达式"]')!;
    assert.ok(input);
    await tick(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,"value")!.set!.call(input,value);
      input.dispatchEvent(new dom.window.Event("input",{bubbles:true}));
    });
  };
  try {
    await tick(() => root.render(<SettingsWindowView key="confirm" />));
    assert.ok(container.querySelector('[data-section-id="file-associations"]'), "General navigation entry");
    await typeExpression(String.raw`*.md; .json;txt > "D:\Program Files (x86)\中文编辑器.exe" --new-window "{file}"`);
    assert.ok(container.querySelector('[data-section-id="file-associations"] .settings-window__nav-dirty'));
    assert.equal(state.settings.model.fileAssociations[0].patterns, "md");
    await tick(() => button("确定").click());
    assert.equal(saved.length, 1, "confirm must include the currently focused inline input");
    assert.equal(saved[0].fileAssociations?.[0].patterns, "*.md;.json;txt");
    assert.equal(saved[0].fileAssociations?.[0].executablePath, String.raw`D:\Program Files (x86)\中文编辑器.exe`);
    assert.equal(saved[0].fileAssociations?.[0].argumentsTemplate, '--new-window "{file}"');

    saved.length = 0;
    await tick(() => root.render(<SettingsWindowView key="no-arguments" />));
    await typeExpression(String.raw`txt > "D:\Program Files\中文编辑器.exe"`);
    await tick(() => button("确定").click());
    assert.equal(saved.length, 1);
    assert.equal(saved[0].fileAssociations?.[0].argumentsTemplate, "", "saving a program without any parameters needs no placeholder");

    saved.length = 0;
    await tick(() => root.render(<SettingsWindowView key="no-placeholder" />));
    await typeExpression(String.raw`txt > C:\Editor\editor.exe --new-window`);
    await tick(() => button("确定").click());
    assert.equal(saved.length, 1);
    assert.equal(saved[0].fileAssociations?.[0].argumentsTemplate, "--new-window");

    saved.length = 0;
    await tick(() => root.render(<SettingsWindowView key="cancel" />));
    await typeExpression("txt > C:\\other.exe");
    await tick(() => button("取消").click());
    assert.equal(saved.length, 0);
    assert.equal(state.settings.model.fileAssociations[0].patterns, "md");

    await tick(() => root.render(<SettingsWindowView key="invalid" />));
    await typeExpression("*.? > C:\\other.exe");
    await tick(() => button("确定").click());
    assert.equal(saved.length, 0);
    assert.ok(container.textContent?.includes("后缀格式无效"));

    await tick(() => root.render(<SettingsWindowView key="invalid-path-quote" />));
    const unfinishedPath = String.raw`txt > "C:\Program Files\editor.exe`;
    await typeExpression(unfinishedPath);
    await tick(() => button("确定").click());
    assert.equal(saved.length, 0);
    assert.ok(container.textContent?.includes("引号"));
    await tick(() => {
      const navigation = container.querySelector<HTMLButtonElement>('[data-section-id="appearance"]')!;
      navigation.focus(); navigation.click();
    });
    await tick(() => container.querySelector<HTMLButtonElement>('[data-section-id="file-associations"]')!.click());
    assert.ok(container.querySelector('[role="option"]')?.textContent?.includes(unfinishedPath), "invalid path draft survives section unmount");
    await tick(() => button("确定").click());
    assert.equal(saved.length, 0);

    await tick(() => root.render(<SettingsWindowView key="invalid-argument-quote" />));
    await typeExpression(String.raw`txt > C:\Editor\editor.exe --title "unfinished`);
    await tick(() => button("确定").click());
    assert.equal(saved.length, 0);
    assert.ok(container.textContent?.includes("参数中的双引号未闭合"));

    await tick(() => root.render(<SettingsWindowView key="repeated-path-quotes" />));
    const repeatedQuotes = String.raw`txt > ""C:\Editor\editor.exe""`;
    await typeExpression(repeatedQuotes);
    await tick(() => {
      const navigation = container.querySelector<HTMLButtonElement>('[data-section-id="appearance"]')!;
      navigation.focus(); navigation.click();
    });
    await tick(() => container.querySelector<HTMLButtonElement>('[data-section-id="file-associations"]')!.click());
    await tick(() => button("确定").click());
    assert.equal(saved.length, 0, "malformed quotes stay invalid after blur, a section change and confirmation");
    assert.ok(container.querySelector('[role="option"]')?.textContent?.includes(repeatedQuotes));
    console.log("ok - actual settings window commits current raw association draft, validates and cancels");
  } finally {
    await tick(() => root.unmount());
    controller.useWorkspaceController = original;
    container.remove();
  }
})();

import assert from "node:assert/strict";
import React, { act } from "react";
import { TemplateCreationMenu, type TemplateCreationMenuProps } from "./TemplateCreationMenu";
import type { TemplateMenuState } from "./templateCreationState";
import { flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";

export const completion = (async () => {
  const dom = installDomEnvironment();
  const ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  const initial: TemplateMenuState = { id: "test", settingsRoot: "C:\\Templates", rootPath: "C:\\Templates",
    target: { panelId: "panel-1", tabId: "tab", rootPath: "C:\\target", selectionRevision: 0 },
    levels: [{ relativePath: "", anchor: { x: 400, y: 200 } }], directories: {}, selected: [] };
  let closed = 0;
  const actions: TemplateCreationMenuProps["actions"] = {
    openTemplateMenu() {}, closeTemplateMenu() { closed++; }, toggleTemplateItem() {}, activateTemplateItem() {},
    expandTemplateDirectory() {}, collapseTemplateDirectory() {}, createSelectedTemplates() {},
    refreshTemplateMenu() {}, openTemplateSettings() {}
  };
  const root = ReactDOM.createRoot(document.getElementById("root")!);
  const tick = async (fn: () => void) => act(async () => { fn(); await flushEffects(); });
  try {
    for (const status of ["unconfigured", "loading", "error", "ready"] as const) {
      const menu: TemplateMenuState = { ...initial, id: status, rootPath: status === "unconfigured" ? "" : initial.rootPath,
        directories: status === "unconfigured" ? {} : { "": { status, entries: [], error: status === "error" ? "模板文件夹无法访问" : undefined } } };
      await tick(() => root.render(<TemplateCreationMenu key={status} menu={menu} actions={actions} />));
      assert.ok(!document.querySelector(".template-menu__footer"), "no selections means no fixed action area");
      for (const removed of ["创建所选（0）", "刷新模板", "返回上一级", "打开新建项目设置"]) {
        assert.ok(!document.querySelector(".template-menu")!.textContent?.includes(removed), removed);
      }
      if (status === "error") assert.match(document.querySelector('[role="alert"]')!.textContent!, /无法访问/);
      if (status === "loading") assert.match(document.querySelector('[role="status"]')!.textContent!, /正在读取/);
      if (status === "ready") assert.match(document.querySelector(".template-menu__body")!.textContent!, /没有模板/);
      if (status === "unconfigured") assert.match(document.querySelector(".template-menu__body")!.textContent!, /尚未设置/);
      const panel = document.querySelector<HTMLElement>(".template-menu")!;
      assert.ok(document.activeElement === panel, "an empty menu remains a keyboard target");
      await tick(() => panel.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
      assert.ok(document.activeElement === panel, "Tab does not focus removed actions");
    }
    let propagated = 0;
    const onKey = () => { propagated++; }; window.addEventListener("keydown", onKey);
    await tick(() => document.querySelector(".template-menu")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    window.removeEventListener("keydown", onKey); assert.equal(propagated, 0); assert.equal(closed, 1);
    await tick(() => document.body.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true })));
    assert.equal(closed, 2);
    console.log("ok - template empty/loading/error states remain informative and keyboard accessible without extra menu actions");
  } finally { await tick(() => root.unmount()); }
})();

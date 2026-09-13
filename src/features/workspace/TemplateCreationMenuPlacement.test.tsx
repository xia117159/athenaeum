import assert from "node:assert/strict";
import React, { act } from "react";
import { TemplateCreationMenu, type TemplateCreationMenuProps } from "./TemplateCreationMenu";
import type { TemplateMenuState } from "./templateCreationState";
import { flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";

export const completion = (async () => {
  const dom = installDomEnvironment(), ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  const previous = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const panel = this.closest<HTMLElement>(".template-menu"), isRow = this.classList.contains("template-menu__row");
    if (!panel) return previous.call(this);
    const left = Number.parseFloat(panel.style.left || "0") + (isRow ? 4 : 0), top = 100;
    return new dom.window.DOMRect(left, top, isRow ? 292 : 300, isRow ? 28 : 380);
  };
  const folder = { name: "Word", relativePath: "Word", path: "C:\\Templates\\Word", kind: "directory" as const };
  const nested = { ...folder, name: "Specs", relativePath: "Word/Specs", path: "C:\\Templates\\Word\\Specs" };
  const menu: TemplateMenuState = { id: "placement", rootPath: "C:\\Templates", settingsRoot: "C:\\Templates", selected: [],
    target: { panelId: "panel-1", tabId: "tab", rootPath: "D:\\Target", selectionRevision: 0 },
    directories: { "": { status: "ready", entries: [folder] }, word: { status: "ready", entries: [nested] }, "word/specs": { status: "ready", entries: [] } },
    levels: [{ relativePath: "", anchor: { x: 762, y: 100 } }, { relativePath: folder.relativePath, parent: folder, anchor: { x: 0, y: 0 } },
      { relativePath: nested.relativePath, parent: nested, anchor: { x: 0, y: 0 } }] };
  const actions: TemplateCreationMenuProps["actions"] = { openTemplateMenu() {}, closeTemplateMenu() {}, toggleTemplateItem() {}, activateTemplateItem() {},
    expandTemplateDirectory() {}, collapseTemplateDirectory() {}, createSelectedTemplates() {}, refreshTemplateMenu() {}, openTemplateSettings() {} };
  const root = ReactDOM.createRoot(document.getElementById("root")!);
  const tick = async (fn: () => void) => act(async () => { fn(); await flushEffects(); });
  try {
    await tick(() => root.render(<TemplateCreationMenu menu={menu} actions={actions} />));
    const panels = [...document.querySelectorAll<HTMLElement>(".template-menu")];
    assert.ok(Number.parseFloat(panels[1].style.left) < Number.parseFloat(panels[0].style.left));
    assert.ok(Number.parseFloat(panels[2].style.left) + 300 <= Number.parseFloat(panels[1].style.left) + 8,
      "third-level menus should continue to the available left side instead of covering the root");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 620 });
    await tick(() => window.dispatchEvent(new dom.window.Event("resize")));
    for (const panel of panels) {
      const left = Number.parseFloat(panel.style.left); assert.ok(left >= 8 && left + 300 <= 612);
    }
    assert.equal(document.querySelectorAll(".template-menu__back").length, 0);
    console.log("ok - nested template menus keep their expansion direction and fit narrow windows");
  } finally { await tick(() => root.unmount()); dom.window.HTMLElement.prototype.getBoundingClientRect = previous; }
})();

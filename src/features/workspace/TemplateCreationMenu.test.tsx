import assert from "node:assert/strict";
import React, { act, useState } from "react";
import { TemplateCreationMenu, type TemplateCreationMenuProps } from "./TemplateCreationMenu";
import type { TemplateMenuState } from "./templateCreationState";
import type { CreationTemplateEntry } from "../../app/templates";
import { toggleTemplateSelection } from "./templateSelection";
import { flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";

export const completion = (async () => {
  const dom = installDomEnvironment(), ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  const file: CreationTemplateEntry = { name: "new.cpp", relativePath: "new.cpp", path: "C:\\Templates\\new.cpp", kind: "file" };
  const folder: CreationTemplateEntry = { name: "Word", relativePath: "Word", path: "C:\\Templates\\Word", kind: "directory" };
  const child: CreationTemplateEntry = { name: "报告.docx", relativePath: "Word/报告.docx", path: "C:\\Templates\\Word\\报告.docx", kind: "file" };
  const initial: TemplateMenuState = { id: "test", rootPath: "C:\\Templates", settingsRoot: "C:\\Templates", target: { panelId: "panel-1", tabId: "tab", rootPath: "D:\\Target", selectionRevision: 0 },
    levels: [{ relativePath: "", anchor: { x: 900, y: 600 } }], directories: { "": { status: "ready", entries: [folder, file] }, word: { status: "ready", entries: [child] } }, selected: [] };
  const submitted: string[][] = []; let latest = initial; let closed = false;
  function Fixture() {
    const [menu, setMenu] = useState(initial), [visible, setVisible] = useState(true); latest = menu;
    const actions: TemplateCreationMenuProps["actions"] = {
      openTemplateMenu() {}, closeTemplateMenu() { closed = true; setVisible(false); },
      toggleTemplateItem(_id, entry) { setMenu(menu => ({ ...menu, selected: toggleTemplateSelection(menu.selected, entry) })); },
      activateTemplateItem(_id, entry) { if (menu.selected.length) this.toggleTemplateItem(_id, entry); else submitted.push([entry.relativePath]); },
      expandTemplateDirectory(_id, depth, entry, anchor) { setMenu(menu => ({ ...menu, levels: [...menu.levels.slice(0, depth + 1), { relativePath: entry.relativePath, parent: entry, anchor }] })); },
      collapseTemplateDirectory(_id, depth) { setMenu(menu => ({ ...menu, levels: menu.levels.slice(0, depth) })); },
      createSelectedTemplates() { submitted.push(menu.selected.map(entry => entry.relativePath)); }, refreshTemplateMenu() {}, openTemplateSettings() {}
    };
    return visible ? <TemplateCreationMenu menu={menu} actions={actions} /> : null;
  }
  const root = ReactDOM.createRoot(document.getElementById("root")!);
  const tick = async (fn: () => void) => act(async () => { fn(); await flushEffects(); });
  const button = (name: string) => { const result = [...document.querySelectorAll("button")].find(button => button.textContent?.trim() === name); assert.ok(result, name); return result; };
  const key = async (element: HTMLElement, key: string) => tick(() => element.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
  try {
    await tick(() => root.render(<Fixture />));
    assert.ok(document.querySelector('[role="menu"][aria-label="新建项目"]'));
    await tick(() => document.querySelector<HTMLInputElement>('[aria-label="选择 new.cpp"]')!.click());
    assert.equal(latest.selected.length, 1); assert.equal(closed, false);
    await key(button("Word"), "ArrowRight");
    assert.equal(latest.levels.length, 2);
    assert.ok(document.activeElement === button("创建整个文件夹"), "expanding a folder focuses its first creation action");
    await key(button("报告.docx"), " ");
    assert.equal(latest.selected.length, 2);
    await key(button("报告.docx"), "Enter"); assert.equal(latest.selected.length, 1, "Enter respects checked-selection mode");
    await key(button("报告.docx"), " ");
    await tick(() => button("创建所选（2）").click());
    assert.deepEqual(submitted[0], [file.relativePath, child.relativePath]);
    await tick(() => document.querySelector<HTMLInputElement>('[aria-label="选择 Word"]')!.click());
    assert.deepEqual(latest.selected.map(entry => entry.relativePath), [file.relativePath, folder.relativePath]);
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="选择 Word/报告.docx"]')!.disabled, true);
    await key(button("报告.docx"), "Escape"); assert.equal(latest.levels.length, 1); assert.equal(closed, false);
    await key(button("Word"), "Escape"); assert.equal(closed, true);
    console.log("ok - template menu supports persistent cross-level checkboxes, ancestor coverage and keyboard control");
  } finally { await tick(() => root.unmount()); }
})();

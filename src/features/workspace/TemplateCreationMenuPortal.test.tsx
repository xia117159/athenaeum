import assert from "node:assert/strict";
import React, { act, useState } from "react";
import { TemplateCreationMenu, type TemplateCreationMenuProps } from "./TemplateCreationMenu";
import { WorkspaceContextMenuPopover } from "./WorkspaceContextMenuPopover";
import type { TemplateMenuState } from "./templateCreationState";
import type { CreationTemplateEntry } from "../../app/templates";
import { expansionFixture } from "./folderExpansionTestSupport";
import { toggleTemplateSelection } from "./templateSelection";
import { flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";

export const completion = (async () => {
  const dom = installDomEnvironment(), ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  const f = expansionFixture(), tab = f.bootstrap.panels["panel-1"].tabs.find(tab => tab.id === f.tabId)!;
  const file: CreationTemplateEntry = { name: "new.cpp", relativePath: "new.cpp", path: "C:\\Templates\\new.cpp", kind: "file" };
  const folder: CreationTemplateEntry = { name: "Word", relativePath: "Word", path: "C:\\Templates\\Word", kind: "directory" };
  const child: CreationTemplateEntry = { name: "report.docx", relativePath: "Word/report.docx", path: "C:\\Templates\\Word\\report.docx", kind: "file" };
  const initial: TemplateMenuState = { id: "portal", rootHidden: true, rootPath: "C:\\Templates", settingsRoot: "C:\\Templates",
    target: { panelId: "panel-1", tabId: f.tabId, rootPath: f.path, selectionRevision: 0 },
    levels: [{ relativePath: "", anchor: { x: 400, y: 200 } }],
    directories: { "": { status: "ready", entries: [folder, file] }, word: { status: "ready", entries: [child] } }, selected: [] };
  const submitted: string[][] = []; let closed = 0, latest = initial;
  function Fixture() {
    const [menu, setMenu] = useState(initial), [visible, setVisible] = useState(true); latest = menu;
    const close = () => { closed++; setVisible(false); };
    const actions: TemplateCreationMenuProps["actions"] = {
      openTemplateMenu(_panel, _tab, anchor, parent) { setMenu(menu => ({ ...menu, rootHidden: false, parent, levels: [{ relativePath: "", anchor }] })); }, closeTemplateMenu: close,
      toggleTemplateItem(_id, entry) { setMenu(menu => ({ ...menu, selected: toggleTemplateSelection(menu.selected, entry) })); },
      activateTemplateItem() {},
      expandTemplateDirectory(_id, depth, entry, anchor) { setMenu(menu => ({ ...menu,
        levels: [...menu.levels.slice(0, depth + 1), { relativePath: entry.relativePath, parent: entry, anchor }] })); },
      collapseTemplateDirectory() {}, createSelectedTemplates() { submitted.push(menu.selected.map(entry => entry.relativePath)); },
      refreshTemplateMenu() {}, openTemplateSettings() {}
    };
    return visible ? <>
      <WorkspaceContextMenuPopover contextMenu={{ panelId: "panel-1", tabId: f.tabId, x: 10, y: 10, scope: "panel", mode: "custom" }}
        viewMode="details" tab={tab} actions={actions as never} layoutMode="single" panelIds={["panel-1"]} templateMenuOpen={!menu.rootHidden} onClose={close} />
      {!menu.rootHidden ? <TemplateCreationMenu menu={menu} actions={actions} /> : null}
    </> : null;
  }
  const root = ReactDOM.createRoot(document.getElementById("root")!);
  const tick = async (fn: () => void) => act(async () => { fn(); await flushEffects(); });
  const pointerClick = async (element: Element) => {
    await tick(() => element.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true })));
    await tick(() => element.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true })));
    await tick(() => element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
  };
  try {
    await tick(() => root.render(<Fixture />));
    await tick(() => document.querySelector<HTMLButtonElement>('[data-template-menu-trigger]')!.click());
    await tick(() => document.querySelector<HTMLInputElement>('[aria-label="选择 new.cpp"]')!.click());
    const chevron = document.querySelector('[data-template-path="Word"] svg:last-child path')!;
    assert.ok(chevron instanceof dom.window.SVGElement);
    await pointerClick(chevron);
    assert.equal(closed, 0, "SVG descendants of the template portal belong to the open menu");
    assert.equal(latest.levels.length, 2);
    await tick(() => document.querySelector<HTMLInputElement>('[aria-label="选择 Word/report.docx"]')!.click());
    await pointerClick(document.querySelector('.template-menu__submit svg path')!);
    assert.equal(closed, 0);
    assert.deepEqual(submitted, [[file.relativePath, child.relativePath]], "clicking the submit icon preserves and submits every selection once");
    console.log("ok - actual parent and template portals retain SVG pointer clicks and cross-level selections");
  } finally { await tick(() => root.unmount()); }
})();

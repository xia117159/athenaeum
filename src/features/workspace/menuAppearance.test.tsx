import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React, { act } from "react";
import { OpenWithMenu } from "./OpenWithMenu";
import { DetailsColumnHeaderMenu } from "./DetailsColumnHeaderMenu";
import { TemplateCreationMenu } from "./TemplateCreationMenu";
import { MenuSurface } from "./MenuPrimitives";
import { installDomEnvironment } from "./workspaceControllerTestHarness";

export const completion = (async () => {
  installDomEnvironment();
  const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");
  const style = document.createElement("style");
  // Match the production bundler's alphabetical stylesheet order.
  style.textContent = ["workspace.shell.css", "workspace.listing.css", "file-opening.css", "templates.css", "operation-history-window.css", "workspace.menus.css"].sort()
    .flatMap(name => { const file = path.join(process.cwd(), "src/features/workspace", name); return fs.existsSync(file) ? [fs.readFileSync(file, "utf8")] : []; }).join("\n")
    // jsdom rejects CSS min(). Use its spacious-viewport result to test the cascade;
    // actual viewport clamping is checked with the unmodified CSS in Chrome.
    .replaceAll("min(380px, calc(100vw - 16px))", "380px")
    .replaceAll("min(540px, calc(100vh - 16px))", "540px");
  document.head.append(style);
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(<>
      <OpenWithMenu menu={{ requestId: "open-test", panelId: "panel-1", tabId: "tab", entryId: "entry", path: "C:\\Test.txt", selectionKey: "", rulesKey: "", ruleIds: ["editor"], selectedIndex: 0, programs: {} }}
        rules={[{ id: "editor", patterns: "txt", executablePath: "C:\\editor.exe", argumentsTemplate: "" }]} onSelect={() => {}} onConfirm={() => {}} onClose={() => {}} />
      <DetailsColumnHeaderMenu menuRef={{ current: null }} x={0} y={0} columns={[{ id: "name", label: "名称" }]} onToggleColumn={() => {}} onShowAll={() => {}} onAutoFit={() => {}} />
      <TemplateCreationMenu menu={{ id: "template-test", target: { panelId: "panel-1", tabId: "tab", rootPath: "C:\\files", selectionRevision: 0 },
        settingsRoot: "C:\\Templates", rootPath: "C:\\Templates", levels: [{ relativePath: "", anchor: { x: 0, y: 0 } }], selected: [],
        directories: { "": { status: "ready", entries: [{ relativePath: "note.txt", path: "C:\\Templates\\note.txt", kind: "file", name: "note.txt" }] } } }}
        actions={{} as React.ComponentProps<typeof TemplateCreationMenu>["actions"]} />
      <MenuSurface className="operation-history-window__clear-menu"><button className="app-menu__item">清理所有 Tab</button></MenuSurface>
      <MenuSurface className="menu-dropdown"><button className="app-menu__item menu-dropdown__item">复制</button></MenuSurface>
    </>));
    for (const selector of [".open-with-menu__item", ".column-header-menu__item", ".template-menu__row"]) {
      const items = document.querySelectorAll<HTMLElement>(selector); assert.ok(items.length, selector);
      for (const item of items) {
        assert.equal(window.getComputedStyle(item).height, "24px", `${selector} must have an exact shared 24px row height`);
        assert.equal(window.getComputedStyle(item).boxSizing, "border-box");
      }
    }
    const association = window.getComputedStyle(document.querySelector('.open-with-menu')!);
    assert.equal(association.width, "380px", "shared surface defaults preserve the association popup width");
    assert.equal(association.padding, "0px");
    assert.equal(association.overflow, "hidden", "only the choices scroll, keeping the settings footer reachable");
    const templates = window.getComputedStyle(document.querySelector('.template-menu')!);
    assert.equal(templates.maxHeight, "540px", "template height limit survives common styles");
    assert.equal(templates.padding, "0px");
    assert.equal(templates.overflow, "hidden");
    assert.equal(window.getComputedStyle(document.querySelector('.operation-history-window__clear-menu')!).width, "172px");
    assert.equal(window.getComputedStyle(document.querySelector('.menu-dropdown__item')!).display, "grid");
    assert.equal(window.getComputedStyle(document.querySelector('.template-menu__entry')!).paddingLeft, "2px");
    console.log("ok - association, template and column menus share actual command row dimensions");
  } finally { await act(async () => root.unmount()); style.remove(); }
})();

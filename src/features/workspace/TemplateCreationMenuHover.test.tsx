import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React, { act } from "react";
import { TemplateCreationMenu } from "./TemplateCreationMenu";
import { WorkspaceContextMenuPopover } from "./WorkspaceContextMenuPopover";
import { useWorkspaceController } from "./useWorkspaceController";
import { expansionFixture, expansionInteractions } from "./folderExpansionTestSupport";
import { createTestGateway, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { CreationTemplateEntry, CreationTemplateListing } from "../../app/templates";

export const completion = (async () => {
  const dom = installDomEnvironment();
  const style = document.createElement("style");
  style.textContent = ["workspace.context-menu.css", "templates.css", "workspace.menus.css"]
    .map(file => fs.readFileSync(path.join(process.cwd(), "src/features/workspace", file), "utf8")).join("\n")
    // jsdom does not resolve var() in background colors; browser checks cover configured values.
    .replaceAll("var(--menu-hover-background, #e5f1fb)", "#e5f1fb");
  document.head.append(style);
  const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");
  const f = expansionFixture(); f.bootstrap.settingsModel.templateRoot = "C:\\Templates";
  const entry = (relativePath: string, kind: CreationTemplateEntry["kind"] = "file"): CreationTemplateEntry => ({
    relativePath, name: relativePath.split("/").pop()!, kind, path: `C:\\Templates\\${relativePath.replaceAll("/", "\\")}` });
  const word = entry("Word", "directory"), ppt = entry("PPT", "directory"), file = entry("new.cpp");
  const nested = entry("Word/Specs", "directory"), child = entry("Word/report.docx");
  const directories: Record<string, CreationTemplateEntry[]> = {
    "": [word, ppt, file], Word: [nested, child], PPT: [entry("PPT/slides.pptx")], "Word/Specs": [entry("Word/Specs/spec.docx")]
  };
  let rootReads = 0, pptReads = 0, holdNested = false, releaseNested: ((listing: CreationTemplateListing) => void) | undefined;
  const listing = (path: string) => ({ rootPath: "C:\\Templates", relativePath: path, entries: directories[path] });
  const gateway = createTestGateway(() => {}, expansionInteractions(), { loadBootstrap: () => f.bootstrap });
  gateway.templates.list = async (_root, path = "") => {
    if (!path) rootReads++;
    if (path === ppt.relativePath) pptReads++;
    if (path === nested.relativePath && holdNested) return new Promise(resolve => { releaseNested = resolve; });
    return listing(path);
  };
  let controller!: ReturnType<typeof useWorkspaceController>;
  function Harness() {
    controller = useWorkspaceController(gateway);
    const { state, actions } = controller, tab = state.panels["panel-1"].tabs.find(tab => tab.id === f.tabId)!;
    return <>
      {state.contextMenu ? <WorkspaceContextMenuPopover contextMenu={state.contextMenu} tab={tab} actions={actions}
        viewMode="details" layoutMode="single" panelIds={["panel-1"]}
        templateMenuOpen={Boolean(state.templateMenu && !state.templateMenu.rootHidden)}
        onClose={actions.closeContextMenu} /> : null}
      {state.templateMenu ? <TemplateCreationMenu key={state.templateMenu.id} menu={state.templateMenu} actions={actions} /> : null}
    </>;
  }
  const root = createRoot(document.getElementById("root")!);
  const tick = async (fn: () => void) => act(async () => { fn(); await flushEffects(); await flushEffects(); });
  const pause = async (ms = 230) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); await flushEffects(); });
  let pointer: Element = document.body;
  const move = async (target: Element) => tick(() => {
    pointer.dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true, relatedTarget: target }));
    target.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true, relatedTarget: pointer }));
    target.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true }));
    pointer = target;
  });
  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("button")];
  const button = (label: string) => { const found = buttons().find(button => button.textContent?.trim() === label); assert.ok(found, label); return found; };
  const template = (path: string) => { const found = buttons().find(button => button.dataset.templatePath === path); assert.ok(found, path); return found; };
  const checkbox = (path: string) => { const found = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    .find(input => input.getAttribute("aria-label") === `选择 ${path}`); assert.ok(found, path); return found; };
  const depth = () => document.querySelectorAll(".template-menu").length;
  const key = (target: HTMLElement, name: string) => tick(() => target.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));
  const openContext = () => tick(() => controller.actions.openContextMenu({ panelId: "panel-1", tabId: f.tabId,
    scope: "panel", mode: "custom", x: 10, y: 10 }));
  try {
    await tick(() => root.render(<Harness />)); await openContext();
    await move(button("新建项目"));
    const sessionId = controller.state.templateMenu!.id;
    const initialReads = rootReads;
    assert.equal(depth(), 1);
    const rowHeight = window.getComputedStyle(button("新建文件")).minHeight;
    assert.equal(window.getComputedStyle(template(file.relativePath)).minHeight, rowHeight, "template entries match the context menu row density");
    await tick(() => checkbox(file.relativePath).click());
    assert.equal(button("创建所选（1）").disabled, false);
    assert.equal(window.getComputedStyle(button("创建所选（1）")).minHeight, rowHeight, "template actions use the same row density");
    for (const label of ["视图", "排序方式"]) {
      await move(template(word.relativePath)); // Queue a child expansion before switching to a sibling menu.
      await move(button(label).querySelector("span:last-child")!);
      assert.equal(depth(), 0, "entering a sibling context-menu item closes the template cascade without waiting");
      assert.equal(button("新建项目").getAttribute("aria-expanded"), "false");
      assert.equal(controller.state.templateMenu?.id, sessionId);
      assert.equal(controller.state.templateMenu?.selected.length, 1);
      await move(button("新建项目")); await pause();
      assert.equal(depth(), 1, "a cancelled hover expansion cannot reopen a child after returning to the root");
      assert.equal(checkbox(file.relativePath).checked, true);
    }
    await move(template(word.relativePath)); await pause(); assert.equal(depth(), 2);
    await move(template(nested.relativePath)); await pause(); assert.equal(depth(), 3);
    await move(template(child.relativePath));
    assert.equal(depth(), 2, "entering a file immediately closes its sibling folder's child menu");
    await move(checkbox(file.relativePath));
    assert.equal(depth(), 1, "entering a checkbox immediately closes the old child menu");
    assert.equal(controller.state.templateMenu?.selected.length, 1);

    await move(template(word.relativePath)); await pause();
    await move(button("创建所选（1）"));
    assert.equal(depth(), 1, "entering a menu action immediately closes its child branch");
    await move(template(word.relativePath)); await pause();
    await move(document.body); await pause(40); await move(template(child.relativePath)); await pause();
    assert.equal(depth(), 2, "a short crossing outside the portal must not close the menu chain");
    await tick(() => checkbox(child.relativePath).click());
    await tick(() => template(child.relativePath).focus());
    const beforePptReads = pptReads;
    await move(template(ppt.relativePath).querySelector("svg")!);
    assert.equal(depth(), 2); assert.ok(template("PPT/slides.pptx"), "switching between expanded folders replaces the branch immediately");
    assert.equal(pptReads, beforePptReads + 1, "one pointer transition requests the replacement directory only once");
    assert.ok(!document.querySelector('[data-template-path="Word/report.docx"]'));
    assert.ok(document.activeElement === template(ppt.relativePath), "replacing a focused child menu returns focus to its new parent item");
    await key(template(ppt.relativePath), "ArrowRight");
    assert.ok(document.activeElement?.closest('.template-menu[data-template-depth="1"]'), "the new branch remains keyboard reachable");
    assert.equal(controller.state.templateMenu?.selected.length, 2, "changing branches preserves cross-level selection");
    await tick(() => template(file.relativePath).focus());
    await move(template(word.relativePath)); await pause();
    await move(template(ppt.relativePath)); await pause();
    assert.ok(document.activeElement === template(file.relativePath), "hover does not steal focus from an item that remains visible");

    await tick(() => template("PPT/slides.pptx").focus());
    await move(button("新建文件"));
    assert.equal(depth(), 0, "entering an ordinary sibling item also closes the cascade immediately");
    assert.ok(document.querySelector(".context-menu"), "the containing context menu stays open");
    assert.equal(button("新建项目").getAttribute("aria-expanded"), "false");
    assert.ok(document.activeElement === button("新建项目"), "hidden-menu focus returns to the parent item");
    const highlight = "rgb(229, 241, 251)";
    const parentBackground = () => window.getComputedStyle(button("新建项目")).backgroundColor;
    assert.notEqual(parentBackground(), highlight, "focus restoration must not leave a second pointer highlight on the parent");
    await move(document.body); await pause();
    assert.notEqual(parentBackground(), highlight, "leaving the entire menu clears the pointer highlight without discarding focus");
    assert.ok(document.activeElement === button("新建项目"));
    await key(button("新建项目"), "F3");
    assert.equal(parentBackground(), highlight, "keyboard navigation restores the visible focus indication");
    await move(button("新建文件"));
    assert.notEqual(parentBackground(), highlight, "returning to the mouse removes the old keyboard fill");
    assert.equal(controller.state.templateMenu?.id, sessionId);
    assert.equal(controller.state.templateMenu?.selected.length, 2);
    await key(button("新建项目"), "ArrowRight");
    assert.equal(depth(), 1); assert.equal(rootReads, initialReads, "re-entering a submenu does not reload its catalog");
    assert.equal(controller.state.templateMenu?.id, sessionId, "re-entering a submenu reuses the same selection session");
    assert.equal(button("新建项目").getAttribute("aria-expanded"), "true");
    assert.equal(checkbox(file.relativePath).checked, true);
    await tick(() => button("新建项目").focus());
    await move(document.body);
    await key(button("新建项目"), "ArrowRight"); await pause();
    assert.equal(depth(), 1, "keyboard navigation on the parent cancels a pending hover dismissal");
    assert.ok(document.activeElement?.closest('.template-menu[data-template-depth="0"]'), "ArrowRight also enters an already open submenu");
    await move(template(word.relativePath)); await pause();
    assert.equal(checkbox(child.relativePath).checked, true);
    await tick(() => checkbox(child.relativePath).click());
    await tick(() => checkbox(file.relativePath).click());
    assert.ok(!document.querySelector(".template-menu__footer"), "deselecting the last item removes the action area");

    await move(template(file.relativePath));
    await key(template(word.relativePath), "ArrowRight"); await pause();
    assert.equal(depth(), 2, "keyboard navigation reopens a branch after moving over a file");
    await key(template(child.relativePath), "ArrowLeft"); assert.equal(depth(), 1);
    await move(document.body); // Leave an old-session timer pending, then replace the whole context menu.
    await tick(() => controller.actions.closeContextMenu()); await openContext();
    await tick(() => button("新建项目").click()); await pause();
    assert.equal(depth(), 1, "an old hover timer must not close a newer session");
    assert.notEqual(controller.state.templateMenu?.id, sessionId);
    assert.equal(controller.state.templateMenu?.selected.length, 0, "closing the entire menu clears the selection");

    holdNested = true;
    await move(template(word.relativePath)); await pause();
    await move(template(nested.relativePath)); await pause(); assert.ok(releaseNested);
    await move(template(file.relativePath)); await pause(); assert.equal(depth(), 1);
    await tick(() => { releaseNested!(listing(nested.relativePath)); releaseNested = undefined; });
    assert.equal(depth(), 1, "late directory results may fill the cache but must not reopen collapsed levels");
    const beforeRefresh = rootReads;
    await tick(() => controller.actions.refreshTemplateMenu(controller.state.templateMenu!.id));
    assert.equal(rootReads, beforeRefresh + 1, "the removed refresh menu item retains its controller function");

    await tick(() => controller.actions.closeContextMenu());
    await tick(() => controller.actions.openTemplateMenu("panel-1", f.tabId, { x: 40, y: 40 }));
    await move(template(file.relativePath)); await move(document.body);
    assert.ok(controller.state.templateMenu, "leaving the chain retains a brief crossing allowance");
    await pause(120);
    assert.equal(controller.state.templateMenu, undefined, "leaving a standalone template menu closes the whole session");
    console.log("ok - real parent/template portals preserve hover navigation, focus, cross-level selection and session boundaries");
  } finally {
    if (releaseNested) await tick(() => releaseNested!(listing(nested.relativePath)));
    await tick(() => root.unmount());
    style.remove();
  }
})();

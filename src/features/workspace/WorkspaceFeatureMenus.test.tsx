import assert from "node:assert/strict";
import React, { act } from "react";
import { WorkspaceMenuBar } from "./WorkspaceMenuBar";
import { WorkspaceContextMenuPopover } from "./WorkspaceContextMenuPopover";
import { OpenWithMenu } from "./OpenWithMenu";
import { TemplateCreationMenu } from "./TemplateCreationMenu";
import { useWorkspaceController } from "./useWorkspaceController";
import { expansionEntry, expansionFixture, expansionInteractions } from "./folderExpansionTestSupport";
import { createTestGateway, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { CreationTemplateEntry } from "../../app/templates";
import type { FileOpenRequest } from "../../app/fileAssociations";

export const completion = (async () => {
  const dom = installDomEnvironment();
  const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");
  const f = expansionFixture(), interactions = expansionInteractions();
  const a = expansionEntry(f.path, "a.txt", "file"), b = expansionEntry(f.path, "b.txt", "file");
  const initialTab = f.bootstrap.panels["panel-1"].tabs[0];
  initialTab.snapshot.entries.push(a, b); initialTab.selectedEntryIds = [a.id, b.id]; initialTab.selectionCursorId = a.id;
  f.bootstrap.settingsModel.templateRoot = "C:\\Templates";
  f.bootstrap.settingsModel.fileAssociations = [{ id: "editor", patterns: "txt", executablePath: "C:\\editor.exe", argumentsTemplate: "" }];
  const entry = (relativePath: string, kind: CreationTemplateEntry["kind"] = "file"): CreationTemplateEntry => ({ relativePath,
    kind, name: relativePath.split("/").pop()!, path: `C:\\Templates\\${relativePath.replaceAll("/", "\\")}` });
  const directories: Record<string, CreationTemplateEntry[]> = { "": [entry("Word", "directory"), entry("new.cpp")], Word: [entry("Word/report.docx")] };
  const gateway = createTestGateway(() => {}, interactions, { loadBootstrap: () => f.bootstrap });
  gateway.templates.list = async (_root, path = "") => ({ rootPath: "C:\\Templates", relativePath: path, entries: directories[path] });
  const opened: FileOpenRequest[] = [];
  gateway.openFile = async request => { opened.push(request); return { status: "opened", localPath: request.target.path, associationId: request.associationId ?? null }; };
  gateway.inspectAssociationPrograms = async paths => paths.map(path => ({ path, exists: true, displayName: "文本编辑器" }));
  let controller!: ReturnType<typeof useWorkspaceController>;
  const templateMenu = () => controller.state.templateMenu;
  function Harness() {
    controller = useWorkspaceController(gateway);
    const { state, actions } = controller, panel = state.panels[state.activePanelId], tab = panel.tabs.find(tab => tab.id === panel.activeTabId)!;
    return <>
      <WorkspaceMenuBar state={state} actions={actions} activeTab={tab} canUseDirectoryCommands={tab.kind === "directory"} canGoBack={false} canGoForward={false} />
      <div className="file-listing__scroll" data-panel-id="panel-1" tabIndex={-1} />
      {state.contextMenu ? <WorkspaceContextMenuPopover contextMenu={state.contextMenu} tab={tab} actions={actions}
        viewMode="details" layoutMode="single" panelIds={["panel-1"]} templateMenuOpen={Boolean(state.templateMenu && !state.templateMenu.rootHidden)} onClose={actions.closeContextMenu} /> : null}
      {state.templateMenu ? <TemplateCreationMenu key={state.templateMenu.id} menu={state.templateMenu} actions={actions} /> : null}
      {state.openWithMenu ? <OpenWithMenu menu={state.openWithMenu} rules={state.settings.model.fileAssociations ?? []}
        onSelect={actions.selectOpenWith} onConfirm={actions.confirmOpenWith} onClose={actions.closeOpenWith} /> : null}
    </>;
  }
  const root = createRoot(document.getElementById("root")!);
  const tick = (fn: () => void) => act(async () => { fn(); await flushEffects(); await flushEffects(); });
  const key = (name: string, target: EventTarget = document.activeElement ?? window) => tick(() => {
    if (target instanceof HTMLElement) target.focus();
    target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  });
  const button = (label: string) => { const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label); assert.ok(found, label); return found; };
  const click = (label: string) => tick(() => button(label).click());
  const move = (target: Element) => tick(() => { target.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    target.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true })); });
  const check = (path: string) => tick(() => { const input = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(item => item.getAttribute("aria-label") === `选择 ${path}`); assert.ok(input); input.click(); });
  const pause = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 230)); await flushEffects(); });
  try {
    await tick(() => root.render(<Harness />));
    const editTrigger = button("编辑");
    await tick(() => { editTrigger.focus(); editTrigger.click(); });
    assert.ok(document.querySelector('.menu-dropdown'));
    await key("Escape", editTrigger);
    assert.ok(!document.querySelector('.menu-dropdown'), "Escape closes a mouse-opened top menu while its trigger holds focus");
    assert.equal(document.activeElement, editTrigger);
    await click("编辑");
    assert.equal(button("打开方式").disabled, false);
    assert.equal(button("新建项目").disabled, false);
    const selection = controller.state.panels["panel-1"].tabs[0].selectedEntryIds;
    await key("Delete", window); await key("F2", window);
    assert.equal(interactions.deleteCalls.length, 0); assert.equal(controller.state.panels["panel-1"].tabs[0].inlineEdit, undefined);
    await key("ArrowDown", button("复制"));
    assert.ok(document.activeElement === button("剪切"), "Down moves to the next menu action");
    assert.deepEqual(controller.state.panels["panel-1"].tabs[0].selectedEntryIds, selection);
    await click("打开方式");
    assert.ok(document.querySelector('.menu-dropdown'), "attached portal keeps its parent open");
    assert.equal(controller.state.openWithMenu?.path, a.path, "multiple selection uses current file");
    assert.ok(button("文本编辑器").querySelector(".association-program-icon"));
    assert.ok(button("打开自定义文件关联"));
    await key("ArrowLeft");
    assert.equal(controller.state.openWithMenu, undefined);
    assert.ok(document.activeElement === button("打开方式"), "Left returns to the exact parent trigger");
    await key("F2", window); assert.equal(controller.state.panels["panel-1"].tabs[0].inlineEdit, undefined);
    await key("ArrowRight", button("打开方式")); await key("Enter");
    assert.equal(opened.length, 1); assert.equal(opened[0].target.path, a.path); assert.equal(opened[0].associationId, "editor");
    assert.ok(!document.querySelector('.menu-dropdown'), "completion closes the entire chain");

    await click("编辑"); await move(button("新建项目"));
    const templateId = controller.state.templateMenu!.id;
    await check("new.cpp");
    const templateHost = document.querySelector(".template-menu-host")!;
    await tick(() => templateHost.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true })));
    assert.ok(document.querySelector('.menu-dropdown'), "checking in a portal preserves the parent");
    await move(button("Word")); await pause(); await check("Word/report.docx");
    assert.equal(controller.state.templateMenu?.selected.length, 2);
    await move(button("复制"));
    assert.equal(document.querySelectorAll('.template-menu').length, 0, "switching sibling collapses immediately");
    await move(button("新建项目"));
    assert.equal(controller.state.templateMenu?.id, templateId);
    assert.equal(controller.state.templateMenu?.selected.length, 2);
    assert.ok(button("创建所选（2）"));
    await key("ArrowLeft", document.querySelector('.template-menu')!);
    assert.ok(document.activeElement === button("新建项目"), "Left returns to the template trigger");
    await key("Delete", window); assert.equal(interactions.deleteCalls.length, 0);
    await move(button("查看"));
    assert.equal(controller.state.templateMenu, undefined, "changing top group discards the session");
    await click("编辑"); await move(button("新建项目"));
    assert.equal(templateMenu()?.selected.length, 0);
    await tick(() => controller.actions.openContextMenu({ panelId: "panel-1", tabId: f.tabId, scope: "panel", mode: "custom", x: 20, y: 20 }));
    assert.ok(!document.querySelector('.menu-dropdown'), "opening another root closes the menubar");
    await move(button("新建项目")); assert.notEqual(templateMenu()?.id, templateId);
    await tick(() => controller.actions.closeContextMenu());
    assert.equal(controller.state.templateMenu, undefined);
    await click("编辑"); await move(button("新建项目"));
    await tick(() => document.body.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true })));
    assert.ok(!document.querySelector('.menu-dropdown'), "outside click closes root"); assert.equal(controller.state.templateMenu, undefined);
    await tick(() => controller.actions.selectEntry("panel-1", f.tabId, f.parent.id, false));
    await click("编辑"); assert.equal(button("打开方式").disabled, true);
    await key("Escape", button("复制"));
    assert.ok(!document.querySelector('.menu-dropdown'), "Escape closes root");
    console.log("ok - shared top/context feature menus, portal ownership, current-file targeting and keyboard boundaries");
  } finally { await tick(() => root.unmount()); }
})();

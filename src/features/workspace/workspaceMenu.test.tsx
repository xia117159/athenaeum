import assert from "node:assert/strict";
import React, { act, useReducer } from "react";
import { WorkspaceMenuBar } from "./WorkspaceMenuBar";
import { createWorkspaceState, workspaceReducer } from "./workspaceReducer";
import { createMockWorkspaceBootstrap } from "./mockData";
import { flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";

export const completion = (async () => {
  installDomEnvironment();
  const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");
  const bootstrap = createMockWorkspaceBootstrap("mock");
  bootstrap.settingsModel.shortcuts.find(item => item.id === "refresh")!.binding = "F8";
  const calls: Array<{ action: string; args: unknown[] }> = [];
  function Harness() {
    const [state, dispatch] = useReducer(workspaceReducer, bootstrap, createWorkspaceState);
    const panel = state.panels[state.activePanelId], tab = panel.tabs.find(item => item.id === panel.activeTabId)!;
    const actions = new Proxy({}, { get: (_target, action: string) => action === "setMenuBar"
      ? (id?: string) => dispatch({ type: "workspaceMenuBarSet", payload: id ? { id, sessionId: id } : undefined })
      : (...args: unknown[]) => calls.push({ action, args }) }) as React.ComponentProps<typeof WorkspaceMenuBar>["actions"];
    return <WorkspaceMenuBar state={state} actions={actions} activeTab={tab} canUseDirectoryCommands canGoBack={false} canGoForward={false} />;
  }
  const root = createRoot(document.getElementById("root")!);
  const button = (label: string) => { const node = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item =>
    item.textContent?.trim() === label || item.querySelector(".menu-dropdown__item-label")?.textContent === label); assert.ok(node, label); return node; };
  const click = async (label: string) => act(async () => { button(label).click(); await flushEffects(); });
  try {
    await act(async () => root.render(<Harness />));
    await click("编辑");
    assert.ok(button("文件查找").previousElementSibling?.matches('[role="separator"]'));
    assert.ok(button("根据内容查找").previousElementSibling?.matches('[role="separator"]'));
    await click("文件查找"); assert.deepEqual(calls.pop(), { action: "openSearchPanel", args: ["name"] });
    assert.ok(!document.querySelector(".menu-dropdown"));
    await click("编辑"); await click("根据内容查找"); assert.deepEqual(calls.pop(), { action: "openSearchPanel", args: ["content"] });
    await click("查看");
    assert.equal(button("刷新").querySelector(".menu-dropdown__shortcut")?.textContent, "F8");
    assert.ok(button("显示目录树").hasAttribute("aria-checked"));
    await click("显示项目");
    assert.ok(document.querySelector('.menu-dropdown__submenu-items[role="menu"]'));
    for (const label of ["显示隐藏文件和文件夹", "显示系统文件和文件夹", "隐藏受系统保护的操作系统文件"]) assert.equal(button(label).getAttribute("role"), "menuitemcheckbox");
    await click("显示隐藏文件和文件夹"); assert.equal(calls.pop()?.action, "setFileVisibility");
    await click("标签页"); await click("标签页面板");
    for (const label of ["单面板", "双面板", "三面板", "四面板"]) assert.equal(button(label).getAttribute("role"), "menuitemradio");
    await click("四面板"); assert.deepEqual(calls.pop(), { action: "setLayoutMode", args: ["quad"] });
    await click("标签页"); await click("同步滚动"); assert.equal(calls.pop()?.action, "setSyncScroll");
    console.log("ok - top menu search, visibility, custom shortcut labels, panel layout and command closure");
  } finally { await act(async () => root.unmount()); }
})();

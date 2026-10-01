import assert from "node:assert/strict";
import React, { act, useReducer } from "react";
import { getFolderListingRows } from "./folderExpansion";
import { sizeFixture } from "./directorySizeTestSupport";
import { assertTest, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import { workspaceReducer } from "./workspaceReducer";
import type { ContextMenuState, EntryViewModel, TabState, WorkspaceState } from "./types";

export const completion = (async () => {
  const dom = installDomEnvironment(); globalThis.Element = dom.window.Element;
  Object.assign(globalThis, { MouseEvent: dom.window.MouseEvent, PointerEvent: dom.window.PointerEvent ?? dom.window.MouseEvent });
  const ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  const { WorkspaceMenuBar } = require("./WorkspaceMenuBar") as typeof import("./WorkspaceMenuBar");
  const { FileListingShell } = require("./FileListing") as typeof import("./FileListing");
  const { WorkspaceContextMenuPopover } = require("./WorkspaceContextMenuPopover") as typeof import("./WorkspaceContextMenuPopover");
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  const calls: Array<{ action: string; args: unknown[] }> = [];
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.textContent?.trim() === label || item.querySelector(".menu-dropdown__item-label")?.textContent === label);
  const click = async (node: HTMLElement | undefined) => act(async () => { assert.ok(node); node.click(); await flushEffects(); });
  const autoOnly = (state: WorkspaceState, paths: string[]) =>
    ({ ...state, settings: { ...state.settings, model: { ...state.settings.model, autoDirectorySizePaths: paths } } });

  const renderMenuBar = async (initial: WorkspaceState) => {
    function Harness() {
      const [state, dispatch] = useReducer(workspaceReducer, initial);
      const panel = state.panels[state.activePanelId], tab = panel.tabs.find((item) => item.id === panel.activeTabId)!;
      const actions = new Proxy({}, { get: (_target, action: string) => action === "setMenuBar"
        ? (id?: string) => dispatch({ type: "workspaceMenuBarSet", payload: id ? { id, sessionId: id } : undefined })
        : (...args: unknown[]) => calls.push({ action, args }) }) as React.ComponentProps<typeof WorkspaceMenuBar>["actions"];
      return <WorkspaceMenuBar state={state} actions={actions} activeTab={tab} canUseDirectoryCommands canGoBack={false} canGoForward={false} />;
    }
    await act(async () => { root.render(<Harness key={Math.random()} />); await flushEffects(); });
    await click(button("查看"));
  };

  try {
    await assertTest("the View menu offers calculate after Refresh, greys it and swaps to retry for failed automatic folders", async () => {
      const f = sizeFixture();
      await renderMenuBar(f.state);
      const calculate = button("立即计算文件夹大小")!;
      assert.equal(calculate.previousElementSibling, button("刷新"));
      assert.equal(calculate.disabled, false);
      await click(calculate);
      assert.deepEqual(calls.pop(), { action: "requestDirectorySizes", args: ["panel-1", f.tab.id, "calculate"] });

      f.tab.columns = f.tab.columns.map((column) => column.id === "size" ? { ...column, visible: false } : column);
      await renderMenuBar(f.state);
      assert.equal(button("立即计算文件夹大小")!.disabled, true);
      assert.equal(button("立即计算文件夹大小")!.title, "需要在详细信息视图中显示大小列");

      const auto = sizeFixture();
      await renderMenuBar(autoOnly(auto.state, [auto.path]));
      assert.equal(button("立即计算文件夹大小"), undefined, "automatic folders hide calculate (D9)");
      assert.equal(button("重试自动计算"), undefined);
      auto.sizes.autoPaused = true; auto.sizes.autoError = "拒绝访问";
      await renderMenuBar(autoOnly(auto.state, [auto.path]));
      await click(button("重试自动计算"));
      assert.deepEqual(calls.pop(), { action: "retryAutoDirectorySizes", args: ["panel-1", auto.tab.id] });
    });

    await assertTest("the size header context menu leads with the same action", async () => {
      const f = sizeFixture(); const selected: string[] = [];
      const rows = getFolderListingRows(f.tab);
      const render = (action?: React.ComponentProps<typeof FileListingShell>["directorySizeAction"]) => act(async () => {
        root.render(<FileListingShell panelId="panel-1" tabId={f.tab.id} columns={f.tab.columns} sort={f.tab.sort} currentPath={f.path}
          selectedEntryIds={[]} detailsRowHeight={12} viewMode="details" entries={rows.map(({ entry }) => entry)} folderRows={rows}
          onSort={() => undefined} onSelect={(_entry: EntryViewModel) => undefined} onOpen={() => undefined} onResizeColumn={() => undefined}
          onOpenContextMenu={() => undefined} onOpenNativeContextMenu={() => undefined} onDropEntries={() => undefined}
          onInlineEditChange={() => undefined} onInlineEditCommit={() => undefined} onInlineEditCancel={() => undefined}
          directorySizeAction={action} />);
        await flushEffects();
      });
      const openHeaderMenu = () => act(async () => {
        container.querySelector(".file-listing__header")!.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
        await flushEffects();
      });
      await render({ label: "立即计算文件夹大小", disabled: false, onSelect: () => selected.push("calculate") });
      await openHeaderMenu();
      const menu = document.querySelector(".column-header-menu")!;
      const first = menu.firstElementChild as HTMLButtonElement;
      assert.equal(first.textContent?.trim(), "立即计算文件夹大小");
      assert.ok(first.nextElementSibling?.matches('[role="separator"]'));
      await click(first);
      assert.deepEqual(selected, ["calculate"]);
      assert.equal(document.querySelector(".column-header-menu"), null, "selecting closes the menu");
      await render({ label: "立即计算文件夹大小", disabled: true, title: "正在计算文件夹大小", onSelect: () => selected.push("busy") });
      await openHeaderMenu();
      const busy = document.querySelector<HTMLButtonElement>(".column-header-menu")!.firstElementChild as HTMLButtonElement;
      assert.equal(busy.disabled, true); assert.equal(busy.title, "正在计算文件夹大小");
      await render(undefined);
      await openHeaderMenu();
      assert.doesNotMatch(document.querySelector(".column-header-menu")!.textContent ?? "", /计算/);
    });

    await assertTest("the tab menu toggles automatic sizes, greys inherited coverage and confirms volume roots", async () => {
      const toggles: Array<[string, boolean]> = []; const confirms: string[] = []; let confirmAnswer = false;
      window.confirm = (message?: string) => { confirms.push(message ?? ""); return confirmAnswer; };
      const actions = new Proxy({}, { get: (_target, action: string) => action === "setAutoDirectorySize"
        ? (path: string, enabled: boolean) => { toggles.push([path, enabled]); return Promise.resolve(); } : () => undefined }) as
        React.ComponentProps<typeof WorkspaceContextMenuPopover>["actions"];
      const render = (tab: TabState, paths: string[]) => act(async () => {
        const menu: ContextMenuState = { x: 1, y: 1, panelId: "panel-1", tabId: tab.id, mode: "custom", scope: "tab" };
        root.render(<WorkspaceContextMenuPopover key={Math.random()} contextMenu={menu} viewMode={tab.viewMode} tab={tab} actions={actions}
          layoutMode="single" panelIds={["panel-1"]} autoDirectorySizePaths={paths} onClose={() => undefined} />);
        await flushEffects();
      });
      const item = () => document.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"][data-menu-id="auto-directory-size"]');
      const f = sizeFixture();
      await render(f.tab, []);
      assert.equal(item()!.getAttribute("aria-checked"), "false");
      assert.equal(item()!.lastElementChild?.textContent, "自动计算文件夹大小");
      await click(item()!);
      assert.deepEqual(toggles.pop(), [f.path, true]);
      await render(f.tab, [f.path]);
      assert.equal(item()!.getAttribute("aria-checked"), "true");
      await click(item()!);
      assert.deepEqual(toggles.pop(), [f.path, false]);
      await render(f.tab, ["C:\\"]);
      assert.equal(item()!.disabled, true);
      assert.equal(item()!.lastElementChild?.textContent, "自动计算文件夹大小（继承自 C:\\）");

      const drive = sizeFixture();
      drive.tab.snapshot.location = { ...drive.tab.snapshot.location, path: "D:\\" };
      await render(drive.tab, []);
      await click(item()!);
      assert.equal(confirms.length, 1); assert.equal(toggles.length, 0, "declined confirmation changes nothing");
      confirmAnswer = true;
      await render(drive.tab, []);
      await click(item()!);
      assert.deepEqual(toggles.pop(), ["D:\\", true]);

      const remote = sizeFixture("sftp");
      await render(remote.tab, [remote.path]);
      assert.equal(item(), null, "remote tabs have no automatic toggle (D5)");
      f.tab.kind = "navigation";
      await render(f.tab, []);
      assert.equal(item(), null);
    });
  } finally { await act(async () => root.unmount()); container.remove(); }
})();

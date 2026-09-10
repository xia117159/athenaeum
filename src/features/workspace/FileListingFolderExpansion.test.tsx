import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { FileListingShell } from "./FileListing";
import { getFolderListingRows } from "./folderExpansion";
import { expansionFixture } from "./folderExpansionTestSupport";
import { getPathComparisonKey } from "./workspacePathRelations";
import { assertTest, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import { readWorkspaceCss } from "./workspaceCssTestUtils";
import type { EntryViewModel } from "./types";

async function withLoadingClock(run: (clock: { advance: (milliseconds: number) => Promise<void>; pending: () => number }) => Promise<void>) {
  const originalSetTimeout = window.setTimeout;
  const originalClearTimeout = window.clearTimeout;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let now = 0, sequence = 0;
  window.setTimeout = ((callback: TimerHandler, delay = 0, ...args: unknown[]) => {
    assert.ok(typeof callback === "function");
    const id = ++sequence;
    timers.set(id, { at: now + delay, callback: () => callback(...args) });
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id?: number) => { if (id !== undefined) timers.delete(id); }) as typeof window.clearTimeout;
  try {
    await run({
      pending: () => timers.size,
      advance: async (milliseconds) => {
        const target = now + milliseconds;
        await act(async () => {
          for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
            if (timer.at > target || !timers.delete(id)) continue;
            now = timer.at;
            timer.callback();
          }
          now = target;
          await flushEffects();
        });
      }
    });
  } finally {
    window.setTimeout = originalSetTimeout;
    window.clearTimeout = originalClearTimeout;
  }
}

export const completion = (async () => {
  const dom = installDomEnvironment();
  globalThis.Element = dom.window.Element;
  globalThis.PointerEvent = dom.window.PointerEvent;
  HTMLElement.prototype.setPointerCapture ??= () => undefined;
  HTMLElement.prototype.releasePointerCapture ??= () => undefined;
  const f = expansionFixture();
  const tab = f.bootstrap.panels["panel-1"].tabs[0];
  tab.folderExpansion = { [getPathComparisonKey(f.parent.path)]: { path: f.parent.path, entries: [f.child, f.nested], status: "ready" } };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  const toggles: string[] = [], retries: string[] = [], selections: string[] = [], opens: string[] = [];
  const widths: string[] = [];
  const drops: Array<{ paths: string[]; destination: string; operation: string }> = [];
  const props = {
    panelId: "panel-1" as const, tabId: tab.id, columns: tab.columns,
    sort: tab.sort, currentPath: f.path, selectedEntryIds: [] as string[], viewMode: "details" as const, detailsRowHeight: 24,
    onSort: () => undefined, onSelect: (entry: EntryViewModel) => selections.push(entry.path),
    onOpen: (entry: EntryViewModel) => opens.push(entry.path), onOpenContextMenu: () => undefined,
    onOpenNativeContextMenu: () => undefined, onResizeColumn: (column: string, width: string) => { if (column === "name") widths.push(width); },
    onDropEntries: (paths: string[], destination: string, operation: string) => drops.push({ paths, destination, operation }),
    onInlineEditChange: () => undefined, onInlineEditCommit: () => undefined, onInlineEditCancel: () => undefined,
    onToggleFolderExpansion: (path: string) => toggles.push(path), onRetryFolderExpansion: (path: string) => retries.push(path)
  };
  async function render(tree = true, viewMode: "details" | "list" = "details") {
    const rows = getFolderListingRows(tab);
    await act(async () => {
      root.render(<FileListingShell {...props} {...{ folderRows: tree ? rows : undefined }} entries={rows.map((row) => row.entry)} viewMode={viewMode} />);
      await flushEffects();
    });
  }
  const rowFor = (path: string) => [...container.querySelectorAll<HTMLElement>(".file-row")].find((row) => row.dataset.entryPath === path)!;
  try {
    await assertTest("Details listing keeps tree order and indents only the name column", async () => {
      await render();
      assert.deepEqual([...container.querySelectorAll<HTMLElement>(".file-row")].map((row) => row.dataset.entryPath),
        [f.parent.path, f.nested.path, f.child.path, f.sibling.path]);
      const childRow = rowFor(f.child.path);
      assert.equal(childRow.querySelector('[data-cell-column-id="name"] [data-folder-depth="1"]') !== null, true);
      assert.equal(childRow.querySelector('[data-cell-column-id="size"] [data-folder-depth]'), null);
      assert.equal(childRow.querySelector<HTMLElement>(".file-row__grid")?.style.gridTemplateColumns,
        rowFor(f.parent.path).querySelector<HTMLElement>(".file-row__grid")?.style.gridTemplateColumns);
      assert.ok(readWorkspaceCss().includes(".file-name-tree__toggle:focus-visible"));
    });
    await assertTest("folder arrows isolate pointer, double-click and keyboard events while child rows still select and open", async () => {
      await render();
      const arrow = rowFor(f.parent.path).querySelector<HTMLButtonElement>('button[aria-expanded="true"]');
      assert.ok(arrow);
      let pointerBubbles = 0, keyboardBubbles = 0;
      const pointer = () => pointerBubbles++;
      const keyboard = () => keyboardBubbles++;
      window.addEventListener("pointerdown", pointer);
      window.addEventListener("keydown", keyboard);
      await act(async () => {
        arrow.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 }));
        arrow.click();
        arrow.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));
        for (const key of ["Enter", " "]) arrow.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        await flushEffects();
      });
      window.removeEventListener("pointerdown", pointer);
      window.removeEventListener("keydown", keyboard);
      assert.equal(pointerBubbles, 0);
      assert.equal(keyboardBubbles, 0);
      assert.deepEqual(toggles, [f.parent.path, f.parent.path, f.parent.path]);
      assert.deepEqual(selections, []);
      assert.deepEqual(opens, []);
      await act(async () => {
        rowFor(f.child.path).click();
        rowFor(f.child.path).dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));
        await flushEffects();
      });
      assert.deepEqual(selections, [f.child.path]);
      assert.deepEqual(opens, [f.child.path]);
    });
    await assertTest("focused folder controls forward ordinary list shortcuts to the workspace", async () => {
      await render();
      const arrow = rowFor(f.parent.path).querySelector<HTMLButtonElement>('button[aria-expanded="true"]')!;
      const received: string[] = [];
      const listener = (event: KeyboardEvent) => received.push(event.key);
      const beforeToggles = toggles.length;
      window.addEventListener("keydown", listener);
      try {
        arrow.focus();
        assert.equal(document.activeElement, arrow);
        await act(async () => {
          for (const key of ["ArrowDown", "a", "F5"]) {
            arrow.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, ctrlKey: key === "a", bubbles: true, cancelable: true }));
          }
          await flushEffects();
        });
        assert.deepEqual(received, ["ArrowDown", "a", "F5"]);
        assert.equal(toggles.length, beforeToggles);
      } finally { window.removeEventListener("keydown", listener); }
    });
    await assertTest("name auto-fit includes the expansion control and deepest indentation", async () => {
      const autoFit = async () => {
        await act(async () => {
          container.querySelector(".file-listing__header")!.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
          await flushEffects();
        });
        await act(async () => {
          const button = [...container.querySelectorAll<HTMLButtonElement>(".column-header-menu button")].find((item) => item.textContent?.includes("立即自动调整列宽"));
          assert.ok(button);
          button.click(); await flushEffects();
        });
      };
      await render(false);
      await autoFit();
      const flat = Number.parseFloat(widths.at(-1)!);
      await render(true);
      await autoFit();
      assert.equal(Number.parseFloat(widths.at(-1)!) - flat, 34);
    });
    await assertTest("an expanded child can Ctrl-drag into a nested folder without changing selection", async () => {
      props.selectedEntryIds = [f.child.id];
      await render();
      const previousHitTest = document.elementFromPoint;
      const beforeSelection = [...selections];
      document.elementFromPoint = () => rowFor(f.nested.path);
      const pointer = (type: string, clientX: number) => {
        const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY: 8, ctrlKey: true });
        Object.defineProperty(event, "pointerId", { value: 1 });
        return event;
      };
      try {
        await act(async () => {
          rowFor(f.child.path).dispatchEvent(pointer("pointerdown", 10));
          window.dispatchEvent(pointer("pointermove", 28));
          window.dispatchEvent(pointer("pointerup", 28));
          await flushEffects();
        });
        assert.deepEqual(drops, [{ paths: [f.child.path], destination: f.nested.path, operation: "copy" }]);
        assert.deepEqual(selections, beforeSelection);
      } finally { document.elementFromPoint = previousHitTest; }
    });
    await assertTest("loading feedback waits 200ms without restarting when queued expansion starts reading", async () => withLoadingClock(async (clock) => {
      const branch = tab.folderExpansion![getPathComparisonKey(f.parent.path)];
      branch.status = "idle";
      branch.entries = [];
      await render();
      assert.equal(rowFor(f.parent.path).querySelector('[aria-expanded="true"]') !== null, true);
      assert.equal(rowFor(f.parent.path).querySelector('[role="status"]') === null, true);
      await clock.advance(100);
      branch.status = "loading";
      await render();
      await clock.advance(99);
      assert.equal(rowFor(f.parent.path).querySelector('[role="status"]') === null, true);
      await clock.advance(1);
      assert.match(rowFor(f.parent.path).querySelector('[role="status"]')?.textContent ?? "", /正在加载/);
      branch.status = "ready";
      branch.entries = [f.child, f.nested];
      await render();
      assert.equal(rowFor(f.parent.path).querySelector('[role="status"]') === null, true);
      assert.ok(rowFor(f.child.path));
    }));
    await assertTest("fast expansion displays children immediately and cancels loading feedback", async () => withLoadingClock(async (clock) => {
      const branch = tab.folderExpansion![getPathComparisonKey(f.parent.path)];
      branch.status = "loading";
      branch.entries = [];
      await render();
      assert.equal(rowFor(f.parent.path).querySelector('[role="status"]') === null, true);
      await clock.advance(100);
      branch.status = "ready";
      branch.entries = [f.child, f.nested];
      await render();
      assert.ok(rowFor(f.child.path));
      assert.equal(clock.pending(), 0);
      await clock.advance(200);
      assert.equal(rowFor(f.parent.path).querySelector('[role="status"]') === null, true);
    }));
    await assertTest("collapse cancels delayed feedback and reopening starts a fresh delay", async () => withLoadingClock(async (clock) => {
      const key = getPathComparisonKey(f.parent.path);
      const branch = tab.folderExpansion![key];
      for (const elapsed of [100, 250]) {
        branch.status = "loading";
        branch.entries = [];
        tab.folderExpansion![key] = branch;
        await render();
        await clock.advance(elapsed);
        delete tab.folderExpansion![key];
        await render();
        assert.equal(clock.pending(), 0);
        await clock.advance(200);
        assert.equal(rowFor(f.parent.path).querySelector('[role="status"]') === null, true);
        tab.folderExpansion![key] = branch;
        await render();
        assert.equal(rowFor(f.parent.path).querySelector('[role="status"]') === null, true);
        await clock.advance(199);
        assert.equal(rowFor(f.parent.path).querySelector('[role="status"]') === null, true);
        await clock.advance(1);
        assert.match(rowFor(f.parent.path).textContent ?? "", /正在加载/);
        branch.status = "ready";
        branch.entries = [f.child, f.nested];
        await render();
      }
    }));
    await assertTest("loading, empty and retry feedback belongs to the folder row; other modes omit controls", async () => withLoadingClock(async (clock) => {
      const branch = tab.folderExpansion![getPathComparisonKey(f.parent.path)];
      branch.status = "loading";
      await render();
      await clock.advance(100);
      branch.status = "error";
      branch.entries = [];
      branch.errorMessage = "permission denied";
      await render();
      assert.match(rowFor(f.parent.path).textContent ?? "", /读取失败/);
      assert.equal(clock.pending(), 0);
      await clock.advance(200);
      assert.doesNotMatch(rowFor(f.parent.path).textContent ?? "", /正在加载/);
      const retry = rowFor(f.parent.path).querySelector<HTMLButtonElement>('[aria-label="重试展开 parent"]');
      assert.ok(retry);
      await act(async () => { retry.click(); await flushEffects(); });
      assert.deepEqual(retries, [f.parent.path]);
      let retryRefreshKeys = 0;
      const onRetryKey = (event: KeyboardEvent) => { if (event.key === "F5") retryRefreshKeys++; };
      window.addEventListener("keydown", onRetryKey);
      try {
        retry.focus();
        await act(async () => { retry.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "F5", bubbles: true })); await flushEffects(); });
        assert.equal(retryRefreshKeys, 1);
      } finally { window.removeEventListener("keydown", onRetryKey); }
      branch.status = "ready";
      await render();
      assert.match(rowFor(f.parent.path).textContent ?? "", /空文件夹/);
      branch.status = "loading";
      await render();
      await render(false);
      assert.equal(container.querySelector(".file-name-tree__toggle"), null);
      assert.equal(clock.pending(), 0);
      await render(true);
      await render(true, "list");
      assert.equal(container.querySelector(".file-name-tree__toggle"), null);
      assert.equal(clock.pending(), 0);
      await render(true);
      await act(async () => { root.render(null); await flushEffects(); });
      assert.equal(clock.pending(), 0);
      await clock.advance(200);
      assert.equal(container.textContent, "");
    }));
  } finally {
    await act(async () => { root.unmount(); await flushEffects(); });
    container.remove();
  }
})();

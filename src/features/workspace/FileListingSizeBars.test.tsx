import assert from "node:assert/strict";
import fs from "node:fs";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { FileListingShell } from "./FileListing";
import { DirectorySizeControl } from "./DirectorySizeControl";
import { getFolderListingRows } from "./folderExpansion";
import { getDetailsCellText } from "./fileListingPresentation";
import { sizeFixture } from "./directorySizeTestSupport";
import { assertTest, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { EntryViewModel, TabViewMode } from "./types";

export const completion = (async () => {
  const dom = installDomEnvironment(); globalThis.Element = dom.window.Element;
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = ReactDOM.createRoot(container); const f = sizeFixture();
  const sorted: string[] = []; const selected: string[] = []; const opened: string[] = []; const actions: string[] = [];
  const resized: string[] = [];
  const props = { panelId: "panel-1" as const, tabId: f.tab.id, columns: f.tab.columns, sort: f.tab.sort, currentPath: f.path,
    selectedEntryIds: [] as string[], detailsRowHeight: 12, tooltipHoverDelayMs: 200,
    onSort: (column: string) => { sorted.push(column); }, onSelect: (entry: EntryViewModel) => { selected.push(entry.path); },
    onOpen: (entry: EntryViewModel) => { opened.push(entry.path); }, onResizeColumn: (column: string) => { resized.push(column); },
    onOpenContextMenu: () => undefined, onOpenNativeContextMenu: () => undefined, onDropEntries: () => undefined,
    onInlineEditChange: () => undefined, onInlineEditCommit: () => undefined, onInlineEditCancel: () => undefined };
  const render = async (mode: TabViewMode = "details") => {
    const rows = getFolderListingRows(f.tab);
    await act(async () => { root.render(<FileListingShell {...props} entries={rows.map(({ entry }) => entry)} folderRows={rows} viewMode={mode}
      sizeHeaderAccessory={<DirectorySizeControl statistics={f.sizes} locationKind="local" onAction={(intent) => actions.push(intent)} />} />); await flushEffects(); });
  };
  try {
    await assertTest("Details size bars render through the real listing, keep selection/open semantics and plain auto-fit text", async () => {
      await render();
      assert.equal(container.querySelectorAll(".size-share-bar").length, 4);
      const row = [...container.querySelectorAll<HTMLElement>(".file-row")].find((row) => row.dataset.entryPath === f.parent.path)!;
      const size = row.querySelector<HTMLElement>('[data-cell-column-id="size"]')!;
      assert.equal(size.textContent, "60 B");
      await act(async () => { size.click(); size.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true })); await flushEffects(); });
      assert.deepEqual(selected, [f.parent.path]); assert.deepEqual(opened, [f.parent.path]);
      assert.equal(getDetailsCellText(getFolderListingRows(f.tab)[0].entry, "size", f.path), "60 B");
    });
    await assertTest("size calculation accessory sits outside sorting and isolates pointer, double-click and keyboard activation", async () => {
      await render();
      const header = container.querySelector<HTMLElement>('[role="columnheader"][data-column-id="size"]')!;
      const action = header.querySelector<HTMLButtonElement>(".directory-size-control button"); assert.ok(action);
      assert.equal(action.closest(".details-column-header__button"), null);
      await act(async () => {
        for (const name of ["pointerdown", "mousedown", "click", "dblclick"]) action.dispatchEvent(new dom.window.MouseEvent(name, { bubbles: true, cancelable: true, button: 0 }));
        action.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        await flushEffects();
      });
      assert.deepEqual(actions, ["calculate", "calculate"]); assert.deepEqual(sorted, []); assert.deepEqual(resized, []);
      await act(async () => { header.querySelector<HTMLButtonElement>(".file-header-button")!.click(); await flushEffects(); });
      assert.deepEqual(sorted, ["size"]);
    });
    await assertTest("other listing modes have no bars/accessory, and workspace passes the supported context and persisted colors", async () => {
      for (const mode of ["list", "tiles", "content", "large-icons"] as const) {
        await render(mode); assert.equal(container.querySelector(".size-share-bar"), null); assert.equal(container.querySelector(".directory-size-control"), null);
      }
      const source = fs.readFileSync("src/features/workspace/WorkspaceView.tsx", "utf8");
      assert.match(source, /sizeHeaderAccessory=/);
      assert.match(source, /supportsDirectorySizes\(activeTab\)/);
      assert.match(source, /"--size-bar-low": state\.settings\.model\.theme\.sizeBarLow/);
      assert.match(source, /"--size-bar-high": state\.settings\.model\.theme\.sizeBarHigh/);
    });
  } finally { await act(async () => root.unmount()); container.remove(); dom.window.close(); }
})();

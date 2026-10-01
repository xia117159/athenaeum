import assert from "node:assert/strict";
import React, { act } from "react";
import { FileListingShell } from "./FileListing";
import { getFolderListingRows } from "./folderExpansion";
import { expansionEntry, expansionFixture, quickFilterProgram } from "./folderExpansionTestSupport";
import { flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";

export const completion = (async () => {
  const dom = installDomEnvironment(); globalThis.Element = dom.window.Element;
  const ReactDOM = require("react-dom/client") as typeof import("react-dom/client");
  const f = expansionFixture(), tab = f.bootstrap.panels["panel-1"].tabs.find(tab => tab.id === f.tabId)!;
  const entry = expansionEntry(f.path, "Created.txt", "file"); tab.snapshot.entries = [entry];
  const root = ReactDOM.createRoot(document.getElementById("root")!);
  const tick = async (fn: () => void) => act(async () => { fn(); await flushEffects(); });
  const render = () => {
    const rows = getFolderListingRows(tab, undefined, quickFilterProgram("no-match"));
    root.render(<FileListingShell panelId="panel-1" tabId={tab.id} columns={tab.columns} sort={tab.sort} currentPath={f.path}
      entries={rows.map(row => row.entry)} folderRows={rows} selectedEntryIds={[entry.id]} viewMode={tab.viewMode} detailsRowHeight={24}
      inlineEdit={tab.inlineEdit} onSort={() => {}} onSelect={() => {}} onOpen={() => {}} onOpenContextMenu={() => {}}
      onOpenNativeContextMenu={() => {}} onResizeColumn={() => {}} onDropEntries={() => {}}
      onInlineEditChange={() => {}} onInlineEditCommit={() => {}} onInlineEditCancel={() => { tab.inlineEdit = undefined; render(); }} />);
  };
  try {
    for (const viewMode of ["details", "large-icons", "tiles", "list"] as const) {
      tab.viewMode = viewMode;
      tab.inlineEdit = { mode: "rename", kind: "file", value: entry.name, parentPath: entry.parentPath,
        entryId: entry.id, originalName: entry.name, originalPath: entry.path };
      await tick(render);
      const input = document.querySelector<HTMLInputElement>(".inline-edit-input");
      assert.ok(input, `${viewMode}: copied entry must render an editor despite the quick filter`);
      assert.equal(document.activeElement, input, `${viewMode}: editor must take keyboard focus`);
      await tick(() => input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      assert.equal(document.querySelector(".inline-edit-input"), null);
      assert.equal(getFolderListingRows(tab, undefined, quickFilterProgram("no-match")).length, 0);
      assert.equal(tab.snapshot.entries[0].path, entry.path, "cancel hides the row again without removing the file");
    }
    console.log("ok - created copies render a focused inline editor through filters in every listing layout");
  } finally { await tick(() => root.unmount()); }
})();

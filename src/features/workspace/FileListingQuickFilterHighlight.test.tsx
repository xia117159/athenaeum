import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { FileListingShell } from "./FileListing";
import { getFolderListingRows } from "./folderExpansion";
import { expansionFixture } from "./folderExpansionTestSupport";
import { createWorkspaceState, getActiveTab } from "./workspaceReducer";
import { compileQuickFilter } from "./quickFilterMatcher";
import { assertTest, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { QuickFilterMode, QuickFilterProgram } from "./quickFilterTypes";
import type { EntryViewModel } from "./types";

function program(text: string, mode: QuickFilterMode = "highlight"): QuickFilterProgram {
  const result = compileQuickFilter(text, "substring", mode);
  assert.ok(result.ok);
  return result.program;
}

export const completion = (async () => {
  installDomEnvironment();
  const f = expansionFixture();
  const state = createWorkspaceState(f.bootstrap);
  const tab = getActiveTab(state.panels[state.activePanelId]);
  const rows = getFolderListingRows(tab);
  // 用真实 EntryViewModel 形状承载可控名称，避免自造 fixture 漂移。
  rows[0].entry.name = "my_project_dir";
  rows[1].entry.name = "时间轴";
  const entries: EntryViewModel[] = rows.map((row) => row.entry);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  const props = {
    panelId: state.activePanelId, tabId: tab.id, columns: tab.columns, sort: tab.sort,
    currentPath: f.path, selectedEntryIds: [] as string[], viewMode: "details" as const, detailsRowHeight: 24,
    onSort: () => undefined, onSelect: () => undefined, onOpen: () => undefined,
    onOpenContextMenu: () => undefined, onOpenNativeContextMenu: () => undefined,
    onResizeColumn: () => undefined, onDropEntries: () => undefined,
    onInlineEditChange: () => undefined, onInlineEditCommit: () => undefined, onInlineEditCancel: () => undefined
  };

  const marks = () => [...container.querySelectorAll<HTMLElement>(".entry-name__match")].map((mark) => mark.textContent);

  async function render(quickFilter: QuickFilterProgram | null) {
    await act(async () => {
      root.render(<FileListingShell {...props} entries={entries} quickFilter={quickFilter} />);
      await flushEffects();
    });
  }

  await assertTest("the listing DOM marks the matched substring without touching the name text", async () => {
    await render(program("project"));
    assert.deepEqual(marks(), ["project"]);
    const names = [...container.querySelectorAll<HTMLElement>(".entry-name")]
      .map((node) => node.textContent).filter((text) => text.includes("project"));
    assert.deepEqual(names, ["my_project_dir"], "the surviving text must equal the original name");
  });

  await assertTest("pinyin initials mark the matched Chinese run in the listing DOM", async () => {
    await render(program("sj"));
    assert.deepEqual(marks(), ["时间"]);
  });

  await assertTest("include and exclude modes change the row set instead of marking names", async () => {
    for (const mode of ["include", "exclude"] as const) {
      await render(program("project", mode));
      assert.deepEqual(marks(), [], `${mode} must not render marks`);
    }
  });

  await assertTest("no filter program leaves the listing completely unmarked", async () => {
    await render(null);
    assert.deepEqual(marks(), []);
    assert.ok([...container.querySelectorAll<HTMLElement>(".entry-name")].some((node) => node.textContent === "my_project_dir"));
    await act(async () => { root.unmount(); await flushEffects(); });
    container.remove();
  });
})();

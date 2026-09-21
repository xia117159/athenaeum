import assert from "node:assert/strict";
import { getFolderListingRows } from "./folderExpansion";
import { expansionEntry, expansionFixture, quickFilterProgram } from "./folderExpansionTestSupport";
import type { TabViewMode } from "./types";

const f = expansionFixture(), tab = f.bootstrap.panels["panel-1"].tabs.find(tab => tab.id === f.tabId)!;
const entry = expansionEntry(f.path, "new-template.txt", "file"); tab.snapshot.entries = [entry];
for (const viewMode of ["details", "large-icons", "tiles", "list"] as TabViewMode[]) {
  tab.viewMode = viewMode;
  assert.equal(getFolderListingRows(tab, undefined, quickFilterProgram("other-name")).length, 0);
  tab.inlineEdit = { mode: "rename", value: entry.name, kind: "file", parentPath: entry.parentPath,
    entryId: entry.id, originalName: entry.name, originalPath: entry.path };
  assert.equal(getFolderListingRows(tab, undefined, quickFilterProgram("other-name"))[0]?.entry.id, entry.id, `${viewMode}: reveal active inline editor through a quick filter`);
  tab.inlineEdit = undefined;
  assert.equal(getFolderListingRows(tab, undefined, quickFilterProgram("other-name")).length, 0, "cancel restores original filtering");
}
console.log("ok - new copies remain reachable during inline rename with an active quick filter");

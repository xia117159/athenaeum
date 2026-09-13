import assert from "node:assert/strict";
import { captureRenameTarget } from "./renameTarget";
import { createWorkspaceState } from "./workspaceReducer";
import { createMockWorkspaceBootstrap } from "./mockData";
import { createEntry } from "./workspaceControllerTestHarness";
import { getPathComparisonKey } from "./workspacePathRelations";

const state = createWorkspaceState(createMockWorkspaceBootstrap("tauri"));
const panel = state.panels["panel-1"], tab = panel.tabs.find(item => item.id === panel.activeTabId)!;
const entries = Array.from({ length: 10000 }, (_, index) => createEntry(tab.snapshot.location.path, `File${index}.txt`));
const paths = entries.map(entry => entry.path.toLowerCase().replace(/\\/g, "/")).reverse();
let reads = 0;
for (const entry of entries) {
  const path = entry.path;
  Object.defineProperty(entry, "path", { get() {
    assert.ok(++reads <= entries.length * 6, "capturing a large selection must have a linear path access budget");
    return path;
  } });
}
tab.snapshot.entries = entries;
const target = captureRenameTarget(state, "panel-1", "contextMenu", tab.id, paths)!;
assert.equal(target.entries.length, 10000);
assert.equal(target.entries[0].name, "File9999.txt");
assert.equal(target.entries.at(-1)?.name, "File0.txt");
assert.equal(captureRenameTarget(state, "panel-1", "contextMenu", tab.id, ["D:\\missing.txt"]), undefined);

const folder = createEntry(tab.snapshot.location.path, "Folder", "folder");
const child = createEntry(folder.path, "Nested.txt");
tab.snapshot.entries = [folder, entries[0]];
tab.viewMode = "details";
tab.folderExpansion = { [getPathComparisonKey(folder.path)]: { path: folder.path, status: "ready", entries: [child] } };
assert.deepEqual(captureRenameTarget(state, "panel-1", "contextMenu", tab.id, [child.path, entries[0].path])?.entries.map(entry => entry.name),
  ["Nested.txt", "File0.txt"]);
console.log("ok - native rename capture keeps request order with bounded lookup, aliases, expanded children and missing paths");

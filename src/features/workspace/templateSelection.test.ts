import assert from "node:assert/strict";
import type { CreationTemplateEntry } from "../../app/templates";
import { templateSelectionStatus, toggleTemplateSelection } from "./templateSelection";

const item = (relativePath: string, kind: CreationTemplateEntry["kind"] = "file"): CreationTemplateEntry =>
  ({ name: relativePath.split("/").at(-1)!, relativePath, path: `C:\\Templates\\${relativePath.replaceAll("/", "\\")}`, kind });
const a = item("Word/a.docx"), b = item("PPT/b.pptx"), folder = item("Word", "directory");
let selected = toggleTemplateSelection([], a); selected = toggleTemplateSelection(selected, b);
assert.equal(selected.length, 2, "cross-level files accumulate");
selected = toggleTemplateSelection(selected, folder);
assert.deepEqual(selected.map(e => e.relativePath), [b.relativePath, folder.relativePath], "parent replaces descendants");
assert.equal(templateSelectionStatus(selected, a), "included");
assert.equal(templateSelectionStatus(selected, item("Word2/a.docx")), "none", "ancestor matching requires a separator");
assert.equal(templateSelectionStatus(selected, item("word", "directory")), "selected");
assert.deepEqual(toggleTemplateSelection(selected, a), selected, "included descendant cannot be selected twice");
selected = toggleTemplateSelection(selected, folder);
assert.deepEqual(selected.map(e => e.relativePath), [b.relativePath], "deselecting parent never resurrects earlier descendants");
assert.deepEqual(toggleTemplateSelection(selected, item("ppt/B.PPTX")), []);
console.log("ok - template mixed selection honors ancestors, boundaries and case-insensitive de-duplication");

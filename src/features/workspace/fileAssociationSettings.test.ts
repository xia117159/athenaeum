import assert from "node:assert/strict";
import type { FileAssociationRule } from "../../app/fileAssociations";
import { createMockWorkspaceBootstrap } from "./mockData";
import { mapSettingsModel, normalizeSettingsModel, normalizeSettingsSection } from "./workspaceMappers";
import { createBrowserSettingsSnapshot, toBackendSettingsModelUpdate } from "./workspaceBackendDtos";
const rules: FileAssociationRule[] = [{
  id:"persisted-1", patterns:"*.md; .json; txt;", executablePath:String.raw` D:\Program Files (x86)\中文编辑器.exe `,
  argumentsTemplate:"--new-window {file}"
}];
const source = Object.assign(createMockWorkspaceBootstrap("mock").settingsModel, {fileAssociations:rules});
const normalized = normalizeSettingsModel(source);
assert.deepEqual((normalized as typeof source).fileAssociations, rules, "normalization must preserve raw editor drafts");
const dto = toBackendSettingsModelUpdate(normalized) as unknown as {fileAssociations:FileAssociationRule[]};
assert.equal(dto.fileAssociations[0].patterns, "*.md;.json;txt");
assert.equal(dto.fileAssociations[0].executablePath, rules[0].executablePath.trim());
assert.equal(source.fileAssociations[0].patterns, rules[0].patterns, "saving must not mutate the draft");
const incoming = mapSettingsModel(Object.assign(createBrowserSettingsSnapshot(), {fileAssociations: dto.fileAssociations}));
assert.deepEqual((incoming as typeof source).fileAssociations, dto.fileAssociations);
assert.deepEqual((mapSettingsModel(createBrowserSettingsSnapshot()) as typeof source).fileAssociations, []);
assert.equal(normalizeSettingsSection("file-associations"), "file-associations");
console.log("ok - association settings preserve drafts and round-trip compatible metadata");

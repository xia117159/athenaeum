import assert from "node:assert/strict";
import { createMockWorkspaceBootstrap } from "./mockData";
import { mapSettingsModel, normalizeSettingsModel } from "./workspaceMappers";
import { createBrowserSettingsSnapshot, toBackendSettingsModelUpdate } from "./workspaceBackendDtos";

const draft = Object.assign(createMockWorkspaceBootstrap("mock").settingsModel, { templateRoot: String.raw` C:\模板文件 ` });
const normalized = normalizeSettingsModel(draft) as typeof draft;
assert.equal(normalized.templateRoot, draft.templateRoot, "normalization preserves the settings draft");
const dto = toBackendSettingsModelUpdate(normalized) as unknown as { templateRoot: string };
assert.equal(dto.templateRoot, draft.templateRoot.trim());
const mapped = mapSettingsModel(Object.assign(createBrowserSettingsSnapshot(), { templateRoot: dto.templateRoot })) as typeof draft;
assert.equal(mapped.templateRoot, dto.templateRoot);
assert.equal((mapSettingsModel(createBrowserSettingsSnapshot()) as typeof draft).templateRoot, "");
console.log("ok - template root is preserved in settings drafts and serialized in both directions");

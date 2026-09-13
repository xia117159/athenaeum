import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_THEME, mapSettingsModel, normalizeSettingsModel } from "./workspaceMappers";
import { createBrowserSettingsSnapshot, toBackendTheme } from "./workspaceBackendDtos";
import { createMockWorkspaceBootstrap } from "./mockData";
import { listenWorkspaceSettingsChanged, saveWorkspaceTheme } from "./workspaceSettingsGateway";

test("size bar endpoints default on both old and invalid settings, normalized with alpha on every DTO path", () => {
  assert.equal(Reflect.get(DEFAULT_THEME, "sizeBarLow"), "#dceaf7");
  assert.equal(Reflect.get(DEFAULT_THEME, "sizeBarHigh"), "#3979b7");
  const old = createBrowserSettingsSnapshot();
  Reflect.deleteProperty(old.theme!, "sizeBarLow"); Reflect.deleteProperty(old.theme!, "sizeBarHigh");
  assert.equal(Reflect.get(mapSettingsModel(old).theme, "sizeBarLow"), "#dceaf7");
  const model = createMockWorkspaceBootstrap("mock").settingsModel;
  const input = { ...model, theme: { ...model.theme, sizeBarLow: " #ABCDEF80 ", sizeBarHigh: "invalid" } };
  const normalized = normalizeSettingsModel(input);
  assert.equal(Reflect.get(normalized.theme, "sizeBarLow"), "#abcdef80");
  assert.equal(Reflect.get(normalized.theme, "sizeBarHigh"), "#3979b7");
  assert.equal(Reflect.get(toBackendTheme(input.theme), "sizeBarLow"), "#abcdef80");
});

test("size bar endpoint changes persist through the existing theme command and settings event", async () => {
  const theme = { ...DEFAULT_THEME, sizeBarLow: "#12345640", sizeBarHigh: "#abcdefff" };
  const calls: unknown[] = [];
  await saveWorkspaceTheme(theme, { runtimeHost: { __TAURI_INTERNALS__: {} },
    invoke: async <T>(command: string, args: Record<string, unknown>) => { calls.push({ command, args }); return undefined as T; } });
  assert.deepEqual(calls, [{ command: "save_ui_theme", args: { theme } }]);
  const snapshot = createBrowserSettingsSnapshot({ theme });
  let received: unknown;
  const dispose = await listenWorkspaceSettingsChanged((event) => { received = event.settingsModel.theme; }, {
    runtimeHost: { __TAURI_INTERNALS__: {} }, listen: async <T>(_name: string, listener: (event: { payload: T }) => void) => {
      listener({ payload: snapshot as T }); return () => undefined;
    }
  });
  assert.deepEqual(received, theme); dispose();
});

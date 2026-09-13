import assert from "node:assert/strict";
import { test } from "node:test";
import { createMockWorkspaceBootstrap } from "./mockData";
import { createBrowserSettingsSnapshot, toBackendSettingsModelUpdate } from "./workspaceBackendDtos";
import { mapSettingsSnapshotToWorkspaceSettings, normalizeSettingsModel } from "./workspaceMappers";
import { listenWorkspaceSettingsChanged, saveWorkspaceSettingsModel } from "./workspaceSettingsGateway";

test("folder expansion is disabled by default, including legacy settings without the field", () => {
  const snapshot = createBrowserSettingsSnapshot();
  Reflect.deleteProperty(snapshot, "folderExpansionEnabled");
  const model = mapSettingsSnapshotToWorkspaceSettings(snapshot).settingsModel;
  assert.equal(Reflect.get(model, "folderExpansionEnabled"), false);
  assert.equal(Reflect.get(createMockWorkspaceBootstrap().settingsModel, "folderExpansionEnabled"), false);
});

test("folder expansion survives workspace normalization and the settings IPC round trip", () => {
  for (const enabled of [true, false]) {
    const snapshot = { ...createBrowserSettingsSnapshot(), folderExpansionEnabled: enabled };
    const model = mapSettingsSnapshotToWorkspaceSettings(snapshot).settingsModel;
    assert.equal(Reflect.get(normalizeSettingsModel(model), "folderExpansionEnabled"), enabled);
    assert.equal(Reflect.get(toBackendSettingsModelUpdate(model), "folderExpansionEnabled"), enabled);
  }
});

test("saving and receiving settings carries the folder expansion choice", async () => {
  const model = { ...createMockWorkspaceBootstrap().settingsModel, folderExpansionEnabled: true };
  const snapshot = { ...createBrowserSettingsSnapshot(), folderExpansionEnabled: true };
  let saved: unknown;
  await saveWorkspaceSettingsModel(model, {
    runtimeHost: { __TAURI_INTERNALS__: {} },
    invoke: async <T>(command: string, args: Record<string, unknown>) => {
      assert.equal(command, "save_settings_model");
      saved = Reflect.get(args.model as object, "folderExpansionEnabled");
      return snapshot as T;
    }
  });
  assert.equal(saved, true);
  let received: unknown;
  await listenWorkspaceSettingsChanged((value) => {
    received = Reflect.get(value.settingsModel, "folderExpansionEnabled");
  }, {
    runtimeHost: { __TAURI_INTERNALS__: {} },
    listen: async (name, handler) => {
      assert.equal(name, "settings_changed");
      await handler({ payload: snapshot as never });
      return () => undefined;
    }
  });
  assert.equal(received, true);
});

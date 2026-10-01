import assert from "node:assert/strict";
import { test } from "node:test";
import { createMockWorkspaceBootstrap } from "./mockData";
import { createBrowserSettingsSnapshot, toBackendSettingsModelUpdate } from "./workspaceBackendDtos";
import { mapSettingsSnapshotToWorkspaceSettings, normalizeSettingsModel } from "./workspaceMappers";
import { listenWorkspaceSettingsChanged, saveWorkspaceSettingsModel } from "./workspaceSettingsGateway";

test("tree auto follow is disabled by default, including legacy settings without the field", () => {
  const snapshot = createBrowserSettingsSnapshot();
  Reflect.deleteProperty(snapshot, "treeAutoFollowEnabled");
  const model = mapSettingsSnapshotToWorkspaceSettings(snapshot).settingsModel;
  assert.equal(Reflect.get(model, "treeAutoFollowEnabled"), false);
  assert.equal(Reflect.get(createMockWorkspaceBootstrap().settingsModel, "treeAutoFollowEnabled"), false);
});

test("tree auto follow survives workspace normalization and the settings IPC round trip", () => {
  for (const enabled of [true, false]) {
    const snapshot = { ...createBrowserSettingsSnapshot(), treeAutoFollowEnabled: enabled };
    const model = mapSettingsSnapshotToWorkspaceSettings(snapshot).settingsModel;
    assert.equal(Reflect.get(normalizeSettingsModel(model), "treeAutoFollowEnabled"), enabled);
    assert.equal(Reflect.get(toBackendSettingsModelUpdate(model), "treeAutoFollowEnabled"), enabled);
  }
});

test("saving and receiving settings carries the tree auto follow choice", async () => {
  const model = { ...createMockWorkspaceBootstrap().settingsModel, treeAutoFollowEnabled: true };
  const snapshot = { ...createBrowserSettingsSnapshot(), treeAutoFollowEnabled: true };
  let saved: unknown;
  await saveWorkspaceSettingsModel(model, {
    runtimeHost: { __TAURI_INTERNALS__: {} },
    invoke: async <T>(command: string, args: Record<string, unknown>) => {
      assert.equal(command, "save_settings_model");
      saved = Reflect.get(args.model as object, "treeAutoFollowEnabled");
      return snapshot as T;
    }
  });
  assert.equal(saved, true);
  let received: unknown;
  await listenWorkspaceSettingsChanged((value) => {
    received = Reflect.get(value.settingsModel, "treeAutoFollowEnabled");
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

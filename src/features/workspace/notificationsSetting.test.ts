import assert from "node:assert/strict";
import { test } from "node:test";
import { createMockWorkspaceBootstrap } from "./mockData";
import { createBrowserSettingsSnapshot, toBackendSettingsModelUpdate } from "./workspaceBackendDtos";
import { mapSettingsSnapshotToWorkspaceSettings, normalizeSettingsModel } from "./workspaceMappers";
import { listenWorkspaceSettingsChanged, saveWorkspaceSettingsModel } from "./workspaceSettingsGateway";

test("notifications are hidden by default, including legacy settings without the field", () => {
  const snapshot = createBrowserSettingsSnapshot();
  Reflect.deleteProperty(snapshot, "notificationsEnabled");
  const model = mapSettingsSnapshotToWorkspaceSettings(snapshot).settingsModel;
  assert.equal(Reflect.get(model, "notificationsEnabled"), false);
  // 全新后端快照缺该字段时同样默认隐藏（serde default → false）。
  assert.equal(
    Reflect.get(mapSettingsSnapshotToWorkspaceSettings(createBrowserSettingsSnapshot()).settingsModel, "notificationsEnabled"),
    false
  );
});

test("notifications setting survives workspace normalization and the settings IPC round trip", () => {
  for (const enabled of [true, false]) {
    const snapshot = { ...createBrowserSettingsSnapshot(), notificationsEnabled: enabled };
    const model = mapSettingsSnapshotToWorkspaceSettings(snapshot).settingsModel;
    assert.equal(Reflect.get(normalizeSettingsModel(model), "notificationsEnabled"), enabled);
    assert.equal(Reflect.get(toBackendSettingsModelUpdate(model), "notificationsEnabled"), enabled);
  }
});

test("saving and receiving settings carries the notifications choice", async () => {
  const model = { ...createMockWorkspaceBootstrap().settingsModel, notificationsEnabled: true };
  const snapshot = { ...createBrowserSettingsSnapshot(), notificationsEnabled: true };
  let saved: unknown;
  await saveWorkspaceSettingsModel(model, {
    runtimeHost: { __TAURI_INTERNALS__: {} },
    invoke: async <T>(command: string, args: Record<string, unknown>) => {
      assert.equal(command, "save_settings_model");
      saved = Reflect.get(args.model as object, "notificationsEnabled");
      return snapshot as T;
    }
  });
  assert.equal(saved, true);
  let received: unknown;
  await listenWorkspaceSettingsChanged((value) => {
    received = Reflect.get(value.settingsModel, "notificationsEnabled");
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
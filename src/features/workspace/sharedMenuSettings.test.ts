import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_THEME, mapSettingsModel, normalizeSettingsModel } from "./workspaceMappers";
import { createBrowserSettingsSnapshot, toBackendSettingsModelUpdate, toBackendTheme } from "./workspaceBackendDtos";
import { listenWorkspaceSettingsChanged, saveWorkspaceTheme } from "./workspaceSettingsGateway";
import { getShortcutBinding } from "./workspaceShortcuts";

const colors = { menuHoverBackground: "#e5f1fb", menuHoverText: "#1f1f1f", fileHoverBorder: "#91c9f7" };

test("menu and file hover colors default old settings and normalize all settings DTO paths", () => {
  const old = createBrowserSettingsSnapshot();
  for (const key of Object.keys(colors)) Reflect.deleteProperty(old.theme!, key);
  const model = mapSettingsModel(old);
  for (const [key, fallback] of Object.entries(colors)) {
    assert.equal(Reflect.get(DEFAULT_THEME, key), fallback);
    assert.equal(Reflect.get(model.theme, key), fallback);
    for (const [input, expected] of [[" #ABCDEF80 ", "#abcdef80"], ["invalid", fallback]]) {
      const draft = { ...model, theme: { ...model.theme, [key]: input } };
      assert.equal(Reflect.get(normalizeSettingsModel(draft).theme, key), expected);
      assert.equal(Reflect.get(toBackendTheme(draft.theme), key), expected);
      const saved = toBackendSettingsModelUpdate(draft);
      assert.equal(Reflect.get(mapSettingsModel({ ...old, ...saved }).theme, key), expected);
    }
  }
});

test("hover colors survive the existing theme command and settings change event", async () => {
  const theme = { ...DEFAULT_THEME, menuHoverBackground: "#12345680", menuHoverText: "#abcdef", fileHoverBorder: "#fedcba" };
  const calls: unknown[] = [];
  await saveWorkspaceTheme(theme, { runtimeHost: { __TAURI_INTERNALS__: {} },
    invoke: async <T>(command: string, args: Record<string, unknown>) => { calls.push({ command, args }); return undefined as T; } });
  assert.deepEqual(calls, [{ command: "save_ui_theme", args: { theme } }]);
  let received: unknown;
  const dispose = await listenWorkspaceSettingsChanged(event => { received = event.settingsModel.theme; }, {
    runtimeHost: { __TAURI_INTERNALS__: {} }, listen: async <T>(_name: string, listener: (event: { payload: T }) => void) => {
      listener({ payload: createBrowserSettingsSnapshot({ theme }) as T }); return () => undefined;
    }
  });
  assert.deepEqual(received, theme); dispose();
});

test("persisted Open With and Batch Rename bindings always display Chinese metadata", () => {
  const snapshot = createBrowserSettingsSnapshot({ shortcuts: [
    { id: "open-with", action: "open-with", accelerator: "Alt+O", scope: "listing" },
    { id: "batch-rename", action: "batch-rename", accelerator: "Ctrl+Shift+M", scope: "listing" },
    { id: "copy", action: "Copy", accelerator: "Alt+C", scope: "listing" }
  ] });
  const model = mapSettingsModel(snapshot);
  for (const [id, title, binding] of [["open-with", "打开方式", "Alt+O"], ["batch-rename", "批量重命名", "Ctrl+Shift+M"], ["copy", "复制", "Alt+C"]]) {
    for (const settings of [model, mapSettingsModel({ ...snapshot, ...toBackendSettingsModelUpdate(model) }),
      normalizeSettingsModel({ ...model, shortcuts: model.shortcuts.map(item => ({ ...item, action: item.id, description: item.id })) })]) {
      const shortcut = settings.shortcuts.find(item => item.id === id)!;
      assert.equal(shortcut.action, title);
      assert.match(shortcut.description, /[\u4e00-\u9fff]/);
      assert.equal(shortcut.binding, binding);
    }
  }
  assert.equal(getShortcutBinding([], "undo"), "Ctrl+Z");
});

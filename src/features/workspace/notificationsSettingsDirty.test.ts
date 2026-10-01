import assert from "node:assert/strict";
import { test } from "node:test";
import { createMockWorkspaceBootstrap } from "./mockData";
import { createWorkspaceState } from "./workspaceReducer";
import { computeDirtySections } from "./SettingsWindowView";

function stateWithNotifications(enabled: boolean) {
  const state = createWorkspaceState(createMockWorkspaceBootstrap("tauri"));
  return {
    ...state,
    settings: {
      ...state.settings,
      model: {
        ...state.settings.model,
        notificationsEnabled: enabled
      }
    }
  };
}

test("toggling only the notifications switch marks menu-mouse dirty so the settings save triggers", () => {
  const persisted = stateWithNotifications(false);
  const draft = stateWithNotifications(true);
  const dirty = computeDirtySections(
    persisted,
    draft,
    persisted.settings.model,
    [],
    {},
    false
  );
  assert.ok(dirty.has("menu-mouse"), "menu-mouse must be dirty when only notifications changed");
  // 仅改动通知开关不应牵连其它分区。
  for (const section of dirty) {
    assert.equal(section, "menu-mouse", `unexpected dirty section: ${section}`);
  }
});

test("no change produces no menu-mouse dirty section", () => {
  const persisted = stateWithNotifications(false);
  const draft = stateWithNotifications(false);
  const dirty = computeDirtySections(
    persisted,
    draft,
    persisted.settings.model,
    [],
    {},
    false
  );
  assert.equal(dirty.has("menu-mouse"), false);
});
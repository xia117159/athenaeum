import assert from "node:assert/strict";
import {
  eventToShortcutBinding,
  getShortcutBinding,
  getShortcutBindingMap,
  modifiersMatchShortcutBinding,
  normalizeShortcutBinding,
  shortcutMatches
} from "./workspaceShortcuts";
import type { SettingsModel } from "./types";

function assertTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const emptyModifiers = {
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false
};

assertTest("modifiersMatchShortcutBinding matches configurable drag modifier bindings", () => {
  assert.equal(modifiersMatchShortcutBinding({ ...emptyModifiers, shiftKey: true }, "Shift"), true);
  assert.equal(modifiersMatchShortcutBinding({ ...emptyModifiers, altKey: true }, "Alt"), true);
  assert.equal(modifiersMatchShortcutBinding({ ...emptyModifiers, ctrlKey: true }, "Ctrl"), true);
  assert.equal(modifiersMatchShortcutBinding({ ...emptyModifiers, metaKey: true }, "Ctrl"), true);
  assert.equal(modifiersMatchShortcutBinding({ ...emptyModifiers, shiftKey: true }, "Alt"), false);
  assert.equal(modifiersMatchShortcutBinding({ ...emptyModifiers, shiftKey: true }, "Ctrl+Shift"), false);
  assert.equal(modifiersMatchShortcutBinding({ ...emptyModifiers, ctrlKey: true, shiftKey: true }, "Ctrl+Shift"), true);
  assert.equal(modifiersMatchShortcutBinding({ ...emptyModifiers, shiftKey: true }, "Shift+F"), false);
});

assertTest("getShortcutBinding returns user bindings and falls back to drag move Shift", () => {
  const shortcuts: SettingsModel["shortcuts"] = [
    {
      id: "drag-move",
      action: "拖放时移动",
      scope: "listing",
      binding: "Alt",
      description: "拖放文件或文件夹时执行移动。"
    }
  ];

  assert.equal(getShortcutBinding(shortcuts, "drag-move"), "Alt");
  assert.equal(getShortcutBinding([], "drag-move"), "Shift");
  assert.equal(getShortcutBinding([], "undo"), "Ctrl+Z");
  assert.equal(getShortcutBinding([], "navigate-up"), "Alt+Up");
  assert.equal(getShortcutBinding([], "navigate-forward"), "Alt+Right");
});

assertTest("shortcutMatches does not treat empty user bindings as active shortcuts", () => {
  const bindings = getShortcutBindingMap([
    {
      id: "refresh",
      action: "刷新",
      scope: "panel",
      binding: "",
      description: "刷新当前面板。"
    }
  ]);

  assert.equal(shortcutMatches(bindings, "refresh", ""), false);
  assert.equal(shortcutMatches(new Map(), "refresh", normalizeShortcutBinding("F5")), true);
});

assertTest("eventToShortcutBinding supports single-key arrow bindings", () => {
  assert.equal(
    eventToShortcutBinding({
      key: "ArrowUp",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false
    } as KeyboardEvent),
    "up"
  );
  assert.equal(
    shortcutMatches(new Map([["navigate-up", normalizeShortcutBinding("Up")]]), "navigate-up", "up"),
    true
  );
});

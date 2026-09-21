import assert from "node:assert/strict";
import {
  eventToShortcutCaptureCandidate,
  eventToShortcutBinding,
  formatShortcutBindingForDisplay,
  getShortcutBinding,
  getShortcutBindingMap,
  isReservedSystemShortcutCandidate,
  isSingleKeyShortcutBinding,
  modifiersMatchShortcutBinding,
  normalizeShortcutBinding,
  normalizeShortcutBindingForStorage,
  shortcutMatches
} from "./workspaceShortcuts";
import type { SettingsModel } from "./types";
import { createMockWorkspaceBootstrap } from "./mockData";
import { normalizeSettingsModel } from "./workspaceMappers";
import { toBackendSettingsModelUpdate } from "./workspaceBackendDtos";
import { DEFAULT_SHORTCUTS } from "./shortcutCatalog";

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
  assert.equal(getShortcutBinding([], "context-menu-toggle"), "Shift");
  assert.equal(getShortcutBinding([], "undo"), "Ctrl+Z");
  assert.equal(getShortcutBinding([], "navigate-up"), "Alt+Up");
  assert.equal(getShortcutBinding([], "navigate-forward"), "Alt+Right");
  assert.equal(getShortcutBinding([], "copy-name"), "Alt+Shift+N");
  assert.equal(getShortcutBinding([], "copy-path"), "Alt+Shift+P");
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

assertTest("space events match captured plain and modified Space bindings", () => {
  for (const modifiers of [emptyModifiers, { ...emptyModifiers, ctrlKey: true }, { ...emptyModifiers, shiftKey: true }]) {
    const event = { key: " ", ...modifiers } as KeyboardEvent;
    const captured = eventToShortcutCaptureCandidate(event);
    assert.ok(captured.endsWith("Space"));
    assert.equal(eventToShortcutBinding(event), normalizeShortcutBinding(captured));
  }
});

assertTest("folder expansion shortcut is added to legacy settings and keeps customized bindings through IPC", () => {
  const model = createMockWorkspaceBootstrap().settingsModel;
  model.shortcuts = model.shortcuts.filter(shortcut => shortcut.id !== "toggle-folder-expansion");
  const normalized = normalizeSettingsModel(model);
  const shortcut = normalized.shortcuts.find(shortcut => shortcut.id === "toggle-folder-expansion");
  assert.ok(shortcut);
  assert.equal(shortcut.binding, "Space");
  assert.equal(shortcut.scope, "listing");
  assert.equal(getShortcutBinding([], shortcut.id), "Space");
  shortcut.binding = "Ctrl+Space";
  const roundTrip = normalizeSettingsModel(normalized);
  assert.equal(getShortcutBinding(roundTrip.shortcuts, shortcut.id), "Ctrl+Space");
  assert.equal(toBackendSettingsModelUpdate(roundTrip).shortcuts.find(item => item.id === shortcut.id)?.accelerator, "Ctrl+Space");
});

assertTest("normalizeShortcutBindingForStorage keeps saved accelerators aligned with backend validation", () => {
  assert.equal(normalizeShortcutBindingForStorage(" Alt + Ctrl + p "), "Ctrl+Alt+P");
  assert.equal(normalizeShortcutBindingForStorage("ctrl+shift+n"), "Ctrl+Shift+N");
  assert.equal(normalizeShortcutBindingForStorage("ArrowUp"), "Up");
  assert.equal(normalizeShortcutBindingForStorage("delete"), "Delete");
  assert.equal(normalizeShortcutBindingForStorage("Ctrl+Alt"), "Ctrl+Alt");
  assert.equal(formatShortcutBindingForDisplay(" ctrl + alt + p "), "Ctrl+Alt+P");
});

assertTest("eventToShortcutCaptureCandidate creates live capture labels from key events", () => {
  assert.equal(
    eventToShortcutCaptureCandidate({
      key: "Control",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false
    } as KeyboardEvent),
    "Ctrl"
  );
  assert.equal(
    eventToShortcutCaptureCandidate({
      key: "p",
      ctrlKey: true,
      metaKey: false,
      altKey: true,
      shiftKey: false
    } as KeyboardEvent),
    "Ctrl+Alt+P"
  );
  assert.equal(
    eventToShortcutCaptureCandidate({
      key: "ArrowUp",
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: false
    } as KeyboardEvent),
    "Alt+Up"
  );
  assert.equal(
    eventToShortcutCaptureCandidate({
      key: "Dead",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false
    } as KeyboardEvent),
    ""
  );
  for (const blockedKey of ["Unidentified", "Process"]) {
    assert.equal(
      eventToShortcutCaptureCandidate({
        key: blockedKey,
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false
      } as KeyboardEvent),
      ""
    );
  }
  assert.equal(
    eventToShortcutCaptureCandidate({
      key: "p",
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: false
    } as KeyboardEvent),
    ""
  );
  assert.equal(
    eventToShortcutCaptureCandidate({
      key: "p",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: true
    } as KeyboardEvent),
    ""
  );
});

assertTest("navigate-parent is removed from default shortcut bindings", () => {
  assert.equal(getShortcutBinding([], "navigate-parent"), "");
  assert.equal(
    shortcutMatches(new Map(), "navigate-parent", normalizeShortcutBinding("Backspace")),
    false
  );
});

assertTest("isReservedSystemShortcutCandidate protects OS-level key combinations", () => {
  assert.equal(isReservedSystemShortcutCandidate("Alt"), true);
  assert.equal(isReservedSystemShortcutCandidate("Alt+Tab"), true);
  assert.equal(isReservedSystemShortcutCandidate("Alt+F4"), true);
  assert.equal(isReservedSystemShortcutCandidate("Meta+P"), true);
  assert.equal(isReservedSystemShortcutCandidate("Ctrl+Alt+Delete"), true);
  assert.equal(isReservedSystemShortcutCandidate("Ctrl+Alt+P"), false);
});

// ===== B25/D25：单键快捷键优先于键盘直输（规格 §8 分片 4b 纯函数矩阵）=====

assertTest("isSingleKeyShortcutBinding requires both a single-char form and a configured binding", () => {
  // 反例 1：未配置任何单键快捷键时，单字符形态不能单独让位（否则 B14 直输被整体废掉）。
  assert.equal(isSingleKeyShortcutBinding(new Map(), "s"), false);
  assert.equal(isSingleKeyShortcutBinding(new Map(), "p"), false);
  // 正例：配置了 s 后，事件绑定 s 命中。
  assert.equal(isSingleKeyShortcutBinding(new Map([["navigate-up", "s"]]), "s"), true);
  // 反例 2（评审 S4）：配置了 s、按下 p，必须为 false（不能把"任一绑定是单字符"当成命中）。
  assert.equal(isSingleKeyShortcutBinding(new Map([["navigate-up", "s"]]), "p"), false);
  // 空绑定不匹配（与 shortcutMatches 的 binding.length > 0 守卫一致）。
  assert.equal(isSingleKeyShortcutBinding(new Map([["clear-selection", ""]]), "s"), false);
});

assertTest("isSingleKeyShortcutBinding treats Shift as a distinct binding half", () => {
  // 用户明确要求：绑 s 与 Shift+S 的大写 S 没有关系（D25 ①）。
  assert.equal(isSingleKeyShortcutBinding(new Map([["navigate-up", "s"]]), "shift+s"), false);
  // 除非 Shift+S 自身也被绑定——此时 shift+s 直接命中。
  assert.equal(
    isSingleKeyShortcutBinding(new Map([["navigate-up", "s"], ["select-next", "shift+s"]]), "shift+s"),
    true
  );
  // CapsLock+字母（impl-03-b25 G-01 记录）：{key:"S", shiftKey:false} 的事件绑定仍是 "s"，
  // 因此被 s 绑定命中——这是既有规范化语义（CapsLock 不进入事件绑定），与 D25 ① 的
  // "真实 Shift 键"边界自洽，spec §9 已记录不修；此处把该形态锁成可追踪的语义。
  assert.equal(
    isSingleKeyShortcutBinding(new Map([["navigate-up", "s"]]), eventToShortcutBinding({ key: "S", shiftKey: false } as KeyboardEvent)),
    true
  );
});

assertTest("isSingleKeyShortcutBinding rejects non printable-single-char event bindings", () => {
  const bindings = new Map([
    ["clear-selection", "escape"],
    ["toggle-folder-expansion", "space"],
    ["open-search", "ctrl+s"],
    ["open-with", "alt+s"],
    ["refresh", "f2"],
    ["select-previous", "up"],
    ["open-entry", "enter"],
    ["delete", "delete"]
  ]);
  for (const eventBinding of ["escape", "space", "ctrl+s", "alt+s", "f2", "up", "enter", "delete"]) {
    assert.equal(isSingleKeyShortcutBinding(bindings, eventBinding), false,
      `event binding "${eventBinding}" must never yield even when configured`);
  }
  // 组合期键（IME）：key === "Process" → 事件绑定 "process"，不匹配形态面。
  assert.equal(
    isSingleKeyShortcutBinding(bindings, eventToShortcutBinding({ key: "Process", isComposing: true } as KeyboardEvent)),
    false
  );
});

assertTest("isSingleKeyShortcutBinding matches the normalized stored binding", () => {
  // 大小写与书写形式归一：" S "（含空白/大写）经 getShortcutBindingMap 规范化后命中事件 "s"。
  const bindings = getShortcutBindingMap([
    { id: "navigate-up", action: "上一级", scope: "panel", binding: " S ", description: "" }
  ]);
  assert.equal(bindings.get("navigate-up"), "s");
  assert.equal(isSingleKeyShortcutBinding(bindings, "s"), true);
  assert.equal(isSingleKeyShortcutBinding(bindings, "shift+s"), false);
});

assertTest("no default shortcut binding is a printable single char (出厂零影响不变量)", () => {
  const bindings = getShortcutBindingMap(DEFAULT_SHORTCUTS.map((shortcut) => ({ ...shortcut })));
  // 枚举直输实际会消费的 94 个 ASCII 字符（0x21–0x7E）及其 Shift 形态：
  // 出厂默认配置下，任何一个都不可能是单键快捷键的命中目标。
  for (let code = 0x21; code <= 0x7E; code += 1) {
    const character = String.fromCharCode(code);
    assert.equal(isSingleKeyShortcutBinding(bindings, character), false, `default config must not yield "${character}"`);
    assert.equal(isSingleKeyShortcutBinding(bindings, `shift+${character}`), false,
      `default config must not yield "shift+${character}"`);
  }
});

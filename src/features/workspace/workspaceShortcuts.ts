import type { SettingsModel } from "./types";

type ModifierState = {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

const MODIFIER_ORDER = ["ctrl", "cmd", "meta", "alt", "shift"];
const MODIFIER_KEYS = new Set(["control", "ctrl", "cmd", "meta", "alt", "shift"]);

const DEFAULT_SHORTCUT_BINDING_LABELS = new Map([
  ["focus-next-panel", "Tab"],
  ["open-search", "Ctrl+F"],
  ["new-tab", "Ctrl+T"],
  ["close-tab", "Ctrl+W"],
  ["copy", "Ctrl+C"],
  ["cut", "Ctrl+X"],
  ["paste", "Ctrl+V"],
  ["undo", "Ctrl+Z"],
  ["create-folder", "Ctrl+Shift+N"],
  ["delete", "Delete"],
  ["rename", "F2"],
  ["refresh", "F5"],
  ["navigate-up", "Alt+Up"],
  ["navigate-forward", "Alt+Right"],
  ["drag-move", "Shift"]
]);

export const DEFAULT_SHORTCUT_BINDINGS = new Map(
  Array.from(DEFAULT_SHORTCUT_BINDING_LABELS, ([actionId, binding]) => [actionId, normalizeShortcutBinding(binding)])
);

export function normalizeShortcutBinding(binding: string) {
  return binding
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .sort((left, right) => {
      const leftIndex = MODIFIER_ORDER.indexOf(left);
      const rightIndex = MODIFIER_ORDER.indexOf(right);
      return (leftIndex === -1 ? MODIFIER_ORDER.length : leftIndex) - (rightIndex === -1 ? MODIFIER_ORDER.length : rightIndex);
    })
    .join("+");
}

export function eventToShortcutBinding(event: KeyboardEvent) {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) {
    parts.push("ctrl");
  }
  if (event.altKey) {
    parts.push("alt");
  }
  if (event.shiftKey) {
    parts.push("shift");
  }

  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase().replace(/^arrow/, "");
  if (!MODIFIER_KEYS.has(key)) {
    parts.push(key);
  }
  return normalizeShortcutBinding(parts.join("+"));
}

export function getShortcutBindingMap(shortcuts: SettingsModel["shortcuts"]) {
  return new Map(shortcuts.map((shortcut) => [shortcut.id, normalizeShortcutBinding(shortcut.binding)]));
}

export function getShortcutBinding(shortcuts: SettingsModel["shortcuts"], actionId: string) {
  const customBinding = shortcuts.find((shortcut) => shortcut.id === actionId)?.binding;
  if (customBinding?.trim()) {
    return customBinding;
  }
  return DEFAULT_SHORTCUT_BINDING_LABELS.get(actionId) ?? "";
}

export function shortcutMatches(bindings: Map<string, string>, actionId: string, eventBinding: string) {
  const binding = bindings.get(actionId);
  if (binding !== undefined) {
    return binding.length > 0 && binding === eventBinding;
  }
  return DEFAULT_SHORTCUT_BINDINGS.get(actionId) === eventBinding;
}

export function modifiersMatchShortcutBinding(modifiers: ModifierState, binding: string) {
  const normalized = normalizeShortcutBinding(binding);
  if (!normalized) {
    return false;
  }

  const parts = normalized.split("+");
  if (parts.some((part) => !["ctrl", "cmd", "meta", "alt", "shift"].includes(part))) {
    return false;
  }

  const wantsCtrl = parts.includes("ctrl") || parts.includes("cmd") || parts.includes("meta");
  const wantsAlt = parts.includes("alt");
  const wantsShift = parts.includes("shift");
  const hasCtrl = Boolean(modifiers.ctrlKey || modifiers.metaKey);
  const hasAlt = Boolean(modifiers.altKey);
  const hasShift = Boolean(modifiers.shiftKey);

  return hasCtrl === wantsCtrl && hasAlt === wantsAlt && hasShift === wantsShift;
}

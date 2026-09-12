import type { SettingsModel } from "./types";

type ModifierState = {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

const MODIFIER_ORDER = ["ctrl", "cmd", "meta", "alt", "shift"];
const MODIFIER_KEYS = new Set(["control", "ctrl", "cmd", "meta", "alt", "shift"]);
const STORAGE_MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Meta"];
const RESERVED_KEY_TOKENS = new Set(["unidentified", "dead", "process"]);

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
  ["drag-move", "Shift"],
  ["context-menu-toggle", "Shift"],
  ["select-first", "Home"],
  ["select-last", "End"],
  ["select-previous", "Up"],
  ["select-next", "Down"],
  ["select-previous-page", "PageUp"],
  ["select-next-page", "PageDown"],
  ["select-previous-column", "Left"],
  ["select-next-column", "Right"],
  ["extend-previous", "Shift+Up"],
  ["extend-next", "Shift+Down"],
  ["extend-first", "Shift+Home"],
  ["extend-last", "Shift+End"],
  ["select-all", "Ctrl+A"],
  ["clear-selection", "Escape"],
  ["open-entry", "Enter"],
  ["open-with", "Ctrl+Alt+O"],
  ["copy-name", "Alt+Shift+N"],
  ["copy-path", "Alt+Shift+P"]
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

function toStorageKeyLabel(part: string) {
  const trimmed = part === " " ? part : part.trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed) {
    return "";
  }
  switch (lower) {
    case "control":
    case "ctrl":
      return "Ctrl";
    case "cmd":
    case "command":
    case "meta":
    case "os":
    case "win":
    case "windows":
      return "Meta";
    case "alt":
    case "option":
      return "Alt";
    case "shift":
      return "Shift";
    case "arrowup":
    case "up":
      return "Up";
    case "arrowdown":
    case "down":
      return "Down";
    case "arrowleft":
    case "left":
      return "Left";
    case "arrowright":
    case "right":
      return "Right";
    case " ":
    case "space":
    case "spacebar":
      return "Space";
    case "esc":
      return "Escape";
    case "del":
      return "Delete";
    case "backspace":
      return "Backspace";
    case "tab":
      return "Tab";
    case "enter":
    case "return":
      return "Enter";
    default:
      if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) {
        return lower.toUpperCase();
      }
      return trimmed.length === 1 ? trimmed.toUpperCase() : `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
  }
}

export function normalizeShortcutBindingForStorage(binding: string) {
  const parts = binding
    .split("+")
    .map(toStorageKeyLabel)
    .filter(Boolean);
  const modifierSet = new Set(parts.filter((part) => STORAGE_MODIFIER_ORDER.includes(part)));
  const keyParts = parts.filter((part) => !STORAGE_MODIFIER_ORDER.includes(part));
  return [...STORAGE_MODIFIER_ORDER.filter((modifier) => modifierSet.has(modifier)), ...keyParts].join("+");
}

export function formatShortcutBindingForDisplay(binding: string) {
  return normalizeShortcutBindingForStorage(binding);
}

export function eventToShortcutCaptureCandidate(event: KeyboardEvent) {
  const key = event.key;
  const normalizedKey = key === " " ? key : key.trim();
  const lowerKey = normalizedKey.toLowerCase();
  if (
    !normalizedKey ||
    RESERVED_KEY_TOKENS.has(lowerKey) ||
    event.isComposing ||
    event.metaKey ||
    ["meta", "os", "win", "windows"].includes(lowerKey)
  ) {
    return "";
  }

  const parts: string[] = [];
  if (event.ctrlKey) {
    parts.push("Ctrl");
  }
  if (event.altKey) {
    parts.push("Alt");
  }
  if (event.shiftKey) {
    parts.push("Shift");
  }

  const keyLabel = toStorageKeyLabel(normalizedKey);
  if (keyLabel && !["Ctrl", "Alt", "Shift", "Meta"].includes(keyLabel)) {
    parts.push(keyLabel);
  }
  return normalizeShortcutBindingForStorage(parts.join("+"));
}

export function isReservedSystemShortcutCandidate(binding: string | null | undefined) {
  const raw = (binding ?? "").trim().toLowerCase();
  if (!raw) {
    return false;
  }
  if (/\b(meta|cmd|command|win|windows|os)\b/.test(raw)) {
    return true;
  }

  const normalized = normalizeShortcutBindingForStorage(binding ?? "").toLowerCase();
  return normalized === "alt" || normalized === "alt+tab" || normalized === "alt+f4" || normalized === "ctrl+alt+delete";
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

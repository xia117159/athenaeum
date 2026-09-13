import type { SettingsSection } from "./types";
import { normalizeSettingsSection } from "./workspaceMappers";

const NAVIGATION_KEY = "athenaeum.settings-navigation";
const NAVIGATION_EVENT = "settings-section-requested";

export interface SettingsNavigationRequest { id: string; section: SettingsSection }
export interface SettingsNavigationRuntime {
  read(): SettingsNavigationRequest | null;
  write(request: SettingsNavigationRequest | null): void;
  emit(request: SettingsNavigationRequest): Promise<void>;
  listen(listener: (request: SettingsNavigationRequest) => void): Promise<() => void>;
}

function isSection(value: unknown): value is SettingsSection {
  return typeof value === "string" && normalizeSettingsSection(value as SettingsSection) === value;
}

function parseRequest(value: unknown): SettingsNavigationRequest | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<SettingsNavigationRequest>;
  return typeof candidate.id === "string" && isSection(candidate.section) ? candidate as SettingsNavigationRequest : null;
}

export const defaultSettingsNavigationRuntime: SettingsNavigationRuntime = {
  read() {
    const value = window.localStorage.getItem(NAVIGATION_KEY);
    if (!value) return null;
    try { return parseRequest(JSON.parse(value)); } catch { return null; }
  },
  write(request) {
    if (request) window.localStorage.setItem(NAVIGATION_KEY, JSON.stringify(request));
    else window.localStorage.removeItem(NAVIGATION_KEY);
  },
  async emit(request) {
    const { emitTo } = await import("@tauri-apps/api/event");
    await emitTo("settings", NAVIGATION_EVENT, request);
  },
  async listen(listener) {
    if (!("__TAURI_INTERNALS__" in window)) {
      const onStorage = () => { const pending = this.read(); if (pending) listener(pending); };
      window.addEventListener("storage", onStorage);
      return () => window.removeEventListener("storage", onStorage);
    }
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    return getCurrentWebviewWindow().listen<SettingsNavigationRequest>(NAVIGATION_EVENT, event => {
      const request = parseRequest(event.payload);
      if (request) listener(request);
    });
  }
};

export function requestedSettingsSection(search: string, fallback: SettingsSection): SettingsSection {
  const section = new URLSearchParams(search).get("section");
  return isSection(section) ? section : fallback;
}

export async function listenSettingsNavigation(navigate: (section: SettingsSection) => void,
  runtime = defaultSettingsNavigationRuntime): Promise<() => void> {
  const seen = new Set<string>();
  const consume = (request: SettingsNavigationRequest) => {
    const pending = runtime.read();
    if (seen.has(request.id) || (pending && pending.id !== request.id)) return;
    seen.add(request.id);
    if (seen.size > 32) seen.delete(seen.values().next().value!);
    navigate(request.section);
    if (runtime.read()?.id === request.id) runtime.write(null);
  };
  // Subscribe first, then read pending storage: creation and listener setup may race.
  const stop = await runtime.listen(consume);
  try {
    const pending = runtime.read();
    if (pending) consume(pending);
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}

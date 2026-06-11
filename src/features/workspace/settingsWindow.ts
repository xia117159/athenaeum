import type { Event } from "@tauri-apps/api/event";
import { WebviewWindow as TauriWebviewWindow, type WebviewWindow } from "@tauri-apps/api/webviewWindow";

export const SETTINGS_WINDOW_LABEL = "settings";
export const SETTINGS_WINDOW_URL = "/?view=settings";

export type SettingsWindowHandle = Pick<WebviewWindow, "show" | "setFocus" | "once">;
export type WebviewWindowConstructor = new (label: string, options: SettingsWindowOptions) => SettingsWindowHandle;

export type SettingsWindowOptions = {
  url: string;
  title: string;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  resizable: boolean;
  decorations: boolean;
  focus: boolean;
  center: boolean;
};

export type SettingsWindowAdapter = {
  hasTauriRuntime: () => boolean;
  openBrowserWindow: (url: string, target: string, features: string) => void;
  loadWebviewWindow: () => Promise<{
    WebviewWindow: WebviewWindowConstructor & {
      getByLabel: (label: string) => Promise<SettingsWindowHandle | null>;
    };
  }>;
};

const SETTINGS_WINDOW_FEATURES = "width=920,height=720,resizable=yes";

function hasTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const defaultSettingsWindowAdapter: SettingsWindowAdapter = {
  hasTauriRuntime,
  openBrowserWindow(url, target, features) {
    window.open(url, target, features);
  },
  loadWebviewWindow() {
    return Promise.resolve({ WebviewWindow: TauriWebviewWindow });
  }
};

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return JSON.stringify(error);
}

function waitForWindowCreation(windowHandle: SettingsWindowHandle) {
  return new Promise<void>((resolve, reject) => {
    void windowHandle.once("tauri://created", () => resolve());
    void windowHandle.once("tauri://error", (event: Event<unknown>) => {
      reject(new Error(`无法打开设置窗口：${toErrorMessage(event.payload)}`));
    });
  });
}

export async function openSettingsWindow(adapter: SettingsWindowAdapter = defaultSettingsWindowAdapter) {
  if (!adapter.hasTauriRuntime()) {
    adapter.openBrowserWindow(SETTINGS_WINDOW_URL, SETTINGS_WINDOW_LABEL, SETTINGS_WINDOW_FEATURES);
    return;
  }

  const { WebviewWindow } = await adapter.loadWebviewWindow();
  const existingWindow = await WebviewWindow.getByLabel(SETTINGS_WINDOW_LABEL);

  if (existingWindow) {
    await existingWindow.show();
    await existingWindow.setFocus();
    return;
  }

  const settingsWindow = new WebviewWindow(SETTINGS_WINDOW_LABEL, {
    url: SETTINGS_WINDOW_URL,
    title: "设置",
    width: 920,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    resizable: true,
    decorations: true,
    focus: true,
    center: true
  });

  await waitForWindowCreation(settingsWindow);
}

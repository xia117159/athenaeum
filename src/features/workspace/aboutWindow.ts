import type { Event } from "@tauri-apps/api/event";
import { WebviewWindow as TauriWebviewWindow, type WebviewWindow } from "@tauri-apps/api/webviewWindow";

export const ABOUT_WINDOW_LABEL = "about";
export const ABOUT_WINDOW_URL = "/?view=about";

export type AboutWindowHandle = Pick<WebviewWindow, "show" | "setFocus" | "once">;
export type AboutWindowConstructor = new (label: string, options: AboutWindowOptions) => AboutWindowHandle;

export type AboutWindowOptions = {
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

export type AboutWindowAdapter = {
  hasTauriRuntime: () => boolean;
  openBrowserWindow: (url: string, target: string, features: string) => void;
  loadWebviewWindow: () => Promise<{
    WebviewWindow: AboutWindowConstructor & {
      getByLabel: (label: string) => Promise<AboutWindowHandle | null>;
    };
  }>;
};

const ABOUT_WINDOW_FEATURES = "width=520,height=420,resizable=no";

function hasTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const defaultAboutWindowAdapter: AboutWindowAdapter = {
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

function waitForWindowCreation(windowHandle: AboutWindowHandle) {
  return new Promise<void>((resolve, reject) => {
    void windowHandle.once("tauri://created", () => resolve());
    void windowHandle.once("tauri://error", (event: Event<unknown>) => {
      reject(new Error(`无法打开关于窗口：${toErrorMessage(event.payload)}`));
    });
  });
}

export async function openAboutWindow(adapter: AboutWindowAdapter = defaultAboutWindowAdapter) {
  if (!adapter.hasTauriRuntime()) {
    adapter.openBrowserWindow(ABOUT_WINDOW_URL, ABOUT_WINDOW_LABEL, ABOUT_WINDOW_FEATURES);
    return;
  }

  const { WebviewWindow } = await adapter.loadWebviewWindow();
  const existingWindow = await WebviewWindow.getByLabel(ABOUT_WINDOW_LABEL);

  if (existingWindow) {
    await existingWindow.show();
    await existingWindow.setFocus();
    return;
  }

  const aboutWindow = new WebviewWindow(ABOUT_WINDOW_LABEL, {
    url: ABOUT_WINDOW_URL,
    title: "关于 Athenaeum",
    width: 520,
    height: 420,
    minWidth: 480,
    minHeight: 360,
    resizable: false,
    decorations: true,
    focus: true,
    center: true
  });

  await waitForWindowCreation(aboutWindow);
}

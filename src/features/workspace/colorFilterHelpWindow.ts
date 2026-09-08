import type { Event } from "@tauri-apps/api/event";
import { WebviewWindow as TauriWebviewWindow, type WebviewWindow } from "@tauri-apps/api/webviewWindow";

export const COLOR_FILTER_HELP_WINDOW_LABEL = "color-filter-help";
export const COLOR_FILTER_HELP_WINDOW_URL = "/?view=color-filter-help";

export type ColorFilterHelpWindowHandle = Pick<WebviewWindow, "show" | "setFocus" | "once">;
export type ColorFilterHelpWindowOptions = {
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
export type ColorFilterHelpWindowConstructor = new (
  label: string,
  options: ColorFilterHelpWindowOptions
) => ColorFilterHelpWindowHandle;

export type ColorFilterHelpWindowAdapter = {
  hasTauriRuntime: () => boolean;
  openBrowserWindow: (url: string, target: string, features: string) => void;
  loadWebviewWindow: () => Promise<{
    WebviewWindow: ColorFilterHelpWindowConstructor & {
      getByLabel: (label: string) => Promise<ColorFilterHelpWindowHandle | null>;
    };
  }>;
};

let pendingOpen: Promise<void> | null = null;

const defaultAdapter: ColorFilterHelpWindowAdapter = {
  hasTauriRuntime: () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window,
  openBrowserWindow: (url, target, features) => { window.open(url, target, features); },
  loadWebviewWindow: () => Promise.resolve({ WebviewWindow: TauriWebviewWindow })
};

function toErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error);
}

async function waitForCreation(windowHandle: ColorFilterHelpWindowHandle) {
  let settle: ((result: { error?: Error }) => void) | undefined;
  let settled = false;
  const terminal = new Promise<{ error?: Error }>((resolve) => { settle = resolve; });
  const settleOnce = (result: { error?: Error }) => {
    if (settled) return;
    settled = true;
    settle?.(result);
  };
  const registrations = await Promise.allSettled([
    windowHandle.once("tauri://created", () => settleOnce({})),
    windowHandle.once("tauri://error", (event: Event<unknown>) => {
      settleOnce({ error: new Error(`\u65e0\u6cd5\u6253\u5f00\u989c\u8272\u89c4\u5219\u5e2e\u52a9\u7a97\u53e3\uff1a${toErrorMessage(event.payload)}`) });
    })
  ]);
  const disposers = registrations.flatMap((registration) =>
    registration.status === "fulfilled" ? [registration.value] : []
  );
  try {
    const rejected = registrations.find((registration) => registration.status === "rejected");
    if (rejected?.status === "rejected") {
      throw new Error(`\u65e0\u6cd5\u76d1\u542c\u989c\u8272\u89c4\u5219\u5e2e\u52a9\u7a97\u53e3\u72b6\u6001\uff1a${toErrorMessage(rejected.reason)}`);
    }
    const result = await terminal;
    if (result.error) throw result.error;
  } finally {
    disposers.forEach((dispose) => dispose());
  }
}

export function openColorFilterHelpWindow(adapter: ColorFilterHelpWindowAdapter = defaultAdapter) {
  if (!adapter.hasTauriRuntime()) {
    adapter.openBrowserWindow(COLOR_FILTER_HELP_WINDOW_URL, COLOR_FILTER_HELP_WINDOW_LABEL, "width=860,height=680,resizable=yes");
    return Promise.resolve();
  }
  if (pendingOpen) return pendingOpen;

  const pending = (async () => {
    const { WebviewWindow } = await adapter.loadWebviewWindow();
    const existing = await WebviewWindow.getByLabel(COLOR_FILTER_HELP_WINDOW_LABEL);
    if (existing) {
      await existing.show();
      await existing.setFocus();
      return;
    }
    const created = new WebviewWindow(COLOR_FILTER_HELP_WINDOW_LABEL, {
      url: COLOR_FILTER_HELP_WINDOW_URL,
      title: "\u989c\u8272\u8fc7\u6ee4\u5668\u5e2e\u52a9",
      width: 860,
      height: 680,
      minWidth: 680,
      minHeight: 480,
      resizable: true,
      decorations: true,
      focus: true,
      center: true
    });
    await waitForCreation(created);
  })().finally(() => {
    if (pendingOpen === pending) pendingOpen = null;
  });
  pendingOpen = pending;
  return pending;
}

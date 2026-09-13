import type { Event } from "@tauri-apps/api/event";
import { WebviewWindow as TauriWebviewWindow, type WebviewWindow } from "@tauri-apps/api/webviewWindow";

export const OPERATION_HISTORY_WINDOW_LABEL = "operation-history";
export const OPERATION_HISTORY_WINDOW_URL = "/?view=operation-history";

export type OperationHistoryWindowHandle = Pick<WebviewWindow, "show" | "setFocus" | "once">;
export type OperationHistoryWindowConstructor = new (
  label: string,
  options: OperationHistoryWindowOptions
) => OperationHistoryWindowHandle;

export type OperationHistoryWindowOptions = {
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

export type OperationHistoryWindowAdapter = {
  hasTauriRuntime: () => boolean;
  openBrowserWindow: (url: string, target: string, features: string) => void;
  loadWebviewWindow: () => Promise<{
    WebviewWindow: OperationHistoryWindowConstructor & {
      getByLabel: (label: string) => Promise<OperationHistoryWindowHandle | null>;
    };
  }>;
};

const WINDOW_FEATURES = "width=960,height=700,resizable=yes";
let openingPromise: Promise<void> | null = null;

function hasTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const defaultOperationHistoryWindowAdapter: OperationHistoryWindowAdapter = {
  hasTauriRuntime,
  openBrowserWindow(url, target, features) {
    window.open(url, target, features);
  },
  loadWebviewWindow() {
    return Promise.resolve({ WebviewWindow: TauriWebviewWindow });
  }
};

function toErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error);
}

async function waitForWindowCreation(windowHandle: OperationHistoryWindowHandle) {
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
      settleOnce({ error: new Error(`\u65e0\u6cd5\u6253\u5f00\u64cd\u4f5c\u5386\u53f2\u7a97\u53e3\uff1a${toErrorMessage(event.payload)}`) });
    })
  ]);
  const disposers = registrations.flatMap((registration) =>
    registration.status === "fulfilled" ? [registration.value] : []
  );
  try {
    const rejected = registrations.find((registration) => registration.status === "rejected");
    if (rejected?.status === "rejected") {
      throw new Error(`\u65e0\u6cd5\u76d1\u542c\u64cd\u4f5c\u5386\u53f2\u7a97\u53e3\u72b6\u6001\uff1a${toErrorMessage(rejected.reason)}`);
    }
    const result = await terminal;
    if (result.error) throw result.error;
  } finally {
    disposers.forEach((dispose) => dispose());
  }
}

async function openWindow(adapter: OperationHistoryWindowAdapter) {
  if (!adapter.hasTauriRuntime()) {
    adapter.openBrowserWindow(OPERATION_HISTORY_WINDOW_URL, OPERATION_HISTORY_WINDOW_LABEL, WINDOW_FEATURES);
    return;
  }

  const { WebviewWindow } = await adapter.loadWebviewWindow();
  const existingWindow = await WebviewWindow.getByLabel(OPERATION_HISTORY_WINDOW_LABEL);
  if (existingWindow) {
    await existingWindow.show();
    await existingWindow.setFocus();
    return;
  }

  const operationHistoryWindow = new WebviewWindow(OPERATION_HISTORY_WINDOW_LABEL, {
    url: OPERATION_HISTORY_WINDOW_URL,
    title: "\u64cd\u4f5c\u5386\u53f2",
    width: 960,
    height: 700,
    minWidth: 720,
    minHeight: 520,
    resizable: true,
    decorations: true,
    focus: true,
    center: true
  });
  await waitForWindowCreation(operationHistoryWindow);
}

export function openOperationHistoryWindow(
  adapter: OperationHistoryWindowAdapter = defaultOperationHistoryWindowAdapter
) {
  if (openingPromise) {
    return openingPromise;
  }
  const pending = openWindow(adapter).finally(() => {
    if (openingPromise === pending) {
      openingPromise = null;
    }
  });
  openingPromise = pending;
  return pending;
}

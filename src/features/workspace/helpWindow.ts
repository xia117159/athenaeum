import { WebviewWindow, type WebviewWindow as WindowHandle } from "@tauri-apps/api/webviewWindow";

export type HelpWindowHandle = Pick<WindowHandle, "show" | "setFocus" | "once">;
export interface HelpWindowOptions {
  url: string; title: string; width: number; height: number; minWidth: number; minHeight: number;
  resizable: boolean; decorations: boolean; focus: boolean; center: boolean;
}
export type HelpWindowConstructor = new (label: string, options: HelpWindowOptions) => HelpWindowHandle;
export interface HelpWindowAdapter {
  hasTauriRuntime(): boolean;
  openBrowserWindow(url: string, target: string, features: string): void;
  loadWebviewWindow(): Promise<{ WebviewWindow: HelpWindowConstructor & { getByLabel(label: string): Promise<HelpWindowHandle | null> } }>;
}
const defaultAdapter: HelpWindowAdapter = {
  hasTauriRuntime: () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window,
  openBrowserWindow: (url, target, features) => { window.open(url, target, features); },
  loadWebviewWindow: async () => ({ WebviewWindow })
};

async function waitForCreation(handle: HelpWindowHandle, title: string) {
  let settle!: (error?: Error) => void;
  const terminal = new Promise<Error | undefined>(resolve => { settle = resolve; });
  const registrations = await Promise.allSettled([
    handle.once("tauri://created", () => settle()),
    handle.once("tauri://error", event => settle(new Error(`无法打开${title}窗口：${String(event.payload)}`)))
  ]);
  try {
    const rejected = registrations.find(result => result.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
    const error = await terminal;
    if (error) throw error;
  } finally {
    for (const registration of registrations) if (registration.status === "fulfilled") registration.value();
  }
}

export function createHelpWindowOpener(label: string, options: Omit<HelpWindowOptions, "resizable" | "decorations" | "focus" | "center">) {
  let pendingOpen: Promise<void> | undefined;
  return (adapter: HelpWindowAdapter = defaultAdapter): Promise<void> => {
    if (!adapter.hasTauriRuntime()) {
      adapter.openBrowserWindow(options.url, label, `width=${options.width},height=${options.height},resizable=yes`);
      return Promise.resolve();
    }
    if (pendingOpen) return pendingOpen;
    const pending = (async () => {
      const { WebviewWindow: Constructor } = await adapter.loadWebviewWindow();
      const existing = await Constructor.getByLabel(label);
      if (existing) { await existing.show(); await existing.setFocus(); return; }
      const created = new Constructor(label, { ...options, resizable: true, decorations: true, focus: true, center: true });
      await waitForCreation(created, options.title);
    })().finally(() => { if (pendingOpen === pending) pendingOpen = undefined; });
    pendingOpen = pending;
    return pending;
  };
}

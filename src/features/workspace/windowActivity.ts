import { hasTauriRuntime } from "./workspaceIpc";

/** Whether the window is on screen; background work that only serves the view pauses while it is not (SPEC-018). */
export interface WindowActivityGateway {
  subscribe(listener: (active: boolean) => void): () => void;
}
type WindowApi = {
  isMinimized(): Promise<boolean>;
  onResized(handler: () => void): Promise<() => void>;
  onFocusChanged(handler: () => void): Promise<() => void>;
};
export interface WindowActivityRuntime { runtimeHost?: object | null; document?: Document; loadWindow?: () => Promise<WindowApi> }

async function loadTauriWindow(): Promise<WindowApi> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export function createWindowActivityGateway(runtime: WindowActivityRuntime = {}): WindowActivityGateway {
  return { subscribe(listener) {
    const doc = runtime.document ?? (typeof document === "undefined" ? undefined : document);
    let disposed = false; let minimized = false; let last: boolean | undefined; let check = 0;
    let win: WindowApi | undefined;
    const unlisteners: Array<() => void> = [];
    const emit = () => {
      const active = !doc?.hidden && !minimized;
      if (!disposed && active !== last) { last = active; listener(active); }
    };
    const refresh = () => {
      emit();
      if (!win) return;
      const token = ++check;
      void win.isMinimized().then((value) => { if (token === check) { minimized = value; emit(); } }, () => undefined);
    };
    doc?.addEventListener("visibilitychange", refresh);
    emit();
    // Without the desktop API only document visibility is known.
    if (hasTauriRuntime(runtime.runtimeHost)) void (runtime.loadWindow ?? loadTauriWindow)().then(async (api) => {
      for (const register of [(handler: () => void) => api.onResized(handler), (handler: () => void) => api.onFocusChanged(handler)]) {
        if (disposed) return;
        const off = await register(refresh);
        if (disposed) { off(); return; }
        unlisteners.push(off);
      }
      win = api;
      refresh();
    }).catch(() => undefined);
    return () => {
      disposed = true;
      doc?.removeEventListener("visibilitychange", refresh);
      for (const off of unlisteners.splice(0)) off();
    };
  } };
}

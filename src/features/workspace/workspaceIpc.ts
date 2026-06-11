import { invoke, isTauri } from "@tauri-apps/api/core";

export type WorkspaceInvoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

type RuntimeHost = object | null | undefined;

function getRuntimeHost(): RuntimeHost {
  return typeof window === "undefined" ? undefined : window;
}

export function hasTauriRuntime(runtimeHost: RuntimeHost = getRuntimeHost()) {
  if (isTauri()) {
    return true;
  }

  return (
    typeof runtimeHost === "object" &&
    runtimeHost !== null &&
    ("__TAURI_INTERNALS__" in runtimeHost || (runtimeHost as { isTauri?: unknown }).isTauri === true)
  );
}

export async function invokeWithBrowserFallback<T>(
  command: string,
  args: Record<string, unknown>,
  browserFallback: () => Promise<T> | T,
  invokeFn: WorkspaceInvoke = invoke,
  runtimeHost: RuntimeHost = getRuntimeHost()
): Promise<T> {
  if (!hasTauriRuntime(runtimeHost)) {
    return browserFallback();
  }

  return invokeFn<T>(command, args);
}

export async function invokeRequired<T>(
  command: string,
  args: Record<string, unknown>,
  browserFallback: () => Promise<T> | T,
  invokeFn: WorkspaceInvoke = invoke,
  runtimeHost: RuntimeHost = getRuntimeHost()
): Promise<T> {
  return invokeWithBrowserFallback(command, args, browserFallback, invokeFn, runtimeHost);
}

export async function showNativeContextMenu(
  paths: string[],
  x: number,
  y: number,
  invokeFn: WorkspaceInvoke = invoke,
  runtimeHost: RuntimeHost = getRuntimeHost()
) {
  if (!hasTauriRuntime(runtimeHost)) {
    return false;
  }

  try {
    const opened = await invokeFn<boolean>("show_native_context_menu", {
      paths,
      x: Math.round(x),
      y: Math.round(y)
    });
    return opened;
  } catch (error) {
    console.warn("Falling back from show_native_context_menu", error);
    return false;
  }
}

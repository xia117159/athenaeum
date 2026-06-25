import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  NativeBackgroundContextMenuOptions,
  NativeBackgroundContextMenuResult,
  SystemFileClipboard,
  WindowsDragDropEnvironment
} from "./types";

export type SystemFileOperationKind = "copy" | "move";

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
  const result = await invokeWithBrowserFallback(command, args, browserFallback, invokeFn, runtimeHost);
  return result;
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

export async function showNativeBackgroundContextMenu(
  directoryPath: string,
  x: number,
  y: number,
  options: NativeBackgroundContextMenuOptions,
  invokeFn: WorkspaceInvoke = invoke,
  runtimeHost: RuntimeHost = getRuntimeHost()
) {
  const fallbackResult: NativeBackgroundContextMenuResult = { opened: false };
  if (!hasTauriRuntime(runtimeHost)) {
    return fallbackResult;
  }

  try {
    const result = await invokeFn<NativeBackgroundContextMenuResult | boolean>("show_native_background_context_menu", {
      directoryPath,
      x: Math.round(x),
      y: Math.round(y),
      options
    });
    return typeof result === "boolean" ? { opened: result } : result;
  } catch (error) {
    console.warn("Falling back from show_native_background_context_menu", error);
    return fallbackResult;
  }
}

export async function setSystemFileClipboard(
  paths: string[],
  mode: SystemFileClipboard["mode"],
  invokeFn: WorkspaceInvoke = invoke,
  runtimeHost: RuntimeHost = getRuntimeHost()
) {
  if (!hasTauriRuntime(runtimeHost)) {
    return;
  }

  await invokeFn<void>("set_system_file_clipboard", { paths, mode });
}

export async function readSystemFileClipboard(
  invokeFn: WorkspaceInvoke = invoke,
  runtimeHost: RuntimeHost = getRuntimeHost()
) {
  if (!hasTauriRuntime(runtimeHost)) {
    return null;
  }

  return invokeFn<SystemFileClipboard | null>("read_system_file_clipboard", {});
}

export async function getWindowsDragDropEnvironment(
  invokeFn: WorkspaceInvoke = invoke,
  runtimeHost: RuntimeHost = getRuntimeHost()
): Promise<WindowsDragDropEnvironment | null> {
  if (!hasTauriRuntime(runtimeHost)) {
    return null;
  }

  try {
    return await invokeFn<WindowsDragDropEnvironment>("get_windows_drag_drop_environment", {});
  } catch (error) {
    console.warn("Unable to read Windows drag-and-drop environment", error);
    return null;
  }
}

export async function startSystemFileDrag(
  paths: string[],
  invokeFn: WorkspaceInvoke = invoke,
  runtimeHost: RuntimeHost = getRuntimeHost()
) {
  if (!hasTauriRuntime(runtimeHost)) {
    return null;
  }

  return invokeFn<SystemFileClipboard["mode"]>("start_system_file_drag", { paths });
}

export async function performSystemFileOperation(
  sources: string[],
  destination: string,
  operation: SystemFileOperationKind,
  invokeFn: WorkspaceInvoke = invoke,
  runtimeHost: RuntimeHost = getRuntimeHost()
) {
  if (!hasTauriRuntime(runtimeHost)) {
    return;
  }

  await invokeFn<void>("perform_system_file_operation", {
    request: {
      sources,
      destination,
      operation
    }
  });
}

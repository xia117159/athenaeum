import type { Event } from "@tauri-apps/api/event";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import { hasTauriRuntime } from "./workspaceIpc";

export type SystemFileDropHandler = (paths: string[], destination: string) => void;

type SystemFileDropTarget = {
  element: HTMLElement;
  kind: string;
  path: string;
};

const SYSTEM_DROP_CLASS_BY_KIND: Record<string, string> = {
  tab: "is-entry-drop-target",
  folder: "is-drop-target",
  listing: "is-drop-target"
};

let highlightedSystemDropElement: HTMLElement | null = null;
let highlightedSystemDropClass: string | null = null;

export function findSystemFileDropTargetFromPoint(position?: { x: number; y: number }): SystemFileDropTarget | null {
  if (!position || typeof document === "undefined") {
    return null;
  }

  const scale = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const element = document.elementFromPoint(position.x / scale, position.y / scale);
  const dropElement = element?.closest("[data-entry-drop-kind][data-entry-drop-path]") as HTMLElement | null;
  const kind = dropElement?.dataset.entryDropKind;
  const path = dropElement?.dataset.entryDropPath;
  if (!dropElement || !kind || !path) {
    return null;
  }

  return {
    element: dropElement,
    kind,
    path
  };
}

export function clearSystemFileDropHighlight() {
  if (highlightedSystemDropElement && highlightedSystemDropClass) {
    highlightedSystemDropElement.classList.remove(highlightedSystemDropClass);
  }
  if (highlightedSystemDropElement) {
    delete highlightedSystemDropElement.dataset.dropOperation;
  }
  highlightedSystemDropElement = null;
  highlightedSystemDropClass = null;
}

export function updateSystemFileDropHighlight(position?: { x: number; y: number }) {
  const target = findSystemFileDropTargetFromPoint(position);
  if (!target) {
    clearSystemFileDropHighlight();
    return null;
  }

  const className = SYSTEM_DROP_CLASS_BY_KIND[target.kind] ?? "is-drop-target";
  if (highlightedSystemDropElement !== target.element || highlightedSystemDropClass !== className) {
    clearSystemFileDropHighlight();
    target.element.classList.add(className);
    highlightedSystemDropElement = target.element;
    highlightedSystemDropClass = className;
  }
  target.element.dataset.dropOperation = "copy";
  return target;
}

export async function listenSystemFileDrops(
  onDrop: SystemFileDropHandler,
  runtimeHost: object | null | undefined = typeof window === "undefined" ? undefined : window
) {
  if (!hasTauriRuntime(runtimeHost)) {
    return () => undefined;
  }

  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  const webview = getCurrentWebview();
  let systemDragActive = false;
  const unlisten = await webview.onDragDropEvent((event: Event<DragDropEvent>) => {
    if (event.payload.type === "leave") {
      systemDragActive = false;
      clearSystemFileDropHighlight();
      return;
    }

    if (event.payload.type === "enter") {
      systemDragActive = event.payload.paths.length > 0;
      if (systemDragActive) {
        updateSystemFileDropHighlight(event.payload.position);
      }
      return;
    }

    if (event.payload.type === "over") {
      if (systemDragActive) {
        updateSystemFileDropHighlight(event.payload.position);
      }
      return;
    }

    if (event.payload.paths.length === 0) {
      clearSystemFileDropHighlight();
      systemDragActive = false;
      return;
    }

    const target = updateSystemFileDropHighlight(event.payload.position);
    clearSystemFileDropHighlight();
    systemDragActive = false;
    if (!target) {
      return;
    }

    onDrop(event.payload.paths, target.path);
  });
  return () => {
    systemDragActive = false;
    clearSystemFileDropHighlight();
    unlisten();
  };
}

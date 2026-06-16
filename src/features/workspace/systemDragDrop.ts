import type { Event } from "@tauri-apps/api/event";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import { hasTauriRuntime } from "./workspaceIpc";

export type SystemFileDropHandler = (paths: string[], destination: string) => void;

type SystemFileDropPayload =
  | {
      type: "enter";
      paths: string[];
      position: { x: number; y: number };
    }
  | {
      type: "over";
      position: { x: number; y: number };
    }
  | {
      type: "drop";
      paths: string[];
      position: { x: number; y: number };
    }
  | {
      type: "leave";
    };

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

export function createSystemFileDropPayloadHandler(onDrop: SystemFileDropHandler) {
  let systemDragActive = false;

  return (payload: SystemFileDropPayload) => {
    if (payload.type === "leave") {
      systemDragActive = false;
      clearSystemFileDropHighlight();
      return;
    }

    if (payload.type === "enter") {
      systemDragActive = payload.paths.length > 0;
      if (systemDragActive) {
        updateSystemFileDropHighlight(payload.position);
      }
      return;
    }

    if (payload.type === "over") {
      if (systemDragActive) {
        updateSystemFileDropHighlight(payload.position);
      }
      return;
    }

    if (!systemDragActive || payload.paths.length === 0) {
      clearSystemFileDropHighlight();
      systemDragActive = false;
      return;
    }

    const target = updateSystemFileDropHighlight(payload.position);
    clearSystemFileDropHighlight();
    systemDragActive = false;
    if (!target) {
      return;
    }

    onDrop(payload.paths, target.path);
  };
}

export async function listenSystemFileDrops(
  onDrop: SystemFileDropHandler,
  runtimeHost: object | null | undefined = typeof window === "undefined" ? undefined : window
) {
  if (!hasTauriRuntime(runtimeHost)) {
    return () => undefined;
  }

  const handlePayload = createSystemFileDropPayloadHandler(onDrop);
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  const webview = getCurrentWebview();
  const unlisten = await webview.onDragDropEvent((event: Event<DragDropEvent>) => {
    handlePayload(event.payload);
  });
  return () => {
    clearSystemFileDropHighlight();
    unlisten();
  };
}

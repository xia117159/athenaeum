import type { Event } from "@tauri-apps/api/event";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import { getWindowsDragDropEnvironment, hasTauriRuntime, disposeQuietly } from "./workspaceIpc";
import type { WindowsDragDropEnvironment } from "./types";

export type SystemFileDropHandler = (paths: string[], destination: string) => void;

export type SystemFileDropListenOptions = {
  runtimeHost?: object | null;
  onExplorerFileDropsBlocked?: (environment: WindowsDragDropEnvironment) => void;
  warn?: (...args: unknown[]) => void;
};

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
  tab: "is-system-entry-drop-target",
  folder: "is-system-drop-target",
  listing: "is-system-drop-target"
};

const SYSTEM_DROP_DEDUPE_WINDOW_MS = 1500;
const recentSystemDropKeys = new Map<string, number>();

let highlightedSystemDropElement: HTMLElement | null = null;
let highlightedSystemDropClass: string | null = null;

function normalizeSystemDropKeyPath(path: string) {
  return path.trim().replace(/\//g, "\\").toLowerCase();
}

function createSystemDropDedupeKey(paths: string[], destination: string) {
  const sourceKey = Array.from(new Set(paths.map(normalizeSystemDropKeyPath).filter(Boolean)))
    .sort()
    .join("\u001f");
  return `${sourceKey}\u001e${normalizeSystemDropKeyPath(destination)}`;
}

function wasSystemDropRecentlyHandled(paths: string[], destination: string, now = Date.now()) {
  const key = createSystemDropDedupeKey(paths, destination);
  for (const [recentKey, handledAt] of recentSystemDropKeys) {
    if (now - handledAt > SYSTEM_DROP_DEDUPE_WINDOW_MS) {
      recentSystemDropKeys.delete(recentKey);
    }
  }

  const handledAt = recentSystemDropKeys.get(key);
  if (handledAt !== undefined && now - handledAt <= SYSTEM_DROP_DEDUPE_WINDOW_MS) {
    return true;
  }

  recentSystemDropKeys.set(key, now);
  return false;
}

export function findSystemFileDropTargetFromPoint(position?: { x: number; y: number }): SystemFileDropTarget | null {
  if (!position || typeof document === "undefined") {
    return null;
  }

  const scale = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const element = document.elementFromPoint(position.x / scale, position.y / scale);
  const entryElement = element?.closest("[data-entry-path]") as HTMLElement | null;
  if (entryElement && !entryElement.dataset.entryDropKind) {
    const listingElement = entryElement.closest("[data-entry-drop-kind='listing'][data-entry-drop-path]") as HTMLElement | null;
    const listingPath = listingElement?.dataset.entryDropPath;
    if (!listingElement || !listingPath) {
      return null;
    }

    return {
      element: listingElement,
      kind: "listing",
      path: listingPath
    };
  }

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
    delete highlightedSystemDropElement.dataset.systemDropOperation;
  }
  highlightedSystemDropElement = null;
  highlightedSystemDropClass = null;
}

export function updateSystemFileDropHighlight(position?: { x: number; y: number }) {
  if (highlightedSystemDropElement && !highlightedSystemDropElement.isConnected) {
    highlightedSystemDropElement = null;
    highlightedSystemDropClass = null;
  }

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
  target.element.dataset.systemDropOperation = "copy";
  return target;
}

// App-origin system drags run through a modal SHDoDragDrop loop on the native
// main thread, which starves WRY's drag-drop event delivery: the native
// enter/over/drop payloads are queued and only flush in a burst at drop. So the
// live drop highlight for an App-origin drag cannot come from those payloads —
// it is driven by a separate position feed the Rust IDropSource emits from
// GiveFeedback on every mouse move. These flags let the native payload handler
// step aside while the feed is the source of truth, and suppress the stale
// enter/over burst (which would otherwise flash the highlight along the replayed
// cursor path) right after the drag ends.
let systemDragPositionFeedActive = false;
let lastSystemDragPositionAt = 0;
const SYSTEM_DRAG_FEED_SUPPRESS_WINDOW_MS = 1000;

export function beginAppOriginSystemDrag() {
  systemDragPositionFeedActive = true;
}

export function endAppOriginSystemDrag() {
  systemDragPositionFeedActive = false;
  clearSystemFileDropHighlight();
}

function shouldDeferToSystemDragPositionFeed(now = Date.now()) {
  return (
    systemDragPositionFeedActive ||
    now - lastSystemDragPositionAt <= SYSTEM_DRAG_FEED_SUPPRESS_WINDOW_MS
  );
}

export function handleSystemDragPosition(position: { x: number; y: number }, now = Date.now()) {
  if (!systemDragPositionFeedActive) {
    return null;
  }
  lastSystemDragPositionAt = now;
  return updateSystemFileDropHighlight(position);
}

export function resetSystemDragStateForTests() {
  systemDragPositionFeedActive = false;
  lastSystemDragPositionAt = 0;
  clearSystemFileDropHighlight();
}

export function createSystemFileDropPayloadHandler(onDrop: SystemFileDropHandler) {
  let systemDragActive = false;

  return (payload: SystemFileDropPayload) => {
    if (payload.type === "leave") {
      systemDragActive = false;
      clearSystemFileDropHighlight();
      return;
    }

    if (payload.type === "enter" || payload.type === "over") {
      // `enter`/`over` are hover signals. The Tauri file-drop listener only
      // fires for an in-flight file drag, so any hover means a drag is active
      // over this WebView. App-origin system drags returning through
      // SHDoDragDrop can skip `enter` (or send it without paths), so we must
      // not gate hover highlight on a prior `enter` carrying paths — otherwise
      // the drop works but the target never shows a highlight.
      systemDragActive = true;
      // For App-origin drags the live highlight comes from the position feed;
      // the buffered enter/over burst that flushes at drop is stale and would
      // flash the highlight along the replayed cursor path, so skip it here.
      if (!shouldDeferToSystemDragPositionFeed()) {
        updateSystemFileDropHighlight(payload.position);
      }
      return;
    }

    // Drop execution stays gated on an active drag and is driven solely by the
    // native `drop.paths`, so a stale drop after `leave` is ignored.
    if (!systemDragActive || payload.paths.length === 0) {
      clearSystemFileDropHighlight();
      systemDragActive = false;
      return;
    }

    // When the position feed owns the highlight, resolve the drop target without
    // re-applying a one-frame highlight; otherwise (Explorer-origin) keep the
    // existing behavior.
    const target = shouldDeferToSystemDragPositionFeed()
      ? findSystemFileDropTargetFromPoint(payload.position)
      : updateSystemFileDropHighlight(payload.position);
    clearSystemFileDropHighlight();
    systemDragActive = false;
    if (!target) {
      return;
    }

    // Dedupe only suppresses duplicate drop execution; it never blocks the
    // enter/over hover highlight above.
    if (wasSystemDropRecentlyHandled(payload.paths, target.path)) {
      return;
    }

    onDrop(payload.paths, target.path);
  };
}

export function warnIfExplorerFileDropsAreBlocked(
  environment: WindowsDragDropEnvironment | null,
  warn: (...args: unknown[]) => void = console.warn
) {
  if (!environment?.explorerToAppDragBlocked) {
    return false;
  }

  warn(
    "Windows Explorer file drops into the app are blocked because the app is running elevated.",
    environment
  );
  return true;
}

function isSystemFileDropListenOptions(value: unknown): value is SystemFileDropListenOptions {
  return (
    typeof value === "object" &&
    value !== null &&
    ("runtimeHost" in value || "onExplorerFileDropsBlocked" in value || "warn" in value)
  );
}

export async function listenSystemFileDrops(
  onDrop: SystemFileDropHandler,
  optionsOrRuntimeHost: SystemFileDropListenOptions | object | null | undefined =
    typeof window === "undefined" ? undefined : window
) {
  const options = isSystemFileDropListenOptions(optionsOrRuntimeHost)
    ? optionsOrRuntimeHost
    : { runtimeHost: optionsOrRuntimeHost };
  const runtimeHost =
    "runtimeHost" in options ? options.runtimeHost : typeof window === "undefined" ? undefined : window;
  if (!hasTauriRuntime(runtimeHost)) {
    return () => undefined;
  }

  const handlePayload = createSystemFileDropPayloadHandler(onDrop);
  const environment = await getWindowsDragDropEnvironment(undefined, runtimeHost);
  if (warnIfExplorerFileDropsAreBlocked(environment, options.warn ?? console.warn) && environment) {
    options.onExplorerFileDropsBlocked?.(environment);
  }
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  const webview = getCurrentWebview();
  const unlisten = await webview.onDragDropEvent((event: Event<DragDropEvent>) => {
    handlePayload(event.payload);
  });

  // Live cursor feed emitted by the Rust IDropSource during App-origin drags
  // (see beginAppOriginSystemDrag/handleSystemDragPosition). This is the only
  // channel that reaches JS while SHDoDragDrop blocks the main thread.
  const { listen } = await import("@tauri-apps/api/event");
  const unlistenPosition = await listen<[number, number]>("system_drag_position", (event) => {
    const [x, y] = event.payload;
    handleSystemDragPosition({ x, y });
  });

  return () => {
    clearSystemFileDropHighlight();
    void disposeQuietly(unlisten);
    void disposeQuietly(unlistenPosition);
  };
}

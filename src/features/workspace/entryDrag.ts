import type { EntryDragPayload, PanelId } from "./types";

export const ENTRY_DRAG_MIME = "application/x-simplefilemanager-entry-list";

let activeEntryDragPayload: EntryDragPayload | null = null;

function pathToFileUri(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const prefixed = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${encodeURI(prefixed).replace(/#/g, "%23")}`;
}

export function pathsToUriList(paths: string[]) {
  return paths.map(pathToFileUri).join("\r\n");
}

export function hasEntryDragPayload(dataTransfer: DataTransfer | null) {
  return activeEntryDragPayload !== null || Array.from(dataTransfer?.types ?? []).includes(ENTRY_DRAG_MIME);
}

export function readEntryDragPayload(dataTransfer: DataTransfer | null, fallbackPanelId: PanelId, fallbackTabId: string) {
  if (!dataTransfer) {
    return null;
  }

  const raw = dataTransfer.getData(ENTRY_DRAG_MIME);
  if (!raw) {
    return hasEntryDragPayload(dataTransfer) ? activeEntryDragPayload : null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<EntryDragPayload>;
    if (!Array.isArray(parsed.paths) || parsed.paths.length === 0) {
      return null;
    }
    return {
      sourcePanelId: parsed.sourcePanelId ?? fallbackPanelId,
      sourceTabId: parsed.sourceTabId ?? fallbackTabId,
      paths: parsed.paths
    } as EntryDragPayload;
  } catch {
    return null;
  }
}

export function startEntryDrag(dataTransfer: DataTransfer, payload: EntryDragPayload, plainText = payload.paths.join("\n")) {
  activeEntryDragPayload = payload;
  dataTransfer.effectAllowed = "copyMove";
  dataTransfer.setData(ENTRY_DRAG_MIME, JSON.stringify(payload satisfies EntryDragPayload));
  dataTransfer.setData("text/plain", plainText);
  dataTransfer.setData("text/uri-list", pathsToUriList(payload.paths));
}

export function clearEntryDrag() {
  activeEntryDragPayload = null;
}

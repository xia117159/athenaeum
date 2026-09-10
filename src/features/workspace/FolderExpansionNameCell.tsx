import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState, type KeyboardEvent, type ReactNode, type SyntheticEvent } from "react";
import type { FolderListingRow } from "./folderExpansion";

export const FOLDER_INDENT_PX = 16;
export const FOLDER_TOGGLE_PX = 18;

const FOLDER_LOADING_DELAY_MS = 200;

/** Delay only the hint; fast reads never render or reserve space for it. */
function FolderExpansionLoadingStatus() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), FOLDER_LOADING_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return visible ? <span className="file-name-tree__status" role="status">正在加载…</span> : null;
}

const stop = (event: SyntheticEvent) => event.stopPropagation();
const stopDoubleClick = (event: SyntheticEvent) => { event.preventDefault(); event.stopPropagation(); };
function activateWithKeyboard(event: KeyboardEvent<HTMLButtonElement>, action: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.stopPropagation();
    event.preventDefault();
    if (!event.repeat) action();
  }
}

/** A list navigation intent moves focus off the expansion control before Enter. */
export function releaseFolderExpansionControlFocus(root: HTMLElement) {
  const focused = root.ownerDocument.activeElement;
  if (focused instanceof HTMLElement && root.contains(focused) &&
    focused.matches(".file-name-tree__toggle, .file-name-tree__retry")) focused.blur();
}

/** Only the name cell participates in tree indentation; all other columns stay aligned. */
export function FolderExpansionNameCell({ row, children, onToggle, onRetry }: {
  row?: FolderListingRow;
  children: ReactNode;
  onToggle?: (path: string) => void;
  onRetry?: (path: string) => void;
}) {
  if (!row) return children;
  const { entry, expansion, depth } = row;
  const loading = expansion?.status === "idle" || expansion?.status === "loading";
  const empty = expansion?.status === "ready" && expansion.entries.length === 0;
  const failed = expansion?.status === "error";
  const toggle = () => onToggle?.(entry.path);
  const retry = () => onRetry?.(entry.path);
  return (
    <div className="file-name-tree" data-folder-depth={depth} style={{ paddingInlineStart: depth * FOLDER_INDENT_PX }}>
      {entry.kind === "folder" && !entry.driveInfo ? (
        <button
          type="button" className="file-name-tree__toggle"
          aria-label={`${expansion ? "收起" : "展开"} ${entry.name}`} aria-expanded={Boolean(expansion)}
          disabled={!onToggle} onPointerDown={stop} onMouseDown={stop} onDoubleClick={stopDoubleClick}
          onKeyDown={(event) => activateWithKeyboard(event, toggle)} onKeyUp={stop}
          onClick={(event) => { event.stopPropagation(); toggle(); }}
        >
          {expansion ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
        </button>
      ) : <span className="file-name-tree__spacer" aria-hidden="true" />}
      {children}
      {loading ? <FolderExpansionLoadingStatus key={entry.path} /> : empty || failed ? (
        <span className={`file-name-tree__status${failed ? " is-error" : ""}`} role="status" title={expansion?.errorMessage}>
          {failed ? "读取失败" : "空文件夹"}
        </span>
      ) : null}
      {failed ? (
        <button type="button" className="file-name-tree__retry" aria-label={`重试展开 ${entry.name}`} title={expansion.errorMessage}
          disabled={!onRetry} onPointerDown={stop} onMouseDown={stop} onDoubleClick={stopDoubleClick}
          onKeyDown={(event) => activateWithKeyboard(event, retry)} onKeyUp={stop}
          onClick={(event) => { event.stopPropagation(); retry(); }}
        >重试</button>
      ) : null}
    </div>
  );
}

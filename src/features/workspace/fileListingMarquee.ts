import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";

type Point = { x: number; y: number };
type Rect = { left: number; top: number; right: number; bottom: number };
type Measurement = { index: number; start: number; end: number; size: number };
type MarqueeEntry = { id: string; inlineCreate?: boolean };

export function toListingContentPoint(clientX: number, clientY: number, bodyRect: Rect): Point {
  return { x: clientX - bodyRect.left, y: clientY - bodyRect.top };
}

/**
 * 滚动条是滚动容器自身的一部分，按下它时事件目标就是容器，无法靠 DOM 目标区分。
 * 用 client 区（内容+内边距）边界判断：落在其右侧/下方且确有滚动条（或边框）占位时视为滚动条按压。
 */
export function isScrollbarPointer(element: HTMLElement, clientX: number, clientY: number): boolean {
  const rect = element.getBoundingClientRect();
  const clientRight = rect.left + element.clientLeft + element.clientWidth;
  const clientBottom = rect.top + element.clientTop + element.clientHeight;
  const hasVerticalGutter = element.offsetWidth - element.clientLeft - element.clientWidth > 0;
  const hasHorizontalGutter = element.offsetHeight - element.clientTop - element.clientHeight > 0;
  return (hasVerticalGutter && clientX >= clientRight) || (hasHorizontalGutter && clientY >= clientBottom);
}

export function getMarqueeEntryIds({ entries, measurements, rect, bodyWidth, padding, scrollMargin, columns, gap }: {
  entries: readonly MarqueeEntry[];
  measurements: readonly Measurement[];
  rect: Rect;
  bodyWidth: number;
  padding: number;
  scrollMargin: number;
  columns: number;
  gap: number;
}): string[] {
  let low = 0;
  let high = measurements.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (measurements[middle].end + padding - scrollMargin <= rect.top) low = middle + 1;
    else high = middle;
  }
  const selected: string[] = [];
  const cellWidth = Math.max(0, (bodyWidth - padding * 2 - gap * (columns - 1)) / columns);
  for (let row = low; row < measurements.length; row += 1) {
    const measurement = measurements[row];
    const top = measurement.start + padding - scrollMargin;
    if (top >= rect.bottom) break;
    for (let column = 0; column < columns; column += 1) {
      const entry = entries[measurement.index * columns + column];
      if (!entry || entry.inlineCreate) continue;
      const left = padding + column * (cellWidth + gap);
      if (rect.left < left + cellWidth && rect.right > left) selected.push(entry.id);
    }
  }
  return selected;
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function useListingMarquee(): {
  overlayRef: RefObject<HTMLDivElement | null>;
  begin: (options: {
    scrollElement: HTMLDivElement;
    clientX: number;
    clientY: number;
    entries: readonly MarqueeEntry[];
    virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>;
    virtualized: boolean;
    columns: number;
    gap: number;
    details: boolean;
    onSelect: (ids: string[]) => void;
  }) => void;
} {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);

  const begin = ({ scrollElement, clientX, clientY, entries, virtualizer, virtualized, columns, gap, details, onSelect }: {
    scrollElement: HTMLDivElement;
    clientX: number;
    clientY: number;
    entries: readonly MarqueeEntry[];
    virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>;
    virtualized: boolean;
    columns: number;
    gap: number;
    details: boolean;
    onSelect: (ids: string[]) => void;
  }) => {
    cleanupRef.current?.();
    const body = scrollElement.querySelector<HTMLElement>(".file-listing__body");
    const overlay = overlayRef.current;
    if (!body || !overlay) return;
    const win = scrollElement.ownerDocument.defaultView;
    if (!win) return;
    const header = details ? scrollElement.querySelector<HTMLElement>(".file-listing__header")?.getBoundingClientRect().height || 24 : 0;
    const initialRect = scrollElement.getBoundingClientRect();
    const startClientY = Math.max(initialRect.top + header, Math.min(initialRect.bottom, clientY));
    const start = toListingContentPoint(clientX, startClientY, body.getBoundingClientRect());
    let pointer = { x: clientX, y: clientY };
    let frame = 0;
    let previousIds: string[] = [];
    let active = true;
    overlay.style.display = "block";

    const update = (allowScroll = true) => {
      frame = 0;
      if (!active) return;
      const viewport = scrollElement.getBoundingClientRect();
      const contentTop = viewport.top + header;
      const x = Math.max(viewport.left, Math.min(viewport.right, pointer.x));
      const y = Math.max(contentTop, Math.min(viewport.bottom, pointer.y));
      const direction = pointer.y <= contentTop + 20 ? -1 : pointer.y >= viewport.bottom - 20 ? 1 : 0;
      const oldScrollTop = scrollElement.scrollTop;
      if (direction && allowScroll) scrollElement.scrollTop += direction * 18;
      const scrolled = scrollElement.scrollTop !== oldScrollTop;
      const bodyRect = body.getBoundingClientRect();
      const current = toListingContentPoint(x, y, bodyRect);
      const rect = {
        left: Math.min(start.x, current.x), top: Math.min(start.y, current.y),
        right: Math.max(start.x, current.x), bottom: Math.max(start.y, current.y)
      };
      const visibleStartX = Math.max(viewport.left, Math.min(viewport.right, bodyRect.left + start.x));
      const visibleStartY = Math.max(contentTop, Math.min(viewport.bottom, bodyRect.top + start.y));
      overlay.style.left = `${Math.min(visibleStartX, x)}px`;
      overlay.style.top = `${Math.min(visibleStartY, y)}px`;
      overlay.style.width = `${Math.abs(x - visibleStartX)}px`;
      overlay.style.height = `${Math.abs(y - visibleStartY)}px`;

      let ids: string[];
      if (virtualized) {
        virtualizer.getVirtualItems();
        ids = getMarqueeEntryIds({
          entries, measurements: virtualizer.measurementsCache, rect,
          bodyWidth: bodyRect.width, padding: details ? 0 : 6,
          scrollMargin: virtualizer.options.scrollMargin ?? 0, columns, gap
        });
      } else {
        ids = Array.from(body.querySelectorAll<HTMLElement>("[data-entry-path]"))
          .filter((element) => {
            const box = element.getBoundingClientRect();
            const left = box.left - bodyRect.left;
            const top = box.top - bodyRect.top;
            return rect.left < left + box.width && rect.right > left && rect.top < top + box.height && rect.bottom > top;
          })
          .map((element) => element.id.startsWith("entry-") ? element.id.slice(6) : "")
          .filter(Boolean);
      }
      if (!sameIds(ids, previousIds)) {
        previousIds = ids;
        onSelect(ids);
      }
      if (scrolled && typeof win.requestAnimationFrame === "function") schedule();
    };
    const schedule = () => {
      if (frame || !active) return;
      if (typeof win.requestAnimationFrame !== "function") { update(false); return; }
      frame = win.requestAnimationFrame(() => update());
    };
    const move = (event: MouseEvent) => {
      event.preventDefault();
      pointer = { x: event.clientX, y: event.clientY };
      schedule();
    };
    const scroll = () => schedule();
    const stop = (finishSelection: boolean) => {
      if (frame) win.cancelAnimationFrame(frame);
      if (finishSelection) update(false);
      active = false;
      if (frame) win.cancelAnimationFrame(frame);
      overlay.style.display = "none";
      win.removeEventListener("mousemove", move);
      win.removeEventListener("mouseup", end);
      scrollElement.removeEventListener("scroll", scroll);
      cleanupRef.current = null;
    };
    const end = () => stop(true);
    win.addEventListener("mousemove", move);
    win.addEventListener("mouseup", end);
    scrollElement.addEventListener("scroll", scroll);
    cleanupRef.current = () => stop(false);
  };
  return { overlayRef, begin };
}

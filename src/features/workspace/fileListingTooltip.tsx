import {
  type MouseEvent as ReactMouseEvent,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import { formatTooltipTags, type ListingEntry } from "./fileListingPresentation";

const ENTRY_TOOLTIP_OFFSET_X = 14;
const ENTRY_TOOLTIP_OFFSET_Y = 18;

function getEntryTooltipPosition(clientX: number, clientY: number, tooltipSize?: { width: number; height: number }) {
  if (typeof window === "undefined") return { left: clientX + ENTRY_TOOLTIP_OFFSET_X, top: clientY + ENTRY_TOOLTIP_OFFSET_Y };
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const width = tooltipSize?.width ?? 420;
  const height = tooltipSize?.height ?? 220;
  const left = Math.max(8, Math.min(clientX + ENTRY_TOOLTIP_OFFSET_X, Math.max(8, viewportWidth - width - 8)));
  const preferredTop = clientY + ENTRY_TOOLTIP_OFFSET_Y;
  const flippedTop = clientY - height - ENTRY_TOOLTIP_OFFSET_Y;
  const top = preferredTop + height > viewportHeight - 8 ? Math.max(8, flippedTop) : Math.max(8, preferredTop);
  return { left, top };
}

function normalizeTooltipDelay(value: number | undefined) {
  return Math.max(0, Math.min(5000, Math.round(Number.isFinite(value) ? value ?? 200 : 200)));
}

export type EntryTooltipLayerHandle = {
  show: (entry: ListingEntry, x: number, y: number) => void;
  move: (entryId: string, x: number, y: number) => void;
  hide: () => void;
};

export const EntryTooltipLayer = forwardRef<EntryTooltipLayerHandle>(function EntryTooltipLayer(_, ref) {
  const [entry, setEntry] = useState<ListingEntry | null>(null);
  const entryRef = useRef<ListingEntry | null>(null);
  const pointRef = useRef({ x: 0, y: 0 });
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const tooltipSizeRef = useRef<{ width: number; height: number } | undefined>(undefined);
  const frameRef = useRef<number | null>(null);

  const place = () => {
    frameRef.current = null;
    if (!tooltipRef.current) return;
    const position = getEntryTooltipPosition(pointRef.current.x, pointRef.current.y, tooltipSizeRef.current);
    tooltipRef.current.style.left = `${position.left}px`;
    tooltipRef.current.style.top = `${position.top}px`;
  };
  const schedulePlace = () => {
    if (frameRef.current !== null) return;
    frameRef.current = typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame(place)
      : window.setTimeout(place, 0);
  };
  useImperativeHandle(ref, () => ({
    show(next, x, y) {
      entryRef.current = next;
      pointRef.current = { x, y };
      setEntry(next);
      schedulePlace();
    },
    move(entryId, x, y) {
      if (entryRef.current?.id !== entryId) return;
      pointRef.current = { x, y };
      schedulePlace();
    },
    hide() {
      entryRef.current = null;
      setEntry(null);
      if (frameRef.current !== null) {
        if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(frameRef.current);
        else window.clearTimeout(frameRef.current);
      }
      frameRef.current = null;
    }
  }));
  useLayoutEffect(() => {
    if (!entry) return;
    const rect = tooltipRef.current?.getBoundingClientRect();
    tooltipSizeRef.current = rect ? { width: rect.width, height: rect.height } : undefined;
    place();
  }, [entry]);
  useEffect(() => () => {
    if (frameRef.current === null) return;
    if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(frameRef.current);
    else window.clearTimeout(frameRef.current);
  }, []);
  if (!entry) return null;
  return <div ref={tooltipRef} className="file-listing__tooltip" role="tooltip" style={{ left: 8, top: 8 }}>
    <div>名称：{entry.name}</div>
    <div>修改日期：{entry.modifiedLabel || "--"}</div>
    <div>标签：{formatTooltipTags(entry)}</div>
    <div className="file-listing__tooltip-comment">注释：{entry.comment || "--"}</div>
  </div>;
});

export function useEntryTooltip({ tooltipHoverDelayMs, isDisabled }: {
  tooltipHoverDelayMs?: number;
  isDisabled: (entry: ListingEntry) => boolean;
}) {
  const layerRef = useRef<EntryTooltipLayerHandle | null>(null);
  const timerRef = useRef<number | null>(null);
  const pendingEntryRef = useRef<ListingEntry | null>(null);
  const pendingPointRef = useRef({ x: 0, y: 0 });
  const clearTimer = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const hideEntryTooltip = () => {
    clearTimer();
    pendingEntryRef.current = null;
    layerRef.current?.hide();
  };
  const buildEntryTooltipHandlers = (entry: ListingEntry) => ({
    onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => {
      if (entry.inlineCreate || isDisabled(entry)) { hideEntryTooltip(); return; }
      clearTimer();
      pendingEntryRef.current = entry;
      pendingPointRef.current = { x: event.clientX, y: event.clientY };
      const delay = normalizeTooltipDelay(tooltipHoverDelayMs);
      if (delay === 0) { layerRef.current?.show(entry, event.clientX, event.clientY); return; }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (pendingEntryRef.current?.id === entry.id) {
          layerRef.current?.show(entry, pendingPointRef.current.x, pendingPointRef.current.y);
        }
      }, delay);
    },
    onMouseMove: (event: ReactMouseEvent<HTMLElement>) => {
      pendingPointRef.current = { x: event.clientX, y: event.clientY };
      layerRef.current?.move(entry.id, event.clientX, event.clientY);
    },
    onMouseLeave: hideEntryTooltip
  });
  useEffect(() => () => { clearTimer(); }, []);
  return { layerRef, hideEntryTooltip, buildEntryTooltipHandlers };
}

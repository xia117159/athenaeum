import {
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import {
  formatTooltipTags,
  type ListingEntry
} from "./fileListingPresentation";

const ENTRY_TOOLTIP_OFFSET_X = 14;
const ENTRY_TOOLTIP_OFFSET_Y = 18;

type EntryTooltipState = {
  entry: ListingEntry;
  x: number;
  y: number;
};

function getEntryTooltipPosition(clientX: number, clientY: number, tooltipRect?: DOMRect) {
  if (typeof window === "undefined") {
    return {
      left: clientX + ENTRY_TOOLTIP_OFFSET_X,
      top: clientY + ENTRY_TOOLTIP_OFFSET_Y
    };
  }

  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const width = tooltipRect?.width ?? 420;
  const height = tooltipRect?.height ?? 220;
  const left = Math.max(8, Math.min(clientX + ENTRY_TOOLTIP_OFFSET_X, Math.max(8, viewportWidth - width - 8)));
  const preferredTop = clientY + ENTRY_TOOLTIP_OFFSET_Y;
  const flippedTop = clientY - height - ENTRY_TOOLTIP_OFFSET_Y;
  const top = preferredTop + height > viewportHeight - 8 ? Math.max(8, flippedTop) : Math.max(8, preferredTop);

  return { left, top };
}

function normalizeTooltipDelay(value: number | undefined) {
  return Math.max(0, Math.min(5000, Math.round(Number.isFinite(value) ? value ?? 200 : 200)));
}

export function useEntryTooltip({
  tooltipHoverDelayMs,
  isDisabled
}: {
  tooltipHoverDelayMs?: number;
  isDisabled: (entry: ListingEntry) => boolean;
}) {
  const entryTooltipRef = useRef<HTMLDivElement | null>(null);
  const entryTooltipTimerRef = useRef<number | null>(null);
  const pendingTooltipEntryRef = useRef<ListingEntry | null>(null);
  const pendingTooltipPointRef = useRef({ x: 0, y: 0 });
  const [entryTooltip, setEntryTooltip] = useState<EntryTooltipState | null>(null);
  const [entryTooltipPosition, setEntryTooltipPosition] = useState({ left: 8, top: 8 });

  const clearEntryTooltipTimer = () => {
    if (entryTooltipTimerRef.current !== null) {
      window.clearTimeout(entryTooltipTimerRef.current);
      entryTooltipTimerRef.current = null;
    }
  };

  const hideEntryTooltip = () => {
    clearEntryTooltipTimer();
    pendingTooltipEntryRef.current = null;
    setEntryTooltip(null);
  };

  const showEntryTooltip = (entry: ListingEntry, clientX: number, clientY: number) => {
    if (entry.inlineCreate || isDisabled(entry)) {
      return;
    }
    setEntryTooltip({
      entry,
      x: clientX,
      y: clientY
    });
    setEntryTooltipPosition(getEntryTooltipPosition(clientX, clientY));
  };

  const scheduleEntryTooltip = (entry: ListingEntry, event: ReactMouseEvent<HTMLElement>) => {
    if (entry.inlineCreate || isDisabled(entry)) {
      hideEntryTooltip();
      return;
    }
    clearEntryTooltipTimer();
    pendingTooltipEntryRef.current = entry;
    pendingTooltipPointRef.current = { x: event.clientX, y: event.clientY };
    const delay = normalizeTooltipDelay(tooltipHoverDelayMs);
    if (delay === 0) {
      showEntryTooltip(entry, event.clientX, event.clientY);
      return;
    }
    entryTooltipTimerRef.current = window.setTimeout(() => {
      entryTooltipTimerRef.current = null;
      if (pendingTooltipEntryRef.current?.id !== entry.id) {
        return;
      }
      showEntryTooltip(entry, pendingTooltipPointRef.current.x, pendingTooltipPointRef.current.y);
    }, delay);
  };

  const moveEntryTooltip = (entry: ListingEntry, event: ReactMouseEvent<HTMLElement>) => {
    pendingTooltipPointRef.current = { x: event.clientX, y: event.clientY };
    if (entryTooltip?.entry.id !== entry.id) {
      return;
    }
    setEntryTooltipPosition(getEntryTooltipPosition(event.clientX, event.clientY, entryTooltipRef.current?.getBoundingClientRect()));
    setEntryTooltip({
      ...entryTooltip,
      x: event.clientX,
      y: event.clientY
    });
  };

  const buildEntryTooltipHandlers = (entry: ListingEntry) => ({
    onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => scheduleEntryTooltip(entry, event),
    onMouseMove: (event: ReactMouseEvent<HTMLElement>) => moveEntryTooltip(entry, event),
    onMouseLeave: () => hideEntryTooltip()
  });

  useEffect(
    () => () => {
      clearEntryTooltipTimer();
    },
    []
  );

  useLayoutEffect(() => {
    if (!entryTooltip) {
      return;
    }
    const rect = entryTooltipRef.current?.getBoundingClientRect();
    setEntryTooltipPosition(getEntryTooltipPosition(entryTooltip.x, entryTooltip.y, rect));
  }, [entryTooltip]);

  return {
    entryTooltip,
    entryTooltipPosition,
    entryTooltipRef,
    hideEntryTooltip,
    buildEntryTooltipHandlers
  };
}

export function EntryTooltip({
  tooltip,
  tooltipRef,
  position
}: {
  tooltip: EntryTooltipState | null;
  tooltipRef: RefObject<HTMLDivElement | null>;
  position: { left: number; top: number };
}) {
  if (!tooltip) {
    return null;
  }

  return (
    <div
      ref={tooltipRef}
      className="file-listing__tooltip"
      role="tooltip"
      style={{
        left: position.left,
        top: position.top
      }}
    >
      <div>名称：{tooltip.entry.name}</div>
      <div>修改日期：{tooltip.entry.modifiedLabel || "--"}</div>
      <div>标签：{formatTooltipTags(tooltip.entry)}</div>
      <div className="file-listing__tooltip-comment">注释：{tooltip.entry.comment || "--"}</div>
    </div>
  );
}

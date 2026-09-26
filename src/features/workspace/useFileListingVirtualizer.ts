import { useLayoutEffect, useRef, useState } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import type { TabViewMode } from "./types";

export function useFileListingVirtualizer({
  viewMode, count, detailsRowHeight, iconSize, editingEntryIndex, itemKeys, initialScrollTop = 0
}: { viewMode: TabViewMode; count: number; detailsRowHeight: number; iconSize: number; editingEntryIndex: number; itemKeys?: string[]; initialScrollTop?: number }) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [listingWidth, setListingWidth] = useState(0);
  useLayoutEffect(() => {
    const element = scrollContainerRef.current;
    if (!element) return;
    const update = () => setListingWidth(element.clientWidth || element.getBoundingClientRect().width || 0);
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const cardMinWidth = viewMode === "list" ? 220 : viewMode === "tiles" ? 260 : viewMode === "content" ? 0 : viewMode === "extra-large-icons" ? 188 : viewMode === "large-icons" ? 156 : viewMode === "medium-icons" ? 128 : 104;
  const cardGap = viewMode === "list" ? 4 : 6;
  const cardColumns = cardMinWidth > 0 ? Math.max(1, Math.floor(((listingWidth || 1000) - 12 + cardGap) / (cardMinWidth + cardGap))) : 1;
  const isGridView = viewMode !== "details" && viewMode !== "content";
  const virtualRowCount = viewMode === "content" ? count : isGridView ? Math.ceil(count / cardColumns) : count;
  const editingRowIndex = editingEntryIndex < 0 ? -1 : isGridView ? Math.floor(editingEntryIndex / cardColumns) : editingEntryIndex;
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: virtualRowCount, getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => viewMode === "details" ? detailsRowHeight : viewMode === "content" ? 112 : viewMode === "tiles" ? 76 : viewMode === "list" ? 42 : iconSize + 108,
    initialOffset: initialScrollTop,
    getItemKey: (index) => itemKeys?.[isGridView ? index * cardColumns : index] ?? index, initialRect: { width: listingWidth || 1000, height: 600 }, overscan: 10,
    scrollMargin: viewMode === "details" ? 24 : 0,
    scrollPaddingStart: viewMode === "details" ? 24 : 0,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      if (editingRowIndex >= 0 && !indexes.includes(editingRowIndex)) indexes.push(editingRowIndex);
      return indexes.sort((a, b) => a - b);
    }
  });
  const previousGeometry = useRef({ viewMode, detailsRowHeight, iconSize, listingWidth, cardColumns });
  useLayoutEffect(() => {
    const previous = previousGeometry.current;
    if (previous.viewMode !== viewMode || previous.detailsRowHeight !== detailsRowHeight ||
      previous.iconSize !== iconSize || previous.listingWidth !== listingWidth || previous.cardColumns !== cardColumns) {
      virtualizer.measure();
      previousGeometry.current = { viewMode, detailsRowHeight, iconSize, listingWidth, cardColumns };
    }
  }, [viewMode, detailsRowHeight, iconSize, listingWidth, cardColumns]);
  return { scrollContainerRef, virtualizer, cardColumns, cardGap, isGridView, virtualRowCount };
}

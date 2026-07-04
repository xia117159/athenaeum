import { type MouseEvent as ReactMouseEvent } from "react";

type DetailsResizeColumn<T extends string> = {
  id: T;
};

export function useDetailsColumnResize<T extends string, C extends DetailsResizeColumn<T>>({
  headerCellSelector,
  getMinWidth,
  getFallbackWidth,
  onResizeColumn
}: {
  headerCellSelector: string;
  getMinWidth: (column: C) => number;
  getFallbackWidth: (column: C) => number;
  onResizeColumn: (columnId: T, width: string) => void;
}) {
  return (column: C, event: ReactMouseEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const headerCell = event.currentTarget.closest(headerCellSelector);
    const measuredWidth = headerCell instanceof HTMLElement ? headerCell.getBoundingClientRect().width : 0;
    const startWidth = measuredWidth > 0 ? measuredWidth : getFallbackWidth(column);
    const startX = event.clientX;
    const minWidth = getMinWidth(column);

    const handleMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      const nextWidth = Math.max(minWidth, Math.round(startWidth + moveEvent.clientX - startX));
      onResizeColumn(column.id, `${nextWidth}px`);
    };

    const handleStop = () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleStop);
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleStop);
  };
}

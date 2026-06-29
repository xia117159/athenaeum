import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";

export type DetailsHeaderSortState<T extends string> = {
  columnId: T;
  direction: "asc" | "desc";
};

export type DetailsHeaderColumn<T extends string> = {
  id: T;
  label: string;
  align?: "left" | "right";
};

export function getDetailsSortIndicator(direction: "asc" | "desc") {
  return direction === "asc" ? "\u25b2" : "\u25bc";
}

export function getDetailsColumnSortIndicator<T extends string>(sort: DetailsHeaderSortState<T>, columnId: T) {
  return sort.columnId === columnId ? getDetailsSortIndicator(sort.direction) : "";
}

export function DetailsColumnHeader<T extends string, C extends DetailsHeaderColumn<T>>({
  headerRef,
  columns,
  sort,
  style,
  headerDataAttributes,
  headerClassName,
  cellClassName,
  buttonClassName,
  indicatorClassName,
  resizerClassName,
  dataAttributeName,
  getColumnLabel = (column) => column.label,
  renderLabel,
  onContextMenu,
  onHeaderPointerDown,
  onHeaderClick,
  onResizeStart
}: {
  headerRef?: RefObject<HTMLDivElement | null>;
  columns: C[];
  sort: DetailsHeaderSortState<T> | null;
  style?: CSSProperties;
  headerDataAttributes?: Record<string, string>;
  headerClassName: string;
  cellClassName: string;
  buttonClassName: string;
  indicatorClassName: string;
  resizerClassName: string;
  dataAttributeName?: string;
  getColumnLabel?: (column: C) => string;
  renderLabel?: (column: C) => ReactNode;
  onContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void;
  onHeaderPointerDown?: (event: ReactPointerEvent<HTMLElement>, column: C) => void;
  onHeaderClick: (event: ReactMouseEvent<HTMLElement>, column: C) => void;
  onResizeStart: (event: ReactMouseEvent<HTMLSpanElement>, column: C) => void;
}) {
  return (
    <div
      ref={headerRef}
      className={`details-column-header ${headerClassName}`}
      role="row"
      style={style}
      onContextMenu={onContextMenu}
      {...headerDataAttributes}
    >
      {columns.map((column) => {
        const ariaSort = sort?.columnId === column.id ? (sort.direction === "asc" ? "ascending" : "descending") : "none";
        const indicator = sort?.columnId === column.id ? getDetailsSortIndicator(sort.direction) : "";
        const customData = dataAttributeName ? { [dataAttributeName]: column.id } : {};
        const alignClassName = column.align ? ` file-cell--${column.align}` : "";
        return (
          <div
            key={column.id}
            className={`details-column-header__cell ${cellClassName}${alignClassName}`}
            role="columnheader"
            data-column-id={column.id}
            aria-sort={ariaSort}
            onPointerDown={(event) => onHeaderPointerDown?.(event, column)}
            onClick={(event) => onHeaderClick(event, column)}
            onContextMenu={onContextMenu}
            {...customData}
          >
            <button type="button" className={`details-column-header__button ${buttonClassName}${alignClassName}`}>
              <span className="details-column-header__label">{renderLabel ? renderLabel(column) : getColumnLabel(column)}</span>
              <span className={`details-column-header__indicator ${indicatorClassName}`}>{indicator}</span>
            </button>
            <span
              className={`details-column-header__resizer ${resizerClassName}`}
              role="separator"
              aria-orientation="vertical"
              aria-label={`resize ${getColumnLabel(column)} column`}
              onMouseDown={(event) => onResizeStart(event, column)}
              onClick={(event) => event.stopPropagation()}
            />
          </div>
        );
      })}
    </div>
  );
}

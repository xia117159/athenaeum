import { type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { DetailsColumnHeader, type DetailsHeaderColumn, type DetailsHeaderSortState } from "./DetailsColumnHeader";
import { DetailsColumnHeaderMenu } from "./DetailsColumnHeaderMenu";
import { getDetailsGridMetrics } from "./detailsGridMetrics";
import { ColumnDragFollowerView, ColumnDropIndicatorView } from "./fileListingColumnDrag";
import { useDetailsColumnDrag } from "./useDetailsColumnDrag";
import { useDetailsColumnResize } from "./useDetailsColumnResize";

export type DetailsListColumn<T extends string> = DetailsHeaderColumn<T> & {
  width: string;
  visible?: boolean;
};

export type DetailsListBaseRenderContext<T extends string, C extends DetailsListColumn<T>> = {
  gridStyle: CSSProperties;
  visibleColumns: C[];
};

export function DetailsListBase<T extends string, C extends DetailsListColumn<T>>({
  columns,
  sort,
  gap,
  getColumnLabel,
  getMenuColumnLabel = getColumnLabel,
  getColumnMinWidth,
  getColumnPixelWidth,
  onSort,
  onResizeColumn,
  onMoveColumn,
  onSetColumnVisibility,
  onShowAllColumns,
  onAutoFitColumn,
  headerClassName,
  cellClassName,
  buttonClassName,
  indicatorClassName,
  resizerClassName,
  resizerSelector,
  headerCellSelector,
  dropIndicatorClassName,
  dataAttributeName,
  headerDataAttributes,
  renderHeaderAccessory,
  children
}: {
  columns: C[];
  sort: DetailsHeaderSortState<T> | null;
  gap: number;
  getColumnLabel: (column: C) => string;
  getMenuColumnLabel?: (column: C) => string;
  getColumnMinWidth: (column: C) => number;
  getColumnPixelWidth: (column: C) => number;
  onSort: (columnId: T) => void;
  onResizeColumn: (columnId: T, width: string) => void;
  onMoveColumn?: (sourceId: T, targetId: T, placement: "before" | "after") => void;
  onSetColumnVisibility?: (columnId: T, visible: boolean) => void;
  onShowAllColumns?: (columnIds: T[]) => void;
  onAutoFitColumn: (column: C) => void;
  headerClassName: string;
  cellClassName: string;
  buttonClassName: string;
  indicatorClassName: string;
  resizerClassName: string;
  resizerSelector: string;
  headerCellSelector: string;
  dropIndicatorClassName?: string;
  dataAttributeName?: string;
  headerDataAttributes?: Record<string, string>;
  renderHeaderAccessory?: (column: C) => ReactNode;
  children: (context: DetailsListBaseRenderContext<T, C>) => ReactNode;
}) {
  const visibleColumns = columns.filter((column) => column.visible ?? true);
  const gridMetrics = getDetailsGridMetrics({
    columns: visibleColumns,
    gap,
    getColumnPixelWidth
  });
  const gridStyle = {
    gridTemplateColumns: gridMetrics.gridTemplateColumns,
    width: `${gridMetrics.width}px`
  } as CSSProperties;
  const columnMenuRef = useRef<HTMLDivElement | null>(null);
  const [columnMenuPosition, setColumnMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const {
    columnDragFollower,
    columnDropIndicator,
    consumeSuppressedClick,
    headerRef,
    startColumnPointerDrag
  } = useDetailsColumnDrag<T, C>({
    onMoveColumn,
    getColumnLabel,
    resizerSelector
  });
  const handleColumnResizeStart = useDetailsColumnResize<T, C>({
    headerCellSelector,
    getMinWidth: getColumnMinWidth,
    getFallbackWidth: getColumnPixelWidth,
    onResizeColumn
  });

  useEffect(() => {
    if (!columnMenuPosition) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && columnMenuRef.current?.contains(event.target)) {
        return;
      }
      setColumnMenuPosition(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setColumnMenuPosition(null);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [columnMenuPosition]);

  const openColumnHeaderMenu = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setColumnMenuPosition({ x: event.clientX, y: event.clientY });
  };

  const selectColumnMenuItem = (callback: () => void) => {
    callback();
    setColumnMenuPosition(null);
  };

  const handleHeaderClick = (event: ReactMouseEvent<HTMLElement>, column: C) => {
    if (event.target instanceof HTMLElement && event.target.closest(resizerSelector)) {
      return;
    }
    if (consumeSuppressedClick(column.id, event)) {
      return;
    }
    onSort(column.id);
  };

  return (
    <>
      {columnMenuPosition ? (
        <DetailsColumnHeaderMenu<T, C>
          menuRef={columnMenuRef}
          x={columnMenuPosition.x}
          y={columnMenuPosition.y}
          columns={columns}
          getColumnLabel={getMenuColumnLabel}
          onToggleColumn={(columnId) => {
            const column = columns.find((candidate) => candidate.id === columnId);
            selectColumnMenuItem(() => onSetColumnVisibility?.(columnId, !(column?.visible ?? true)));
          }}
          onShowAll={() => selectColumnMenuItem(() => onShowAllColumns?.(columns.map((column) => column.id)))}
          onAutoFit={() => selectColumnMenuItem(() => visibleColumns.forEach(onAutoFitColumn))}
        />
      ) : null}
      <DetailsColumnHeader
        headerRef={headerRef}
        columns={visibleColumns}
        sort={sort}
        style={gridStyle}
        headerDataAttributes={headerDataAttributes}
        headerClassName={headerClassName}
        cellClassName={cellClassName}
        buttonClassName={buttonClassName}
        indicatorClassName={indicatorClassName}
        resizerClassName={resizerClassName}
        dataAttributeName={dataAttributeName}
        getColumnLabel={getColumnLabel}
        renderAccessory={renderHeaderAccessory}
        onContextMenu={openColumnHeaderMenu}
        onHeaderPointerDown={(event, column) => startColumnPointerDrag(event, column)}
        onHeaderClick={(event, column) => handleHeaderClick(event, column)}
        onResizeStart={(event, column) => handleColumnResizeStart(column, event)}
      />
      <ColumnDropIndicatorView headerRef={headerRef} indicator={columnDropIndicator} className={dropIndicatorClassName} />
      {children({ gridStyle, visibleColumns })}
      <ColumnDragFollowerView follower={columnDragFollower} />
    </>
  );
}

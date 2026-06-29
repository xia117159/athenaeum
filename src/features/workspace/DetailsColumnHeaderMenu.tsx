import type { RefObject } from "react";

type ColumnMenuColumn<T extends string> = {
  id: T;
  label?: string;
  visible?: boolean;
};

export function DetailsColumnHeaderMenu<T extends string, C extends ColumnMenuColumn<T> = ColumnMenuColumn<T>>({
  menuRef,
  x,
  y,
  columns,
  visibility,
  getColumnLabel = (column) => column.label ?? column.id,
  onToggleColumn,
  onShowAll,
  onAutoFit
}: {
  menuRef: RefObject<HTMLDivElement | null>;
  x: number;
  y: number;
  columns: C[];
  visibility?: Record<T, boolean>;
  getColumnLabel?: (column: C) => string;
  onToggleColumn: (columnId: T) => void;
  onShowAll: () => void;
  onAutoFit: () => void;
}) {
  const isColumnVisible = (column: C) => visibility?.[column.id] ?? column.visible ?? true;

  return (
    <div
      ref={menuRef}
      className="column-header-menu"
      role="menu"
      style={{ left: x, top: y }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {columns.map((column) => (
        <button
          key={column.id}
          type="button"
          className="column-header-menu__item"
          data-column-menu-id={column.id}
          role="menuitemcheckbox"
          aria-checked={isColumnVisible(column)}
          onClick={() => onToggleColumn(column.id)}
        >
          <span className="column-header-menu__check" aria-hidden="true">
            {isColumnVisible(column) ? "\u2713" : ""}
          </span>
          <span>{getColumnLabel(column)}</span>
        </button>
      ))}
      <div className="column-header-menu__separator" role="separator" />
      <button type="button" className="column-header-menu__item" role="menuitem" onClick={onShowAll}>
        <span className="column-header-menu__check" aria-hidden="true" />
        <span>{"\u663e\u793a\u6240\u6709\u5217"}</span>
      </button>
      <button type="button" className="column-header-menu__item" role="menuitem" onClick={onAutoFit}>
        <span className="column-header-menu__check" aria-hidden="true" />
        <span>{"\u7acb\u5373\u81ea\u52a8\u8c03\u6574\u5217\u5bbd"}</span>
      </button>
    </div>
  );
}

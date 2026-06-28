import type { RefObject } from "react";

type ColumnMenuColumn<T extends string> = {
  id: T;
  label: string;
};

export function NavigationColumnHeaderMenu<T extends string>({
  menuRef,
  x,
  y,
  columns,
  visibility,
  onToggleColumn,
  onShowAll,
  onAutoFit
}: {
  menuRef: RefObject<HTMLDivElement | null>;
  x: number;
  y: number;
  columns: Array<ColumnMenuColumn<T>>;
  visibility: Record<T, boolean>;
  onToggleColumn: (columnId: T) => void;
  onShowAll: () => void;
  onAutoFit: () => void;
}) {
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
          aria-checked={visibility[column.id]}
          onClick={() => onToggleColumn(column.id)}
        >
          <span className="column-header-menu__check" aria-hidden="true">
            {visibility[column.id] ? "\u2713" : ""}
          </span>
          <span>{column.label}</span>
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

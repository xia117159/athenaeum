import {
  WORKSPACE_SORT_COLUMN_MENU_ITEMS,
  WORKSPACE_SORT_DIRECTION_MENU_ITEMS,
  WORKSPACE_VIEW_MODE_MENU_ITEMS
} from "./workspaceSharedMenus";
import type { ColumnId, SortDirection, SortState, TabViewMode } from "./types";

type SharedMenuClassNames = {
  item: string;
  check: string;
  separator?: string;
};

export function WorkspaceViewMenuItems({
  classNames,
  viewMode,
  disabled = false,
  onSelect
}: {
  classNames: SharedMenuClassNames;
  viewMode: TabViewMode;
  disabled?: boolean;
  onSelect: (viewMode: TabViewMode) => void;
}) {
  return (
    <>
      {WORKSPACE_VIEW_MODE_MENU_ITEMS.map((option) => (
        <button
          key={option.id}
          type="button"
          className={classNames.item}
          disabled={disabled}
          onClick={() => onSelect(option.id)}
        >
          <span className={classNames.check}>{viewMode === option.id ? "✓" : ""}</span>
          <span>{option.label}</span>
        </button>
      ))}
    </>
  );
}

export function WorkspaceSortMenuItems({
  classNames,
  sort,
  disabled = false,
  onSelectColumn,
  onSelectDirection
}: {
  classNames: SharedMenuClassNames;
  sort?: SortState;
  disabled?: boolean;
  onSelectColumn: (columnId: ColumnId) => void;
  onSelectDirection: (direction: SortDirection) => void;
}) {
  return (
    <>
      {WORKSPACE_SORT_COLUMN_MENU_ITEMS.map((option) => (
        <button
          key={option.id}
          type="button"
          className={classNames.item}
          disabled={disabled}
          onClick={() => onSelectColumn(option.id)}
        >
          <span className={classNames.check}>{sort?.columnId === option.id ? "✓" : ""}</span>
          <span>{option.label}</span>
        </button>
      ))}
      <div className={classNames.separator ?? ""} role="separator" />
      {WORKSPACE_SORT_DIRECTION_MENU_ITEMS.map((option) => (
        <button
          key={option.id}
          type="button"
          className={classNames.item}
          disabled={disabled}
          onClick={() => onSelectDirection(option.id)}
        >
          <span className={classNames.check}>{sort?.direction === option.id ? "✓" : ""}</span>
          <span>{option.label}</span>
        </button>
      ))}
    </>
  );
}

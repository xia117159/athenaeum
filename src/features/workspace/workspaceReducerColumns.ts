type ColumnLayout<T extends string> = {
  id: T;
  visible: boolean;
  width: string;
};

const MIN_COLUMN_WIDTH = 40;
const MAX_COLUMN_WIDTH = 960;

function normalizeColumnWidth(width: string) {
  const trimmed = width.trim();
  const pixelMatch = /^(\d+(?:\.\d+)?)px$/i.exec(trimmed);
  if (!pixelMatch) {
    return trimmed || `${MIN_COLUMN_WIDTH}px`;
  }

  const nextWidth = Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(Number(pixelMatch[1]))));
  return `${nextWidth}px`;
}

export function setColumnWidth<T extends string, C extends ColumnLayout<T>>(columns: C[], columnId: T, width: string) {
  let changed = false;
  const normalizedWidth = normalizeColumnWidth(width);
  const nextColumns = columns.map((column) => {
    if (column.id !== columnId) {
      return column;
    }
    changed = true;
    return {
      ...column,
      width: normalizedWidth
    };
  });
  return changed ? nextColumns : columns;
}

export function setColumnVisibility<T extends string, C extends ColumnLayout<T>>(columns: C[], columnIds: T[], visible: boolean) {
  const targetIds = new Set(columnIds);
  let changed = false;
  const nextColumns = columns.map((column) => {
    if (!targetIds.has(column.id) || column.visible === visible) {
      return column;
    }
    changed = true;
    return {
      ...column,
      visible
    };
  });
  return changed ? nextColumns : columns;
}

export function moveColumn<T extends string, C extends ColumnLayout<T>>(
  columns: C[],
  sourceId: T,
  targetId: T,
  placement: "before" | "after"
) {
  if (sourceId === targetId) {
    return columns;
  }

  const sourceIndex = columns.findIndex((column) => column.id === sourceId);
  const targetIndex = columns.findIndex((column) => column.id === targetId);
  if (sourceIndex === -1 || targetIndex === -1) {
    return columns;
  }

  const nextColumns = [...columns];
  const [source] = nextColumns.splice(sourceIndex, 1);
  const targetIndexAfterRemoval = nextColumns.findIndex((column) => column.id === targetId);
  if (targetIndexAfterRemoval === -1) {
    return columns;
  }
  const insertIndex = placement === "before" ? targetIndexAfterRemoval : targetIndexAfterRemoval + 1;
  nextColumns.splice(insertIndex, 0, source);

  return nextColumns.map((column, index) => (column === columns[index] ? columns[index] : column));
}

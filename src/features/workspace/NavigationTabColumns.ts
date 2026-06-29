import { estimateDetailsAutoFitColumnWidth } from "./detailsColumnAutoFit";
import { getDetailsColumnPixelWidth } from "./detailsGridMetrics";
import { getTextMeasureUnits } from "./textMeasure";
import type { NavigationColumnDefinition, NavigationColumnId, NavigationItem } from "./types";

export type NavigationSortState = { columnId: NavigationColumnId; direction: "asc" | "desc" };

export const NAVIGATION_GRID_COLUMN_GAP_PX = 4;
export const NAVIGATION_COLUMN_MIN_WIDTHS: Record<NavigationColumnId, number> = {
  name: 64,
  kind: 40,
  path: 64,
  comment: 40,
  status: 40,
  lastOpened: 64
};

export const NAVIGATION_COLUMNS: NavigationColumnDefinition[] = [
  { id: "name", label: "\u540d\u79f0", visible: true, width: "220px", align: "left" },
  { id: "kind", label: "\u7c7b\u578b", visible: true, width: "96px", align: "left" },
  { id: "path", label: "\u8def\u5f84", visible: true, width: "180px", align: "left" },
  { id: "comment", label: "\u6ce8\u91ca", visible: true, width: "112px", align: "left" },
  { id: "status", label: "\u72b6\u6001", visible: true, width: "80px", align: "left" },
  { id: "lastOpened", label: "\u6700\u8fd1\u6253\u5f00", visible: true, width: "132px", align: "left" }
];

const DEFAULT_NAVIGATION_COLUMN_BY_ID = new Map(NAVIGATION_COLUMNS.map((column) => [column.id, column] as const));
const LEGACY_DEFAULT_NAVIGATION_WIDTHS: Record<NavigationColumnId, string> = {
  name: "240px",
  kind: "112px",
  path: "220px",
  comment: "148px",
  status: "120px",
  lastOpened: "148px"
};

export const STATUS_LABELS: Record<NavigationItem["targetStatus"], string> = {
  ok: "\u6b63\u5e38",
  missing: "\u7f3a\u5931",
  permissionDenied: "\u65e0\u6743\u9650",
  unsupportedRemote: "\u8fdc\u7a0b\u6682\u4e0d\u652f\u6301",
  invalidPath: "\u8def\u5f84\u65e0\u6548",
  unknownError: "\u672a\u77e5\u9519\u8bef"
};

export const KIND_LABELS: Record<NavigationItem["targetKind"], string> = {
  file: "\u6587\u4ef6",
  folder: "\u6587\u4ef6\u5939",
  missing: "\u7f3a\u5931",
  unknown: "\u672a\u77e5",
  remoteUnsupported: "\u8fdc\u7a0b\u6682\u4e0d\u652f\u6301"
};

function normalizeNavigationColumnId(value?: string | null): NavigationColumnId | null {
  return DEFAULT_NAVIGATION_COLUMN_BY_ID.has(value as NavigationColumnId) ? (value as NavigationColumnId) : null;
}

export function getNavigationColumnHeaderMinWidth(column: Pick<NavigationColumnDefinition, "id" | "label">) {
  const fallback = DEFAULT_NAVIGATION_COLUMN_BY_ID.get(column.id)?.label ?? column.id;
  const label = column.label.trim() || fallback;
  return Math.max(NAVIGATION_COLUMN_MIN_WIDTHS[column.id], Math.ceil(getTextMeasureUnits(label) * 6 + 4));
}

function normalizeNavigationColumnWidth(columnId: NavigationColumnId, width?: string | null, label?: string | null) {
  const fallbackColumn = DEFAULT_NAVIGATION_COLUMN_BY_ID.get(columnId);
  const fallback = fallbackColumn?.width ?? "120px";
  const trimmed = typeof width === "string" ? width.trim() : "";
  const match = /^(\d+(?:\.\d+)?)px$/i.exec(trimmed);
  if (!match) {
    return fallback;
  }
  const minWidth = getNavigationColumnHeaderMinWidth({
    id: columnId,
    label: typeof label === "string" && label.trim() ? label : fallbackColumn?.label ?? columnId
  });
  return `${Math.max(minWidth, Math.round(Number(match[1])))}px`;
}

export function cloneNavigationColumns(columns: NavigationColumnDefinition[] = NAVIGATION_COLUMNS) {
  return columns.map((column) => ({ ...column }));
}

function isLegacyDefaultNavigationColumnSet(columns: NavigationColumnDefinition[]) {
  return (
    columns.length === NAVIGATION_COLUMNS.length &&
    columns.every((column, index) => {
      const fallback = NAVIGATION_COLUMNS[index];
      return (
        fallback?.id === column.id &&
        column.label === fallback.label &&
        column.visible === true &&
        column.align === fallback.align &&
        column.width === LEGACY_DEFAULT_NAVIGATION_WIDTHS[column.id]
      );
    })
  );
}

export function normalizeNavigationColumns(
  columns?: Array<{
    id?: string | null;
    label?: string | null;
    visible?: boolean | null;
    width?: string | null;
    align?: string | null;
  }> | null
): NavigationColumnDefinition[] {
  if (!columns || columns.length === 0) {
    return cloneNavigationColumns();
  }

  const seen = new Set<NavigationColumnId>();
  const normalized: NavigationColumnDefinition[] = [];
  const normalizedById = new Map<NavigationColumnId, NavigationColumnDefinition>();
  for (const column of columns) {
    const id = normalizeNavigationColumnId(column.id);
    if (!id || seen.has(id)) {
      continue;
    }
    const fallback = DEFAULT_NAVIGATION_COLUMN_BY_ID.get(id)!;
    seen.add(id);
    const label = typeof column.label === "string" && column.label.trim() ? column.label : fallback.label;
    const normalizedColumn: NavigationColumnDefinition = {
      id,
      label,
      visible: typeof column.visible === "boolean" ? column.visible : fallback.visible,
      width: normalizeNavigationColumnWidth(id, column.width, label),
      align: column.align === "right" ? "right" : "left"
    };
    normalized.push(normalizedColumn);
    normalizedById.set(id, normalizedColumn);
  }

  if (seen.size < NAVIGATION_COLUMNS.length) {
    return NAVIGATION_COLUMNS.map((column) => normalizedById.get(column.id) ?? { ...column });
  }

  if (isLegacyDefaultNavigationColumnSet(normalized)) {
    return cloneNavigationColumns();
  }

  return normalized.length > 0 ? normalized : cloneNavigationColumns();
}

export function createNavigationColumnVisibility(columns: NavigationColumnDefinition[]) {
  return Object.fromEntries(columns.map((column) => [column.id, column.visible])) as Record<NavigationColumnId, boolean>;
}

export function getNavigationColumnPixelWidth(column: NavigationColumnDefinition) {
  return getDetailsColumnPixelWidth({
    column,
    minWidth: getNavigationColumnHeaderMinWidth(column),
    fallbackWidth: Number.parseInt(DEFAULT_NAVIGATION_COLUMN_BY_ID.get(column.id)?.width ?? "120px", 10)
  });
}

export function formatNavigationTime(value?: string | null) {
  if (!value) {
    return "--";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function getNavigationCellText(item: NavigationItem, columnId: NavigationColumnId) {
  switch (columnId) {
    case "name":
      return item.displayName;
    case "kind":
      return KIND_LABELS[item.targetKind];
    case "path":
      return item.path;
    case "comment":
      return item.description || "--";
    case "status":
      return STATUS_LABELS[item.targetStatus];
    case "lastOpened":
      return formatNavigationTime(item.lastOpenedAt);
    default:
      return "";
  }
}

export function estimateNavigationColumnWidth(column: NavigationColumnDefinition, items: NavigationItem[]) {
  return estimateDetailsAutoFitColumnWidth({
    column,
    items,
    getHeaderText: (candidate) => candidate.label,
    getCellText: (item, candidate) => getNavigationCellText(item, candidate.id),
    getMinWidth: (candidate) => NAVIGATION_COLUMN_MIN_WIDTHS[candidate.id],
    getIconAllowance: (candidate) => (candidate.id === "name" ? 22 : 0)
  });
}

export function sortNavigationItemsForColumn(items: NavigationItem[], sort: NavigationSortState | null) {
  if (!sort) {
    return items;
  }
  const direction = sort.direction === "asc" ? 1 : -1;
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const result = getNavigationCellText(left.item, sort.columnId).localeCompare(
        getNavigationCellText(right.item, sort.columnId),
        "zh-CN",
        { numeric: true, sensitivity: "base" }
      );
      return result === 0 ? left.index - right.index : result * direction;
    })
    .map(({ item }) => item);
}

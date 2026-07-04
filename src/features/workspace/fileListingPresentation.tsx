import type { ReactNode } from "react";
import { estimateDetailsAutoFitColumnWidth } from "./detailsColumnAutoFit";
import { getDetailsColumnSortIndicator } from "./DetailsColumnHeader";
import { getDetailsColumnPixelWidth, getDetailsGridMetrics as getSharedDetailsGridMetrics } from "./detailsGridMetrics";
import { FileSystemIcon } from "./FileSystemIcon";
import type { SystemIconImageList } from "./systemIconGateway";
import { getTextMeasureUnits } from "./textMeasure";
import type {
  ColumnDefinition,
  ColumnId,
  EntryViewModel,
  GitFileStatus,
  SortState,
  TabViewMode
} from "./types";

export const ICON_VIEW_MODES: TabViewMode[] = ["extra-large-icons", "large-icons", "medium-icons", "small-icons"];

const DETAILS_GRID_COLUMN_GAP_PX = 4;
const DETAILS_MIN_COLUMN_WIDTH_PX = 40;

const DEFAULT_DETAILS_COLUMN_WIDTHS: Record<ColumnId, number> = {
  name: 240,
  type: 112,
  extension: 96,
  size: 96,
  created: 148,
  modified: 148,
  accessed: 148,
  tags: 120,
  comment: 220,
  location: 220
};

export type InlineIconSpec = {
  displaySize: number;
  imageList: SystemIconImageList;
};

export type ListingEntry = EntryViewModel & {
  inlineCreate?: boolean;
};

export function getLocalizedColumnLabel(column: ColumnDefinition) {
  switch (column.id) {
    case "name":
      return "名称";
    case "type":
      return "类型";
    case "extension":
      return "扩展名";
    case "size":
      return "大小";
    case "created":
      return "创建日期";
    case "modified":
      return "修改日期";
    case "accessed":
      return "访问日期";
    case "tags":
      return "标签";
    case "comment":
      return "注释";
    case "location":
      return "位置";
    default:
      return column.label;
  }
}

export function getEntryTypeLabel(entry: EntryViewModel) {
  return entry.kind === "folder" ? "文件夹" : entry.extension.replace(".", "").toUpperCase() || "文件";
}

export function getLocationLabel(entry: EntryViewModel, currentPath: string) {
  return entry.parentPath === currentPath ? "当前目录" : entry.parentPath;
}

export function getColumnMenuLabel(columnId: ColumnId) {
  switch (columnId) {
    case "name":
      return "名称";
    case "type":
      return "类型";
    case "extension":
      return "扩展名";
    case "size":
      return "大小";
    case "created":
      return "创建日期";
    case "modified":
      return "修改日期";
    case "accessed":
      return "访问日期";
    case "tags":
      return "标签";
    case "comment":
      return "注释";
    case "location":
      return "位置";
    default:
      return columnId;
  }
}

function parseSizeLabel(sizeLabel: string) {
  if (!sizeLabel || sizeLabel === "--") {
    return -1;
  }

  const match = sizeLabel.trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
  if (!match) {
    return Number.NaN;
  }

  const value = Number(match[1]);
  const unit = match[2].toUpperCase();
  const multiplierMap: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4
  };
  return value * (multiplierMap[unit] ?? 1);
}

function parseModifiedLabel(label: string) {
  const timestamp = Date.parse(label.replace(" ", "T"));
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function compareEntryByColumn(left: EntryViewModel, right: EntryViewModel, columnId: ColumnId, currentPath: string) {
  switch (columnId) {
    case "name":
      return left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" });
    case "type":
      return getEntryTypeLabel(left).localeCompare(getEntryTypeLabel(right), "zh-CN", {
        numeric: true,
        sensitivity: "base"
      });
    case "extension":
      return left.extension.localeCompare(right.extension, "zh-CN", { numeric: true, sensitivity: "base" });
    case "size":
      return parseSizeLabel(left.sizeLabel) - parseSizeLabel(right.sizeLabel);
    case "created":
      return parseModifiedLabel(left.createdLabel ?? "") - parseModifiedLabel(right.createdLabel ?? "");
    case "modified":
      return parseModifiedLabel(left.modifiedLabel) - parseModifiedLabel(right.modifiedLabel);
    case "accessed":
      return parseModifiedLabel(left.accessedLabel ?? "") - parseModifiedLabel(right.accessedLabel ?? "");
    case "tags":
      return left.tags.join(",").localeCompare(right.tags.join(","), "zh-CN", { sensitivity: "base" });
    case "comment":
      return (left.comment ?? "").localeCompare(right.comment ?? "", "zh-CN", { numeric: true, sensitivity: "base" });
    case "location":
      return getLocationLabel(left, currentPath).localeCompare(getLocationLabel(right, currentPath), "zh-CN", {
        numeric: true,
        sensitivity: "base"
      });
    default:
      return 0;
  }
}

export function sortEntries(entries: EntryViewModel[], sort: SortState, currentPath: string) {
  const direction = sort.direction === "asc" ? 1 : -1;
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "folder" ? -1 : 1;
    }

    const columnResult = compareEntryByColumn(left, right, sort.columnId, currentPath);
    if (columnResult !== 0) {
      return columnResult * direction;
    }

    return left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" });
  });
}

export function getSortIndicator(sort: SortState, columnId: ColumnId) {
  if (sort.columnId !== columnId) {
    return "";
  }
  return sort.direction === "asc" ? "▲" : "▼";
}

export function getViewBodyClassName(viewMode: TabViewMode, isEmpty: boolean) {
  const classes = ["file-listing__body", `file-listing__body--${viewMode}`];
  if (isEmpty) {
    classes.push("is-empty");
  }
  return classes.join(" ");
}

export function getInlineIconSpec(viewMode: TabViewMode): InlineIconSpec {
  switch (viewMode) {
    case "extra-large-icons":
      return { displaySize: 72, imageList: "jumbo" };
    case "large-icons":
      return { displaySize: 48, imageList: "extra-large" };
    case "medium-icons":
      return { displaySize: 32, imageList: "large" };
    case "small-icons":
      return { displaySize: 16, imageList: "small" };
    case "details":
      return { displaySize: 16, imageList: "sys-small" };
    case "tiles":
      return { displaySize: 48, imageList: "extra-large" };
    case "list":
    case "content":
    default:
      return { displaySize: 16, imageList: "sys-small" };
  }
}

export function renderNameCell(
  entry: EntryViewModel,
  iconSpec: InlineIconSpec,
  iconClassName?: string,
  nameContent?: ReactNode,
  gitStatus?: GitFileStatus
) {
  return (
    <div className={`entry-name${iconClassName ? ` ${iconClassName}` : ""}`}>
      <FileSystemIcon
        kind={entry.kind}
        path={entry.path}
        extension={entry.extension}
        size={iconSpec.displaySize}
        imageList={iconSpec.imageList}
        hidden={entry.isHidden}
        gitStatus={gitStatus}
      />
      {nameContent ?? <span>{entry.name}</span>}
    </div>
  );
}

export function renderTagStack(entry: EntryViewModel) {
  return (
    <div className="tag-stack">
      {entry.tags.length > 0 ? entry.tags.map((tag) => <span key={tag}>{tag}</span>) : <span>--</span>}
    </div>
  );
}

export function renderDetailsCell(
  entry: ListingEntry,
  columnId: ColumnDefinition["id"],
  currentPath: string,
  nameContent?: ReactNode,
  gitStatus?: GitFileStatus
) {
  const detailIconSpec = getInlineIconSpec("details");
  switch (columnId) {
    case "name":
      return renderNameCell(entry, detailIconSpec, undefined, nameContent, gitStatus);
    case "type":
      return getEntryTypeLabel(entry);
    case "extension":
      return entry.extension || "--";
    case "size":
      return entry.sizeLabel;
    case "created":
      return entry.createdLabel ?? "--";
    case "modified":
      return entry.modifiedLabel;
    case "accessed":
      return entry.accessedLabel ?? "--";
    case "tags":
      return renderTagStack(entry);
    case "comment":
      return entry.comment || "--";
    case "location":
      return getLocationLabel(entry, currentPath);
    default:
      return "";
  }
}

export function getDetailsCellText(entry: EntryViewModel, columnId: ColumnId, currentPath: string) {
  switch (columnId) {
    case "name":
      return entry.name;
    case "type":
      return getEntryTypeLabel(entry);
    case "extension":
      return entry.extension || "--";
    case "size":
      return entry.sizeLabel;
    case "created":
      return entry.createdLabel ?? "--";
    case "modified":
      return entry.modifiedLabel;
    case "accessed":
      return entry.accessedLabel ?? "--";
    case "tags":
      return entry.tags.length > 0 ? entry.tags.join(", ") : "--";
    case "comment":
      return entry.comment || "--";
    case "location":
      return getLocationLabel(entry, currentPath);
    default:
      return "";
  }
}

export function formatTooltipTags(entry: EntryViewModel) {
  return entry.tags.length > 0 ? entry.tags.join("、") : "--";
}

export function estimateAutoFitColumnWidth(column: ColumnDefinition, entries: EntryViewModel[], currentPath: string) {
  return estimateDetailsAutoFitColumnWidth({
    column,
    items: entries,
    getHeaderText: (candidate) => getColumnMenuLabel(candidate.id),
    getCellText: (entry, candidate) => getDetailsCellText(entry, candidate.id, currentPath),
    getMinWidth: () => DETAILS_MIN_COLUMN_WIDTH_PX,
    getIconAllowance: (candidate) => (candidate.id === "name" ? 22 : 0)
  });
}

export function getColumnHeaderMinWidth(column: ColumnDefinition) {
  const label = getLocalizedColumnLabel(column) || column.label || column.id;
  return Math.max(DETAILS_MIN_COLUMN_WIDTH_PX, Math.ceil(getTextMeasureUnits(label) * 6 + 4));
}

export function getColumnPixelWidth(column: ColumnDefinition) {
  const fallbackWidth = DEFAULT_DETAILS_COLUMN_WIDTHS[column.id] ?? 120;
  return getDetailsColumnPixelWidth({
    column,
    minWidth: getColumnHeaderMinWidth(column),
    fallbackWidth
  });
}

export function getDetailsGridMetrics(columns: ColumnDefinition[]) {
  return getSharedDetailsGridMetrics({
    columns,
    gap: DETAILS_GRID_COLUMN_GAP_PX,
    getColumnPixelWidth
  });
}

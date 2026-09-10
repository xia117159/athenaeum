import type { ColumnId, EntryViewModel, SortState } from "./types";

export function getEntryTypeLabel(entry: EntryViewModel) {
  return entry.kind === "folder" ? "文件夹" : entry.extension.replace(".", "").toUpperCase() || "文件";
}

export function getLocationLabel(entry: EntryViewModel, currentPath: string) {
  return entry.parentPath === currentPath ? "当前目录" : entry.parentPath;
}

function parseSizeLabel(sizeLabel: string) {
  if (!sizeLabel || sizeLabel === "--") return -1;
  const match = sizeLabel.trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
  if (!match) return Number.NaN;
  const multiplierMap: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Number(match[1]) * (multiplierMap[match[2].toUpperCase()] ?? 1);
}

function parseModifiedLabel(label: string) {
  const timestamp = Date.parse(label.replace(" ", "T"));
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function compareEntryByColumn(left: EntryViewModel, right: EntryViewModel, columnId: ColumnId, currentPath: string) {
  switch (columnId) {
    case "name": return left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" });
    case "type": return getEntryTypeLabel(left).localeCompare(getEntryTypeLabel(right), "zh-CN", { numeric: true, sensitivity: "base" });
    case "extension": return left.extension.localeCompare(right.extension, "zh-CN", { numeric: true, sensitivity: "base" });
    case "size": return parseSizeLabel(left.sizeLabel) - parseSizeLabel(right.sizeLabel);
    case "created": return parseModifiedLabel(left.createdLabel ?? "") - parseModifiedLabel(right.createdLabel ?? "");
    case "modified": return parseModifiedLabel(left.modifiedLabel) - parseModifiedLabel(right.modifiedLabel);
    case "accessed": return parseModifiedLabel(left.accessedLabel ?? "") - parseModifiedLabel(right.accessedLabel ?? "");
    case "tags": return left.tags.join(",").localeCompare(right.tags.join(","), "zh-CN", { sensitivity: "base" });
    case "comment": return (left.comment ?? "").localeCompare(right.comment ?? "", "zh-CN", { numeric: true, sensitivity: "base" });
    case "location": return getLocationLabel(left, currentPath).localeCompare(getLocationLabel(right, currentPath), "zh-CN", { numeric: true, sensitivity: "base" });
    default: return 0;
  }
}

export function sortEntries(entries: EntryViewModel[], sort: SortState, currentPath: string) {
  const direction = sort.direction === "asc" ? 1 : -1;
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
    const columnResult = compareEntryByColumn(left, right, sort.columnId, currentPath);
    if (columnResult !== 0) return columnResult * direction;
    return left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" });
  });
}

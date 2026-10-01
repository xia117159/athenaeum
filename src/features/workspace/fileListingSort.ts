import type { ColumnId, EntryViewModel, SortState } from "./types";
import { exactSizeBytes } from "./directorySizes";

const NUMERIC_COLLATOR = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
const TEXT_COLLATOR = new Intl.Collator("zh-CN", { sensitivity: "base" });

export function getEntryTypeLabel(entry: EntryViewModel) {
  return entry.kind === "folder" ? "文件夹" : entry.extension.replace(".", "").toUpperCase() || "文件";
}

export function getLocationLabel(entry: EntryViewModel, currentPath: string) {
  return entry.parentPath === currentPath ? "当前目录" : entry.parentPath;
}

function parseSizeLabel(sizeLabel: string) {
  if (!sizeLabel || sizeLabel === "--") return Number.NaN;
  const match = sizeLabel.trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
  if (!match) return Number.NaN;
  const multiplierMap: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Number(match[1]) * (multiplierMap[match[2].toUpperCase()] ?? 1);
}

function sortableSize(entry: EntryViewModel): bigint | null {
  const exact = exactSizeBytes(entry);
  if (exact !== null || entry.kind === "folder" || entry.sizeBytes != null) return exact;
  const legacy = parseSizeLabel(entry.sizeLabel);
  return Number.isSafeInteger(Math.round(legacy)) && legacy >= 0 ? BigInt(Math.round(legacy)) : null;
}

function parseModifiedLabel(label: string) {
  const timestamp = Date.parse(label.replace(" ", "T"));
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function compareEntryByColumn(left: EntryViewModel, right: EntryViewModel, columnId: ColumnId, currentPath: string) {
  switch (columnId) {
    case "name": return NUMERIC_COLLATOR.compare(left.name, right.name);
    case "type": return NUMERIC_COLLATOR.compare(getEntryTypeLabel(left), getEntryTypeLabel(right));
    case "extension": return NUMERIC_COLLATOR.compare(left.extension, right.extension);
    case "size": return 0; // Exact sizes and unknown-last ordering are handled below.
    case "created": return parseModifiedLabel(left.createdLabel ?? "") - parseModifiedLabel(right.createdLabel ?? "");
    case "modified": return parseModifiedLabel(left.modifiedLabel) - parseModifiedLabel(right.modifiedLabel);
    case "accessed": return parseModifiedLabel(left.accessedLabel ?? "") - parseModifiedLabel(right.accessedLabel ?? "");
    case "tags": return TEXT_COLLATOR.compare(left.tags.join(","), right.tags.join(","));
    case "comment": return NUMERIC_COLLATOR.compare(left.comment ?? "", right.comment ?? "");
    case "location": return NUMERIC_COLLATOR.compare(getLocationLabel(left, currentPath), getLocationLabel(right, currentPath));
    default: return 0;
  }
}

export function sortEntries(entries: EntryViewModel[], sort: SortState, currentPath: string) {
  const direction = sort.direction === "asc" ? 1 : -1;
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
    if (sort.columnId === "size") {
      const leftSize = sortableSize(left); const rightSize = sortableSize(right);
      if ((leftSize === null) !== (rightSize === null)) return leftSize === null ? 1 : -1;
      if (leftSize !== null && rightSize !== null && leftSize !== rightSize) return (leftSize < rightSize ? -1 : 1) * direction;
    }
    const columnResult = compareEntryByColumn(left, right, sort.columnId, currentPath);
    if (columnResult !== 0) return columnResult * direction;
    return NUMERIC_COLLATOR.compare(left.name, right.name);
  });
}

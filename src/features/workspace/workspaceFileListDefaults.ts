import type { ColumnDefinition } from "./types";

export const DEFAULT_COLUMNS: ColumnDefinition[] = [
  { id: "name", label: "名称", visible: true, width: "240px", align: "left" },
  { id: "type", label: "类型", visible: true, width: "112px", align: "left" },
  { id: "extension", label: "扩展名", visible: true, width: "96px", align: "left" },
  { id: "size", label: "大小", visible: true, width: "96px", align: "right" },
  { id: "created", label: "创建日期", visible: true, width: "148px", align: "left" },
  { id: "modified", label: "修改日期", visible: true, width: "148px", align: "left" },
  { id: "accessed", label: "访问日期", visible: true, width: "148px", align: "left" },
  { id: "tags", label: "标签", visible: true, width: "120px", align: "left" },
  { id: "comment", label: "注释", visible: true, width: "220px", align: "left" },
  { id: "location", label: "位置", visible: false, width: "220px", align: "left" }
];

export const DEFAULT_TOOLTIP_HOVER_DELAY_MS = 200;
export const DEFAULT_METADATA_RETENTION_HOURS = 720;

export function cloneColumns(columns: ColumnDefinition[] = DEFAULT_COLUMNS): ColumnDefinition[] {
  return columns.map((column) => ({ ...column }));
}

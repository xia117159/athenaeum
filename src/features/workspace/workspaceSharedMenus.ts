import type { ColumnId, SortDirection, TabViewMode } from "./types";

export const WORKSPACE_VIEW_MODE_MENU_ITEMS: Array<{ id: TabViewMode; label: string }> = [
  { id: "extra-large-icons", label: "超大图标" },
  { id: "large-icons", label: "大图标" },
  { id: "medium-icons", label: "中等图标" },
  { id: "small-icons", label: "小图标" },
  { id: "list", label: "列表" },
  { id: "details", label: "详细信息列表" },
  { id: "tiles", label: "平铺" },
  { id: "content", label: "内容" }
];

export const WORKSPACE_SORT_COLUMN_MENU_ITEMS: Array<{ id: ColumnId; label: string }> = [
  { id: "name", label: "名称" },
  { id: "modified", label: "修改日期" },
  { id: "type", label: "类型" },
  { id: "size", label: "大小" }
];

export const WORKSPACE_SORT_DIRECTION_MENU_ITEMS: Array<{ id: SortDirection; label: string }> = [
  { id: "asc", label: "递增" },
  { id: "desc", label: "递减" }
];

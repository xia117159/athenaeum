import { memo, type CSSProperties, type ReactNode } from "react";
import type { ListingEntry } from "./fileListingPresentation";
import type { FolderListingRow } from "./folderExpansion";
import type { ColumnDefinition, GitFileStatus, TabViewMode } from "./types";
import type { QuickFilterProgram } from "./quickFilterTypes";

type DropOperation = "copy" | "move";

export type RowRenderState = {
  entry: ListingEntry;
  selected: boolean;
  dropTarget: boolean;
  dropOperation?: DropOperation;
  editing: boolean;
  editValue?: string;
  cut: boolean;
  gitStatus?: GitFileStatus;
  folderRow?: FolderListingRow;
  columns: ColumnDefinition[];
  gridStyle: CSSProperties;
  quickFilter?: QuickFilterProgram | null;
  colorFilterEnabled: boolean;
  sizeBarLow?: string;
  sizeBarHigh?: string;
  currentPath: string;
  viewMode: TabViewMode;
  render: (state: RowRenderState) => ReactNode;
  onRender?: (id: string) => void;
};

export const FileDetailsRow = memo(function FileDetailsRow(props: RowRenderState) {
  props.onRender?.(props.entry.id);
  return props.render(props);
});

export const FileIconCard = memo(function FileIconCard(props: RowRenderState) {
  props.onRender?.(props.entry.id);
  return props.render(props);
});

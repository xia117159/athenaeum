export type DetailsGridColumn<T extends string = string> = {
  id: T;
  width: string;
};

export type DetailsGridMetrics = {
  gridTemplateColumns: string;
  width: number;
};

export function parseDetailsPixelWidth(width: string) {
  const match = /^(\d+(?:\.\d+)?)px$/i.exec(width.trim());
  if (!match) {
    return Number.NaN;
  }
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function getDetailsColumnPixelWidth<C extends DetailsGridColumn>({
  column,
  minWidth,
  fallbackWidth
}: {
  column: C;
  minWidth: number;
  fallbackWidth: number;
}) {
  const parsedWidth = parseDetailsPixelWidth(column.width);
  return Math.max(minWidth, Math.round(Number.isFinite(parsedWidth) ? parsedWidth : fallbackWidth));
}

export function getDetailsGridMetrics<C extends DetailsGridColumn>({
  columns,
  gap,
  getColumnPixelWidth
}: {
  columns: C[];
  gap: number;
  getColumnPixelWidth: (column: C) => number;
}): DetailsGridMetrics {
  const widths = columns.map(getColumnPixelWidth);
  const gridTemplateColumns = widths.map((width) => `${width}px`).join(" ");
  const totalGapWidth = Math.max(0, widths.length - 1) * gap;
  return {
    gridTemplateColumns,
    width: widths.reduce((sum, columnWidth) => sum + columnWidth, 0) + totalGapWidth
  };
}

import { getTextMeasureUnits } from "./textMeasure";

const DEFAULT_AUTO_FIT_EXTRA_WIDTH_PX = 4;
const DEFAULT_AUTO_FIT_MAX_WIDTH_PX = 520;
const DEFAULT_AUTO_FIT_TEXT_UNIT_WIDTH_PX = 6;
const DEFAULT_AUTO_FIT_HORIZONTAL_PADDING_PX = 8;
const HEADER_BUTTON_SELECTOR = ".details-column-header__button";

type DetailsAutoFitColumn = {
  id: string;
};

function getAutoFitMeasureSource(element: HTMLElement) {
  if (element.hasAttribute("data-column-id")) {
    return element.querySelector<HTMLElement>(HEADER_BUTTON_SELECTOR) ?? element;
  }

  return element;
}

function copyComputedTypography(source: HTMLElement, target: HTMLElement) {
  const view = source.ownerDocument.defaultView;
  if (!view) {
    return;
  }

  const computed = view.getComputedStyle(source);
  target.style.fontFamily = computed.fontFamily;
  target.style.fontSize = computed.fontSize;
  target.style.fontStretch = computed.fontStretch;
  target.style.fontStyle = computed.fontStyle;
  target.style.fontVariant = computed.fontVariant;
  target.style.fontWeight = computed.fontWeight;
  target.style.letterSpacing = computed.letterSpacing;
  target.style.lineHeight = computed.lineHeight;
  target.style.textTransform = computed.textTransform;
  target.style.wordSpacing = computed.wordSpacing;
}

function getAutoFitElementWidth(element: HTMLElement) {
  const source = getAutoFitMeasureSource(element);
  const documentRef = element.ownerDocument;
  const measureHost = documentRef.createElement("div");
  measureHost.style.position = "fixed";
  measureHost.style.left = "-10000px";
  measureHost.style.top = "-10000px";
  measureHost.style.visibility = "hidden";
  measureHost.style.pointerEvents = "none";
  measureHost.style.width = "max-content";

  const clone = source.cloneNode(true) as HTMLElement;
  copyComputedTypography(source, clone);
  clone.style.width = "max-content";
  clone.style.maxWidth = "none";
  clone.style.minWidth = "0";
  clone.style.overflow = "visible";
  clone.style.textOverflow = "clip";
  measureHost.appendChild(clone);
  documentRef.body.appendChild(measureHost);

  const width = Math.max(clone.scrollWidth, clone.getBoundingClientRect().width);
  measureHost.remove();
  return Math.ceil(width);
}

export function getDetailsAutoFitColumnWidthFromDom({
  root,
  columnId,
  minWidth,
  cellDataAttribute,
  extraWidth = DEFAULT_AUTO_FIT_EXTRA_WIDTH_PX
}: {
  root: HTMLElement | null;
  columnId: string;
  minWidth: number;
  cellDataAttribute: string;
  extraWidth?: number;
}) {
  if (!root) {
    return null;
  }

  const candidates = [
    root.querySelector<HTMLElement>(`[data-column-id="${columnId}"]`),
    ...Array.from(root.querySelectorAll<HTMLElement>(`[${cellDataAttribute}="${columnId}"]`))
  ].filter((element): element is HTMLElement => Boolean(element));
  const measuredWidth = candidates.reduce((maxWidth, element) => Math.max(maxWidth, getAutoFitElementWidth(element)), 0);
  if (measuredWidth <= 0) {
    return null;
  }

  return `${Math.max(minWidth, measuredWidth + extraWidth)}px`;
}

export function estimateDetailsAutoFitColumnWidth<TColumn extends DetailsAutoFitColumn, TItem>({
  column,
  items,
  getHeaderText,
  getCellText,
  getMinWidth,
  getIconAllowance = () => 0,
  maxWidth = DEFAULT_AUTO_FIT_MAX_WIDTH_PX,
  textUnitWidth = DEFAULT_AUTO_FIT_TEXT_UNIT_WIDTH_PX,
  horizontalPadding = DEFAULT_AUTO_FIT_HORIZONTAL_PADDING_PX
}: {
  column: TColumn;
  items: TItem[];
  getHeaderText: (column: TColumn) => string;
  getCellText: (item: TItem, column: TColumn) => string;
  getMinWidth: (column: TColumn) => number;
  getIconAllowance?: (column: TColumn) => number;
  maxWidth?: number;
  textUnitWidth?: number;
  horizontalPadding?: number;
}) {
  const values = [getHeaderText(column), ...items.map((item) => getCellText(item, column))];
  const maxUnits = values.map(getTextMeasureUnits).reduce((max, units) => Math.max(max, units), 0);
  const width = Math.ceil(maxUnits * textUnitWidth + horizontalPadding + getIconAllowance(column));
  return `${Math.min(maxWidth, Math.max(getMinWidth(column), width))}px`;
}

export function getDetailsAutoFitColumnWidth<TColumn extends DetailsAutoFitColumn, TItem>({
  root,
  column,
  items,
  cellDataAttribute,
  getHeaderText,
  getCellText,
  getMinWidth,
  getIconAllowance,
  extraWidth = DEFAULT_AUTO_FIT_EXTRA_WIDTH_PX
}: {
  root: HTMLElement | null;
  column: TColumn;
  items: TItem[];
  cellDataAttribute: string;
  getHeaderText: (column: TColumn) => string;
  getCellText: (item: TItem, column: TColumn) => string;
  getMinWidth: (column: TColumn) => number;
  getIconAllowance?: (column: TColumn) => number;
  extraWidth?: number;
}) {
  return (
    getDetailsAutoFitColumnWidthFromDom({
      root,
      columnId: column.id,
      minWidth: getMinWidth(column),
      cellDataAttribute,
      extraWidth
    }) ??
    estimateDetailsAutoFitColumnWidth({
      column,
      items,
      getHeaderText,
      getCellText,
      getMinWidth,
      getIconAllowance
    })
  );
}

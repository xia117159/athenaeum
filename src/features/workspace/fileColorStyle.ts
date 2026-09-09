import type { CSSProperties } from "react";

type ColorDecoratedEntry = {
  foregroundColorHex?: string | null;
  backgroundColorHex?: string | null;
};

export type FileColorProperties = CSSProperties & {
  "--row-accent"?: string;
  "--entry-rule-foreground"?: string;
};

export type FileColorLabelProperties = CSSProperties & {
  "--entry-rule-background"?: string;
};

export const NAME_LABEL_RULE_BACKGROUND_CLASS = "entry-name__label--rule-background";

export type FileColorPresentation = {
  className: string;
  style: FileColorProperties | undefined;
  labelClassName: string;
  labelStyle: FileColorLabelProperties | undefined;
};

// 颜色规则的前景作用于条目文本（名称 + 元数据），由行/卡片容器继承；
// 背景不再作用于行/卡片表面，而是只涂在名称标签元素后面，
// 宽度即名称内容的渲染宽度，选中/hover 的表面背景在标签之下。
export function getFileColorPresentation(entry: ColorDecoratedEntry, enabled: boolean): FileColorPresentation {
  if (!enabled || (!entry.foregroundColorHex && !entry.backgroundColorHex)) {
    return { className: "", style: undefined, labelClassName: "", labelStyle: undefined };
  }
  const classNames = ["has-color-filter"];
  const style: FileColorProperties = {};
  if (entry.foregroundColorHex) {
    classNames.push("has-color-filter--foreground");
    style["--entry-rule-foreground"] = entry.foregroundColorHex;
  }
  const hasBackground = Boolean(entry.backgroundColorHex);
  return {
    className: classNames.join(" "),
    style: Object.keys(style).length > 0 ? style : undefined,
    labelClassName: hasBackground ? NAME_LABEL_RULE_BACKGROUND_CLASS : "",
    labelStyle: hasBackground ? { "--entry-rule-background": entry.backgroundColorHex! } : undefined
  };
}

export function getFileColorRowAttributes(
  entry: ColorDecoratedEntry & { accentColor: string },
  enabled: boolean
): { classNameSuffix: string; style: FileColorProperties } {
  const presentation = getFileColorPresentation(entry, enabled);
  return {
    classNameSuffix: presentation.className ? ` ${presentation.className}` : "",
    style: {
      "--row-accent": entry.accentColor,
      ...presentation.style
    }
  };
}

export function getFileColorLabelAttributes(
  entry: ColorDecoratedEntry,
  enabled: boolean
): { className: string; style: FileColorLabelProperties | undefined } {
  const presentation = getFileColorPresentation(entry, enabled);
  return {
    className: presentation.labelClassName,
    style: presentation.labelStyle
  };
}

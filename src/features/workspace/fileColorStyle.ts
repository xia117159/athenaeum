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
  "--entry-rule-foreground"?: string;
};

export const NAME_LABEL_RULE_BACKGROUND_CLASS = "entry-name__label--rule-background";
export const NAME_LABEL_RULE_FOREGROUND_CLASS = "entry-name__label--rule-foreground";

export type FileColorPresentation = {
  className: string;
  style: FileColorProperties | undefined;
  labelClassName: string;
  labelStyle: FileColorLabelProperties | undefined;
};

// 颜色规则前景的作用域由“是否同时设置了背景色”决定，且不使用深浅判断（直通）：
// - 仅设置字体色：前景作用于条目全文（名称 + 元数据），由行/卡片容器继承，整行生效；
// - 仅设置背景色：背景只涂在名称标签后面，宽度即名称内容的渲染宽度；
// - 同时设置字体色与背景色：前景不再作用整行（元数据等其它列回默认色），
//   而是与背景一起只应用在名称标签区域——保证“深背景 + 浅字”不会让整行其它列
//   以浅字落在白色 UI 上而看不清。
// 选中/hover 的表面背景在标签之下。
export function getFileColorPresentation(entry: ColorDecoratedEntry, enabled: boolean): FileColorPresentation {
  if (!enabled || (!entry.foregroundColorHex && !entry.backgroundColorHex)) {
    return { className: "", style: undefined, labelClassName: "", labelStyle: undefined };
  }
  const classNames = ["has-color-filter"];
  const style: FileColorProperties = {};
  const hasBackground = Boolean(entry.backgroundColorHex);
  // 前景 + 背景同时设置时，前景收进名称标签（与背景同区域），行级不再承载前景。
  const foregroundOnlyOnNameLabel = Boolean(entry.foregroundColorHex) && hasBackground;
  if (entry.foregroundColorHex && !foregroundOnlyOnNameLabel) {
    classNames.push("has-color-filter--foreground");
    style["--entry-rule-foreground"] = entry.foregroundColorHex;
  }
  const labelClasses: string[] = [];
  const labelStyle: FileColorLabelProperties = {};
  if (foregroundOnlyOnNameLabel) {
    labelClasses.push(NAME_LABEL_RULE_FOREGROUND_CLASS);
    labelStyle["--entry-rule-foreground"] = entry.foregroundColorHex!;
  }
  if (hasBackground) {
    labelClasses.push(NAME_LABEL_RULE_BACKGROUND_CLASS);
    labelStyle["--entry-rule-background"] = entry.backgroundColorHex!;
  }
  return {
    className: classNames.join(" "),
    style: Object.keys(style).length > 0 ? style : undefined,
    labelClassName: labelClasses.join(" "),
    labelStyle: Object.keys(labelStyle).length > 0 ? labelStyle : undefined
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

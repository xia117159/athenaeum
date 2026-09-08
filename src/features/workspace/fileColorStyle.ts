import type { CSSProperties } from "react";

type ColorDecoratedEntry = {
  foregroundColorHex?: string | null;
  backgroundColorHex?: string | null;
};

export type FileColorProperties = CSSProperties & {
  "--row-accent"?: string;
  "--entry-rule-foreground"?: string;
  "--entry-rule-background"?: string;
};

export function getFileColorPresentation(entry: ColorDecoratedEntry, enabled: boolean): {
  className: string;
  style: FileColorProperties | undefined;
} {
  if (!enabled || (!entry.foregroundColorHex && !entry.backgroundColorHex)) {
    return { className: "", style: undefined };
  }
  const classNames = ["has-color-filter"];
  const style: FileColorProperties = {};
  if (entry.foregroundColorHex) {
    classNames.push("has-color-filter--foreground");
    style["--entry-rule-foreground"] = entry.foregroundColorHex;
  }
  if (entry.backgroundColorHex) {
    classNames.push("has-color-filter--background");
    style["--entry-rule-background"] = entry.backgroundColorHex;
  }
  return {
    className: classNames.join(" "),
    style
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

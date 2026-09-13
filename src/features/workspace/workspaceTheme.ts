import type { ThemeSettings } from "./types";

export const DEFAULT_THEME: ThemeSettings = {
  panelFocusAccent: "#0f6cbd",
  activeTabBackground: "#ffffff",
  dropHighlightFill: "#0f6cbd",
  dropHighlightBorder: "#0f6cbd",
  sizeBarLow: "#dceaf7",
  sizeBarHigh: "#3979b7",
  menuHoverBackground: "#e5f1fb",
  menuHoverText: "#1f1f1f",
  fileHoverBorder: "#91c9f7",
  tabMinWidth: 96
};
export function normalizeTabMinWidth(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_THEME.tabMinWidth;
  }

  return Math.max(1, Math.round(value));
}

export function normalizeThemeAccentColor(value?: string | null, fallback = DEFAULT_THEME.panelFocusAccent) {
  if (!value || !/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value.trim())) {
    return fallback;
  }

  return value.trim().toLowerCase();
}


export type ThemeColorKey = Exclude<keyof ThemeSettings, "tabMinWidth">;
export type HoverColorKey = "menuHoverBackground" | "menuHoverText" | "fileHoverBorder";
export function normalizeTheme(theme?: Partial<ThemeSettings> | null): ThemeSettings {
  const normalized = { ...DEFAULT_THEME };
  for (const key of Object.keys(DEFAULT_THEME) as (keyof ThemeSettings)[]) {
    if (key !== "tabMinWidth") normalized[key] = normalizeThemeAccentColor(theme?.[key], DEFAULT_THEME[key]);
  }
  normalized.tabMinWidth = normalizeTabMinWidth(theme?.tabMinWidth);
  return normalized;
}

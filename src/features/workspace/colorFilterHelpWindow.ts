import { createHelpWindowOpener } from "./helpWindow";
export type { HelpWindowHandle as ColorFilterHelpWindowHandle, HelpWindowOptions as ColorFilterHelpWindowOptions,
  HelpWindowConstructor as ColorFilterHelpWindowConstructor, HelpWindowAdapter as ColorFilterHelpWindowAdapter } from "./helpWindow";

export const COLOR_FILTER_HELP_WINDOW_LABEL = "color-filter-help";
export const COLOR_FILTER_HELP_WINDOW_URL = "/?view=color-filter-help";
export const openColorFilterHelpWindow = createHelpWindowOpener(COLOR_FILTER_HELP_WINDOW_LABEL, {
  url: COLOR_FILTER_HELP_WINDOW_URL, title: "颜色过滤器帮助", width: 860, height: 680, minWidth: 680, minHeight: 480
});

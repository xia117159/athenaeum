import { createHelpWindowOpener } from "./helpWindow";

export const BATCH_RENAME_HELP_WINDOW_LABEL = "batch-rename-help";
export const BATCH_RENAME_HELP_WINDOW_URL = "/?view=batch-rename-help";
export const openBatchRenameHelpWindow = createHelpWindowOpener(BATCH_RENAME_HELP_WINDOW_LABEL, {
  url: BATCH_RENAME_HELP_WINDOW_URL, title: "批量重命名帮助", width: 860, height: 680, minWidth: 620, minHeight: 440
});

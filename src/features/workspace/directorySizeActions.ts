import type { Dispatch } from "react";
import type { AutoDirectorySizeGateway } from "./autoDirectorySizeGateway";
import { supportsDirectorySizes } from "./directorySizes";
import { nextDirectorySizeRequestOrder } from "./directorySizeState";
import type { PanelId, TabState } from "./types";
import type { WorkspaceAction } from "./workspaceReducer";

/** Directory size commands of the workspace controller (spec §6.5, §6.6). */
export function createDirectorySizeActions({ gateway, dispatch, findTab, notifyError }: {
  gateway: AutoDirectorySizeGateway;
  dispatch: Dispatch<WorkspaceAction>;
  findTab: (panelId: PanelId, tabId: string) => TabState | undefined;
  notifyError: (error: unknown, fallback: string) => void;
}) {
  // The automatic list is saved by dedicated commands, never by a settings draft (E7). The desktop answers with no list:
  // its `settings_changed` broadcast is applied instead (SAF-04).
  const sync = (paths: string[] | undefined) => { if (paths) dispatch({ type: "autoDirectorySizePathsSynced", payload: paths }); return paths; };
  return {
    requestDirectorySizes: (panelId: PanelId, tabId: string, intent: "calculate" | "cancel") => {
      const tab = findTab(panelId, tabId);
      if (tab && supportsDirectorySizes(tab)) dispatch({ type: "directorySizeRequested", payload: {
        panelId, tabId, rootPath: tab.snapshot.location.path, intent, requestedAt: nextDirectorySizeRequestOrder()
      } });
    },
    retryAutoDirectorySizes: (panelId: PanelId, tabId: string) => {
      const tab = findTab(panelId, tabId);
      if (tab) dispatch({ type: "directorySizeAutoRetried", payload: { panelId, tabId, rootPath: tab.snapshot.location.path } });
    },
    addAutoDirectorySizePath: async (path: string) => sync(await gateway.add(path)),
    removeAutoDirectorySizePath: async (path: string) => sync(await gateway.remove(path)),
    chooseAutoDirectorySizeFolder: () => gateway.choose(),
    /** Volume and share roots are confirmed by the calling component (E4). */
    setAutoDirectorySize: async (path: string, enabled: boolean) => {
      try { sync(await (enabled ? gateway.add(path) : gateway.remove(path))); }
      catch (error) { notifyError(error, "无法更新自动计算文件夹大小设置"); }
    }
  };
}

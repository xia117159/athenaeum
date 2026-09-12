import { useEffect, useEffectEvent, useRef, type Dispatch } from "react";
import type { WorkspaceState } from "./types";
import type { WorkspaceAction } from "./workspaceReducer";
import type { WorkspaceGateway } from "./workspaceGateway";
import { fileOpenTarget } from "./fileOpeningGateway";
import { createOpenWithMenu, reconcileOpenWithMenu } from "./fileOpeningState";
import { getErrorMessage, getEntryNameFromPath } from "./workspaceControllerUtils";
import { openSettingsWindow } from "./settingsWindow";

export interface FileOpeningControllerOptions {
  state: WorkspaceState;
  dispatch: Dispatch<WorkspaceAction>;
  gateway: WorkspaceGateway;
  enabled: boolean;
  notify: (intent: WorkspaceState["notifications"][number]["intent"], message: string) => void;
  openSettings?: () => Promise<void>;
}

type OpenSession = { registered: boolean; aborted: boolean; cancelRequested: boolean };

export function useFileOpeningController({ state, dispatch, gateway, enabled, notify, openSettings }: FileOpeningControllerOptions) {
  const mounted = useRef(true);
  const sessions = useRef(new Map<string, OpenSession>());
  useEffect(() => {
    mounted.current = true;
    const active = sessions.current;
    return () => {
      mounted.current = false;
      for (const [id, session] of active) {
        session.aborted = true;
        if (session.registered) void gateway.cancelFileOpen(id).catch(() => {});
      }
    };
  }, [gateway]);

  const openFile = useEffectEvent(async (path: string, associationId?: string): Promise<boolean> => {
    if (!enabled) return false;
    const requestId = `open-${crypto.randomUUID()}`;
    const session: OpenSession = { registered: false, aborted: false, cancelRequested: false };
    sessions.current.set(requestId, session);
    dispatch({ type: "fileOpenStarted", payload: { requestId, path } });
    try {
      const target = fileOpenTarget(path, state.remoteProfiles);
      const result = await gateway.openFile({ requestId, target, associationId }, progress => {
        if (sessions.current.get(requestId) !== session) return;
        if (session.aborted) {
          if (!session.registered) {
            session.registered = true;
            void gateway.cancelFileOpen(requestId).catch(() => {});
          }
          return;
        }
        session.registered = true;
        dispatch({ type: "fileOpenProgressed", payload: { requestId, progress } });
      });
      if (session.aborted) return false;
      if (result.status === "cancelled") {
        notify("info", `已取消打开“${getEntryNameFromPath(path)}”。`);
        return false;
      }
      if (target.kind === "remote") notify("success", `已打开临时副本：${result.localPath}`);
      return true;
    } catch (error) {
      if (!session.aborted) notify("danger", `无法打开“${getEntryNameFromPath(path)}”：${getErrorMessage(error, "文件打开失败。")}`);
      return false;
    } finally {
      sessions.current.delete(requestId);
      if (mounted.current) dispatch({ type: "fileOpenFinished", payload: { requestId } });
    }
  });

  const cancelFileOpen = useEffectEvent(async (requestId: string) => {
    const pending = state.fileOpens?.find(open => open.requestId === requestId);
    const session = sessions.current.get(requestId);
    if (!pending?.registered || pending.progress.phase === "opening" || !session || session.cancelRequested) return;
    session.cancelRequested = true;
    dispatch({ type: "fileOpenCancelling", payload: { requestId, cancelling: true } });
    try {
      const accepted = await gateway.cancelFileOpen(requestId);
      if (!accepted && sessions.current.get(requestId) === session && !session.aborted) {
        dispatch({ type: "fileOpenProgressed", payload: { requestId, progress: { phase: "opening" } } });
      }
    } catch (error) {
      if (sessions.current.get(requestId) !== session || session.aborted) return;
      session.cancelRequested = false;
      dispatch({ type: "fileOpenCancelling", payload: { requestId, cancelling: false } });
      notify("danger", getErrorMessage(error, "无法取消文件打开。"));
    }
  });

  const requestOpenWith = useEffectEvent(() => {
    if (!enabled || state.status !== "ready" || state.contextMenu) return;
    const panel = state.panels[state.activePanelId];
    if (panel.tabs.find(tab => tab.id === panel.activeTabId)?.inlineEdit) return;
    const requestId = `menu-${crypto.randomUUID()}`;
    if (createOpenWithMenu(state, requestId)) dispatch({ type: "openWithRequested", payload: { requestId } });
  });

  const menu = state.openWithMenu;
  useEffect(() => {
    if (!menu) return;
    let disposed = false;
    const paths = menu.ruleIds.map(id => state.settings.model.fileAssociations?.find(rule => rule.id === id)?.executablePath)
      .filter((path): path is string => Boolean(path));
    if (paths.length) void gateway.inspectAssociationPrograms(paths).then(programs => {
      if (!disposed) dispatch({ type: "openWithProgramsReceived", payload: { requestId: menu.requestId, programs } });
    }).catch(error => {
      if (!disposed) dispatch({ type: "openWithProgramsReceived", payload: { requestId: menu.requestId, programs: [],
        error: getErrorMessage(error, "无法读取程序名称，已显示文件名。") } });
    });
    return () => { disposed = true; };
  }, [menu?.requestId, gateway, dispatch]);

  const closeOpenWith = useEffectEvent((requestId: string) => {
    if (state.openWithMenu?.requestId === requestId) dispatch({ type: "openWithClosed" });
  });
  const selectOpenWith = useEffectEvent((requestId: string, index: number) => {
    if (state.openWithMenu?.requestId === requestId) dispatch({ type: "openWithSelectionChanged", payload: index });
  });
  const confirmOpenWith = useEffectEvent(async (requestId: string, index?: number) => {
    const current = reconcileOpenWithMenu(state).openWithMenu;
    if (current?.requestId !== requestId) return;
    const selected = index ?? current.selectedIndex;
    if (selected < 0 || selected > current.ruleIds.length) return;
    dispatch({ type: "openWithClosed" });
    if (selected < current.ruleIds.length) {
      await openFile(current.path, current.ruleIds[selected]);
    } else {
      try { await (openSettings ? openSettings() : openSettingsWindow(undefined, "file-associations")); }
      catch (error) { notify("danger", getErrorMessage(error, "无法打开自定义文件关联设置。")); }
    }
  });

  return { openFile, requestOpenWith, actions: { closeOpenWith, selectOpenWith, confirmOpenWith, cancelFileOpen } };
}

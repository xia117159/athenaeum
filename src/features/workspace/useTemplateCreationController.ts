import { useEffect, useEffectEvent, useRef, type Dispatch } from "react";
import type { CreationTemplateEntry } from "../../app/templates";
import type { OperationTaskSnapshot } from "../../app/types";
import type { WorkspaceAction } from "./workspaceReducer";
import type { WorkspaceGateway } from "./workspaceGateway";
import type { WorkspaceState, PanelId } from "./types";
import type { TemplateAnchor, TemplateTarget } from "./templateCreationState";
import type { RenameTarget } from "./batchRenameState";
import { captureTemplateTarget, templateTargetMatches } from "./templateCreationState";
import { templateKey, templateSelectionStatus } from "./templateSelection";
import { isTerminalOperationTask } from "./workspaceRefreshPlanner";
import { getErrorMessage } from "./workspaceControllerUtils";
import { openSettingsWindow } from "./settingsWindow";

interface Options {
  state: WorkspaceState; dispatch: Dispatch<WorkspaceAction>; gateway: WorkspaceGateway; enabled: boolean;
  notify: (intent: WorkspaceState["notifications"][number]["intent"], message: string) => void;
  rename: (target: RenameTarget | undefined) => void;
  projectTask: (task: OperationTaskSnapshot) => Promise<void>;
}
interface Submission { requestId: string; finished: boolean; handled: boolean; timer?: ReturnType<typeof setTimeout>; error?: string }
export function useTemplateCreationController({ state, dispatch, gateway, enabled, notify, rename, projectTask }: Options) {
  const mounted = useRef(true), menuId = useRef<string | undefined>(undefined), submission = useRef<Submission | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; menuId.current = undefined; clearTimeout(submission.current?.timer); };
  }, [gateway]);
  useEffect(() => { if (!state.templateMenu) menuId.current = undefined; }, [state.templateMenu]);
  const load = useEffectEvent(async (id: string, root: string, relativePath: string) => {
    dispatch({ type: "templateDirectoryRequested", payload: { id, relativePath } });
    try {
      const listing = await gateway.templates.list(root, relativePath);
      if (mounted.current && menuId.current === id) dispatch({ type: "templateDirectoryLoaded", payload: { id, listing } });
    } catch (error) {
      if (mounted.current && menuId.current === id) dispatch({ type: "templateDirectoryFailed", payload: { id, relativePath,
        error: getErrorMessage(error, "无法读取模板文件夹") } });
    }
  });
  const openCaptured = useEffectEvent((target: TemplateTarget | undefined, anchor: TemplateAnchor) => {
    if (!enabled || state.status !== "ready" || state.batchRename || !target) return;
    if (!templateTargetMatches(state, target)) { notify("info", "目标目录已改变，请重新打开新建项目菜单。"); return; }
    if (submission.current || state.templateCreation) { notify("info", "模板创建仍在进行，可在操作任务中查看进度。"); return; }
    const id = crypto.randomUUID(), settingsRoot = state.settings.model.templateRoot ?? "";
    menuId.current = id;
    dispatch({ type: "templateMenuOpened", payload: { id, target, settingsRoot, rootPath: settingsRoot.trim(),
      levels: [{ relativePath: "", anchor }], directories: {}, selected: [] } });
    if (settingsRoot.trim()) void load(id, settingsRoot.trim(), "");
  });
  const open = useEffectEvent((panelId: PanelId, tabId: string, anchor: TemplateAnchor) => {
    if (state.panels[panelId].tabs.find(tab => tab.id === tabId)?.pendingNavigationRequestId !== undefined) {
      notify("info", "正在切换目录，请稍后再打开新建项目菜单。"); return;
    }
    openCaptured(captureTemplateTarget(state, panelId, tabId), anchor);
  });
  const close = useEffectEvent((id: string) => {
    if (menuId.current !== id) return;
    menuId.current = undefined;
    dispatch({ type: "templateMenuClosed", payload: { id } });
    dispatch({ type: "contextMenuSet", payload: undefined });
  });
  const expand = useEffectEvent((id: string, depth: number, entry: CreationTemplateEntry, anchor: TemplateAnchor) => {
    const menu = state.templateMenu;
    if (!menu || menu.id !== id || entry.kind !== "directory") return;
    dispatch({ type: "templateMenuExpanded", payload: { id, depth, entry, anchor } });
    const current = menu.directories[templateKey(entry.relativePath)];
    if (!current || current.status === "error") void load(id, menu.rootPath, entry.relativePath);
  });
  const poll = useEffectEvent((session: Submission) => {
    clearTimeout(session.timer);
    if (submission.current !== session || session.finished || !mounted.current) return;
    session.timer = setTimeout(async () => {
      try {
        const snapshot = await gateway.listOperationTasks();
        if (submission.current !== session || !mounted.current || session.finished) return;
        const task = snapshot.tasks.find(task => task.requestId === session.requestId);
        if (task) await projectTask(task);
        else if (session.error) {
          submission.current = undefined;
          dispatch({ type: "templateCreationDismissed", payload: { requestId: session.requestId } });
          notify("danger", session.error); return;
        }
      } catch { /* A later snapshot can recover a missed task event without re-submitting the copy. */ }
      poll(session);
    }, 1200);
  });
  const submit = useEffectEvent(async (id: string, entries: CreationTemplateEntry[]) => {
    const menu = state.templateMenu;
    if (!menu || menu.id !== id || !entries.length || !menu.rootPath || submission.current || state.templateCreation
      || !templateTargetMatches(state, menu.target)) return;
    const session: Submission = { requestId: crypto.randomUUID(), finished: false, handled: false };
    submission.current = session; menuId.current = undefined;
    dispatch({ type: "templateCreationStarted", payload: { requestId: session.requestId, target: menu.target } });
    poll(session);
    try {
      const task = await gateway.templates.create({ requestId: session.requestId, templateRoot: menu.rootPath,
        relativePaths: entries.map(entry => entry.relativePath), destination: menu.target.rootPath,
        panelId: menu.target.panelId, tabId: menu.target.tabId });
      if (mounted.current) await projectTask(task);
    } catch (error) {
      if (!mounted.current || session.finished) return;
      session.error = getErrorMessage(error, "无法创建模板副本"); poll(session);
    }
  });
  const activate = useEffectEvent((id: string, entry: CreationTemplateEntry) => {
    const menu = state.templateMenu;
    if (!menu || menu.id !== id) return;
    if (menu.selected.length) {
      if (entry.kind === "directory" && templateSelectionStatus(menu.selected, entry) !== "none") return;
      dispatch({ type: "templateSelectionToggled", payload: { id, entry } });
    } else void submit(id, [entry]);
  });
  const prepareCompletion = useEffectEvent((task: OperationTaskSnapshot) => {
    if (submission.current?.requestId === task.requestId && isTerminalOperationTask(task)) {
      dispatch({ type: "templateTaskCompleted", payload: { task } });
    }
  });
  const finishCompletion = useEffectEvent((task: OperationTaskSnapshot) => {
    const session = submission.current;
    if (!session || session.requestId !== task.requestId || session.finished || !isTerminalOperationTask(task)) return;
    session.finished = true; clearTimeout(session.timer);
    dispatch({ type: "templateRefreshFinished", payload: { requestId: task.requestId } });
  });
  useEffect(() => {
    const pending = state.templateCreation, session = submission.current;
    if (!pending || !session || pending.requestId !== session.requestId || session.handled || !["ready", "manual"].includes(pending.phase)) return;
    session.handled = true; submission.current = undefined; clearTimeout(session.timer);
    dispatch({ type: "templateCreationDismissed", payload: { requestId: pending.requestId } });
    const status = pending.task?.status;
    const canRename = pending.phase === "ready" && pending.allowRename && pending.renameTarget
      && templateTargetMatches(state, pending.target) && !state.batchRename;
    const suffix = !canRename && pending.paths.length ? " 副本已保留在原目标目录，可手动重命名。" : "";
    notify(status === "succeeded" ? "success" : status === "failed" ? "danger" : "warning",
      (pending.task?.message ?? `已创建 ${pending.paths.length} 个项目。`) + suffix);
    if (canRename) rename(pending.renameTarget);
  }, [state, dispatch, notify, rename]);
  return { openCaptured, prepareCompletion, finishCompletion, actions: {
    openTemplateMenu: open,
    closeTemplateMenu: close, expandTemplateDirectory: expand,
    collapseTemplateDirectory: (id: string, depth: number) => dispatch({ type: "templateMenuCollapsed", payload: { id, depth } }),
    toggleTemplateItem: (id: string, entry: CreationTemplateEntry) => dispatch({ type: "templateSelectionToggled", payload: { id, entry } }),
    activateTemplateItem: activate,
    createSelectedTemplates: (id: string) => { const menu = state.templateMenu; if (menu?.id === id) void submit(id, menu.selected); },
    refreshTemplateMenu: (id: string) => { const menu = state.templateMenu; if (menu?.id === id) openCaptured(menu.target, menu.levels[0].anchor); },
    openTemplateSettings: (id: string) => { close(id); void openSettingsWindow(undefined, "templates").catch(error => notify("danger", getErrorMessage(error, "无法打开新建项目设置"))); }
  } };
}

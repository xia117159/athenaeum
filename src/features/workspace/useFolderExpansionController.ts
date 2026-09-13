import { useEffect, useReducer, useRef, type Dispatch } from "react";
import { getExpandedFolderPaths, getFolderBranch, supportsFolderExpansion } from "./folderExpansion";
import { getErrorMessage } from "./workspaceControllerUtils";
import { pathsEqual } from "./workspacePathRelations";
import type { FolderExpansionBranch, WorkspaceState } from "./types";
import type { WorkspaceAction } from "./workspaceReducer";
import type { WorkspaceGateway } from "./workspaceGateway";
import { useDirectoryListingBudget } from "./directoryListingBudget";

const MAX_CONCURRENT_READS = 4;

/** The reducer owns branches; idle branches themselves are the bounded scheduler's queue. */
export function useFolderExpansionController({ state, dispatch, workspaceGateway }: {
  state: WorkspaceState;
  dispatch: Dispatch<WorkspaceAction>;
  workspaceGateway: WorkspaceGateway;
}) {
  const running = useRef(new Set<FolderExpansionBranch>());
  const sequence = useRef(0);
  const mounted = useRef(false);
  const [completion, wakeScheduler] = useReducer((value: number) => value + 1, 0);
  const { budget, version: budgetVersion } = useDirectoryListingBudget(workspaceGateway);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (state.status !== "ready" || !state.settings.model.folderExpansionEnabled) return;
    for (const panel of Object.values(state.panels)) {
      for (const tab of panel.tabs) {
        if (!supportsFolderExpansion(tab) || tab.status !== "ready") continue;
        for (const path of getExpandedFolderPaths(tab)) {
          if (running.current.size >= MAX_CONCURRENT_READS) return;
          const branch = getFolderBranch(tab, path)!;
          if (branch.status !== "idle" || running.current.has(branch)) continue;
          const releaseRead = budget.tryAcquire();
          if (!releaseRead) return;
          // Check the current committed branch immediately before starting IPC. A
          // collapsed/moved/refreshed queued branch is never captured by this scan.
          const payload = { panelId: panel.id, tabId: tab.id, path, rootSnapshot: tab.snapshot, requestId: ++sequence.current };
          running.current.add(branch);
          dispatch({ type: "folderExpansionLoadStarted", payload: { ...payload, expectedBranch: branch } });
          void Promise.resolve()
            .then(() => workspaceGateway.resolveDirectory(path))
            .then((snapshot) => {
              if (!pathsEqual(snapshot.location.path, path)) throw new Error(`目录读取结果与请求路径不一致：${path}`);
              if (mounted.current) dispatch({ type: "folderExpansionLoadSucceeded", payload: { ...payload, snapshot } });
            })
            .catch((error: unknown) => {
              if (mounted.current) dispatch({ type: "folderExpansionLoadFailed", payload: {
                ...payload, errorMessage: getErrorMessage(error, `无法展开 ${path}`)
              } });
            })
            .finally(() => {
              running.current.delete(branch);
              releaseRead();
              // A stale result may leave reducer state unchanged, but still frees a slot.
              if (mounted.current) wakeScheduler();
            });
        }
      }
    }
  }, [state.panels, state.status, state.settings.model.folderExpansionEnabled, workspaceGateway, dispatch, completion, budget, budgetVersion]);
}

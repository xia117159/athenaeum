import { useEffect, useEffectEvent, useRef, type Dispatch } from "react";
import { compareRevisionTokens, toColorRuleInputs } from "./colorFilterEditorModel";
import { disposeQuietly } from "./workspaceIpc";
import type { WorkspaceAction } from "./workspaceReducer";
import type { WorkspaceGateway } from "./workspaceGateway";
import type { SettingsModel, WorkspaceState } from "./types";
import type { ColorFilterConfigSnapshot } from "./colorFilterTypes";

type ColorFilterGateway = Pick<
  WorkspaceGateway,
  "getColorFilterSnapshot" | "setColorFilterEnabled" | "replaceColorRules" | "validateColorRule" | "listenColorFilterChanged"
>;

type UseColorFilterControllerOptions = {
  state: WorkspaceState;
  dispatch: Dispatch<WorkspaceAction>;
  workspaceGateway: ColorFilterGateway;
  refreshVisibleEntries: () => Promise<void>;
  pushNotification: (
    intent: WorkspaceState["notifications"][number]["intent"],
    message: string
  ) => void;
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useColorFilterController({
  state,
  dispatch,
  workspaceGateway,
  refreshVisibleEntries,
  pushNotification
}: UseColorFilterControllerOptions) {
  const pendingToggleRef = useRef(false);
  const focusReloadPendingRef = useRef(false);
  const aggregateRevisionRef = useRef(state.settings.model.colorFilterRevision ?? "0");
  const rulesRevisionRef = useRef(state.settings.model.colorRulesRevision ?? "0");

  const currentAggregateRevision = state.settings.model.colorFilterRevision ?? "0";
  if (compareRevisionTokens(currentAggregateRevision, aggregateRevisionRef.current) > 0) {
    aggregateRevisionRef.current = currentAggregateRevision;
    rulesRevisionRef.current = state.settings.model.colorRulesRevision ?? "0";
  }

  const receiveSnapshot = useEffectEvent((snapshot: ColorFilterConfigSnapshot) => {
    const aggregateOrder = compareRevisionTokens(snapshot.revision, aggregateRevisionRef.current);
    const rulesOrder = compareRevisionTokens(snapshot.rulesRevision, rulesRevisionRef.current);
    dispatch({ type: "colorFilterSnapshotReceived", payload: snapshot });
    if (aggregateOrder <= 0) {
      return;
    }
    aggregateRevisionRef.current = snapshot.revision;
    rulesRevisionRef.current = snapshot.rulesRevision;
    if (rulesOrder > 0) {
      void refreshVisibleEntries();
    }
  });

  const publishWarnings = useEffectEvent((warnings: string[]) => {
    for (const warning of warnings) pushNotification("warning", warning);
  });

  const toggleColorFilter = useEffectEvent(async (enabled: boolean) => {
    if (pendingToggleRef.current) {
      return;
    }
    pendingToggleRef.current = true;
    dispatch({ type: "colorFilterTogglePendingSet", payload: true });
    try {
      const result = await workspaceGateway.setColorFilterEnabled(enabled);
      receiveSnapshot(result.snapshot);
      publishWarnings(result.warnings);
    } catch (error) {
      pushNotification("danger", errorMessage(error, "Unable to update the color filter"));
    } finally {
      pendingToggleRef.current = false;
      dispatch({ type: "colorFilterTogglePendingSet", payload: false });
    }
  });

  const replaceColorRules = useEffectEvent(async (
    rules: SettingsModel["colorRules"],
    baseRulesRevision: string,
    force = false
  ) => {
    const result = await workspaceGateway.replaceColorRules({
      rules: toColorRuleInputs(rules),
      baseRulesRevision,
      force
    });
    receiveSnapshot(result.snapshot);
    publishWarnings(result.warnings);
    return result;
  });

  const validateColorRule = useEffectEvent((expression: string) =>
    workspaceGateway.validateColorRule(expression)
  );

  useEffect(() => {
    if (state.status !== "ready" || state.source !== "tauri") {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void workspaceGateway.listenColorFilterChanged((snapshot) => {
      if (!disposed) receiveSnapshot(snapshot);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    }).catch((error) => {
      if (!disposed) {
        pushNotification("warning", errorMessage(error, "Unable to listen for color filter changes"));
      }
    });
    return () => {
      disposed = true;
      disposeQuietly(unlisten);
    };
  }, [state.source, state.status, workspaceGateway]);

  useEffect(() => {
    if (state.status !== "ready" || state.source !== "tauri") return;
    const reloadOnFocus = () => {
      if (focusReloadPendingRef.current) return;
      focusReloadPendingRef.current = true;
      void workspaceGateway.getColorFilterSnapshot()
        .then(receiveSnapshot)
        .catch((error) => {
          pushNotification("warning", errorMessage(error, "Unable to reload the color filter"));
        })
        .finally(() => {
          focusReloadPendingRef.current = false;
        });
    };
    window.addEventListener("focus", reloadOnFocus);
    return () => window.removeEventListener("focus", reloadOnFocus);
  }, [state.source, state.status, workspaceGateway]);

  return { toggleColorFilter, replaceColorRules, validateColorRule };
}

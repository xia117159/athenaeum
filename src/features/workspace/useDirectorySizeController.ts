import { useEffect, useReducer, useRef, type Dispatch } from "react";
import type { WorkspaceState } from "./types";
import { getActiveTab, getVisiblePanelIds, type WorkspaceAction } from "./workspaceReducer";
import type { WorkspaceGateway } from "./workspaceGateway";
import { currentDirectorySizes, supportsDirectorySizes } from "./directorySizes";
import { directorySizeContext, directorySizeLookupPaths, type DirectorySizeContext } from "./directorySizePlanning";
import { openDirectorySizeSubscription } from "./directorySizeSubscription";
import { getPathComparisonKey } from "./workspacePathRelations";
import { getErrorMessage } from "./workspaceControllerUtils";
import type { DirectorySizeLeaseTarget } from "./directorySizeState";
import { useDirectorySizeAlignment } from "./useDirectorySizeAlignment";

type ActiveLease = {
  payload: DirectorySizeLeaseTarget; context: DirectorySizeContext; gateway: WorkspaceGateway;
  closed: boolean; close(): void; lookupVersion?: string; lookedUp: Set<string>;
};

export function useDirectorySizeController({ state, dispatch, workspaceGateway, enabled = true }: {
  state: WorkspaceState; dispatch: Dispatch<WorkspaceAction>; workspaceGateway: WorkspaceGateway; enabled?: boolean;
}) {
  const leases = useRef(new Map<string, ActiveLease>());
  const mounted = useRef(false);
  const lookupCount = useRef(0);
  const [completion, wake] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const lease of leases.current.values()) { lease.closed = true; lease.close(); }
      leases.current.clear();
    };
  }, []);

  useEffect(() => {
    const gateway = workspaceGateway.directorySizes;
    const desired = new Map<string, { tab: ReturnType<typeof getActiveTab>; panelId: DirectorySizeLeaseTarget["panelId"]; context: DirectorySizeContext | Error }>();
    if (enabled && gateway && state.status === "ready") for (const panelId of getVisiblePanelIds(state.layoutMode)) {
      const tab = getActiveTab(state.panels[panelId]);
      const sizes = currentDirectorySizes(tab);
      if (!supportsDirectorySizes(tab) || sizes?.paused || tab.snapshot.location.kind !== "local" && !sizes?.requested) continue;
      let context: DirectorySizeContext | Error;
      try { context = directorySizeContext(tab, state.remoteProfiles); }
      catch (error) { context = new Error(getErrorMessage(error, "无法准备目录大小计算")); }
      desired.set(`${panelId}:${tab.id}`, { tab, panelId, context });
    }
    for (const [key, lease] of leases.current) {
      const next = desired.get(key);
      const version = next && (currentDirectorySizes(next.tab)?.requestVersion ?? 0);
      const sameContext = next && !(next.context instanceof Error) && next.context.identity === lease.context.identity;
      if (next && sameContext && version === lease.payload.requestVersion && lease.gateway === workspaceGateway) continue;
      lease.closed = true; lease.close(); leases.current.delete(key);
      dispatch({ type: "directorySizeReleased", payload: lease.payload });
      // Changing a remote profile is invalidation, not authorization for another traversal.
      if (next && !sameContext && version === lease.payload.requestVersion && next.tab.snapshot.location.kind !== "local") desired.delete(key);
    }
    if (!gateway) return;
    for (const [key, { tab, panelId, context }] of desired) {
      if (leases.current.has(key)) continue;
      const sizes = currentDirectorySizes(tab);
      const payload: DirectorySizeLeaseTarget = { panelId, tabId: tab.id, rootPath: tab.snapshot.location.path,
        requestVersion: sizes?.requestVersion ?? 0, consumerId: `ds-${crypto.randomUUID()}` };
      dispatch({ type: "directorySizeLeaseStarted", payload });
      if (context instanceof Error) { dispatch({ type: "directorySizeFailed", payload: { ...payload, message: context.message } }); continue; }
      const lease: ActiveLease = { payload, context, gateway: workspaceGateway, closed: false, close() {}, lookedUp: new Set() };
      leases.current.set(key, lease);
      const subscription = openDirectorySizeSubscription(gateway, { consumerId: payload.consumerId, target: context.target, refresh: sizes?.forceRefresh === true },
        (snapshot) => { if (!lease.closed && mounted.current) dispatch({ type: "directorySizeSnapshotReceived", payload: { ...payload, snapshot } }); },
        (error) => { if (!lease.closed && mounted.current) dispatch({ type: "directorySizeFailed", payload: { ...payload, message: getErrorMessage(error, "无法获取目录大小统计") } }); });
      lease.close = subscription.close;
    }
  }, [enabled, state.status, state.panels, state.layoutMode, state.remoteProfiles, workspaceGateway, dispatch]);

  useEffect(() => {
    const gateway = workspaceGateway.directorySizes;
    if (!enabled || !gateway || state.status !== "ready") return;
    for (const lease of leases.current.values()) {
      const { payload, context } = lease;
      const tab = state.panels[payload.panelId].tabs.find((item) => item.id === payload.tabId);
      const sizes = tab && currentDirectorySizes(tab);
      const snapshot = sizes?.snapshot;
      if (!tab || lease.closed || sizes?.consumerId !== payload.consumerId || !snapshot ||
        (snapshot.phase !== "complete" && snapshot.phase !== "partial")) continue;
      const lookupVersion = `${snapshot.generation}:${snapshot.sequence}`;
      if (lease.lookupVersion !== lookupVersion) { lease.lookupVersion = lookupVersion; lease.lookedUp.clear(); }
      const paths = directorySizeLookupPaths(state, payload.panelId, tab)
        .filter((path) => !sizes.records[getPathComparisonKey(path)] && !lease.lookedUp.has(getPathComparisonKey(path)));
      for (let offset = 0; offset < paths.length && lookupCount.current < 2; offset += 256) {
        const chunk = paths.slice(offset, offset + 256);
        chunk.forEach((path) => lease.lookedUp.add(getPathComparisonKey(path)));
        lookupCount.current++;
        void Promise.resolve().then(() => gateway.lookup({ consumerId: payload.consumerId, generation: snapshot.generation, paths: chunk.map(context.toBackendPath) }))
          .then((lookup) => {
            if (lease.closed || !mounted.current) return;
            const allowed = new Set(chunk.map(getPathComparisonKey));
            const directories = lookup.directories.map((record) => ({ ...record, path: context.fromBackendPath(record.path) }))
              .filter((record) => allowed.has(getPathComparisonKey(record.path)));
            dispatch({ type: "directorySizeLookupReceived", payload: { ...payload, lookup: { ...lookup, directories } } });
          })
          .catch((error) => { if (!lease.closed && mounted.current) dispatch({ type: "directorySizeFailed", payload: { ...payload, message: getErrorMessage(error, "无法查询目录大小") } }); })
          .finally(() => { lookupCount.current--; if (mounted.current) wake(); });
      }
    }
  }, [enabled, state, workspaceGateway, dispatch, completion]);
  useDirectorySizeAlignment({ state, dispatch, workspaceGateway, enabled });
}

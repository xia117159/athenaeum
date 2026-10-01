import { useEffect, useReducer, useRef, type Dispatch } from "react";
import type { WorkspaceState } from "./types";
import type { WorkspaceGateway } from "./workspaceGateway";
import { getActiveTab, getVisiblePanelIds, type WorkspaceAction } from "./workspaceReducer";
import { pathsEqual } from "./workspacePathRelations";

/** Advisory reads have their own listing fence, independent of scan leases. */
export function useDirectorySizeEnrichment({ state, dispatch, workspaceGateway, enabled }: {
  state: WorkspaceState; dispatch: Dispatch<WorkspaceAction>; workspaceGateway: WorkspaceGateway; enabled: boolean;
}) {
  const current = useRef(state); current.current = state;
  const [revision, wake] = useReducer((value: number) => value + 1, 0);
  const version = useRef(0);
  // Native invokes outlive an effect. Only settling the actual promise returns
  // a permit; a new listing replaces queued intent without resetting capacity.
  const scheduler = useRef<{ active: number; pump?: () => void }>({ active: 0 });
  const gateway = workspaceGateway.directorySizes;
  useEffect(() => {
    if (!enabled || !gateway?.listenCache) return;
    let closed = false; let dispose: (() => void) | undefined;
    void gateway.listenCache((event) => {
      if (!closed && getVisiblePanelIds(current.current.layoutMode).some((id) =>
        pathsEqual(getActiveTab(current.current.panels[id]).snapshot.location.path, event.path))) wake();
    }).then((unsubscribe) => { if (closed) unsubscribe(); else dispose = unsubscribe; }).catch(() => undefined);
    return () => { closed = true; dispose?.(); };
  }, [enabled, gateway]);
  // Progress updates do not change this signature. Cache merges keep entries stable.
  const visible = getVisiblePanelIds(state.layoutMode).map((panelId) => ({ panelId, tab: getActiveTab(state.panels[panelId]) }));
  const scopes = useRef<Array<{ panelId: string; tabId: string; path: string; entries: unknown }>>([]);
  const next = visible.map(({ panelId, tab }) => ({ panelId, tabId: tab.id, path: tab.snapshot.location.path, entries: tab.snapshot.entries }));
  if (next.length !== scopes.current.length || next.some((scope, index) => {
    const old = scopes.current[index]; return !old || old.panelId !== scope.panelId || old.tabId !== scope.tabId || old.path !== scope.path || old.entries !== scope.entries;
  })) scopes.current = next;
  const signature = scopes.current;
  useEffect(() => {
    if (!enabled || state.status !== "ready" || !gateway?.lookupCache) return;
    let closed = false; const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
    const requestVersion = ++version.current;
    const jobs = getVisiblePanelIds(current.current.layoutMode).flatMap((panelId) => {
      const tab = getActiveTab(current.current.panels[panelId]);
      if (tab.kind !== "directory" || tab.snapshot.location.kind !== "local" || tab.status !== "ready") return [];
      const entries = tab.snapshot.entries.filter((entry) => entry.kind === "folder" && !entry.attributes.includes("L") && entry.sizeCreatedAt)
        .map((entry) => ({ path: entry.path, createdAt: entry.sizeCreatedAt! }));
      const chunks = [];
      for (let offset = 0; offset < entries.length; offset += 256) chunks.push({ panelId, tabId: tab.id,
        rootPath: tab.snapshot.location.path, expectedEntries: tab.snapshot.entries, entries: entries.slice(offset, offset + 256) });
      return chunks;
    });
    const read = async (job: typeof jobs[number]) => {
      for (let attempt = 0; !closed && attempt < 30; attempt++) {
        try {
          const lookup = await gateway.lookupCache!({ path: job.rootPath, requestVersion, entries: job.entries });
          if (closed || lookup.requestVersion !== requestVersion) return;
          dispatch({ type: "directorySizeCacheReceived", payload: { ...job, lookup } });
          if (!lookup.entries.some((entry) => entry.status === "pending")) return;
        } catch { if (closed || attempt >= 4) return; }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { timers.delete(timer); resolve(); }, 1000);
          timers.set(timer, resolve);
        });
      }
    };
    // Bound native reads for wide listings instead of issuing every page at once.
    const lane = scheduler.current;
    const pump = () => {
      while (!closed && lane.active < 2 && jobs.length) {
        const job = jobs.shift()!; lane.active++;
        void read(job).finally(() => { lane.active--; lane.pump?.(); });
      }
    };
    lane.pump = pump; pump();
    return () => {
      closed = true; if (lane.pump === pump) lane.pump = undefined;
      jobs.length = 0;
      for (const [timer, resolve] of timers) { clearTimeout(timer); resolve(); }
    };
  }, [enabled, state.status, gateway, signature, revision, dispatch]);
}

import { useEffect, useReducer, useRef, type Dispatch } from "react";
import type { PanelId, TabState, WorkspaceState } from "./types";
import { getActiveTab, getVisiblePanelIds, type WorkspaceAction } from "./workspaceReducer";
import type { WorkspaceGateway } from "./workspaceGateway";
import { currentDirectorySizes, hasVisibleSizeColumn } from "./directorySizes";
import { directorySizeContext, directorySizeLookupPaths, type DirectorySizeContext } from "./directorySizePlanning";
import { openDirectorySizeSubscription } from "./directorySizeSubscription";
import { getPathComparisonKey } from "./workspacePathRelations";
import { getErrorMessage } from "./workspaceControllerUtils";
import { manualSubscribeIntent, type DirectorySizeLeaseTarget } from "./directorySizeState";
import type { DirectorySizeLeaseMode, DirectorySizeSnapshot, SubscribeDirectorySizesRequest } from "./directorySizeTypes";
import { findAutoDirectorySizeRoot } from "./directorySizeAutoPaths";
import { useWindowActivity } from "./useWindowActivity";
import { useDirectorySizeAlignment } from "./useDirectorySizeAlignment";
import { DirectorySizeSlot } from "./directorySizeSlot";
import { useDirectorySizeEnrichment } from "./useDirectorySizeEnrichment";
import { useDirectorySizeViews } from "./useDirectorySizeViews";
import { matchesDirectorySizeLookupListing } from "./directorySizeLookupFence";

type Desire = {
  tab: TabState; panelId: PanelId; mode: DirectorySizeLeaseMode; visible: boolean; context: DirectorySizeContext | Error;
  requestVersion: number; attemptVersion: number;
};
type ActiveLease = {
  payload: DirectorySizeLeaseTarget; mode: DirectorySizeLeaseMode; attemptVersion: number;
  /** Logical routing may move; the subscribed owner and physical auto slot must not. */
  ownerKey: string; slotPanelId: PanelId;
  context: DirectorySizeContext; gateway: WorkspaceGateway; channel: "slot" | "own";
  closed: boolean; close(): void;
  /** Committed to the reducer; until then snapshots are buffered and nothing is dispatched for this consumer. */
  committed: boolean; buffered?: DirectorySizeSnapshot;
  /** The committed lease this one replaces once accepted: a mode swap or a tab moved to another panel. */
  replaces?: ActiveLease;
  lookupVersion?: string; lookedUp: Set<string>;
  lookupRoot?: TabState["snapshot"]; lookupExpansion?: TabState["folderExpansion"];
};

const BACKGROUND_MANUAL_LEASES = 4;

/** Lease rules of spec §6.4 over every directory tab of every panel (D15). */
function desiredLeases(state: WorkspaceState, windowActive: boolean) {
  const desired = new Map<string, Desire>();
  const visiblePanels = new Set(getVisiblePanelIds(state.layoutMode));
  const autoPaths = state.settings.model.autoDirectorySizePaths ?? [];
  const background: Array<[string, Desire, number]> = [];
  for (const panelId of Object.keys(state.panels) as PanelId[]) {
    const panel = state.panels[panelId];
    const activeTabId = getActiveTab(panel).id;
    for (const tab of panel.tabs) {
      // A refreshing listing keeps its lease; new leases wait for a ready listing (F5 never replaces a lease, D10).
      if (!hasVisibleSizeColumn(tab)) continue;
      const sizes = currentDirectorySizes(tab);
      const visible = visiblePanels.has(panelId) && tab.id === activeTabId;
      const local = tab.snapshot.location.kind === "local";
      const auto = !sizes?.autoPaused && visible && local && windowActive &&
        findAutoDirectorySizeRoot(tab.snapshot.location.path, autoPaths) !== null;
      if (!auto && (sizes?.paused || !sizes?.requested)) continue;
      let context: DirectorySizeContext | Error;
      try { context = directorySizeContext(tab, state.remoteProfiles); }
      catch (error) { context = new Error(getErrorMessage(error, "无法准备目录大小计算")); }
      const desire: Desire = { tab, panelId, mode: auto ? "auto" : "manual", visible, context,
        requestVersion: sizes?.requestVersion ?? 0, attemptVersion: sizes?.attemptVersion ?? 0 };
      const key = `${panelId}:${tab.id}`;
      if (!auto && !visible) background.push([key, desire, sizes?.requestedAt ?? 0]);
      else desired.set(key, desire);
    }
  }
  background.sort((a, b) => b[2] - a[2]);
  for (const [key, desire] of background.slice(0, BACKGROUND_MANUAL_LEASES)) desired.set(key, desire);
  return desired;
}

export function useDirectorySizeController({ state, dispatch, workspaceGateway, enabled = true }: {
  state: WorkspaceState; dispatch: Dispatch<WorkspaceAction>; workspaceGateway: WorkspaceGateway; enabled?: boolean;
}) {
  const leases = useRef(new Map<string, ActiveLease>());
  /** Same-tab mode swaps: the old lease stays committed until its replacement is accepted (SPEC-025). */
  const replacements = useRef(new Map<string, ActiveLease>());
  const slots = useRef(new Map<string, { gateway: WorkspaceGateway; lane: DirectorySizeSlot }>());
  const mounted = useRef(false);
  const lookupCount = useRef(0);
  const [completion, wake] = useReducer((value: number) => value + 1, 0);
  const windowActive = useWindowActivity(workspaceGateway.windowActivity);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const lease of [...leases.current.values(), ...replacements.current.values()]) { lease.closed = true; lease.close(); }
      leases.current.clear(); replacements.current.clear();
      for (const slot of slots.current.values()) slot.lane.clear();
      slots.current.clear();
    };
  }, []);

  useEffect(() => {
    const gateway = workspaceGateway.directorySizes;
    const desired = enabled && gateway && state.status === "ready" ? desiredLeases(state, windowActive) : new Map<string, Desire>();
    const matches = (lease: ActiveLease, desire: Desire | undefined) => desire !== undefined && lease.mode === desire.mode &&
      !(desire.context instanceof Error) && desire.context.identity === lease.context.identity &&
      desire.requestVersion === lease.payload.requestVersion && lease.gateway === workspaceGateway &&
      (lease.mode === "manual" || desire.attemptVersion === lease.attemptVersion);
    // tabMoved preserves the consumer even when the destination renames a colliding tab ID.
    // Route releases/errors too, including tabs which are no longer eligible for a lease.
    for (const [key, lease] of [...leases.current]) {
      if (!lease.committed) continue;
      for (const panel of Object.values(state.panels)) {
        const tab = panel.tabs.find((tab) => currentDirectorySizes(tab)?.consumerId === lease.payload.consumerId);
        if (!tab) continue;
        const target = `${panel.id}:${tab.id}`;
        lease.payload = { ...lease.payload, panelId: panel.id, tabId: tab.id };
        if (key !== target) { leases.current.delete(key); leases.current.set(target, lease); }
        break;
      }
    }
    for (const [key, pending] of replacements.current) {
      if (matches(pending, desired.get(key)) && pending.replaces && !pending.replaces.closed) continue;
      pending.closed = true; pending.close(); replacements.current.delete(key);
    }
    const started: Array<[string, Desire, ActiveLease?]> = [];
    const released: ActiveLease[] = [];
    for (const [key, lease] of leases.current) {
      const next = desired.get(key);
      if (lease.ownerKey === key && matches(lease, next)) continue;
      const sizes = next && currentDirectorySizes(next.tab);
      if (next && lease.committed && (next.mode !== lease.mode || lease.ownerKey !== key) && !(next.context instanceof Error) &&
        lease.gateway === workspaceGateway && sizes?.consumerId === lease.payload.consumerId &&
        sizes.requestVersion === lease.payload.requestVersion && next.context.identity === lease.context.identity) {
        if (!replacements.current.has(key)) started.push([key, next, lease]);
        continue;
      }
      lease.closed = true;
      leases.current.delete(key);
      released.push(lease);
    }
    if (gateway) for (const [key, desire] of desired) {
      if (!leases.current.has(key) && !replacements.current.has(key) && !started.some(([next]) => next === key) &&
        desire.tab.status === "ready") started.push([key, desire]);
    }
    // A migrating automatic consumer still occupies its original panel slot until
    // the destination accepts it. Reusing that slot earlier cancels its last lease.
    const reservedSlots = new Map<PanelId, string>();
    for (const [key, lease] of leases.current) {
      if (lease.channel === "slot" && lease.committed && lease.ownerKey !== key) reservedSlots.set(lease.slotPanelId, key);
    }
    const ready = started.filter(([key, next]) => next.mode !== "auto" ||
      !reservedSlots.has(next.panelId) || reservedSlots.get(next.panelId) === key);
    for (const lease of released) {
      // Only an automatic lease followed by an automatic lease starting in its panel hands the slot over.
      const handoff = lease.channel === "slot" && lease.gateway === workspaceGateway && ready.some(([, next]) =>
        next.panelId === lease.slotPanelId && next.mode === "auto" && !(next.context instanceof Error));
      if (!handoff) lease.close();
      if (lease.committed) dispatch({ type: "directorySizeReleased", payload: lease.payload });
    }
    if (!gateway) return;
    for (const [key, desire, replacing] of ready) {
      const { tab, panelId, mode, context } = desire;
      const sizes = currentDirectorySizes(tab);
      const payload: DirectorySizeLeaseTarget = { panelId, tabId: tab.id, rootPath: tab.snapshot.location.path,
        requestVersion: desire.requestVersion, consumerId: `ds-${crypto.randomUUID()}` };
      const attempt = { mode, attemptVersion: mode === "auto" ? desire.attemptVersion : undefined };
      if (context instanceof Error) { dispatch({ type: "directorySizeLeaseFailed", payload: { ...payload, ...attempt, message: context.message } }); continue; }
      const lease: ActiveLease = { payload, mode, attemptVersion: desire.attemptVersion, context, gateway: workspaceGateway,
        ownerKey: key, slotPanelId: panelId, channel: mode === "auto" ? "slot" : "own",
        closed: false, close() {}, committed: false, lookedUp: new Set(), replaces: replacing };
      (replacing ? replacements.current : leases.current).set(key, lease);
      const request: SubscribeDirectorySizesRequest = mode === "auto"
        ? { consumerId: payload.consumerId, target: context.target, intent: "auto", retryFailed: !sizes?.autoAttempted }
        : { consumerId: payload.consumerId, target: context.target, intent: manualSubscribeIntent(sizes!, context.target.kind === "remote") };
      const receive = (snapshot: DirectorySizeSnapshot) => {
        if (lease.closed || !mounted.current) return;
        if (!lease.committed) lease.buffered = snapshot;
        else dispatch({ type: "directorySizeSnapshotReceived", payload: { ...lease.payload, snapshot } });
      };
      const commit = () => {
        if (lease.closed || lease.committed || !mounted.current) return;
        lease.committed = true;
        dispatch({ type: "directorySizeLeaseStarted", payload: { ...payload, ...attempt } });
        const buffered = lease.buffered; lease.buffered = undefined;
        if (buffered) dispatch({ type: "directorySizeSnapshotReceived", payload: { ...payload, snapshot: buffered } });
        if (!replacing) return;
        replacements.current.delete(key);
        for (const [held, current] of leases.current) if (current === replacing) {
          leases.current.delete(held); replacing.closed = true; replacing.close();
        }
        leases.current.set(key, lease);
      };
      const fail = (error: unknown) => {
        if (lease.closed || !mounted.current) return;
        const message = getErrorMessage(error, "无法获取目录大小统计");
        if (lease.committed) { dispatch({ type: "directorySizeFailed", payload: { ...lease.payload, message } }); return; }
        lease.closed = true; lease.close();
        const owner = replacing ? replacements.current : leases.current;
        if (owner.get(key) === lease) owner.delete(key);
        // Manual subscriptions own no panel resource. A rejected physical transfer
        // can keep the valid old subscription at its new logical route (D15).
        if (mode === "manual" && replacing?.mode === "manual" && !replacing.closed && replacing.committed) {
          replacing.ownerKey = key; wake(); return;
        }
        // A failed replacement records the target mode's error without touching the live lease (READY-006).
        dispatch({ type: "directorySizeLeaseFailed", payload: { ...payload, ...attempt, message } });
      };
      if (lease.channel === "slot") {
        let slot = slots.current.get(panelId);
        if (!slot || slot.gateway !== workspaceGateway) {
          slot?.lane.clear();
          slot = { gateway: workspaceGateway, lane: new DirectorySizeSlot(gateway, panelId) };
          slots.current.set(panelId, slot);
        }
        lease.close = slot.lane.replace({ request, receive, fail, accepted: commit });
      } else {
        const subscription = openDirectorySizeSubscription(gateway, request, receive, fail);
        lease.close = subscription.close;
        void subscription.settled.then((accepted) => { if (accepted) commit(); });
      }
    }
  }, [enabled, state.status, state.panels, state.layoutMode, state.remoteProfiles, state.settings.model.autoDirectorySizePaths,
    windowActive, workspaceGateway, dispatch, completion]);

  useEffect(() => {
    const gateway = workspaceGateway.directorySizes;
    if (!enabled || !gateway || state.status !== "ready") return;
    const visiblePanels = new Set(getVisiblePanelIds(state.layoutMode));
    for (const lease of leases.current.values()) {
      const { payload, context } = lease;
      // Background leases keep their snapshot; lookups wait until the tab is visible again (SPEC-032).
      if (!visiblePanels.has(payload.panelId) || getActiveTab(state.panels[payload.panelId]).id !== payload.tabId) continue;
      const tab = state.panels[payload.panelId].tabs.find((item) => item.id === payload.tabId);
      const sizes = tab && currentDirectorySizes(tab);
      const snapshot = sizes?.snapshot;
      if (!tab || tab.status !== "ready" || lease.closed || !lease.committed || sizes?.consumerId !== payload.consumerId || !snapshot ||
        !(snapshot.phase === "complete" || snapshot.phase === "partial" || snapshot.phase === "stale" && snapshot.staleReadable === true)) continue;
      const lookupVersion = `${snapshot.generation}:${snapshot.sequence}:${snapshot.invalidationRevision ?? ""}`;
      if (lease.lookupVersion !== lookupVersion || !lease.lookupRoot || !matchesDirectorySizeLookupListing(tab, {
        expectedRoot: lease.lookupRoot, expectedExpansion: lease.lookupExpansion
      })) {
        lease.lookupVersion = lookupVersion;
        lease.lookedUp.clear();
      }
      lease.lookupRoot = tab.snapshot; lease.lookupExpansion = tab.folderExpansion;
      const listing = { expectedRoot: tab.snapshot, expectedExpansion: tab.folderExpansion };
      const paths = directorySizeLookupPaths(state, payload.panelId, tab)
        .filter((path) => (!sizes.records[getPathComparisonKey(path)] || sizes.records[getPathComparisonKey(path)].state === "unknown") && !lease.lookedUp.has(getPathComparisonKey(path)));
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
            dispatch({ type: "directorySizeLookupReceived", payload: { ...lease.payload, ...listing, lookup: { ...lookup, directories } } });
          })
          .catch((error) => { if (!lease.closed && mounted.current) dispatch({ type: "directorySizeFailed", payload: { ...lease.payload,
            lookupFence: { ...listing, generation: snapshot.generation, sequence: snapshot.sequence }, message: getErrorMessage(error, "无法查询目录大小") } }); })
          .finally(() => { lookupCount.current--; if (mounted.current) wake(); });
      }
    }
  }, [enabled, state, workspaceGateway, dispatch, completion]);
  useDirectorySizeAlignment({ state, dispatch, workspaceGateway, enabled });
  useDirectorySizeEnrichment({ state, dispatch, workspaceGateway, enabled });
  useDirectorySizeViews({ state, dispatch, workspaceGateway, enabled });
}

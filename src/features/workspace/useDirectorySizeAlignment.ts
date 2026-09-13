import { useEffect, useRef, type Dispatch } from "react";
import { currentDirectorySizes, listingSizeFingerprint, listingSizeIdentityIsReliable, supportsDirectorySizes } from "./directorySizes";
import { directorySizeContext, directorySizeLookupPaths } from "./directorySizePlanning";
import { useDirectoryListingBudget } from "./directoryListingBudget";
import { DirectorySizeAlignmentRequest, type SizeAlignmentTarget, type AlignmentResult } from "./directorySizeAlignmentRequest";
import { sizingPathIdentity } from "./directorySizeMapping";
import { getPathComparisonKey, pathsEqual } from "./workspacePathRelations";
import { getErrorMessage } from "./workspaceControllerUtils";
import { getActiveTab, getVisiblePanelIds, type WorkspaceAction } from "./workspaceReducer";
import type { WorkspaceState } from "./types";
import type { WorkspaceGateway } from "./workspaceGateway";

type Scope = { used: number; directories: Map<string, DirectorySizeAlignmentRequest> };

function targetIsCurrent(state: WorkspaceState, target: SizeAlignmentTarget) {
  if (!getVisiblePanelIds(state.layoutMode).includes(target.panelId)) return false;
  const tab = getActiveTab(state.panels[target.panelId]);
  const sizes = currentDirectorySizes(tab);
  return tab.id === target.tabId && supportsDirectorySizes(tab) && tab.snapshot === target.expectedRoot &&
    sizes?.consumerId === target.consumerId && sizes.requestVersion === target.requestVersion && !sizes.paused &&
    sizes.snapshot?.generation === target.generation && (target.expectedBranch
      ? tab.folderExpansion?.[getPathComparisonKey(target.path)] === target.expectedBranch
      : pathsEqual(target.path, tab.snapshot.location.path));
}

function captureOriginalTargets(state: WorkspaceState, identity: string, generation: number, path: string, fingerprint: string) {
  const targets: SizeAlignmentTarget[] = [];
  for (const panelId of getVisiblePanelIds(state.layoutMode)) {
    const tab = getActiveTab(state.panels[panelId]);
    const sizes = currentDirectorySizes(tab); const snapshot = sizes?.snapshot;
    if (!supportsDirectorySizes(tab) || !sizes?.consumerId || sizes.paused || snapshot?.generation !== generation ||
      (snapshot.phase !== "complete" && snapshot.phase !== "partial")) continue;
    try { if (directorySizeContext(tab, state.remoteProfiles).identity !== identity) continue; } catch { continue; }
    const isRoot = pathsEqual(path, tab.snapshot.location.path);
    const branch = isRoot ? undefined : tab.folderExpansion?.[getPathComparisonKey(path)];
    if (!isRoot && branch?.status !== "ready") continue;
    if (!listingSizeIdentityIsReliable(tab, path) || listingSizeFingerprint(tab, path) === fingerprint) continue;
    targets.push({ panelId, tabId: tab.id, rootPath: tab.snapshot.location.path, consumerId: sizes.consumerId,
      requestVersion: sizes.requestVersion, generation, path, expectedRoot: tab.snapshot, expectedBranch: branch });
  }
  return targets;
}

/** One ordinary listing per loaded directory/generation, shared by same-root panels. */
export function useDirectorySizeAlignment({ state, dispatch, workspaceGateway, enabled }: {
  state: WorkspaceState; dispatch: Dispatch<WorkspaceAction>; workspaceGateway: WorkspaceGateway; enabled: boolean;
}) {
  const scopes = useRef(new Map<string, Scope>());
  const sequence = useRef(0);
  const mounted = useRef(false);
  const inFlight = useRef(new Set<DirectorySizeAlignmentRequest>());
  const { budget, version } = useDirectoryListingBudget(workspaceGateway);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; scopes.current.clear();
      for (const request of inFlight.current) request.discard();
      inFlight.current.clear();
    };
  }, [workspaceGateway]);
  useEffect(() => {
    // Only the physically in-flight reads (at most four) hold consumer snapshots.
    for (const request of inFlight.current) request.prune((target) => enabled && state.status === "ready" && targetIsCurrent(state, target));
    if (!enabled || state.status !== "ready" || !workspaceGateway.directorySizes) return;
    const deliver = (target: SizeAlignmentTarget, result: AlignmentResult) => {
      if (!mounted.current) return;
      if (result.snapshot) dispatch({ type: "directorySizeListingAligned", payload: { ...target, snapshot: result.snapshot } });
      else dispatch({ type: "directorySizeListingAlignmentFailed", payload: { ...target, message: result.error } });
    };
    // Plan every known root before any branch, independent of panel/lookup order.
    const knownRootScopes = new Set<string>();
    for (const rootsOnly of [true, false]) for (const panelId of getVisiblePanelIds(state.layoutMode)) {
      const tab = getActiveTab(state.panels[panelId]);
      const sizes = currentDirectorySizes(tab); const snapshot = sizes?.snapshot;
      if (!supportsDirectorySizes(tab) || !sizes?.consumerId || sizes.paused || !snapshot ||
        (snapshot.phase !== "complete" && snapshot.phase !== "partial")) continue;
      let identity: string;
      try { identity = directorySizeContext(tab, state.remoteProfiles).identity; } catch { continue; }
      const scopeKey = JSON.stringify([identity, snapshot.generation]);
      let scope = scopes.current.get(scopeKey);
      if (!scope) {
        // Adjacent generations may coexist; the LRU below bounds their tombstones.
        scope = { used: ++sequence.current, directories: new Map() }; scopes.current.set(scopeKey, scope);
      }
      scope.used = ++sequence.current;
      const root = tab.snapshot.location.path;
      const rootKey = getPathComparisonKey(root);
      // Lookup batches can finish out of order. A missing root record is pending,
      // unlike an authoritative record that has no usable fingerprint.
      if (rootsOnly && sizes.records[rootKey]) knownRootScopes.add(scopeKey);
      const rootAlignment = scope.directories.get(rootKey);
      if (!rootsOnly && (!knownRootScopes.has(scopeKey) || rootAlignment && inFlight.current.has(rootAlignment))) continue;
      const paths = rootsOnly ? [root] : directorySizeLookupPaths(state, panelId, tab).filter((path) => !pathsEqual(path, root));
      for (const path of paths) {
        const isRoot = pathsEqual(path, tab.snapshot.location.path);
        const branch = isRoot ? undefined : tab.folderExpansion?.[getPathComparisonKey(path)];
        if (!isRoot && branch?.status !== "ready") continue;
        const record = sizes.records[getPathComparisonKey(path)];
        const pathKey = getPathComparisonKey(path);
        if (!record?.sizeFingerprint || scope.directories.has(pathKey)) continue;
        // A matched panel's record may still identify another original panel's
        // mismatch. Capture before I/O, never enroll replacements after start.
        const targets = captureOriginalTargets(state, identity, snapshot.generation, path, record.sizeFingerprint);
        if (!targets.length) continue;
        const release = budget.tryAcquire();
        if (!release) break;
        const result = new DirectorySizeAlignmentRequest(); scope.directories.set(pathKey, result);
        for (const target of targets) result.enroll(target);
        inFlight.current.add(result);
        void Promise.resolve().then(() => { result.start(); return workspaceGateway.resolveDirectory(path); })
          .then((listing) => {
            const local = listing.location.kind === "local";
            if (sizingPathIdentity(listing.location.path, local) !== sizingPathIdentity(path, local)) throw new Error("目录读取结果与大小统计路径不一致");
            result.finish({ snapshot: listing }, deliver);
          })
          .catch((error) => result.finish({ error: getErrorMessage(error, "无法对齐目录大小与列表") }, deliver))
          .finally(() => { inFlight.current.delete(result); release(); });
      }
    }
    while (scopes.current.size > 8) {
      const oldest = [...scopes.current].sort((left, right) => left[1].used - right[1].used)[0];
      scopes.current.delete(oldest[0]);
    }
  }, [enabled, state, workspaceGateway, dispatch, budget, version]);
}

import type { DirectorySizePresentation, DirectorySizePresentationView, RetainedEntrySize } from "./directorySizeTypes";
import type { EntryViewModel, RemoteConnectionProfile, TabState, WorkspaceState } from "./types";
import { createCurrentSizeProjector, listingSizeIdentityIsReliable, retainedSizeMatches } from "./directorySizes";
import { directorySizeContext } from "./directorySizePlanning";
import { getPathComparisonKey, isSameOrDescendantPath } from "./workspacePathRelations";

const HISTORY_ROOTS = 7;
const HISTORY_ROWS = 20_000;

function scopeFor(tab: TabState, profiles: RemoteConnectionProfile[]) {
  if (tab.kind !== "directory" || tab.snapshot.location.kind === "virtual") return undefined;
  try { return directorySizeContext(tab, profiles).identity; } catch { return undefined; }
}

function viewScope(tab: TabState, view: DirectorySizePresentationView, profiles: RemoteConnectionProfile[]) {
  return scopeFor({ ...tab, snapshot: { ...tab.snapshot, sizeIdentityReliable: true, location: {
    ...tab.snapshot.location, path: view.rootPath, kind: view.locationKind
  } } }, profiles);
}

/** Capture display summaries only; current records and all IPC fences stay untouched. */
function capture(tab: TabState, scope: string, previous?: DirectorySizePresentationView): DirectorySizePresentationView {
  const entries = new Map<string, EntryViewModel>();
  const authoritative = new Map<string, Set<string>>();
  const visited = new Set<string>();
  const visit = (path: string, children: EntryViewModel[], ready: boolean) => {
    if (visited.has(path)) return;
    visited.add(path);
    if (ready) authoritative.set(path, new Set(children.map((entry) => entry.path)));
    for (const entry of children) {
      entries.set(entry.path, entry);
      const branch = tab.folderExpansion?.[getPathComparisonKey(entry.path)];
      if (entry.kind === "folder" && branch) visit(branch.path, branch.entries, branch.status === "ready");
    }
  };
  visit(tab.snapshot.location.path, tab.snapshot.entries, tab.status === "ready");
  const rows: Record<string, RetainedEntrySize> = {};
  const removed = new Set<string>();
  for (const row of Object.values(previous?.rows ?? {})) {
    const entry = entries.get(row.path);
    if (authoritative.get(row.parentPath)?.has(row.path) === false || entry && !retainedSizeMatches(row, entry)) removed.add(row.path);
  }
  const removedAncestor = (row: RetainedEntrySize) => {
    let ancestor: RetainedEntrySize | undefined = row;
    while (ancestor) {
      if (removed.has(ancestor.path)) return true;
      if (ancestor.path === ancestor.parentPath) break;
      ancestor = previous?.rows[ancestor.parentPath];
    }
    return false;
  };
  // A descendant can have a retained display even when its parent never had
  // a directory-size record. Walk successful listing boundaries so deletion
  // evidence still reaches those descendants without treating failed or
  // collapsed branches as deletions.
  const removedByAuthoritativeAncestor = (row: RetainedEntrySize) => {
    let childPath = row.path;
    let parentPath = row.parentPath;
    const visited = new Set<string>();
    while (!visited.has(getPathComparisonKey(parentPath))) {
      visited.add(getPathComparisonKey(parentPath));
      const listing = authoritative.get(parentPath);
      if (listing) return !listing.has(childPath);
      const ancestor = [...authoritative.entries()]
        .filter(([path]) => path !== parentPath && isSameOrDescendantPath(path, parentPath))
        .sort(([left], [right]) => right.length - left.length)[0];
      if (ancestor) return !ancestor[1].has(parentPath);
      const parentRow = previous?.rows[parentPath];
      if (!parentRow) return false;
      childPath = parentPath;
      parentPath = parentRow.parentPath;
    }
    return false;
  };
  let detached = 0;
  for (const row of Object.values(previous?.rows ?? {})) {
    const entry = entries.get(row.path);
    if (removedAncestor(row) || removedByAuthoritativeAncestor(row) || !listingSizeIdentityIsReliable(tab, row.parentPath)) continue;
    if (!entry && ++detached > HISTORY_ROWS) continue;
    rows[row.path] = row;
  }
  const total = createCurrentSizeProjector(tab);
  const max = createCurrentSizeProjector(tab, "folder-max");
  for (const entry of entries.values()) {
    const display = total(entry);
    if (display.bytes === null || display.state !== "complete" && display.state !== "partial") continue;
    // Preserve the existing live ratio policy. With restart history, retain new
    // scalar values even when a bounded scan cannot supply the denominator.
    if (display.share === null && rows[entry.path] && !tab.snapshot.directorySizeCache?.historical) continue;
    rows[entry.path] = { path: entry.path, parentPath: entry.parentPath, kind: entry.kind, createdAt: entry.sizeCreatedAt,
      total: display, max: max(entry) };
  }
  return { rootPath: tab.snapshot.location.path, locationKind: tab.snapshot.location.kind, scope, rows };
}

function trimHistory(views: DirectorySizePresentationView[]) {
  let count = 0;
  return views.filter((view, index) => {
    count += Object.keys(view.rows).length;
    return index < HISTORY_ROOTS && count <= HISTORY_ROWS;
  });
}

function reconcileTab(before: TabState | undefined, after: TabState, oldProfiles: RemoteConnectionProfile[], profiles: RemoteConnectionProfile[]): TabState {
  if (before && before.snapshot === after.snapshot && before.directorySizes === after.directorySizes &&
    before.folderExpansion === after.folderExpansion && before.status === after.status && oldProfiles === profiles) return after;
  if (!before?.directorySizes && !after.directorySizes && !before?.directorySizePresentation && !after.directorySizePresentation) return after;
  const scope = scopeFor(after, profiles);
  const previousScope = before && scopeFor(before, oldProfiles);
  let presentation: DirectorySizePresentation = before?.directorySizePresentation ?? after.directorySizePresentation ?? { history: [] };
  if (before && previousScope && presentation.current?.scope !== previousScope) {
    presentation = { ...presentation, current: capture(before, previousScope) };
  }
  const candidates = [...(presentation.current ? [presentation.current] : []), ...presentation.history]
    .filter((view, index, views) => views.findIndex((other) => other.scope === view.scope) === index && viewScope(after, view, profiles) === view.scope);
  const contextChanged = before && before.snapshot.location.path === after.snapshot.location.path && previousScope !== scope;
  // A changed remote connection must not expose its predecessor's live statistics even for one render.
  const tab = contextChanged ? { ...after, directorySizes: undefined } : after;
  const previous = candidates.find((view) => view.scope === scope);
  const phase = tab.directorySizes?.snapshot?.phase;
  const newResults = (phase === "complete" || phase === "partial") && before?.directorySizes?.records !== tab.directorySizes?.records;
  const sameListing = previous && before?.snapshot === tab.snapshot && before.folderExpansion === tab.folderExpansion;
  // Progress/lease events change freshness, not the rows being displayed. Avoid
  // copying thousands of retained summaries on every scan progress notification.
  const current = scope ? (sameListing && !newResults ? previous : capture(tab, scope, previous)) : undefined;
  const removedPaths = current && current !== previous ? Object.keys(previous?.rows ?? {}).filter((path) => !current.rows[path]) : [];
  const history = candidates.filter((view) => view.scope !== scope &&
    !removedPaths.some((path) => isSameOrDescendantPath(path, view.rootPath)));
  return { ...tab, directorySizePresentation: { current, history: trimHistory(history) } };
}

export function reconcileDirectorySizePresentation(before: WorkspaceState, after: WorkspaceState): WorkspaceState {
  if (before === after || before.panels === after.panels && before.remoteProfiles === after.remoteProfiles) return after;
  let panels = after.panels;
  for (const panelId of Object.keys(panels) as Array<keyof typeof panels>) {
    const panel = panels[panelId];
    const oldTabs = new Map(before.panels[panelId].tabs.map((tab) => [tab.id, tab]));
    const tabs = panel.tabs.map((tab) => reconcileTab(oldTabs.get(tab.id), tab, before.remoteProfiles, after.remoteProfiles));
    if (tabs.some((tab, index) => tab !== panel.tabs[index])) panels = { ...panels, [panelId]: { ...panel, tabs } };
  }
  return panels === after.panels ? after : { ...after, panels };
}

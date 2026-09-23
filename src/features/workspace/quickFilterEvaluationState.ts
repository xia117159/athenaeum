import { getTabEntries } from "./folderExpansion";
import { getPathComparisonKey } from "./workspacePathRelations";
import { isDirectoryLikeTab } from "./workspaceTabs";
import type { WorkspaceState } from "./types";
import type { QuickFilterEntry, QuickFilterEvaluationResult } from "./quickFilterTypes";

export interface QuickFilterCorpus { path: string; names: string[]; key: string }

/** Name-only matching permits sharing across same-path panels, even when their
 * snapshots/expanded branches differ. No entry/path from the Worker becomes an
 * operation target: the current tab still owns the actual entries.
 */
export function collectQuickFilterCorpora(state: WorkspaceState): Map<string, QuickFilterCorpus> {
  const paths = new Map<string, { path: string; names: Set<string> }>();
  for (const panel of Object.values(state.panels)) {
    for (const tab of panel.tabs) {
      if (!isDirectoryLikeTab(tab)) continue;
      const path = tab.snapshot.location.path;
      if (!path) continue;
      const key = getPathComparisonKey(path);
      if (!state.quickFilter.byPath[key]?.text.trim()) continue;
      let corpus = paths.get(key);
      if (!corpus) paths.set(key, corpus = { path, names: new Set() });
      for (const entry of getTabEntries(tab)) corpus.names.add(entry.name);
    }
  }
  return new Map([...paths].map(([key, corpus]) => {
    const names = [...corpus.names].sort();
    return [key, { path: corpus.path, names, key: JSON.stringify(names) }];
  }));
}

export interface QuickFilterEvaluationCommit {
  path: string;
  expectedEntry: QuickFilterEntry;
  corpusKey: string;
  result: QuickFilterEvaluationResult;
}

export function applyQuickFilterEvaluation(state: WorkspaceState, payload: QuickFilterEvaluationCommit): WorkspaceState {
  if (state.quickFilter.syntax !== "regex") return state;
  const key = getPathComparisonKey(payload.path);
  const previous = state.quickFilter.byPath[key];
  if (!previous || previous !== payload.expectedEntry || !previous.text.trim()) return state;
  if (collectQuickFilterCorpora(state).get(key)?.key !== payload.corpusKey) return state;
  const { result } = payload;
  const evaluation = result.evaluation ?? (result.error ? previous.regexEvaluation : undefined);
  const entry: QuickFilterEntry = {
    ...previous,
    appliedText: evaluation?.text ?? previous.appliedText,
    error: result.error,
    regexEvaluation: evaluation,
    regexAttempt: { text: previous.text, corpusKey: payload.corpusKey }
  };
  return { ...state, quickFilter: { ...state.quickFilter, byPath: { ...state.quickFilter.byPath, [key]: entry } } };
}

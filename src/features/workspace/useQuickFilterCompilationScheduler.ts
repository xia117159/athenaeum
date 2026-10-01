import { useEffect, useRef, type Dispatch } from "react";
import { collectQuickFilterCorpora } from "./quickFilterEvaluationState";
import { createQuickFilterWorkerClient, type QuickFilterWorkerClient } from "./quickFilterWorkerClient";
import { QUICK_FILTER_REGEX_DEBOUNCE_MS, type QuickFilterEntry } from "./quickFilterTypes";
import { getPathComparisonKey } from "./workspacePathRelations";
import { isDirectoryLikeTab } from "./workspaceTabs";
import type { WorkspaceAction } from "./workspaceReducer";
import type { TabState, WorkspaceState } from "./types";

type Work = { entry: QuickFilterEntry; corpusKey: string; controller: AbortController; timer: ReturnType<typeof setTimeout> };
type CorpusInput = {
  path: string;
  entries: TabState["snapshot"]["entries"];
  entryCount: number;
  expansion: TabState["folderExpansion"];
  expansionEntryCount: number;
  kind: TabState["kind"];
  viewMode: TabState["viewMode"];
  locationKind: TabState["snapshot"]["location"]["kind"];
  hasText: boolean;
};

function corpusInputs(state: WorkspaceState): CorpusInput[] {
  const inputs: CorpusInput[] = [];
  for (const panel of Object.values(state.panels)) {
    const tab = panel.tabs.find((candidate) => candidate.id === panel.activeTabId);
    if (!tab || !isDirectoryLikeTab(tab) || !tab.snapshot.location.path) continue;
    const path = tab.snapshot.location.path;
    inputs.push({
      path, entries: tab.snapshot.entries, entryCount: tab.snapshot.entries.length,
      expansion: tab.folderExpansion,
      expansionEntryCount: Object.values(tab.folderExpansion ?? {}).reduce((count, branch) => count + branch.entries.length, 0),
      kind: tab.kind, viewMode: tab.viewMode, locationKind: tab.snapshot.location.kind,
      hasText: Boolean(state.quickFilter.byPath[getPathComparisonKey(path)]?.text.trim())
    });
  }
  return inputs;
}

function sameCorpusInputs(left: CorpusInput[], right: CorpusInput[]) {
  return left.length === right.length && left.every((input, index) => {
    const previous = right[index];
    return input.path === previous.path && input.entries === previous.entries && input.entryCount === previous.entryCount &&
      input.expansion === previous.expansion && input.expansionEntryCount === previous.expansionEntryCount &&
      input.kind === previous.kind && input.viewMode === previous.viewMode && input.locationKind === previous.locationKind &&
      input.hasText === previous.hasText;
  });
}

/** Reconcile each path independently; unrelated renders never reset its debounce. */
export function useQuickFilterCompilationScheduler({ state, dispatch, enabled = true }: {
  state: WorkspaceState; dispatch: Dispatch<WorkspaceAction>; enabled?: boolean;
}) {
  const clientRef = useRef<QuickFilterWorkerClient | null>(null);
  const workRef = useRef(new Map<string, Work>());
  const corporaRef = useRef<{ inputs: CorpusInput[]; corpora: ReturnType<typeof collectQuickFilterCorpora> } | null>(null);

  useEffect(() => {
    const work = workRef.current;
    const stop = (key: string, item: Work) => {
      work.delete(key);
      clearTimeout(item.timer);
      item.controller.abort();
    };
    if (!enabled || state.quickFilter.syntax !== "regex") {
      clientRef.current?.dispose();
      clientRef.current = null;
      for (const [key, item] of work) stop(key, item);
      return;
    }
    const inputs = corpusInputs(state);
    const previous = corporaRef.current;
    const corpora = previous && sameCorpusInputs(inputs, previous.inputs)
      ? previous.corpora
      : collectQuickFilterCorpora(state);
    corporaRef.current = { inputs, corpora };
    for (const [key, item] of work) {
      if (state.quickFilter.byPath[key] !== item.entry || corpora.get(key)?.key !== item.corpusKey) stop(key, item);
    }
    for (const [key, corpus] of corpora) {
      const entry = state.quickFilter.byPath[key];
      if (!entry?.text.trim() || work.has(key)) continue;
      if (entry.regexAttempt?.text === entry.text && entry.regexAttempt.corpusKey === corpus.key) continue;
      const controller = new AbortController();
      const run = async () => {
        try {
          const client = clientRef.current ?? (clientRef.current = createQuickFilterWorkerClient());
          // Compute ranges once even in include/exclude mode, so mode switches are synchronous.
          const result = await client.evaluate({ text: entry.text, fallbackText: entry.appliedText, names: corpus.names, includeRanges: true }, controller.signal);
          if (!controller.signal.aborted) dispatch({ type: "quickFilterEvaluationCommitted",
            payload: { path: corpus.path, expectedEntry: entry, corpusKey: corpus.key, result } });
        } catch (error) {
          if (!controller.signal.aborted) dispatch({ type: "quickFilterEvaluationCommitted",
            payload: { path: corpus.path, expectedEntry: entry, corpusKey: corpus.key,
              result: { error: error instanceof Error ? error.message : String(error), evaluation: null } } });
        } finally {
          if (work.get(key)?.controller === controller) work.delete(key);
        }
      };
      work.set(key, { entry, corpusKey: corpus.key, controller, timer: setTimeout(() => void run(), QUICK_FILTER_REGEX_DEBOUNCE_MS) });
    }
  }, [enabled, state.quickFilter, state.panels, dispatch]);

  useEffect(() => () => {
    clientRef.current?.dispose();
    clientRef.current = null;
    for (const work of workRef.current.values()) { clearTimeout(work.timer); work.controller.abort(); }
    workRef.current.clear();
  }, []);
}

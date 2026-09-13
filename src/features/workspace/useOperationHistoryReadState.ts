import { emit, listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OperationWorkspaceState } from "./types";
import {
  getOperationHistoryIds,
  OPERATION_HISTORY_TABS,
  projectOperationHistoryTabs,
  type OperationHistoryTab
} from "./operationHistoryModel";
import {
  createEmptyOperationHistoryReadState,
  getOperationHistoryUnreadCounts,
  markOperationHistoryTabSeen,
  persistOperationHistoryReadState,
  readOperationHistoryReadState,
  OPERATION_HISTORY_READ_STORAGE_KEY,
  type OperationHistoryReadResult,
  type OperationHistoryReadState
} from "./operationHistoryReadStore";

export const OPERATION_HISTORY_READ_EVENT = "operation-history-read-state-changed";
const BROWSER_READ_EVENT = "athenaeum-operation-history-read-state-changed";
const PERSISTENCE_WARNING = "\u672a\u80fd\u6301\u4e45\u5316\u672a\u8bfb\u72b6\u6001";
const SUBSCRIPTION_WARNING = "\u672a\u80fd\u8ba2\u9605\u672a\u8bfb\u72b6\u6001\u53d8\u66f4";
const SYNC_WARNING = "\u672a\u80fd\u540c\u6b65\u672a\u8bfb\u72b6\u6001";

type PendingTabMutation = {
  selectedTab: OperationHistoryTab | null;
  seenIdsByTab: Record<OperationHistoryTab, string[]>;
};

type ReadRecoveryState = {
  storageReadFailed: boolean;
  subscriptionFailed: boolean;
  pendingWrite: OperationHistoryReadState | null;
  pendingNotify: OperationHistoryReadState | null;
};

function createPendingTabMutation(): PendingTabMutation {
  return {
    selectedTab: null,
    seenIdsByTab: { running: [], waiting: [], problems: [], completed: [], history: [] }
  };
}

function queueTabMutation(
  pending: PendingTabMutation,
  tab: OperationHistoryTab,
  seenIds: string[],
  select: boolean
) {
  return {
    selectedTab: select ? tab : pending.selectedTab,
    seenIdsByTab: {
      ...pending.seenIdsByTab,
      [tab]: Array.from(new Set([...pending.seenIdsByTab[tab], ...seenIds]))
    }
  };
}

function hasPendingTabMutation(pending: PendingTabMutation) {
  return pending.selectedTab !== null
    || OPERATION_HISTORY_TABS.some((tab) => pending.seenIdsByTab[tab.id].length > 0);
}

function applyPendingTabMutation(state: OperationHistoryReadState, pending: PendingTabMutation) {
  let changed = pending.selectedTab !== null && pending.selectedTab !== state.selectedTab;
  const seenIdsByTab = { ...state.seenIdsByTab };
  for (const tab of OPERATION_HISTORY_TABS) {
    const seen = new Set(state.seenIdsByTab[tab.id]);
    const before = seen.size;
    pending.seenIdsByTab[tab.id].forEach((id) => seen.add(id));
    if (seen.size !== before) {
      changed = true;
      seenIdsByTab[tab.id] = Array.from(seen);
    }
  }
  if (!changed) return state;
  return { ...state, selectedTab: pending.selectedTab ?? state.selectedTab, seenIdsByTab };
}

function mergePendingWrite(canonical: OperationHistoryReadState, pending: OperationHistoryReadState) {
  if (canonical.epoch !== pending.epoch) return canonical;
  const seenIdsByTab = { ...canonical.seenIdsByTab };
  for (const tab of OPERATION_HISTORY_TABS) {
    seenIdsByTab[tab.id] = Array.from(new Set([
      ...canonical.seenIdsByTab[tab.id],
      ...pending.seenIdsByTab[tab.id]
    ]));
  }
  return { ...canonical, selectedTab: pending.selectedTab, seenIdsByTab };
}

export type OperationHistoryReadEnvironment = {
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  createEpoch: () => string;
  isForeground: () => boolean;
  subscribe: (handler: () => void) => Promise<() => void>;
  notify: (state: OperationHistoryReadState) => Promise<void>;
  subscribeForeground: (handler: () => void) => () => void;
};

function hasTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function defaultStorage() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export const defaultOperationHistoryReadEnvironment: OperationHistoryReadEnvironment = {
  storage: defaultStorage(),
  createEpoch: () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
  isForeground: () =>
    typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus(),
  async subscribe(handler) {
    const onStorage = (event: StorageEvent) => {
      if (event.key === OPERATION_HISTORY_READ_STORAGE_KEY) handler();
    };
    const onCustom = () => handler();
    window.addEventListener("storage", onStorage);
    window.addEventListener(BROWSER_READ_EVENT, onCustom);
    let unlisten: (() => void) | undefined;
    try {
      if (hasTauriRuntime()) {
        unlisten = await listen(OPERATION_HISTORY_READ_EVENT, handler);
      }
    } catch (error) {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(BROWSER_READ_EVENT, onCustom);
      throw error;
    }
    return () => {
      unlisten?.();
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(BROWSER_READ_EVENT, onCustom);
    };
  },
  async notify(state) {
    window.dispatchEvent(new CustomEvent(BROWSER_READ_EVENT));
    if (hasTauriRuntime()) {
      await emit(OPERATION_HISTORY_READ_EVENT, { epoch: state.epoch, revision: state.revision });
    }
  },
  subscribeForeground(handler) {
    window.addEventListener("focus", handler);
    window.addEventListener("blur", handler);
    document.addEventListener("visibilitychange", handler);
    return () => {
      window.removeEventListener("focus", handler);
      window.removeEventListener("blur", handler);
      document.removeEventListener("visibilitychange", handler);
    };
  }
};

export function useOperationHistoryReadState(
  idsByTab: Record<OperationHistoryTab, string[]>,
  writer: boolean,
  environment: OperationHistoryReadEnvironment = defaultOperationHistoryReadEnvironment
) {
  const [readState, setReadState] = useState(() => createEmptyOperationHistoryReadState("pending"));
  const stateRef = useRef(readState);
  const [ready, setReady] = useState(false);
  const [foreground, setForeground] = useState(() => environment.isForeground());
  const [recovery, setRecovery] = useState<ReadRecoveryState>({
    storageReadFailed: false,
    subscriptionFailed: false,
    pendingWrite: null,
    pendingNotify: null
  });
  const [subscriptionRevision, setSubscriptionRevision] = useState(0);
  const mountedRef = useRef(true);
  const canonicalReadyRef = useRef(false);
  const pendingTabMutationRef = useRef(createPendingTabMutation());
  const recoveryRef = useRef(recovery);
  const notifyAttemptRef = useRef(0);
  stateRef.current = readState;
  recoveryRef.current = recovery;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const updateRecovery = useCallback((update: (current: ReadRecoveryState) => ReadRecoveryState) => {
    const next = update(recoveryRef.current);
    recoveryRef.current = next;
    if (mountedRef.current) setRecovery(next);
  }, []);

  const notifyReadState = useCallback((state: OperationHistoryReadState) => {
    const attempt = ++notifyAttemptRef.current;
    void environment.notify(state).then(() => {
      if (notifyAttemptRef.current === attempt) {
        updateRecovery((current) => ({ ...current, pendingNotify: null }));
      }
    }).catch(() => {
      if (notifyAttemptRef.current === attempt) {
        updateRecovery((current) => ({ ...current, pendingNotify: state }));
      }
    });
  }, [environment, updateRecovery]);

  const commit = useCallback((candidate: OperationHistoryReadState) => {
    if (!environment.storage) {
      stateRef.current = candidate;
      setReadState(candidate);
      updateRecovery((current) => ({ ...current, pendingWrite: candidate }));
      return;
    }
    const result = persistOperationHistoryReadState(candidate, environment.storage);
    if (!result.ok) {
      stateRef.current = candidate;
      setReadState(candidate);
      updateRecovery((current) => ({ ...current, pendingWrite: candidate }));
      return;
    }
    pendingTabMutationRef.current = createPendingTabMutation();
    stateRef.current = result.state;
    setReadState(result.state);
    updateRecovery((current) => ({ ...current, pendingWrite: null }));
    notifyReadState(result.state);
  }, [environment, notifyReadState, updateRecovery]);

  const applyReadResult = useCallback((result: OperationHistoryReadResult) => {
    if (result.status === "storageError") {
      canonicalReadyRef.current = false;
      updateRecovery((current) => ({ ...current, storageReadFailed: true }));
      return false;
    }
    const canonical = result.state;
    const current = stateRef.current;
    if (canonicalReadyRef.current && canonical.epoch === current.epoch && canonical.revision < current.revision) {
      updateRecovery((faults) => ({ ...faults, storageReadFailed: false }));
      return true;
    }
    canonicalReadyRef.current = true;
    updateRecovery((faults) => ({ ...faults, storageReadFailed: false }));
    const pendingWrite = recoveryRef.current.pendingWrite;
    const writeBase = pendingWrite && (pendingWrite.epoch === canonical.epoch
      || result.status === "missing" || result.status === "malformed")
      ? (pendingWrite.epoch === canonical.epoch ? mergePendingWrite(canonical, pendingWrite) : pendingWrite)
      : canonical;
    const candidate = applyPendingTabMutation(writeBase, pendingTabMutationRef.current);
    const shouldPersist = writer && (result.status !== "valid" || pendingWrite !== null
      || hasPendingTabMutation(pendingTabMutationRef.current) || candidate !== canonical);
    if (shouldPersist) commit(candidate);
    else {
      stateRef.current = candidate;
      setReadState(candidate);
    }
    return true;
  }, [commit, updateRecovery, writer]);

  const reconcile = useCallback(() => applyReadResult(
    readOperationHistoryReadState(environment.storage, environment.createEpoch)
  ), [applyReadResult, environment]);

  useEffect(() => {
    let disposed = false;
    let dispose: () => void = () => undefined;
    canonicalReadyRef.current = false;
    setReady(false);
    void environment.subscribe(() => {
      if (!disposed) reconcile();
    }).then((registeredDispose) => {
      if (disposed) {
        registeredDispose();
        return;
      }
      dispose = registeredDispose;
      updateRecovery((current) => ({ ...current, subscriptionFailed: false }));
      const initial = readOperationHistoryReadState(environment.storage, environment.createEpoch);
      applyReadResult(initial);
      setReady(true);
      reconcile();
      if (recoveryRef.current.pendingNotify) notifyReadState(stateRef.current);
    }).catch(() => {
      if (!disposed) {
        reconcile();
        setReady(true);
        updateRecovery((current) => ({ ...current, subscriptionFailed: true }));
      }
    });
    return () => {
      disposed = true;
      dispose();
    };
  }, [applyReadResult, environment, notifyReadState, reconcile, subscriptionRevision, updateRecovery]);

  useEffect(() => environment.subscribeForeground(() => setForeground(environment.isForeground())), [environment]);

  const selectTab = useCallback((tab: OperationHistoryTab) => {
    if (!writer) return;
    const selected = { ...stateRef.current, selectedTab: tab };
    const candidate = foreground ? markOperationHistoryTabSeen(selected, tab, idsByTab[tab]) : selected;
    pendingTabMutationRef.current = queueTabMutation(
      pendingTabMutationRef.current,
      tab,
      foreground ? idsByTab[tab] : [],
      true
    );
    if (!canonicalReadyRef.current) {
      stateRef.current = candidate;
      setReadState(candidate);
      return;
    }
    commit(candidate);
  }, [commit, foreground, idsByTab, writer]);

  useEffect(() => {
    if (!writer || !ready || !foreground || !canonicalReadyRef.current) return;
    const candidate = markOperationHistoryTabSeen(readState, readState.selectedTab, idsByTab[readState.selectedTab]);
    if (candidate !== readState) {
      pendingTabMutationRef.current = queueTabMutation(
        pendingTabMutationRef.current,
        readState.selectedTab,
        idsByTab[readState.selectedTab],
        false
      );
      commit(candidate);
    }
  }, [commit, foreground, idsByTab, readState, ready, writer]);

  const warning = recovery.storageReadFailed || recovery.pendingWrite
    ? PERSISTENCE_WARNING
    : recovery.subscriptionFailed
      ? SUBSCRIPTION_WARNING
      : recovery.pendingNotify
        ? SYNC_WARNING
        : null;

  return {
    readState,
    ready,
    warning,
    foreground,
    unreadCounts: getOperationHistoryUnreadCounts(readState, idsByTab),
    selectTab,
    retry: () => setSubscriptionRevision((value) => value + 1)
  };
}

export function useOperationHistoryProblemUnread(operations: OperationWorkspaceState) {
  const idsByTab = useMemo(
    () => getOperationHistoryIds(projectOperationHistoryTabs(operations)),
    [operations]
  );
  const read = useOperationHistoryReadState(idsByTab, false);
  return { count: read.unreadCounts.problems, retry: read.retry, warning: read.warning };
}

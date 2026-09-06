import type { OperationHistoryTab } from "./operationHistoryModel";
import { OPERATION_HISTORY_TABS } from "./operationHistoryModel";

export const OPERATION_HISTORY_READ_STORAGE_KEY = "athenaeum.operationHistoryReadState.v1";

export type OperationHistoryReadState = {
  version: 1;
  epoch: string;
  revision: number;
  selectedTab: OperationHistoryTab;
  seenIdsByTab: Record<OperationHistoryTab, string[]>;
};

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "setItem">;

export type OperationHistoryReadResult =
  | { status: "valid" | "missing" | "normalized" | "malformed"; state: OperationHistoryReadState }
  | { status: "storageError"; state: OperationHistoryReadState; error: unknown };

const TAB_IDS = new Set(OPERATION_HISTORY_TABS.map((tab) => tab.id));

function emptySeenIds(): Record<OperationHistoryTab, string[]> {
  return { running: [], waiting: [], problems: [], completed: [], history: [] };
}

export function createEmptyOperationHistoryReadState(epoch: string): OperationHistoryReadState {
  return { version: 1, epoch, revision: 0, selectedTab: "running", seenIdsByTab: emptySeenIds() };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function parseOperationHistoryReadState(
  raw: string | null,
  createEpoch: () => string
): OperationHistoryReadResult {
  if (raw === null) {
    return { status: "missing", state: createEmptyOperationHistoryReadState(createEpoch()) };
  }
  try {
    const value = JSON.parse(raw) as Partial<OperationHistoryReadState> | null;
    if (
      !value ||
      value.version !== 1 ||
      typeof value.epoch !== "string" ||
      !Number.isSafeInteger(value.revision) ||
      Number(value.revision) < 0 ||
      !value.seenIdsByTab
    ) throw new Error("invalid read state");
    let normalized = !TAB_IDS.has(value.selectedTab as OperationHistoryTab);
    const seenIdsByTab = emptySeenIds();
    for (const tab of OPERATION_HISTORY_TABS) {
      const ids = value.seenIdsByTab[tab.id];
      if (!isStringArray(ids)) throw new Error("invalid seen IDs");
      seenIdsByTab[tab.id] = Array.from(new Set(ids));
      normalized ||= seenIdsByTab[tab.id].length !== ids.length;
    }
    return {
      status: normalized ? "normalized" : "valid",
      state: {
        version: 1,
        epoch: value.epoch,
        revision: Number(value.revision),
        selectedTab: TAB_IDS.has(value.selectedTab as OperationHistoryTab)
          ? value.selectedTab as OperationHistoryTab
          : "running",
        seenIdsByTab
      }
    };
  } catch {
    return { status: "malformed", state: createEmptyOperationHistoryReadState(createEpoch()) };
  }
}

export function readOperationHistoryReadState(
  storage: ReadStorage | null | undefined,
  createEpoch: () => string
): OperationHistoryReadResult {
  if (!storage) {
    return {
      status: "storageError",
      state: createEmptyOperationHistoryReadState(createEpoch()),
      error: new Error("operation history read storage is unavailable")
    };
  }
  try {
    return parseOperationHistoryReadState(storage.getItem(OPERATION_HISTORY_READ_STORAGE_KEY), createEpoch);
  } catch (error) {
    return { status: "storageError", state: createEmptyOperationHistoryReadState(createEpoch()), error };
  }
}

export function markOperationHistoryTabSeen(
  state: OperationHistoryReadState,
  tab: OperationHistoryTab,
  ids: string[]
): OperationHistoryReadState {
  const seen = new Set(state.seenIdsByTab[tab]);
  let changed = state.selectedTab !== tab;
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      changed = true;
    }
  }
  if (!changed) return state;
  return {
    ...state,
    selectedTab: tab,
    seenIdsByTab: { ...state.seenIdsByTab, [tab]: Array.from(seen) }
  };
}

export function getOperationHistoryUnreadCounts(
  state: OperationHistoryReadState,
  idsByTab: Record<OperationHistoryTab, string[]>
) {
  return Object.fromEntries(OPERATION_HISTORY_TABS.map((tab) => {
    const seen = new Set(state.seenIdsByTab[tab.id]);
    return [tab.id, idsByTab[tab.id].filter((id) => !seen.has(id)).length];
  })) as Record<OperationHistoryTab, number>;
}

export function persistOperationHistoryReadState(state: OperationHistoryReadState, storage: WriteStorage) {
  const persisted = { ...state, revision: state.revision + 1 };
  try {
    storage.setItem(OPERATION_HISTORY_READ_STORAGE_KEY, JSON.stringify(persisted));
    return { ok: true as const, state: persisted };
  } catch (error) {
    return { ok: false as const, state, error };
  }
}

import type { DirectorySizePhase } from "./directorySizeTypes";

export type DirectorySizeCacheReason = "liveHit" | "historyHit" | "noAcceptedResult" | "watchLost" |
  "identityPending" | "scopeEvicted" | "fingerprintMismatch" | "objectMismatch" | "storageUnavailable" | "unsupported";
export interface DirectorySizeTransition { path: string; generation: string; phase: DirectorySizePhase; reason: string | null }
export interface DirectorySizeCandidate extends DirectorySizeTransition {
  sequence: string; monitored: boolean; identityKnown: boolean; identityExpired: boolean; resultPresent: boolean; scopePresent: boolean;
}
export interface DirectorySizeDiagnostics {
  path: string; reason: DirectorySizeCacheReason; liveRejection: DirectorySizeCacheReason | null;
  diskRead: "hit" | "miss" | "pending" | "unavailable";
  listingFingerprint: string | null; displayRecords: number; historyEnabled: boolean;
  cacheBytes: string; scanJobsStarted: string; candidates: DirectorySizeCandidate[]; transitions: DirectorySizeTransition[];
  storage: {
    ready: boolean; readOnly: boolean; readsDisabled: boolean; capacityPressure: boolean;
    queueBytes: string; queueLimitBytes: string; droppedRecords: string; physicalBytes: string;
    lastCommit: string | null; lastError: string | null;
  };
}

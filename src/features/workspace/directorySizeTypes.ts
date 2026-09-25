export type DirectorySizeTarget = { kind: "local"; path: string } | { kind: "remote"; profileId: string; path: string };
export type DirectorySizePhase = "queued" | "scanning" | "complete" | "partial" | "failed" | "cancelled" | "stale";
export interface DirectorySizeSnapshot {
  cacheRevision?: string;
  artifactRevision?: string;
  consumerId: string;
  generation: number;
  sequence: number;
  phase: DirectorySizePhase;
  knownBytes: string;
  totalBytes: string | null;
  files: number;
  directories: number;
  skippedLinks: number;
  skippedSpecial: number;
  errors: number;
  freshness: "monitored" | "snapshot";
  reason: string | null;
}
export interface DirectorySizeRecord {
  path: string;
  state: "complete" | "partial" | "unknown";
  bytes: string | null;
  sizeFingerprint: string | null;
  /** Display-only history; never a live generation or freshness certificate. */
  cachedAt?: string | null;
  createdAt?: string | null;
}
export interface DirectorySizeHandoff { slotId: string; slotRevision: number; handoffFrom?: string }
export interface SubscribeDirectorySizesRequest extends Partial<DirectorySizeHandoff> { consumerId: string; target: DirectorySizeTarget; refresh: boolean }
export interface LookupDirectorySizesRequest { consumerId: string; generation: number; paths: string[] }
export interface DirectorySizeLookup {
  consumerId: string; generation: number; sequence: number; stale: boolean; directories: DirectorySizeRecord[];
}
export interface DirectorySizeCache {
  revision?: string;
  artifactRevision?: string;
  generation: number;
  sequence: number;
  directories: DirectorySizeRecord[];
  historical?: boolean;
}
export interface DirectorySizeTabState {
  rootPath: string;
  requestVersion: number;
  requested: boolean;
  paused: boolean;
  manualStarted: boolean;
  pending: boolean;
  forceRefresh?: boolean;
  consumerId?: string;
  snapshot?: DirectorySizeSnapshot;
  /** Rejected listing versions remain rejected across consumer replacement. */
  cacheFence?: { generation: number; sequence: number };
  records: Record<string, DirectorySizeRecord>;
}
export interface EntrySizeDisplay {
  state: "complete" | "partial" | "unknown" | "stale" | "excluded";
  bytes: string | null;
  share: number | null;
  label: string;
  title: string;
  /** Last displayed value, never evidence that the current scan is valid. */
  retained?: boolean;
  /** A cached scalar that has never been verified in this tab's live result. */
  advisory?: boolean;
}
export interface RetainedEntrySize {
  path: string;
  parentPath: string;
  kind: import("./types").EntryKind;
  createdAt?: string | null;
  total: EntrySizeDisplay;
  max: EntrySizeDisplay;
}
export interface DirectorySizePresentationView {
  rootPath: string;
  locationKind: import("./types").LocationDescriptor["kind"];
  scope: string;
  rows: Record<string, RetainedEntrySize>;
}
export interface DirectorySizePresentation {
  current?: DirectorySizePresentationView;
  history: DirectorySizePresentationView[];
}
export interface DirectorySizesGateway {
  updateViews?(request: import("./directorySizeViewsTypes").UpdateDirectorySizeViewsRequest): Promise<import("./directorySizeViewsTypes").DirectorySizeViewsAck>;
  listenViewsFlush?(listener: (event: import("./directorySizeViewsTypes").DirectorySizeViewsFlushRequested) => void): Promise<() => void>;
  lookupCache?(request: import("./directorySizeCacheTypes").LookupDirectorySizeCacheRequest): Promise<import("./directorySizeCacheTypes").DirectorySizeCacheLookup>;
  listenCache?(listener: (event: import("./directorySizeCacheTypes").DirectorySizeCacheUpdated) => void): Promise<() => void>;
  diagnostics?(path: string): Promise<import("./directorySizeDiagnostics").DirectorySizeDiagnostics>;
  subscribe(request: SubscribeDirectorySizesRequest): Promise<DirectorySizeSnapshot>;
  release(consumerId: string, handoff?: DirectorySizeHandoff): Promise<void>;
  lookup(request: LookupDirectorySizesRequest): Promise<DirectorySizeLookup>;
  listen(listener: (snapshot: DirectorySizeSnapshot) => void): Promise<() => void>;
}

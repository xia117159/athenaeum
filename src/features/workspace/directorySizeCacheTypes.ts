import type { DirectorySizeRecord } from "./directorySizeTypes";

export interface LookupDirectorySizeCacheRequest {
  path: string; requestVersion: number; entries: Array<{ path: string; createdAt: string }>;
}
export interface DirectorySizeCacheLookup {
  path: string; requestVersion: number; revision: string;
  entries: Array<{ path: string; status: "hit" | "miss" | "pending"; record: DirectorySizeRecord | null }>;
}
export interface DirectorySizeCacheUpdated { path: string; revision: string; ownerEpoch: string }

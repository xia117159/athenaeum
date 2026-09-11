import type { DirectoryListing as BackendListing } from "../../app/types";
import type { EntryViewModel } from "./types";

/** Sizing must not certify a lossy legacy navigation/operation path mapping. */
export function sizingPathIdentity(path: string, local: boolean): string {
  if (!local) return path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return path.replace(/\//g, "\\").replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "")
    .replace(/^[A-Z]:/, (drive) => drive.toLowerCase()).replace(/\\+$/, "");
}

export function isSizingPathRepresentable(path: string, local: boolean): boolean {
  return !path.split(/[\\/]/).some((part) => part.trim() !== part || local && part.endsWith("."));
}

function mappedPath(path: string, local: boolean) {
  if (local) return path;
  return path.match(/^(?:ftp|sftp):\/\/[^/]+(\/.*)$/)?.[1] ?? path;
}

export function directoryListingIdentityIsReliable(listing: BackendListing, root: string, entries: EntryViewModel[]): boolean {
  const local = listing.location.kind === "local";
  const same = (raw: string, mapped: string) => isSizingPathRepresentable(raw, local) &&
    sizingPathIdentity(raw, local) === sizingPathIdentity(mappedPath(mapped, local), local);
  if (!same(listing.location.path, root)) return false;
  const keys = new Set<string>();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!same(listing.entries[index].path, entry.path)) return false;
    const path = sizingPathIdentity(entry.path, local);
    // Existing listing/selection keys fold local case. An ambiguous sibling is
    // not reliable even when the backend's raw fingerprint is perfectly valid.
    const key = local ? path.toLowerCase() : path;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

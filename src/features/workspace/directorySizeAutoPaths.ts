import { isRemotePath, isSameOrDescendantPath, pathsEqual } from "./workspacePathRelations";

const INVALID_SEGMENT = /[\u0000-\u001f\u007f-\u009f<>"|?*:]/;

/** Mirrors `services::auto_directory_size_paths::normalize`; both sides share one vector fixture. */
export function normalizeAutoDirectorySizePath(input: string): string | null {
  let path = input.trim().replace(/\//g, "\\");
  if (/^\\\\\?\\UNC\\/i.test(path)) path = `\\\\${path.slice(8)}`;
  else if (path.startsWith("\\\\?\\")) path = path.slice(4);
  if (path.startsWith("\\\\.\\")) return null;
  const drive = /^[a-z]:\\/i.test(path);
  const unc = path.startsWith("\\\\");
  if (!drive && !unc) return null;
  const parts = path.slice(drive ? 3 : 2).split("\\").filter(Boolean);
  if (unc && parts.length < 2) return null;
  if (parts.some((part) => part === "." || part === ".." || INVALID_SEGMENT.test(part))) return null;
  const normalized = drive ? `${path[0].toUpperCase()}:\\${parts.join("\\")}` : `\\\\${parts.join("\\")}`;
  // String length counts UTF-16 code units, matching the Rust `encode_utf16` limit.
  return normalized.length <= 32_767 ? normalized : null;
}

/** `X:\` or `\\server\share`: adding one asks for confirmation (D11, D17). */
export function isVolumeRootPath(path: string): boolean {
  return /^[a-z]:\\$/i.test(path) || /^\\\\[^\\]+\\[^\\]+$/.test(path);
}

/** The shallowest list entry covering `path`; `inherited` when it is a strict ancestor (D1). */
export function findAutoDirectorySizeRoot(path: string, list: readonly string[]): { root: string; inherited: boolean } | null {
  if (isRemotePath(path)) return null;
  let root: string | null = null;
  for (const candidate of list) {
    if (!isSameOrDescendantPath(candidate, path)) continue;
    if (root === null || isSameOrDescendantPath(candidate, root)) root = candidate;
  }
  return root === null ? null : { root, inherited: !pathsEqual(root, path) };
}

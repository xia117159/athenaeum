import { normalizeLocationPath } from "./mockData";

export function isRemotePath(path: string) {
  return path.startsWith("ftp://") || path.startsWith("sftp://");
}

function normalizeOperationPath(path: string) {
  return normalizeLocationPath(path);
}

export function getPathComparisonKey(path: string) {
  const normalized = normalizeOperationPath(path);
  return isRemotePath(normalized) ? normalized : normalized.toLowerCase();
}

export function pathsEqual(left: string, right: string) {
  return getPathComparisonKey(left) === getPathComparisonKey(right);
}

export function isSameOrDescendantPath(source: string, destination: string) {
  const sourceKey = getPathComparisonKey(source);
  const destinationKey = getPathComparisonKey(destination);
  const separator = isRemotePath(sourceKey) || isRemotePath(destinationKey) ? "/" : "\\";
  const prefix = sourceKey.endsWith(separator) ? sourceKey : `${sourceKey}${separator}`;
  return destinationKey === sourceKey || destinationKey.startsWith(prefix);
}

/** A selected directory already includes its descendants in a filesystem operation. */
export function getTopLevelPaths(paths: string[]) {
  const normalized = paths.map((path) => path.trim()).filter(Boolean).map(normalizeOperationPath);
  const unique = new Map(normalized.map((path) => [getPathComparisonKey(path), path]));
  return [...unique].filter(([key]) => {
    const separator = isRemotePath(key) ? "/" : "\\";
    // Only a path-prefix boundary can be an ancestor; do not compare every
    // source pair on the renderer thread when thousands of siblings are selected.
    for (let index = key.indexOf(separator); index >= 0; index = key.indexOf(separator, index + 1)) {
      if (unique.has(key.slice(0, index)) ||
        (index < key.length - 1 && unique.has(key.slice(0, index + 1)))) return false;
    }
    return true;
  }).map(([, path]) => path);
}
